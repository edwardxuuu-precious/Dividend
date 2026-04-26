from __future__ import annotations

import logging

from app.cache import MemoryTTLCache
from app.data_sources.base import PriceSource
from app.models import Quote, Stock

logger = logging.getLogger(__name__)

_PRICE_TTL_SECONDS = 5.0
_BATCH_KEY = "__batch__"


class PriceService:
    """
    批量取行情，5 秒内重复请求复用同一份快照。
    """

    def __init__(self, source: PriceSource, ttl_seconds: float = _PRICE_TTL_SECONDS) -> None:
        self.source = source
        self.cache: MemoryTTLCache = MemoryTTLCache(ttl_seconds)

    def get_quotes(self, stocks: list[Stock]) -> dict[str, Quote]:
        cached = self.cache.get(_BATCH_KEY)
        if cached is not None:
            return cached
        try:
            quotes = self.source.get_quotes(stocks)
        except Exception as e:
            logger.warning("行情拉取失败: %s", e)
            return {}
        self.cache.set(_BATCH_KEY, quotes)
        return quotes
