from __future__ import annotations

import bisect
import logging
import statistics
from datetime import date, datetime, timedelta

from app.cache import FileCache
from app.data_sources.base import HistoricalPriceSource
from app.models import DailyBar, DividendEvent, Stock
from app.services.dividend_service import (
    DividendService,
    analyze_latest_annual,
    earliest_ex_date_in_year,
    annual_payment_groups,
    drop_incomplete_latest_year,
)
from app.services.price_service import PriceService

logger = logging.getLogger(__name__)

_BARS_TTL_SECONDS = 24 * 3600
_STATIC_TTL_SECONDS = 6 * 3600   # 静态部分（series/分位/年度/预估）缓存 6 小时
_TTM_DAYS = 365
_CARRY_STALE_DAYS = 540   # 距上次除权 > 此天数仍无新分红 → 视为已停止分红（lapsed）
_INCREMENTAL_MAX_STALE_DAYS = 30  # stale 超过此天数走全量重拉，避免一次性补几个月数据时的边界 bug
_ROLLING_WINDOW_DAYS = 750   # 滚动分位带的窗口长度（约 3 年交易日）
_ROLLING_MIN_SAMPLES = 250   # 窗口内有效样本不足时该日不输出分位（约 1 年）
_STATIC_CACHE_NAME = "history_static_v11_cache"  # v11：series/annual_series 各加并行 rolling bands（750 交易日窗口），旧 v10 自然失效

# series 每条记录第 5 列 source 的取值
SOURCE_WINDOW = "window"        # 365 天窗口里有真实分红数据
SOURCE_CARRY = "carry"          # 窗口空缺但仍在 540 天内，沿用上一年度累计兜底
SOURCE_LAPSED = "lapsed"        # 距上次除权 > 540 天，视为公司已停止分红
SOURCE_PRE = "pre_first"        # 公司首次除权之前，没有任何历史分红


