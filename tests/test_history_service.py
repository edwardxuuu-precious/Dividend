from unittest.mock import MagicMock

from app.cache import FileCache
from app.models import DailyBar, DividendEvent, Stock
from app.services.dividend_service import DividendService
from app.services.history_service import (
    SOURCE_CARRY,
    SOURCE_LAPSED,
    SOURCE_PRE,
    SOURCE_WINDOW,
    HistoryService,
    _merge_bars,
    compute_ttm_series,
    summarize_lapsed,
)


def test_empty_bars():
    assert compute_ttm_series([], []) == []


def test_no_dividends_yields_zero():
    bars = [DailyBar(date="2024-01-02", close=100.0)]
    series = compute_ttm_series(bars, [])
    assert len(series) == 1
    date_, close, ttm, pct, src = series[0]
    assert date_ == "2024-01-02"
    assert close == 100.0
    assert ttm == 0.0
    assert pct == 0.0
    assert src == SOURCE_PRE


def test_dividend_enters_window_on_ex_date():
    bars = [
        DailyBar(date="2024-06-19", close=1000.0),  # 当天就是除权日
        DailyBar(date="2024-06-20", close=1000.0),  # 之后一天，仍在窗口
    ]
    events = [DividendEvent(ex_date="2024-06-19", cash_per_share=30.0)]
    series = compute_ttm_series(bars, events)
    assert series[0][2] == 30.0  # ttm
    assert series[0][3] == 3.0   # 30/1000*100
    assert series[0][4] == SOURCE_WINDOW
    assert series[1][2] == 30.0
    assert series[1][4] == SOURCE_WINDOW


def test_carry_fills_zero_gap_with_annual_total():
    """方案 D：窗口空缺但仍在 540 天内 → 沿用上一年度累计，避免假 0。"""
    events = [DividendEvent(ex_date="2024-01-15", cash_per_share=25.0)]
    bars = [
        DailyBar(date="2024-12-31", close=1000.0),  # 仍在窗口
        DailyBar(date="2025-01-13", close=1000.0),  # 仍在窗口
        DailyBar(date="2025-01-14", close=1000.0),  # 滑出窗口 → carry
        DailyBar(date="2025-06-01", close=1000.0),  # 仍在 540 天内 → carry
    ]
    series = compute_ttm_series(bars, events)
    assert series[0][2] == 25.0 and series[0][4] == SOURCE_WINDOW
    assert series[1][2] == 25.0 and series[1][4] == SOURCE_WINDOW
    # 之前是 0、现在用 2024 年累计 25.0 兜底
    assert series[2][2] == 25.0 and series[2][4] == SOURCE_CARRY
    assert series[3][2] == 25.0 and series[3][4] == SOURCE_CARRY


def test_lapsed_after_540_days():
    """超过 540 天没有新分红 → 视为停止分红，TTM = 0。"""
    events = [DividendEvent(ex_date="2024-01-15", cash_per_share=25.0)]
    bars = [
        DailyBar(date="2025-07-08", close=1000.0),  # 距 ex 540 天，仍 carry
        DailyBar(date="2025-07-09", close=1000.0),  # 距 ex 541 天，lapsed
        DailyBar(date="2026-01-01", close=1000.0),  # lapsed
    ]
    series = compute_ttm_series(bars, events)
    assert series[0][4] == SOURCE_CARRY
    assert series[0][2] == 25.0
    assert series[1][4] == SOURCE_LAPSED
    assert series[1][2] == 0.0
    assert series[2][4] == SOURCE_LAPSED


def test_carry_uses_full_year_total_not_just_last_event():
    """中报 + 年报两笔分红时，carry 段应用整年累计，不是只最后一笔。"""
    events = [
        DividendEvent(ex_date="2024-04-20", cash_per_share=0.5),
        DividendEvent(ex_date="2024-08-15", cash_per_share=1.0),
    ]
    bars = [
        # 跨过 365 天后两笔都滑出窗口，进入 carry
        DailyBar(date="2025-09-01", close=100.0),
    ]
    series = compute_ttm_series(bars, events)
    # 距 last_ex (2024-08-15) = 382 天 ≤ 540 → carry
    # 兜底 = 2024 整年累计 = 0.5 + 1.0 = 1.5
    assert series[0][4] == SOURCE_CARRY
    assert series[0][2] == 1.5


