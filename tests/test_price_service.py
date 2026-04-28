"""PriceService 兜底（stale-on-failure）行为测试。

核心保证：
  - 整批请求异常时，回退到上次成功的 quote（保留原 ts，前端据此判断陈旧）
  - 单只 symbol 从批量响应里漏掉时，回退到该 symbol 的上次成功值
  - 冷启动从未成功过的 symbol 仍会缺席（watcher 走"行情不可用"路径）
  - 5s 内重复请求复用同一份 merged 快照（不重复打数据源）
"""
from datetime import datetime, timedelta
from unittest.mock import MagicMock

from app.models import Quote, Stock
from app.services.price_service import PriceService


def _stock(symbol: str = "600519") -> Stock:
    return Stock(symbol=symbol, name="X", exchange="SH")


def _quote(symbol: str, price: float, ts: datetime | None = None) -> Quote:
    return Quote(symbol=symbol, price=price, ts=ts or datetime.now())


def test_first_call_returns_fresh_quotes():
    src = MagicMock()
    s1, s2 = _stock("600519"), _stock("000858")
    src.get_quotes.return_value = {
        "600519": _quote("600519", 1500.0),
        "000858": _quote("000858", 100.0),
    }
    ps = PriceService(src, ttl_seconds=-1)  # TTL=0 让每次都打 source
    out = ps.get_quotes([s1, s2])
    assert out["600519"].price == 1500.0
    assert out["000858"].price == 100.0


def test_batch_failure_falls_back_to_last_good():
    """sina 整批挂掉 → 回退到上次成功的 quote，保留原 ts。"""
    src = MagicMock()
    s1, s2 = _stock("600519"), _stock("000858")

    t0 = datetime(2026, 4, 26, 10, 0, 0)
    src.get_quotes.return_value = {
        "600519": _quote("600519", 1500.0, ts=t0),
        "000858": _quote("000858", 100.0, ts=t0),
    }
    ps = PriceService(src, ttl_seconds=-1)
    first = ps.get_quotes([s1, s2])
    assert first["600519"].ts == t0

    # 第二次：sina 抛异常
    src.get_quotes.side_effect = RuntimeError("network down")
    second = ps.get_quotes([s1, s2])

    # 仍能拿到两只，且 ts 还是上次成功的时刻（前端据此判断陈旧）
    assert second["600519"].price == 1500.0
    assert second["600519"].ts == t0
    assert second["000858"].price == 100.0
    assert second["000858"].ts == t0


def test_partial_response_falls_back_per_symbol():
    """新浪只返了 1 只 → 漏掉的那只用上次成功值兜底。"""
    src = MagicMock()
    s1, s2 = _stock("600519"), _stock("000858")

    t0 = datetime(2026, 4, 26, 10, 0, 0)
    src.get_quotes.return_value = {
        "600519": _quote("600519", 1500.0, ts=t0),
        "000858": _quote("000858", 100.0, ts=t0),
    }
    ps = PriceService(src, ttl_seconds=-1)
    ps.get_quotes([s1, s2])  # 建立 last_good

    # 第二次：000858 漏掉
    t1 = datetime(2026, 4, 26, 10, 0, 12)
    src.get_quotes.side_effect = None
    src.get_quotes.return_value = {
        "600519": _quote("600519", 1510.0, ts=t1),
    }
    out = ps.get_quotes([s1, s2])
    # 600519 是新值
    assert out["600519"].price == 1510.0
    assert out["600519"].ts == t1
    # 000858 是上次值（陈旧）
    assert out["000858"].price == 100.0
    assert out["000858"].ts == t0


def test_cold_start_failure_leaves_symbol_missing():
    """从未成功过的 symbol 在首次失败时仍缺席（watcher 报'行情不可用'）。"""
    src = MagicMock()
    src.get_quotes.side_effect = RuntimeError("network down")
    ps = PriceService(src, ttl_seconds=-1)
    out = ps.get_quotes([_stock("600519"), _stock("000858")])
    # 没建过 last_good，全部缺席
    assert out == {}


def test_ttl_caches_merged_snapshot():
    """TTL 内重复调用复用同一份 merged 快照，不重复打 source。"""
    src = MagicMock()
    s1 = _stock("600519")
    src.get_quotes.return_value = {"600519": _quote("600519", 1500.0)}
    ps = PriceService(src, ttl_seconds=60.0)
    ps.get_quotes([s1])
    ps.get_quotes([s1])
    ps.get_quotes([s1])
    assert src.get_quotes.call_count == 1


def test_full_failure_does_not_cache_so_next_call_retries_source():
    """整批失败时不能缓存兜底结果，否则会把一次新浪抖动放大成 TTL 长度的全列陈旧。"""
    src = MagicMock()
    s1 = _stock("600519")
    t0 = datetime(2026, 4, 26, 10, 0, 0)
    src.get_quotes.return_value = {"600519": _quote("600519", 1500.0, ts=t0)}
    ps = PriceService(src, ttl_seconds=60.0)
    ps.get_quotes([s1])  # 第 1 次：成功，缓存 60s

    # 第 2 次：在 TTL 内但 source 抛异常 —— 关键场景。
    # 注意：成功结果仍在缓存里，要先把它清掉以模拟"缓存过期 + 当下失败"
    ps.cache.clear()
    src.get_quotes.side_effect = RuntimeError("network down")
    ps.get_quotes([s1])  # 第 2 次：失败，必须不缓存

    # 第 3 次：source 仍异常。如果上一次缓存了兜底结果，这里 source 不会被调用。
    ps.get_quotes([s1])
    # 期望 source 被打了 3 次（成功 1 + 失败 2），而不是 2 次
    assert src.get_quotes.call_count == 3


def test_recovery_after_failure_updates_last_good():
    """失败 → 兜底 → 恢复后 last_good 应更新到最新成功值。"""
    src = MagicMock()
    s1 = _stock("600519")
    t0 = datetime(2026, 4, 26, 10, 0, 0)
    src.get_quotes.return_value = {"600519": _quote("600519", 1500.0, ts=t0)}
    ps = PriceService(src, ttl_seconds=-1)
    ps.get_quotes([s1])

    # 失败回合
    src.get_quotes.side_effect = RuntimeError("flaky")
    ps.get_quotes([s1])

    # 恢复回合：source 又能用了
    t2 = datetime(2026, 4, 26, 10, 0, 24)
    src.get_quotes.side_effect = None
    src.get_quotes.return_value = {"600519": _quote("600519", 1520.0, ts=t2)}
    out = ps.get_quotes([s1])
    assert out["600519"].price == 1520.0
    assert out["600519"].ts == t2

    # 再失败一次：兜底到 t2 的值，不是 t0
    src.get_quotes.side_effect = RuntimeError("flaky again")
    out = ps.get_quotes([s1])
    assert out["600519"].price == 1520.0
    assert out["600519"].ts == t2