class HistoryService:
    """
    按交易日逐日计算两套口径的股息率：

    1) TTM（滚动 365 天）—— 主估值口径，分位/估值标签都基于这条
        TTM 分红_t = sum(每股现金分红 for ex_date in (t - 365 天, t])
        TTM 股息率_t = TTM 分红_t / 收盘价_t * 100

    2) 年化（最近完整派息自然年）—— 与首页卡片一致，跨除权日不漂移
        年化分红_t = 截至 t 的 events 经 drop_incomplete_latest_year 后最近年合计
        年化股息率_t = 年化分红_t / 收盘价_t * 100

    设计：
    - 静态部分（series/annual_series/percentiles/annual/forecast/eod）—— 6h 文件缓存
    - 动态 current —— 永远基于最新 quote 实时计算两套口径，不缓存
    这样盘中卡片（年化）、详情头（双口径）、图表（双线）、估值徽章（TTM）全同步。
    """

    def __init__(
        self,
        bars_source: HistoricalPriceSource,
        dividend_service: DividendService,
        price_service: PriceService | None = None,
        bars_cache: FileCache | None = None,
        history_cache: FileCache | None = None,
        carry_stale_days: int = _CARRY_STALE_DAYS,
    ) -> None:
        self.bars_source = bars_source
        self.dividend_service = dividend_service
        self.price_service = price_service
        self.carry_stale_days = carry_stale_days
        self.bars_cache = bars_cache or FileCache("daily_bars_cache", _BARS_TTL_SECONDS)
        # 缓存名 v4：新增 annual_series / annual_eod，旧 v3 缓存自然失效
        self.static_cache = history_cache or FileCache(
            _STATIC_CACHE_NAME, _STATIC_TTL_SECONDS
        )

    # ---------- 公共接口 ----------

    def get_history(self, stock: Stock) -> dict:
        """完整 payload（含实时 current）。"""
        static = self._get_static(stock)
        result = dict(static)
        result["current"] = self._compute_live_current(stock, static)
        return result

    def get_live_current(self, stock: Stock) -> dict | None:
        """轻量端点用：只算实时 current，不返回 series 等大对象。"""
        static = self._get_static(stock)
        return self._compute_live_current(stock, static)

    def get_percentile_only(
        self, stock: Stock, live_price: float | None = None
    ) -> dict | None:
        """主表横向对比用：仅当静态缓存已就绪时返回双口径 P 分位 + 估值标签 + TTM 股息率。

        与 get_live_current 区别：**不会触发** _get_static 的冷启动（耗时几秒），
        所以可以安全地在每次 watcher.snapshot() 里调用。冷启动期间返回 None，
        前端显示"—"，等后台 prewarm 把 cache 填满后再下个 tick 出现。

        live_price 可由调用方传入：watcher.snapshot() 已经在主表 tick 开头取过完整
        watchlist 的批量行情，把对应价直接传进来即可，避免本函数再次发起 1-only 的
        get_quotes 调用污染 PriceService 的 5s 共享缓存（详见 price_service.py 注释）。
        如果传入 None，仍会回退到 price_service.get_quotes([stock])。

        返回字段同时覆盖两套口径：
          - percentile_rank / valuation —— TTM 分位（基于 TTM series 历史样本）
          - annual_percentile_rank / annual_valuation —— 年化分位（基于年化 series 历史样本）
          - yield_ttm_pct —— 当前 TTM 股息率（与详情/图表同口径，EOD ttm_dividend ÷ 实时价）
        """
        cached = self.static_cache.get(stock.symbol)
        if cached is None:
            return None
        eod = cached.get("eod")
        series = cached.get("series") or []
        annual_series = cached.get("annual_series") or []
        annual_eod = cached.get("annual_eod") or {}
        if eod is None or not series:
            return None

        if live_price is None and self.price_service is not None:
            quotes = self.price_service.get_quotes([stock])
            quote = quotes.get(stock.symbol)
            if quote is not None and quote.price > 0:
                live_price = quote.price

        ttm = eod["ttm_dividend"]
        if live_price is not None and live_price > 0:
            yield_pct = round(ttm / live_price * 100.0, 4)
        else:
            yield_pct = eod["yield_pct"]

        # 年化口径分位：annual_dividend ÷ 实时价，再到年化 series 样本里取分位
        annual_div = annual_eod.get("annual_dividend")
        if annual_div is not None and live_price is not None and live_price > 0:
            annual_yield_pct = round(annual_div / live_price * 100.0, 4)
        else:
            annual_yield_pct = annual_eod.get("annual_yield_pct")

        rank = percentile_rank(yield_pct, series)
        annual_rank = annual_percentile_rank(annual_yield_pct, annual_series)
        return {
            "percentile_rank": rank,
            "valuation": valuation_label(rank),
            "annual_percentile_rank": annual_rank,
            "annual_valuation": valuation_label(annual_rank),
            "yield_ttm_pct": yield_pct,
        }

    # ---------- 静态部分（缓存） ----------

    def _get_static(self, stock: Stock) -> dict:
        cached = self.static_cache.get(stock.symbol)
        if cached is not None:
            return cached

        bars = self._get_bars(stock)
        events = self.dividend_service.get_events(stock)
        expected = stock.expected_payments_per_year
        series = compute_ttm_series(bars, events, carry_stale_days=self.carry_stale_days)
        annual_series = compute_annual_yield_series(bars, events, expected_count=expected)
        annual = compute_annual_history(events, expected_count=expected)
        forecast = forecast_next_year(annual)
        percentiles = compute_percentiles(series)
        annual_percentiles = compute_annual_percentiles(annual_series)
        bands = compute_rolling_bands(series)
        annual_bands = compute_annual_rolling_bands(annual_series)

        eod = None
        if series:
            d, c, ttm, y, src = series[-1]
            eod = {
                "date": d,
                "close": c,
                "ttm_dividend": ttm,
                "yield_pct": y,
                "source": src,
            }

        annual_eod = None
        if annual_series:
            d, c, ad, ay, year = annual_series[-1]
            annual_eod = {
                "date": d,
                "close": c,
                "annual_dividend": ad,
                "annual_yield_pct": ay,
                "annual_year": year,
            }

        lapsed_summary = summarize_lapsed(
            series, events, carry_stale_days=self.carry_stale_days
        )

        # 与首页卡片保持一致：仅在最近一个完整派息年被判为"含特别股利"时，
        # 给该年内的所有事件打 unusual。不在历史所有年份扫描，避免成长股
        # （如复合增长 ~20%/年）因近年中位数被远古小额股利拉低而误标常态化派息。
        latest_analysis = analyze_latest_annual(events, expected_count=expected)
        unusual_year = (
            latest_analysis.annual.year
            if latest_analysis.unusually_high and latest_analysis.annual is not None
            else None
        )

        result = {
            "symbol": stock.symbol,
            "name": stock.name,
            "series": series,
            "annual_series": annual_series,
            "events": [
                {
                    "ex_date": e.ex_date,
                    "cash_per_share": round(e.cash_per_share, 6),
                    "unusual": unusual_year is not None and _ex_date_year(e.ex_date) == unusual_year,
                }
                for e in sorted(events, key=lambda x: x.ex_date, reverse=True)
            ],
            "percentiles": percentiles,
            "annual_percentiles": annual_percentiles,
            "bands": bands,
            "annual_bands": annual_bands,
            "annual": annual,
            "forecast": forecast,
            "eod": eod,
            "annual_eod": annual_eod,
            "lapsed_summary": lapsed_summary,
        }
        if series:
            self.static_cache.set(stock.symbol, result)
        return result

    # ---------- 动态实时 current ----------

    def _compute_live_current(self, stock: Stock, static: dict) -> dict | None:
        """
        从 PriceService 拿 5s 缓存的最新 quote，结合昨收 TTM/年化分红重新算今日双口径股息率。
        失败/无 PriceService 时退化到 EOD 值，前端体验仍 OK。

        返回字段同时包含两套口径：
          - yield_pct / ttm_dividend / percentile_rank / valuation —— TTM
          - annual_yield_pct / annual_dividend / annual_year —— 年化（按派息年聚合）
        """
        eod = static.get("eod")
        if eod is None:
            return None
        annual_eod = static.get("annual_eod") or {}

        live_price = None
        live_ts = None
        if self.price_service is not None:
            quotes = self.price_service.get_quotes([stock])
            quote = quotes.get(stock.symbol)
            if quote is not None and quote.price > 0:
                live_price = quote.price
                live_ts = quote.ts.isoformat(timespec="seconds")

        ttm = eod["ttm_dividend"]
        if live_price is not None:
            yield_pct = round(ttm / live_price * 100.0, 4) if live_price > 0 else None
            source = "live"
        else:
            live_price = eod["close"]
            yield_pct = eod["yield_pct"]
            source = "eod"

        annual_div = annual_eod.get("annual_dividend")
        annual_year = annual_eod.get("annual_year")
        if annual_div is not None and live_price and live_price > 0:
            annual_yield_pct = round(annual_div / live_price * 100.0, 4)
        else:
            annual_yield_pct = annual_eod.get("annual_yield_pct")

        rank = percentile_rank(yield_pct, static.get("series") or [])
        annual_rank = annual_percentile_rank(
            annual_yield_pct, static.get("annual_series") or []
        )
        return {
            "live_price": live_price,
            "live_ts": live_ts,
            "ttm_dividend": ttm,
            "yield_pct": yield_pct,
            "percentile_rank": rank,
            "valuation": valuation_label(rank),
            "source": source,  # "live" 表示拿到实时，"eod" 表示退回上日
            "eod_close": eod["close"],
            "eod_yield_pct": eod["yield_pct"],
            "eod_date": eod["date"],
            # 年化口径（与首页卡片一致）
            "annual_dividend": annual_div,
            "annual_yield_pct": annual_yield_pct,
            "annual_year": annual_year,
            "annual_eod_yield_pct": annual_eod.get("annual_yield_pct"),
            "annual_percentile_rank": annual_rank,
            "annual_valuation": valuation_label(annual_rank),
        }

    def _get_bars(self, stock: Stock) -> list[DailyBar]:
        # 1. Fresh cache hit：TTL 内直接返回
        cached = self.bars_cache.get(stock.symbol)
        if cached is not None:
            return [DailyBar(**b) for b in cached]

        # 2. Stale 存在：增量补差量。茅台 5907 bar 全量重抓 ≈ 1s+，
        #    增量只拉 (last+1, today]，几乎一定是 0-3 个新交易日，毫秒级。
        #    例外：stale 距今 > 30 天则走全量，避免一次补几个月数据的边界 bug。
        stale = self.bars_cache.get_stale(stock.symbol)
        if stale:
            stale_bars = [DailyBar(**b) for b in stale]
            last_date = max(b.date for b in stale_bars)
            stale_age_days = (
                datetime.now().date() - datetime.strptime(last_date, "%Y-%m-%d").date()
            ).days
            if stale_age_days <= _INCREMENTAL_MAX_STALE_DAYS:
                try:
                    next_day = (
                        datetime.strptime(last_date, "%Y-%m-%d").date() + timedelta(days=1)
                    ).strftime("%Y-%m-%d")
                    new_bars = self.bars_source.get_daily_bars(stock, start_date=next_day)
                except Exception as e:
                    logger.warning("增量拉日 K 失败 %s: %s（沿用 stale）", stock.symbol, e)
                    return stale_bars

                merged = _merge_bars(stale_bars, new_bars)
                self.bars_cache.set(
                    stock.symbol,
                    [{"date": b.date, "close": b.close} for b in merged],
                )
                return merged
            logger.info(
                "stale 距今 %d 天 > 阈值 %d，走全量",
                stale_age_days, _INCREMENTAL_MAX_STALE_DAYS,
            )

        # 3. Cold start：全量拉
        try:
            bars = self.bars_source.get_daily_bars(stock)
        except Exception as e:
            logger.warning("日 K 拉取失败 %s: %s", stock.symbol, e)
            return []

        if bars:
            self.bars_cache.set(
                stock.symbol,
                [{"date": b.date, "close": b.close} for b in bars],
            )
        return bars


