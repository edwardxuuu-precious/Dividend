from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime

from app.cache import FileCache
from app.data_sources.base import DividendSource
from app.models import AnnualDividend, DividendEvent, Stock

logger = logging.getLogger(__name__)

_DIVIDEND_TTL_SECONDS = 24 * 3600


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
        return latest_annual_from_events(self.get_events(stock))


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


def drop_incomplete_latest_year(by_year: dict[int, list[float]]) -> dict[int, list[float]]:
    """剔除"看起来还在进行中"的最新年。

    判断方法：最新年的派息次数 < **前 3 年中任一年的最大派息次数** → 视为不完整。
    用 max（而非众数）能捕捉模式变化：例如长电 2025 起从 1 次/年 改为 2 次/年，
    2026 至今只 1 次（中期），仍能被识别为不完整。

    招行这类"每年只 1 次年度分红"的股票不受影响：
    所有年份的次数都是 1，max=1，latest=1 不会被剔除。

    历史不足 3 年时不做判断（避免误伤新股或刚改派息节奏的）。
    """
    if len(by_year) < 3:
        return dict(by_year)
    years_desc = sorted(by_year.keys(), reverse=True)
    latest = years_desc[0]
    latest_count = len(by_year[latest])
    prior_counts = [len(by_year[y]) for y in years_desc[1:4]]
    if prior_counts and latest_count < max(prior_counts):
        return {y: v for y, v in by_year.items() if y != latest}
    return dict(by_year)


def latest_annual_from_events(events: list[DividendEvent]) -> AnnualDividend | None:
    if not events:
        return None
    by_year = drop_incomplete_latest_year(annual_payment_groups(events))
    if not by_year:
        return None
    latest_year = max(by_year)
    total = sum(by_year[latest_year])
    return AnnualDividend(year=latest_year, cash_per_share=round(total, 6))


def _encode_events(events: list[DividendEvent]) -> list[dict]:
    return [{"ex_date": e.ex_date, "cash_per_share": e.cash_per_share} for e in events]


def _decode_events(raw: list[dict]) -> list[DividendEvent]:
    return [DividendEvent(ex_date=r["ex_date"], cash_per_share=r["cash_per_share"]) for r in raw]
