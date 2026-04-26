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

    Stale-on-failure：每只股票最近一次成功获取的 Quote 会被保留下来，
    当 sina 整批请求失败、或单只股票从批量响应里漏掉时，回退到上一次的 Quote
    （Quote.ts 仍是当时获取的真实时间，前端据此决定是否打"⏱"水印）。
    冷启动从未成功过的股票，仍会在结果里缺席，由 watcher 报"行情不可用"。
    """

    def __init__(self, source: PriceSource, ttl_seconds: float = _PRICE_TTL_SECONDS) -> None:
        self.source = source
        self.cache: MemoryTTLCache = MemoryTTLCache(ttl_seconds)
        # 每个 symbol 最近一次成功获取的 quote。整批失败/单只缺失时回填。
        self._last_good: dict[str, Quote] = {}

    def get_quotes(self, stocks: list[Stock]) -> dict[str, Quote]:
        cached = self.cache.get(_BATCH_KEY)
        if cached is not None:
            return cached
        try:
            fresh = self.source.get_quotes(stocks)
        except Exception as e:
            logger.warning("行情拉取失败: %s（回退到上次成功值）", e)
            fresh = {}

        # 更新成功 symbol 的 last_good
        for sym, q in fresh.items():
            self._last_good[sym] = q

        # 用 last_good 兜底缺失/失败的 symbol；首次冷启动且失败的 symbol 仍缺席
        merged: dict[str, Quote] = dict(fresh)
        for s in stocks:
            if s.symbol not in merged and s.symbol in self._last_good:
                merged[s.symbol] = self._last_good[s.symbol]

        self.cache.set(_BATCH_KEY, merged)
        return merged