def _ex_date_year(ex_date: str) -> int | None:
    try:
        return datetime.strptime(ex_date, "%Y-%m-%d").year
    except ValueError:
        return None


def _merge_bars(stale: list[DailyBar], new: list[DailyBar]) -> list[DailyBar]:
    """合并 stale + new，按 date 去重（new 覆盖 stale），按日期升序排列。"""
    by_date: dict[str, DailyBar] = {b.date: b for b in stale}
    for b in new:
        by_date[b.date] = b
    return sorted(by_date.values(), key=lambda b: b.date)


def compute_ttm_series(
    bars: list[DailyBar],
    events: list[DividendEvent],
    *,
    carry_stale_days: int = _CARRY_STALE_DAYS,
) -> list[list]:
    """
    O(N + M)：每个交易日 t 给出 TTM 分红与股息率，并标注数据来源 source。

    三档逻辑（方案 D）：
      window  —— 365 天滑动窗口里有真实分红，TTM = 窗口内累计
      carry   —— 窗口为 0 但距上次除权 ≤ 540 天，TTM = 上一笔除权所在自然年度累计
                 （兜底估计，避免分红日漂移导致的"假 0"）
      lapsed  —— 距上次除权 > 540 天，视为公司已停止分红，TTM = 0
      pre_first —— 公司首次除权之前，TTM = 0

    返回 [[date_str, close, ttm_dividend, yield_pct, source], ...]
    """
    if not bars:
        return []
    bars_sorted = sorted(bars, key=lambda b: b.date)
    events_sorted = sorted(events, key=lambda e: e.ex_date)
    parsed_events = [
        (datetime.strptime(e.ex_date, "%Y-%m-%d").date(), e.cash_per_share)
        for e in events_sorted
    ]

    series: list[list] = []
    head = 0  # 第一个仍在窗口内的事件
    tail = 0  # 第一个尚未"激活"（ex_date > t）的事件
    window_sum = 0.0
    window = timedelta(days=_TTM_DAYS)
    stale = timedelta(days=carry_stale_days)

    # 自然年度累计：只统计 ex_date ≤ 当前 t 的事件，避免兜底时"窥见未来"
    year_total: dict[int, float] = {}
    last_ex_date = None

    for bar in bars_sorted:
        try:
            t = datetime.strptime(bar.date, "%Y-%m-%d").date()
        except ValueError:
            continue

        # 把 ex_date <= t 的事件加入窗口 + 年度累计
        while tail < len(parsed_events) and parsed_events[tail][0] <= t:
            ex_date, cash = parsed_events[tail]
            window_sum += cash
            year_total[ex_date.year] = year_total.get(ex_date.year, 0.0) + cash
            last_ex_date = ex_date
            tail += 1
        # 把 ex_date <= t - 365 天的事件移出窗口（年度累计不滚出，它代表上一年度全貌）
        cutoff = t - window
        while head < tail and parsed_events[head][0] <= cutoff:
            window_sum -= parsed_events[head][1]
            head += 1

        if window_sum > 1e-9:
            ttm = round(window_sum, 6)
            source = SOURCE_WINDOW
        elif last_ex_date is None:
            ttm = 0.0
            source = SOURCE_PRE
        elif (t - last_ex_date) <= stale:
            ttm = round(year_total.get(last_ex_date.year, 0.0), 6)
            source = SOURCE_CARRY
        else:
            ttm = 0.0
            source = SOURCE_LAPSED

        yield_pct = round(ttm / bar.close * 100.0, 4) if bar.close > 0 else None
        series.append([bar.date, round(bar.close, 4), ttm, yield_pct, source])

    return series


