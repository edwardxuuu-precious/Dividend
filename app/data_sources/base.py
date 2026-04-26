from __future__ import annotations

from abc import ABC, abstractmethod

from app.models import DailyBar, DividendEvent, Quote, Stock


class PriceSource(ABC):
    @abstractmethod
    def get_quotes(self, stocks: list[Stock]) -> dict[str, Quote]:
        """批量获取多只股票的最新行情；key 为 symbol。"""


class DividendSource(ABC):
    @abstractmethod
    def get_dividend_history(self, stock: Stock) -> list[DividendEvent]:
        """获取单只股票的全部历史现金分红记录。"""


class HistoricalPriceSource(ABC):
    @abstractmethod
    def get_daily_bars(
        self, stock: Stock, start_date: str | None = None
    ) -> list[DailyBar]:
        """获取历史日 K 线（不复权收盘价）。

        start_date: YYYY-MM-DD，仅返回 >= 此日期的 bar；None 表示全量。
        用于增量更新缓存：只补差量而非每天全量重抓。
        """
