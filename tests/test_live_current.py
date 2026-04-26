"""测试 HistoryService 的 live current 计算（核心：盘中实时同步）。"""
from datetime import datetime
from unittest.mock import MagicMock

from app.cache import FileCache
from app.models import DailyBar, DividendEvent, Quote, Stock
from app.services.dividend_service import DividendService
from app.services.history_service import HistoryService
from app.services.price_service import PriceService


def _stock():
    return Stock(symbol="600519", name="贵州茅台", exchange="SH")


def _make_history_service(tmp_path, price_quote: float | None):
    """构造一个 HistoryService 实例，喂入固定的 bars/events，并模拟实时报价。"""
    stock = _stock()

    # bars：构造 5 个交易日，最后一个 close=1500，TTM=51.63
    bars = [
        DailyBar(date="2026-04-20", close=1400.0),
        DailyBar(date="2026-04-21", close=1420.0),
        DailyBar(date="2026-04-22", close=1450.0),
        DailyBar(date="2026-04-23", close=1480.0),
        DailyBar(date="2026-04-24", close=1500.0),
    ]
    events = [
        DividendEvent(ex_date="2025-06-26", cash_per_share=27.673),
        DividendEvent(ex_date="2025-12-19", cash_per_share=23.957),
    ]

    bars_source = MagicMock()
    bars_source.get_daily_bars.return_value = bars

    div_source = MagicMock()
    div_source.get_dividend_history.return_value = events
    ds = DividendService(
        div_source, cache=FileCache("test_div", 60, cache_dir=tmp_path)
    )

    price_source = MagicMock()
    if price_quote is not None:
        price_source.get_quotes.return_value = {
            stock.symbol: Quote(symbol=stock.symbol, price=price_quote, ts=datetime.now())
        }
    else:
        price_source.get_quotes.return_value = {}
    ps = PriceService(price_source, ttl_seconds=0.1)

    hs = HistoryService(
        bars_source=bars_source,
        dividend_service=ds,
        price_service=ps,
        bars_cache=FileCache("test_bars", 60, cache_dir=tmp_path),
        history_cache=FileCache("test_hist", 60, cache_dir=tmp_path),
    )
    return hs, stock


def test_live_current_uses_realtime_price(tmp_path):
    hs, stock = _make_history_service(tmp_path, price_quote=1600.0)
    payload = hs.get_history(stock)
    cur = payload["current"]

    assert cur["source"] == "live"
    assert cur["live_price"] == 1600.0
    # TTM = 51.63 (来自 EOD 的 last bar)
    assert cur["ttm_dividend"] == 51.63
    # yield_pct = 51.63 / 1600 * 100 = 3.2269
    assert abs(cur["yield_pct"] - 3.2269) < 0.001
    # EOD 字段保留为对比
    assert cur["eod_close"] == 1500.0
    assert cur["eod_date"] == "2026-04-24"


def test_falls_back_to_eod_when_quote_missing(tmp_path):
    hs, stock = _make_history_service(tmp_path, price_quote=None)
    cur = hs.get_history(stock)["current"]

    assert cur["source"] == "eod"
    assert cur["live_price"] == 1500.0  # = EOD close
    # EOD yield = 51.63 / 1500 * 100 = 3.442
    assert abs(cur["yield_pct"] - 3.442) < 0.001


def test_get_live_current_does_not_require_full_payload(tmp_path):
    hs, stock = _make_history_service(tmp_path, price_quote=1480.0)
    cur = hs.get_live_current(stock)
    assert cur is not None
    assert cur["source"] == "live"
    assert cur["live_price"] == 1480.0
    # 51.63 / 1480 * 100 = 3.488
    assert abs(cur["yield_pct"] - 3.488) < 0.001


def test_live_current_changes_with_price(tmp_path):
    """同一只股票不同价格，应给出不同的 yield 与 percentile_rank。"""
    hs1, stock = _make_history_service(tmp_path, price_quote=1500.0)
    cur1 = hs1.get_live_current(stock)

    # 涨价 → 股息率降，分位排名也应变低
    hs2, _ = _make_history_service(tmp_path / "_2", price_quote=1800.0)
    cur2 = hs2.get_live_current(stock)

    assert cur1["yield_pct"] > cur2["yield_pct"]
    if cur1["percentile_rank"] is not None and cur2["percentile_rank"] is not None:
        assert cur1["percentile_rank"] >= cur2["percentile_rank"]