# ---------------- 年化股息率序列（按派息年聚合） ----------------


def compute_annual_yield_series(
    bars: list[DailyBar],
    events: list[DividendEvent],
    *,
    expected_count: int = 0,
) -> list[list]:
    """
    按"最近完整派息自然年"口径逐日给出年化股息率，与首页卡片同口径：
        年化分红_t = 截至 t 的 events 经 drop_incomplete_latest_year 后最近年的合计
        年化股息率_t = 年化分红_t / 收盘价_t × 100

    与 compute_ttm_series 的差异：
      - 基准是"最近一个完整派息自然年"，而非"过去 365 天滑动窗口"
      - 跨除权日不漂移（除权日掉出 365 天窗口 → TTM 会跳水，年化不会）
      - drop_incomplete_latest_year 与 latest_annual_from_events 同逻辑，保证
        卡片的"派息年/每股"与图表"年化曲线最右端"完全一致

    返回 [[date, close, annual_dividend, annual_yield_pct, annual_year], ...]
    annual_year 为 None 表示当时还没有任何派息记录（pre_first 期，全部 0）。
    """
    if not bars:
        return []
    bars_sorted = sorted(bars, key=lambda b: b.date)
    events_sorted = sorted(events, key=lambda e: e.ex_date)
    parsed_events = [
        (datetime.strptime(e.ex_date, "%Y-%m-%d").date(), e.cash_per_share)
        for e in events_sorted
    ]

    series: list[list] = []
    by_year_so_far: dict[int, list[float]] = {}
    earliest_ex_per_year: dict[int, date] = {}
    j = 0
    for bar in bars_sorted:
        try:
            t = datetime.strptime(bar.date, "%Y-%m-%d").date()
        except ValueError:
            continue
        # 累积所有 ex_date ≤ t 的事件到逐年桶里（不滚出，年化是累计口径）
        while j < len(parsed_events) and parsed_events[j][0] <= t:
            ex_date, cash = parsed_events[j]
            by_year_so_far.setdefault(ex_date.year, []).append(cash)
            # events_sorted 已按 ex_date 升序，每年首次出现即最早除权日
            earliest_ex_per_year.setdefault(ex_date.year, ex_date)
            j += 1

        if not by_year_so_far:
            series.append([bar.date, round(bar.close, 4), 0.0, 0.0, None])
            continue
        latest_year_so_far = max(by_year_so_far)
        filtered = drop_incomplete_latest_year(
            by_year_so_far,
            latest_first_ex_date=earliest_ex_per_year.get(latest_year_so_far),
            today=t,
            expected_count=expected_count,
        )
        if not filtered:
            series.append([bar.date, round(bar.close, 4), 0.0, None, None])
            continue
        latest_year = max(filtered)
        total = round(sum(filtered[latest_year]), 6)
        if bar.close > 0:
            ypct = round(total / bar.close * 100.0, 4)
        else:
            ypct = None
        series.append([bar.date, round(bar.close, 4), total, ypct, latest_year])
    return series


