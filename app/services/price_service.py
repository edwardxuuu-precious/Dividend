from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from app.cache import MemoryTTLCache
from app.data_sources.base import PriceSource
from app.models import Quote, Stock

if TYPE_CHECKING:
    from app.config import AppConfig

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

    全集兜底（watchlist）：缓存键固定 _BATCH_KEY，与传入 stocks 列表无关。
    历史教训：早期实现中如果调用方只传 1 只 stock 进来（如 /current 端点 →
    history_service.get_live_current → get_quotes([stock])），缓存会被覆盖成 1-only
    dict，5 秒内 watcher 主表 tick 命中坏 cache 拿到 6/7 个 None。盘中实测 26.7%
    探测出现 1/7 现象。修复：构造时注入 watchlist，单只调用一律扩展为全集去取。
    """

    def __init__(
        self,
        source: PriceSource,
        ttl_seconds: float = _PRICE_TTL_SECONDS,
        watchlist: list[Stock] | None = None,
        config: "AppConfig | None" = None,
    ) -> None:
        self.source = source
        self.cache: MemoryTTLCache = MemoryTTLCache(ttl_seconds)
        # 每个 symbol 最近一次成功获取的 quote。整批失败/单只缺失时回填。
        self._last_good: dict[str, Quote] = {}
        # 运行时优先读 config.stocks（前端编辑 watchlist 时立即可见）；
        # 测试 / 老调用走 watchlist 静态拷贝。
        self._config = config
        self._static_watchlist: list[Stock] = list(watchlist) if watchlist else []

    @property
    def _watchlist(self) -> list[Stock]:
        """完整 watchlist；用于把任意子集调用扩展到全集，避免缓存被 1-only 污染。"""
        if self._config is not None:
            return self._config.stocks
        return self._static_watchlist

    def get_quotes(self, stocks: list[Stock]) -> dict[str, Quote]:
        cached = self.cache.get(_BATCH_KEY)
        if cached is not None:
            return cached

        # 任何调用都按 watchlist 全集去 source 拉行情，避免单只调用污染缓存。
        # 调用方传子集时也只额外多拉几只，5s 缓存内复用，开销可忽略。
        fetch_stocks = self._watchlist if self._watchlist else stocks
        try:
            fresh = self.source.get_quotes(fetch_stocks)
        except Exception as e:
            logger.warning("行情拉取失败: %s（回退到上次成功值）", e)
            fresh = {}

        # 更新成功 symbol 的 last_good
        for sym, q in fresh.items():
            self._last_good[sym] = q

        # 用 last_good 兜底缺失/失败的 symbol；首次冷启动且失败的 symbol 仍缺席
        merged: dict[str, Quote] = dict(fresh)
        for s in fetch_stocks:
            if s.symbol not in merged and s.symbol in self._last_good:
                merged[s.symbol] = self._last_good[s.symbol]

        self.cache.set(_BATCH_KEY, merged)
        return merged
