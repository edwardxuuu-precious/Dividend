from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class Stock:
    symbol: str
    name: str
    exchange: str


@dataclass(frozen=True)
class DividendEvent:
    """单次分红事件（来自交易所明细记录）。"""
    ex_date: str            # 除权除息日 YYYY-MM-DD
    cash_per_share: float   # 每股税前现金分红（元）


@dataclass(frozen=True)
class AnnualDividend:
    """某一年度合并后的每股分红。"""
    year: int
    cash_per_share: float


@dataclass(frozen=True)
class Quote:
    symbol: str
    price: float
    ts: datetime


@dataclass(frozen=True)
class DailyBar:
    """单个交易日的不复权收盘信息。"""
    date: str    # YYYY-MM-DD
    close: float


@dataclass(frozen=True)
class YieldRow:
    symbol: str
    name: str
    price: float | None
    dividend: float | None
    dividend_year: int | None
    yield_pct: float | None
    updated_at: datetime
    error: str | None = None
    # 历史分位排名（0-100），仅当 history_service 静态缓存已就绪时有值。
    # rank 越高 = 当前股息率在历史上越偏高 = 价格越便宜。
    percentile_rank: float | None = None
    valuation: str | None = None
