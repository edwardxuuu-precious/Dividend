from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class Stock:
    symbol: str
    name: str
    exchange: str
    shares: int = 0   # 持仓数量（股）；0 表示未持仓，仅观察用
    # 预期每年派息次数。> 0 时覆盖 drop_incomplete_latest_year 的"历史 max 推断"，
    # 用于股票刚改派息节奏（如招行 2025 起从年报 1 次改为年报+中期 2 次）的过渡年。
    # 0 表示不指定，仍用历史最大次数推断。
    expected_payments_per_year: int = 0


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
    # 年化股息率（最近完整派息年累计 ÷ 实时价）—— 主排序键，与卡片大字一致
    yield_pct: float | None
    updated_at: datetime
    error: str | None = None
    # 历史分位排名（0-100），基于 TTM 口径。
    # rank 越高 = 当前 TTM 股息率在历史上越偏高 = 价格越便宜。
    percentile_rank: float | None = None
    valuation: str | None = None
    # 历史分位排名 + 估值标签，基于"年化"口径（与卡片大字 yield_pct 同口径）。
    # 与 TTM 的 percentile_rank 并列存在，让两套大字下方各挂自己的徽章。
    annual_percentile_rank: float | None = None
    annual_valuation: str | None = None
    # TTM 股息率（过去 365 天滚动窗口实际除权 ÷ 实时价）—— 与详情/图表一致
    yield_ttm_pct: float | None = None
    # True 表示派息年合计 > 历史中位数 × 1.5（含特别股利或节奏过渡），
    # 卡片上的"年化"标签会变橙提示用户这不是常态化数字。
    annual_unusually_high: bool = False
    # price 的真实获取时间。stale-on-failure 时仍是上次成功的时刻；
    # 前端据此判断价格是否陈旧（updated_at - price_ts > 1.5 × refresh）。
    price_ts: datetime | None = None
    # 持仓相关：仅当 watchlist 配了 shares > 0 时填充
    shares: int = 0
    position_value: float | None = None   # shares × price
    annual_cash: float | None = None      # shares × 最近年度每股分红