def test_multiple_dividends_in_window_sum():
    bars = [DailyBar(date="2025-12-31", close=1500.0)]
    events = [
        DividendEvent(ex_date="2025-06-26", cash_per_share=27.673),
        DividendEvent(ex_date="2025-12-19", cash_per_share=23.957),
        DividendEvent(ex_date="2024-12-20", cash_per_share=23.882),  # >365 天前
    ]
    series = compute_ttm_series(bars, events)
    assert series[0][2] == 51.63
    # 51.63 / 1500 * 100 = 3.442
    assert abs(series[0][3] - 3.442) < 0.001
    assert series[0][4] == SOURCE_WINDOW


def test_yield_curve_rises_when_dividend_announced():
    bars = [
        DailyBar(date="2025-06-25", close=1500.0),  # 除权前一天
        DailyBar(date="2025-06-26", close=1500.0),  # 除权日
    ]
    events = [DividendEvent(ex_date="2025-06-26", cash_per_share=27.673)]
    series = compute_ttm_series(bars, events)
    # 除权前公司从未分红 → pre_first
    assert series[0][3] == 0.0
    assert series[0][4] == SOURCE_PRE
    # 除权日有真实数据
    assert series[1][3] is not None and series[1][3] > 0
    assert series[1][4] == SOURCE_WINDOW


# ---------------- 阈值可配置 ----------------

def test_carry_stale_days_is_configurable():
    """阈值参数化：把阈值改小，原本 carry 的天会立即变 lapsed。"""
    events = [DividendEvent(ex_date="2024-01-15", cash_per_share=25.0)]
    bars = [DailyBar(date="2025-06-01", close=1000.0)]  # 距 ex 503 天
    # 默认 540 天 → carry
    s_default = compute_ttm_series(bars, events)
    assert s_default[0][4] == SOURCE_CARRY
    # 收紧到 400 天 → lapsed
    s_strict = compute_ttm_series(bars, events, carry_stale_days=400)
    assert s_strict[0][4] == SOURCE_LAPSED
    assert s_strict[0][2] == 0.0


# ---------------- Lapsed 汇总 ----------------

def test_summarize_lapsed_no_events():
    assert summarize_lapsed([], []) is None


def test_summarize_lapsed_currently_lapsed():
    events = [DividendEvent(ex_date="2024-01-15", cash_per_share=25.0)]
    bars = [
        DailyBar(date="2025-07-08", close=1000.0),  # carry
        DailyBar(date="2026-01-01", close=1000.0),  # lapsed (距 ex > 540)
    ]
    series = compute_ttm_series(bars, events)
    summary = summarize_lapsed(series, events)
    assert summary["currently_lapsed"] is True
    assert summary["last_ex_date"] == "2024-01-15"
    # 2026-01-01 - 2024-01-15 = 717 天
    assert summary["days_since_last_ex"] == 717
    assert summary["historical_lapsed_count"] == 1
    assert summary["stale_threshold_days"] == 540


def test_summarize_lapsed_history_only():
    """有过 lapsed 段，但当前已恢复分红。"""
    events = [
        DividendEvent(ex_date="2022-01-15", cash_per_share=10.0),
        DividendEvent(ex_date="2024-06-01", cash_per_share=12.0),  # 间隔 868 天 > 540
    ]
    bars = [
        DailyBar(date="2022-06-01", close=100.0),  # window
        DailyBar(date="2023-12-01", close=100.0),  # lapsed
        DailyBar(date="2024-06-01", close=100.0),  # window 恢复
    ]
    series = compute_ttm_series(bars, events)
    summary = summarize_lapsed(series, events)
    assert summary["currently_lapsed"] is False
    assert summary["historical_lapsed_count"] == 1


# ---------------- 增量日 K 缓存 ----------------

def test_merge_bars_dedupes_and_sorts():
    stale = [
        DailyBar(date="2026-04-22", close=1450.0),
        DailyBar(date="2026-04-23", close=1480.0),
    ]
    new = [
        DailyBar(date="2026-04-23", close=1481.0),  # 与 stale 重叠 → new 覆盖
        DailyBar(date="2026-04-24", close=1500.0),
    ]
    merged = _merge_bars(stale, new)
    assert [b.date for b in merged] == ["2026-04-22", "2026-04-23", "2026-04-24"]
    # 重叠日由 new 覆盖
    assert merged[1].close == 1481.0