# ---------------- Lapsed 汇总（停止分红警报） ----------------


def summarize_lapsed(
    series: list[list],
    events: list[DividendEvent],
    *,
    carry_stale_days: int = _CARRY_STALE_DAYS,
) -> dict | None:
    """
    扫描 series，汇总公司"停止分红"信号供前端警告徽章使用：
      currently_lapsed       —— EOD 当前是否处于 lapsed 状态（最严重）
      days_since_last_ex     —— EOD 距最近一次除权多少天
      last_ex_date           —— 最近一次除权日（YYYY-MM-DD）
      historical_lapsed_count —— 历史出现过几段独立的 lapsed 段（连续 lapsed 算一段）
      segments               —— 每段独立 lapsed 的明细列表，按开始时间升序：
                                start_date / end_date / days / prev_ex_date / resumed_ex_date / ongoing
                                供前端可点开徽章查看"每段断流的具体年份、跨度、原因"

    无任何分红事件时返回 None（pre_first 全程不构成警报）。
    """
    if not events:
        return None
    if not series:
        return None

    last_ex_date = max(e.ex_date for e in events)
    sorted_ex_dates = sorted(e.ex_date for e in events)

    def _prev_ex_date(start_date: str) -> str | None:
        # 该 lapsed 段开始前最近一次除权 = 触发 540 天计时的那笔
        idx = bisect.bisect_right(sorted_ex_dates, start_date) - 1
        return sorted_ex_dates[idx] if idx >= 0 else None

    def _resumed_ex_date(end_date: str) -> str | None:
        # 该 lapsed 段结束后最近一次除权 = 让 series 重新落入 window 的那笔
        idx = bisect.bisect_right(sorted_ex_dates, end_date)
        return sorted_ex_dates[idx] if idx < len(sorted_ex_dates) else None

    def _span_days(start_date: str, end_date: str) -> int | None:
        try:
            s = datetime.strptime(start_date, "%Y-%m-%d").date()
            e = datetime.strptime(end_date, "%Y-%m-%d").date()
            return (e - s).days
        except ValueError:
            return None

    # 数 lapsed 段：连续 lapsed 算一段，状态切换才计数
    segments: list[dict] = []
    cur_start: str | None = None
    cur_end: str | None = None
    for p in series:
        date_str = p[0]
        src = p[4] if len(p) >= 5 else SOURCE_WINDOW
        if src == SOURCE_LAPSED:
            if cur_start is None:
                cur_start = date_str
            cur_end = date_str
        elif cur_start is not None:
            segments.append(
                {
                    "start_date": cur_start,
                    "end_date": cur_end,
                    "days": _span_days(cur_start, cur_end),
                    "prev_ex_date": _prev_ex_date(cur_start),
                    "resumed_ex_date": _resumed_ex_date(cur_end),
                    "ongoing": False,
                }
            )
            cur_start = None
            cur_end = None
    if cur_start is not None:
        segments.append(
            {
                "start_date": cur_start,
                "end_date": cur_end,
                "days": _span_days(cur_start, cur_end),
                "prev_ex_date": _prev_ex_date(cur_start),
                "resumed_ex_date": None,
                "ongoing": True,
            }
        )

    eod_date_str, _, _, _, eod_src = series[-1]
    try:
        eod_date = datetime.strptime(eod_date_str, "%Y-%m-%d").date()
        last_ex = datetime.strptime(last_ex_date, "%Y-%m-%d").date()
        days_since_last_ex = (eod_date - last_ex).days
    except ValueError:
        days_since_last_ex = None

    return {
        "currently_lapsed": eod_src == SOURCE_LAPSED,
        "days_since_last_ex": days_since_last_ex,
        "last_ex_date": last_ex_date,
        "historical_lapsed_count": len(segments),
        "stale_threshold_days": carry_stale_days,
        "segments": segments,
    }


