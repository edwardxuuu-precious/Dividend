from __future__ import annotations

import logging
import statistics
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime

from app.cache import FileCache
from app.data_sources.base import DividendSource
from app.models import AnnualDividend, DividendEvent, Stock

logger = logging.getLogger(__name__)

_DIVIDEND_TTL_SECONDS = 24 * 3600

# 当年累计 < prior 中位金额 × 此比例时进入"金额成色"判据候选。
# 0.7 = 比往年腰斩程度更宽容，避免业绩小幅下滑误剔。
_INCOMPLETE_AMOUNT_RATIO = 0.7
# 金额成色判据只在最早除权日距今 < 此天数时生效。
# 270 ≈ 9 个月：年内还有时间补足；超过则当年已基本走完，按现状保留。
_INCOMPLETE_RECENCY_DAYS = 270

# "含特别股利/异常高"判定：当年合计 ÷ 近 N 年中位数 ≥ 此比例时给前端打 unusually_high。
# 1.5 = 比近年高 50% 才标，避免把业绩自然增长误标。
_UNUSUALLY_HIGH_RATIO = 1.5
# 异常判定的参照窗口：只看最近 N 个完整年（含 in-progress 年也排除）。
# 5 = 给"成长股"留余地（避免被远古小额拉低中位数误标），同时足够稳健
# 抵抗单年波动；与 drop_incomplete_latest_year 的 prior 3 不一致是有意的：
# 完整性判据要敏感，异常判据要稳健。
_UNUSUAL_HIGH_LOOKBACK_YEARS = 5


@dataclass(frozen=True)
class AnnualAnalysis:
    """latest_annual 加上"是否异常偏高"的判定，供前端展示提示标签。"""
    annual: AnnualDividend | None
    unusually_high: bool
    historical_median: float | None  # 历史完整年合计中位数（不含本年）；不足 3 年时为 None


class DividendService:
    """
    取"最近一个完整年度"的每股分红。

    定义：按除权除息日所在年份聚合每股现金分红，取最近一个有过派现的年份。
    （A 股年度分红实施时间通常滞后财报年度数月，"最新有派现的年份"就是市场常说的
    "最近一个完整年度的分红"。）
    """

    def __init__(self, source: DividendSource, cache: FileCache | None = None) -> None:
        self.source = source
        self.cache = cache or FileCache("dividend_cache", _DIVIDEND_TTL_SECONDS)

    def get_events(self, stock: Stock) -> list[DividendEvent]:
        """获取该股票全部历史分红事件（带缓存）。"""
        cached = self.cache.get(stock.symbol)
        if cached is not None:
            return _decode_events(cached)
        try:
            events = self.source.get_dividend_history(stock)
            if events:  # 只缓存非空结果，避免数据源临时失败把空列表锁 24h
                self.cache.set(stock.symbol, _encode_events(events))
            return events
        except Exception as e:
            logger.warning("分红拉取失败 %s: %s", stock.symbol, e)
            stale = self.cache.get_stale(stock.symbol)
            return _decode_events(stale) if stale else []

    def get_latest_annual(self, stock: Stock) -> AnnualDividend | None:
        return latest_annual_from_events(
            self.get_events(stock),
            expected_count=stock.expected_payments_per_year,
        )

    def analyze_latest_annual(self, stock: Stock) -> AnnualAnalysis:
        """同 get_latest_annual，但额外返回"年度合计是否异常偏高"标志。"""
        return analyze_latest_annual(
            self.get_events(stock),
            expected_count=stock.expected_payments_per_year,
        )


def annual_payment_groups(events: list[DividendEvent]) -> dict[int, list[float]]:
    """按 ex_date 自然年聚合每股派息列表（保留逐次金额，便于判断完整性）。"""
    by_year: dict[int, list[float]] = defaultdict(list)
    for ev in events:
        try:
            year = datetime.strptime(ev.ex_date, "%Y-%m-%d").year
        except ValueError:
            continue
        by_year[year].append(ev.cash_per_share)
    return by_year