def test_get_bars_incremental_when_stale_exists(tmp_path):
    """TTL 过期时，应只拉 last_date+1 之后的差量并合并，而不是全量重抓。"""
    stock = Stock(symbol="600519", name="贵州茅台", exchange="SH")

    # 短 TTL 让缓存立即变 stale；预先写入 3 个 stale bar
    bars_cache = FileCache("test_inc_bars", ttl_seconds=0, cache_dir=tmp_path)
    bars_cache.set(
        stock.symbol,
        [
            {"date": "2026-04-22", "close": 1450.0},
            {"date": "2026-04-23", "close": 1480.0},
            {"date": "2026-04-24", "close": 1500.0},
        ],
    )

    bars_source = MagicMock()
    bars_source.get_daily_bars.return_value = [
        DailyBar(date="2026-04-25", close=1510.0),
    ]
    div_source = MagicMock()
    div_source.get_dividend_history.return_value = []
    ds = DividendService(div_source, cache=FileCache("test_inc_div", 60, cache_dir=tmp_path))

    hs = HistoryService(
        bars_source=bars_source,
        dividend_service=ds,
        bars_cache=bars_cache,
        history_cache=FileCache("test_inc_hist", 60, cache_dir=tmp_path),
    )

    bars = hs._get_bars(stock)

    # 验证：调用了 source.get_daily_bars(stock, start_date="2026-04-25")（last+1）
    bars_source.get_daily_bars.assert_called_once_with(stock, start_date="2026-04-25")
    # 合并后包含 stale 3 条 + new 1 条 = 4 条
    assert [b.date for b in bars] == [
        "2026-04-22", "2026-04-23", "2026-04-24", "2026-04-25",
    ]


def test_get_bars_incremental_falls_back_to_stale_on_source_error(tmp_path):
    """增量拉失败时不应该把 stale 弄丢。"""
    stock = Stock(symbol="600519", name="贵州茅台", exchange="SH")

    bars_cache = FileCache("test_inc_err_bars", ttl_seconds=0, cache_dir=tmp_path)
    bars_cache.set(
        stock.symbol,
        [{"date": "2026-04-23", "close": 1480.0}],
    )

    bars_source = MagicMock()
    bars_source.get_daily_bars.side_effect = RuntimeError("network down")

    div_source = MagicMock()
    div_source.get_dividend_history.return_value = []
    ds = DividendService(div_source, cache=FileCache("test_inc_err_div", 60, cache_dir=tmp_path))

    hs = HistoryService(
        bars_source=bars_source,
        dividend_service=ds,
        bars_cache=bars_cache,
        history_cache=FileCache("test_inc_err_hist", 60, cache_dir=tmp_path),
    )

    bars = hs._get_bars(stock)
    assert [b.date for b in bars] == ["2026-04-23"]


def test_get_bars_full_fetch_when_stale_too_old(tmp_path):
    """stale > 30 天时走全量重拉，不再用 start_date 增量。"""
    stock = Stock(symbol="600519", name="贵州茅台", exchange="SH")

    bars_cache = FileCache("test_old_bars", ttl_seconds=0, cache_dir=tmp_path)
    # 故意写一个 5 年前的 stale，> 30 天阈值
    bars_cache.set(stock.symbol, [{"date": "2020-01-01", "close": 1000.0}])

    bars_source = MagicMock()
    bars_source.get_daily_bars.return_value = [
        DailyBar(date="2026-04-24", close=1500.0),
        DailyBar(date="2026-04-25", close=1510.0),
    ]
    div_source = MagicMock()
    div_source.get_dividend_history.return_value = []
    ds = DividendService(div_source, cache=FileCache("test_old_div", 60, cache_dir=tmp_path))

    hs = HistoryService(
        bars_source=bars_source,
        dividend_service=ds,
        bars_cache=bars_cache,
        history_cache=FileCache("test_old_hist", 60, cache_dir=tmp_path),
    )

    bars = hs._get_bars(stock)
    bars_source.get_daily_bars.assert_called_once_with(stock)  # 全量（无 start_date）
    assert [b.date for b in bars] == ["2026-04-24", "2026-04-25"]