# ---------------- 历史分位（估值锚点） ----------------

_PERCENTILES = [10, 25, 50, 75, 90]


def _meaningful_yields(series: list[list]) -> list[float]:
    """
    取计算分位用的样本：仅统计 source == window 的天（真实窗口数据）。
    carry 是兜底估计、lapsed/pre_first 是 0，都不应进入分位样本。
    兼容旧 4 元素格式（视为 window）。
    """
    out: list[float] = []
    for p in series:
        if p[3] is None or p[3] <= 0:
            continue
        src = p[4] if len(p) >= 5 else SOURCE_WINDOW
        if src == SOURCE_WINDOW:
            out.append(p[3])
    return sorted(out)


def compute_percentiles(series: list[list]) -> dict[str, float | None]:
    """
    返回 {p10, p25, p50, p75, p90}：历史 TTM 股息率的分位值（剔除 0 后的样本）。
    用线性插值（同 numpy.percentile 默认 linear 方式）。
    """
    samples = _meaningful_yields(series)
    out: dict[str, float | None] = {}
    if len(samples) < 2:
        for p in _PERCENTILES:
            out[f"p{p}"] = None
        return out
    n = len(samples)
    for p in _PERCENTILES:
        rank = (p / 100.0) * (n - 1)
        lo = int(rank)
        hi = min(lo + 1, n - 1)
        frac = rank - lo
        out[f"p{p}"] = round(samples[lo] * (1 - frac) + samples[hi] * frac, 4)
    return out


def percentile_rank(value: float | None, series: list[list]) -> float | None:
    """
    给定当前股息率 value，返回它在历史样本中的百分位排名（0-100）。
    例：返回 63.0 表示历史上有 63% 的交易日股息率比这低（即比这高的占 37%）。
    """
    if value is None or value <= 0:
        return None
    samples = _meaningful_yields(series)
    if not samples:
        return None
    pos = bisect.bisect_left(samples, value)
    return round(pos / len(samples) * 100.0, 1)


def _interp_percentiles(sorted_window: list[float]) -> list[float]:
    """对已排序的样本列表做线性插值，返回 [p10,p25,p50,p75,p90]，与 compute_percentiles 同口径。"""
    m = len(sorted_window)
    out: list[float] = []
    for pct in _PERCENTILES:
        rank = (pct / 100.0) * (m - 1)
        lo = int(rank)
        hi = min(lo + 1, m - 1)
        frac = rank - lo
        v = sorted_window[lo] * (1 - frac) + sorted_window[hi] * frac
        out.append(round(v, 2))
    return out


