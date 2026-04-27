from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import TYPE_CHECKING

from app.config import AppConfig
from app.models import YieldRow
from app.services.dividend_service import DividendService
from app.services.price_service import PriceService
from app.services.yield_calculator import calc_yield_pct

if TYPE_CHECKING:
    from app.services.history_service import HistoryService

_MAX_WORKERS = 8


class WatcherService:
    """组合 price + dividend，输出 watchlist 的 YieldRow 列表。"""

    def __init__(
        self,
        config: AppConfig,
        price_service: PriceService,
        dividend_service: DividendService,
        history_service: "HistoryService | None" = None,
    ) -> None:
        self.config = config
        self.price_service = price_service
        self.dividend_service = dividend_service
        # 可选：用于在主表填 P 分位 + 估值标签（仅读静态缓存，不触发冷启动）
        self.history_service = history_service

    def snapshot(self) -> list[YieldRow]:
        quotes = self.price_service.get_quotes(self.config.stocks)
        # 并发拉分红：首次冷启动从 N×0.5s 降到 ~0.5s；缓存命中后无副作用。
        stocks = self.config.stocks
        if len(stocks) > 1:
            with ThreadPoolExecutor(max_workers=min(_MAX_WORKERS, len(stocks))) as ex:
                annuals_list = list(ex.map(self.dividend_service.get_latest_annual, stocks))
        else:
            annuals_list = [self.dividend_service.get_latest_annual(s) for s in stocks]
        annuals = dict(zip([s.symbol for s in stocks], annuals_list))

        # P 分位 + 估值标签：仅读静态缓存，未就绪时为 None。
        # live_price 直接复用上面 quotes dict 里的价，避免 percentile_only 内部再发起
        # 1-only 的 get_quotes 调用污染 PriceService 5s 共享缓存（详见 price_service.py）。
        percentiles: dict[str, dict | None] = {}
        if self.history_service is not None:
            for stock in stocks:
                quote = quotes.get(stock.symbol)
                lp = quote.price if quote is not None and quote.price > 0 else None
                percentiles[stock.symbol] = self.history_service.get_percentile_only(
                    stock, live_price=lp
                )

        now = datetime.now()
        rows: list[YieldRow] = []
        for stock in stocks:
            quote = quotes.get(stock.symbol)
            annual = annuals.get(stock.symbol)

            price = quote.price if quote else None
            dividend = annual.cash_per_share if annual else None
            year = annual.year if annual else None

            yield_pct: float | None = None
            error: str | None = None
            if price is None and dividend is None:
                error = "行情与分红均无法获取"
            elif price is None:
                error = "行情不可用"
            elif dividend is None:
                error = "无分红记录"
            else:
                yield_pct = round(calc_yield_pct(dividend, price), 4)

            pct_info = percentiles.get(stock.symbol)
            position_value = (
                round(stock.shares * price, 2) if stock.shares > 0 and price is not None else None
            )
            annual_cash = (
                round(stock.shares * dividend, 2)
                if stock.shares > 0 and dividend is not None
                else None
            )
            rows.append(
                YieldRow(
                    symbol=stock.symbol,
                    name=stock.name,
                    price=price,
                    dividend=dividend,
                    dividend_year=year,
                    yield_pct=yield_pct,
                    updated_at=now,
                    error=error,
                    percentile_rank=pct_info["percentile_rank"] if pct_info else None,
                    valuation=pct_info["valuation"] if pct_info else None,
                    annual_percentile_rank=(
                        pct_info.get("annual_percentile_rank") if pct_info else None
                    ),
                    annual_valuation=(
                        pct_info.get("annual_valuation") if pct_info else None
                    ),
                    yield_ttm_pct=pct_info.get("yield_ttm_pct") if pct_info else None,
                    price_ts=quote.ts if quote else None,
                    shares=stock.shares,
                    position_value=position_value,
                    annual_cash=annual_cash,
                )
            )
        return rows

    def portfolio_summary(self, rows: list[YieldRow]) -> dict | None:
        """聚合 rows 中带持仓的行：总市值 / 年化分红 / 加权股息率。

        无任何持仓时返回 None；前端用此判断是否显示持仓摘要。
        """
        positioned = [r for r in rows if r.shares > 0]
        if not positioned:
            return None
        total_value = round(sum(r.position_value or 0 for r in positioned), 2)
        total_cash = round(sum(r.annual_cash or 0 for r in positioned), 2)
        weighted_yield = (
            round(total_cash / total_value * 100, 2) if total_value > 0 else None
        )
        return {
            "total_value": total_value,
            "annual_cash": total_cash,
            "weighted_yield_pct": weighted_yield,
            "stock_count": len(positioned),
        }