def drop_incomplete_latest_year(
    by_year: dict[int, list[float]],
    *,
    latest_first_ex_date: date | None = None,
    today: date | None = None,
    expected_count: int = 0,
) -> dict[int, list[float]]:
    """剔除"看起来还在进行中"的最新年。三条独立判据，命中任一即剔除。

    A. 派息次数法：最新年的派息次数 < **前 3 年中任一年的最大派息次数**。
       捕捉模式变化：例如长电 2025 起从 1 次/年 改为 2 次/年，2026 至今
       只 1 次（中期），仍能被识别为不完整。

    B. 金额成色法（需传 latest_first_ex_date + today）：最新年累计金额
       < 前 3 年金额中位数 × _INCOMPLETE_AMOUNT_RATIO，且最新年最早除权日
       距 today < _INCOMPLETE_RECENCY_DAYS。捕捉招行这类"派息次数仍是 1 次/年
       但 2025 财年中报除权日跨到 2026-01-16"的情况：单看次数判据无效
       （prior 全是 1，max=1，latest=1 不 <），但金额上 ¥1.013 ≪ ¥1.97 中位
       且时间窗刚开始，应判 in-progress。距今 ≥ 9 个月仍达不到中位 70% 时
       不再剔除：业绩可能真下滑了，让用户看到当年实际状况好过永远剔除。

    C. 人工 override（expected_count > 0）：当 watchlist 给该股票配了
       expected_payments_per_year 时，直接用该值替代历史 max 推断。
       用于 A/B 都漏判的边界情况，或股票节奏新立无足够历史样本时（< 3 年）
       仍想强制识别 in-progress。

    历史不足 3 年时只跑 C（如有 override）；A/B 不参与判断（避免误伤新股）。

    latest_first_ex_date / today 二者皆为 None 时跳过 B；expected_count = 0 时跳过 C。
    """
    if not by_year:
        return dict(by_year)
    years_desc = sorted(by_year.keys(), reverse=True)
    latest = years_desc[0]
    latest_count = len(by_year[latest])

    # C. expected override 优先，因为它是"用户/运维明确指定"的最强信号。
    if expected_count > 0 and latest_count < expected_count:
        return {y: v for y, v in by_year.items() if y != latest}

    if len(by_year) < 3:
        return dict(by_year)

    prior_years = years_desc[1:4]
    prior_counts = [len(by_year[y]) for y in prior_years]
    if prior_counts and latest_count < max(prior_counts):
        return {y: v for y, v in by_year.items() if y != latest}

    if latest_first_ex_date is not None and today is not None:
        prior_sums = [sum(by_year[y]) for y in prior_years]
        if prior_sums:
            median_prior = statistics.median(prior_sums)
            latest_sum = sum(by_year[latest])
            if (
                median_prior > 0
                and latest_sum < median_prior * _INCOMPLETE_AMOUNT_RATIO
                and (today - latest_first_ex_date).days < _INCOMPLETE_RECENCY_DAYS
            ):
                return {y: v for y, v in by_year.items() if y != latest}

    return dict(by_year)


def earliest_ex_date_in_year(events: list[DividendEvent], year: int) -> date | None:
    earliest: date | None = None
    for ev in events:
        try:
            d = datetime.strptime(ev.ex_date, "%Y-%m-%d").date()
        except ValueError:
            continue
        if d.year != year:
            continue
        if earliest is None or d < earliest:
            earliest = d
    return earliest


def latest_annual_from_events(
    events: list[DividendEvent],
    *,
    today: date | None = None,
    expected_count: int = 0,
) -> AnnualDividend | None:
    if not events:
        return None
    by_year = annual_payment_groups(events)
    if not by_year:
        return None
    earliest_ex = earliest_ex_date_in_year(events, max(by_year))
    by_year = drop_incomplete_latest_year(
        by_year,
        latest_first_ex_date=earliest_ex,
        today=today or date.today(),
        expected_count=expected_count,
    )
    if not by_year:
        return None
    latest_year = max(by_year)
    total = sum(by_year[latest_year])
    return AnnualDividend(year=latest_year, cash_per_share=round(total, 6))


def analyze_latest_annual(
    events: list[DividendEvent],
    *,
    today: date | None = None,
    expected_count: int = 0,
) -> AnnualAnalysis:
    """同 latest_annual_from_events，但补一个"年度合计是否异常偏高"标志。

    判定：选 annual.year 之前最近 _UNUSUAL_HIGH_LOOKBACK_YEARS 个完整年的合计中位数，
    若本年合计 ≥ 该中位数 × 1.5 则 unusually_high = True。
    用于五粮液 2025 这类"在年度分红外加发特别股利"导致单年合计明显抬升的情形，
    前端据此把"年化"标签改成警告样式。

    用近年（而非全历史）做参照，避免成长股被 1999/2000 年代的小额股利拉低中位数
    导致正常增长也被误标 high。"严格 < annual.year"也自动排除被 drop 掉的
    in-progress 年（如招行 2026）混入参照集。
    """
    annual = latest_annual_from_events(events, today=today, expected_count=expected_count)
    if annual is None:
        return AnnualAnalysis(annual=None, unusually_high=False, historical_median=None)
    by_year = annual_payment_groups(events)
    prior_year_sums = {y: round(sum(v), 6) for y, v in by_year.items() if y < annual.year}
    if len(prior_year_sums) < 3:
        return AnnualAnalysis(annual=annual, unusually_high=False, historical_median=None)
    recent_years = sorted(prior_year_sums.keys(), reverse=True)[:_UNUSUAL_HIGH_LOOKBACK_YEARS]
    recent_sums = [prior_year_sums[y] for y in recent_years]
    median_prior = statistics.median(recent_sums)
    unusually_high = (
        median_prior > 0 and annual.cash_per_share >= median_prior * _UNUSUALLY_HIGH_RATIO
    )
    return AnnualAnalysis(
        annual=annual,
        unusually_high=unusually_high,
        historical_median=round(median_prior, 6),
    )


def _encode_events(events: list[DividendEvent]) -> list[dict]:
    return [{"ex_date": e.ex_date, "cash_per_share": e.cash_per_share} for e in events]


def _decode_events(raw: list[dict]) -> list[DividendEvent]:
    return [DividendEvent(ex_date=r["ex_date"], cash_per_share=r["cash_per_share"]) for r in raw]