def compute_rolling_bands(
    series: list[list],
    *,
    window: int = _ROLLING_WINDOW_DAYS,
    min_samples: int = _ROLLING_MIN_SAMPLES,
) -> list[list]:
    """
    返回与 series 下标 1:1 对齐的 [[p10, p25, p50, p75, p90], ...]。
    每行用过去 window 个 series 行内的有效样本（与 _meaningful_yields 同口径：
    source==window 且 yield>0）按线性插值算分位；窗口内有效样本 < min_samples
    时该行为全 None。视为带状的 Bollinger 风格分位上下轨。
    """
    n = len(series)
    out: list[list] = []
    if n == 0:
        return out

    sorted_window: list[float] = []
    fifo: list[tuple[int, float | None]] = []  # (series_index, value or None)，按插入序
    head = 0  # fifo 当前头指针（已 popleft 的视为不存在）
    null_row: list[float | None] = [None] * len(_PERCENTILES)

    for i in range(n):
        p = series[i]
        ypct = p[3] if len(p) >= 4 else None
        src = p[4] if len(p) >= 5 else SOURCE_WINDOW
        if ypct is not None and ypct > 0 and src == SOURCE_WINDOW:
            bisect.insort(sorted_window, ypct)
            fifo.append((i, ypct))
        else:
            fifo.append((i, None))

        # 窗口外的最老条目（series 行号 < i - window + 1）出队
        cutoff = i - window + 1
        while head < len(fifo) and fifo[head][0] < cutoff:
            _, old_val = fifo[head]
            head += 1
            if old_val is not None:
                idx = bisect.bisect_left(sorted_window, old_val)
                if idx < len(sorted_window) and sorted_window[idx] == old_val:
                    sorted_window.pop(idx)

        if len(sorted_window) < min_samples:
            out.append(list(null_row))
        else:
            out.append(_interp_percentiles(sorted_window))

    return out


# ---------------- 年化口径分位 ----------------
#
# 设计差异：
# - 样本来源 = compute_annual_yield_series 的 yield_pct（每元素第 4 列）
# - 过滤规则：剔除 annual_year is None（pre_first 期）以及 yield_pct ≤ 0/None 的点
#   —— 与 TTM 的 _meaningful_yields 等价：都只统计"有真实分红支撑"的样本
# - 分位算法（线性插值）和估值标签函数（valuation_label）与 TTM 完全复用
#
# 这样年化与 TTM 两套分位徽章用同一套阈值（≥90 历史性低估、≥75 偏低估…），
# 用户横比两口径时不需要换思维框架。


def _meaningful_annual_yields(annual_series: list[list]) -> list[float]:
    """
    取计算年化分位用的样本：剔除 pre_first 期（annual_year is None）和 yield ≤ 0。
    annual_series 元素结构：[date, close, annual_dividend, annual_yield_pct, annual_year]
    """
    out: list[float] = []
    for p in annual_series:
        # 兼容旧缓存被部分清掉的情形
        if len(p) < 5:
            continue
        if p[4] is None:
            continue
        ypct = p[3]
        if ypct is None or ypct <= 0:
            continue
        out.append(ypct)
    return sorted(out)


def compute_annual_percentiles(annual_series: list[list]) -> dict[str, float | None]:
    """
    返回年化口径的 {p10, p25, p50, p75, p90}。算法与 TTM compute_percentiles 一致，
    仅样本不同（来自 compute_annual_yield_series 而非 TTM series）。
    """
    samples = _meaningful_annual_yields(annual_series)
    out: dict[str, float | None] = {}
    if len(samples) < 2:
        for p in _PERCENTILES:
            out[f"p{p}"] = None
        return out
    n = len(samples)
    for p in _PERCENTILES:
        rank = (p / 100.0) * (n - 1)
        lo = int(rank)
        hi = min(lo + 1, n - 1)
        frac = rank - lo
        out[f"p{p}"] = round(samples[lo] * (1 - frac) + samples[hi] * frac, 4)
    return out


def annual_percentile_rank(
    value: float | None, annual_series: list[list]
) -> float | None:
    """
    给定当前年化股息率 value，返回它在年化历史样本中的百分位排名（0-100）。
    与 TTM percentile_rank 同算法，只换样本。
    """
    if value is None or value <= 0:
        return None
    samples = _meaningful_annual_yields(annual_series)
    if not samples:
        return None
    pos = bisect.bisect_left(samples, value)
    return round(pos / len(samples) * 100.0, 1)


def compute_annual_rolling_bands(
    annual_series: list[list],
    *,
    window: int = _ROLLING_WINDOW_DAYS,
    min_samples: int = _ROLLING_MIN_SAMPLES,
) -> list[list]:
    """
    年化口径的滚动分位带。算法与 compute_rolling_bands 完全一致，仅样本过滤口径
    改为 _meaningful_annual_yields 的语义（剔除 pre_first 期 year is None 与 yield<=0）。
    返回与 annual_series 下标 1:1 对齐的 [[p10,p25,p50,p75,p90], ...]，
    样本不足为全 None 行。
    """
    n = len(annual_series)
    out: list[list] = []
    if n == 0:
        return out

    sorted_window: list[float] = []
    fifo: list[tuple[int, float | None]] = []
    head = 0
    null_row: list[float | None] = [None] * len(_PERCENTILES)

    for i in range(n):
        p = annual_series[i]
        # 兼容旧缓存被部分清掉的情形
        if len(p) < 5:
            ypct, year = None, None
        else:
            ypct, year = p[3], p[4]
        if year is not None and ypct is not None and ypct > 0:
            bisect.insort(sorted_window, ypct)
            fifo.append((i, ypct))
        else:
            fifo.append((i, None))

        cutoff = i - window + 1
        while head < len(fifo) and fifo[head][0] < cutoff:
            _, old_val = fifo[head]
            head += 1
            if old_val is not None:
                idx = bisect.bisect_left(sorted_window, old_val)
                if idx < len(sorted_window) and sorted_window[idx] == old_val:
                    sorted_window.pop(idx)

        if len(sorted_window) < min_samples:
            out.append(list(null_row))
        else:
            out.append(_interp_percentiles(sorted_window))

    return out


def valuation_label(rank: float | None) -> str | None:
    """
    分位 → 估值描述。高股息率（高分位）= 价格便宜。
    """
    if rank is None:
        return None
    if rank >= 90:
        return "历史性低估"
    if rank >= 75:
        return "偏低估"
    if rank >= 25:
        return "中性"
    if rank >= 10:
        return "偏高估"
    return "历史性高估"


# ---------------- 年度分红 + 预估 ----------------


def compute_annual_history(
    events: list[DividendEvent],
    *,
    expected_count: int = 0,
) -> list[dict]:
    """
    按除权年份聚合每股现金分红，返回升序列表（每年一条）。
    {year, total, yoy_pct}  yoy_pct 是相对前一年的增长百分比，可能为 None（首年）。

    会剔除"看起来还在进行中"的最新年（见 drop_incomplete_latest_year）。
    这样年度表 + 预估都不会被半年度中期分红误导。
    expected_count > 0 时透传给 drop_incomplete_latest_year 作为人工 override。
    """
    raw_by_year = annual_payment_groups(events)
    earliest_ex = (
        earliest_ex_date_in_year(events, max(raw_by_year)) if raw_by_year else None
    )
    by_year = drop_incomplete_latest_year(
        raw_by_year,
        latest_first_ex_date=earliest_ex,
        today=date.today(),
        expected_count=expected_count,
    )
    out: list[dict] = []
    prev = None
    for y in sorted(by_year):
        total = round(sum(by_year[y]), 6)
        yoy = None
        if prev is not None and prev > 0:
            yoy = round((total / prev - 1) * 100, 2)
        out.append({"year": y, "total": total, "yoy_pct": yoy})
        prev = total
    return out


def forecast_next_year(annual: list[dict]) -> dict | None:
    """
    基于近 3 / 5 年 YoY 给出明年分红预估。
    返回三档：
      conservative — 与去年持平（最保守）
      mid          — 按近 3 年平均 YoY 增长
      optimistic   — 按近 3 年中最高 YoY 增长（乐观但有先例）
    再附上方法说明，供前端展示。
    """
    if not annual:
        return None

    last_complete = annual[-1]
    last_year = last_complete["year"]
    last_total = last_complete["total"]

    # YoY 序列（剔除 None）
    yoys = [a["yoy_pct"] for a in annual if a["yoy_pct"] is not None]
    yoy_3y = yoys[-3:] if len(yoys) >= 1 else []
    yoy_5y = yoys[-5:] if len(yoys) >= 1 else []

    avg_3 = round(statistics.mean(yoy_3y), 2) if yoy_3y else None
    avg_5 = round(statistics.mean(yoy_5y), 2) if yoy_5y else None

    conservative = round(last_total, 4)
    mid = (
        round(last_total * (1 + avg_3 / 100.0), 4) if avg_3 is not None else conservative
    )
    optimistic = (
        round(last_total * (1 + max(yoy_3y) / 100.0), 4)
        if yoy_3y
        else conservative
    )

    # 置信度：连续年都有派现的年数越多越可信
    consecutive = 0
    for a in reversed(annual):
        if a["total"] > 0:
            consecutive += 1
        else:
            break
    if consecutive >= 5:
        confidence = "high"
    elif consecutive >= 3:
        confidence = "medium"
    else:
        confidence = "low"

    return {
        "next_year": last_year + 1,
        "based_on_year": last_year,
        "based_on_total": round(last_total, 4),
        "conservative": conservative,
        "mid": mid,
        "optimistic": optimistic,
        "avg_yoy_3y": avg_3,
        "avg_yoy_5y": avg_5,
        "confidence": confidence,
        "method": (
            "保守=去年持平；中位=去年×(1+近3年平均YoY)；"
            "乐观=去年×(1+近3年最大YoY)"
        ),
    }
