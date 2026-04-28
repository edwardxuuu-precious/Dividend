"""watchlist 编辑 API 的轻量集成测试。

不依赖 fastapi.testclient（避免引入 httpx 测试依赖），直接验证:
  - main.py 里的常量与正则约束
  - _validate_new_stock 在不同 source 行为下的判定
  - _cleanup_caches_for 真的清掉 4 处缓存条目

端点本身的 HTTP 包装层（参数提取、HTTPException 抛出）属于 fastapi 框架行为，
靠 e2e 手工验证 + curl 即可。
"""
from datetime import datetime
from unittest.mock import MagicMock

import pytest

from app.cache import FileCache, MemoryTTLCache
from app.models import Quote, Stock


# ---------- 校验约束 ----------


def test_symbol_regex_accepts_6_digits():
    from app.main import _SYMBOL_RE

    assert _SYMBOL_RE.match("600519")
    assert _SYMBOL_RE.match("000858")


def test_symbol_regex_rejects_invalid():
    from app.main import _SYMBOL_RE

    assert not _SYMBOL_RE.match("60519")        # 5 位
    assert not _SYMBOL_RE.match("6005199")      # 7 位
    assert not _SYMBOL_RE.match("60051a")       # 含字母
    assert not _SYMBOL_RE.match("")             # 空


def test_valid_exchanges_only_sh_sz():
    from app.main import _VALID_EXCHANGES

    assert _VALID_EXCHANGES == {"SH", "SZ"}


# ---------- _validate_new_stock ----------


def _patch_source(monkeypatch, get_quotes_ret=None, get_dividend_history_ret=None,
                  get_quotes_exc=None, get_dividend_exc=None):
    from app import main as main_mod

    fake = MagicMock()
    if get_quotes_exc is not None:
        fake.get_quotes.side_effect = get_quotes_exc
    else:
        fake.get_quotes.return_value = get_quotes_ret or {}
    if get_dividend_exc is not None:
        fake.get_dividend_history.side_effect = get_dividend_exc
    else:
        fake.get_dividend_history.return_value = get_dividend_history_ret or []
    monkeypatch.setattr(main_mod, "_source", fake)
    return fake


def _stock(symbol="002415"):
    return Stock(symbol=symbol, name="X", exchange="SZ")


def test_validate_passes_with_quote_and_dividend(monkeypatch):
    from app.main import _validate_new_stock
    from app.models import DividendEvent

    s = _stock()
    _patch_source(
        monkeypatch,
        get_quotes_ret={"002415": Quote(symbol="002415", price=33.5, ts=datetime.now())},
        get_dividend_history_ret=[DividendEvent(ex_date="2024-06-01", cash_per_share=0.5)],
    )
    ok, reason = _validate_new_stock(s)
    assert ok is True
    assert reason == ""


def test_validate_fails_when_no_quote(monkeypatch):
    from app.main import _validate_new_stock

    _patch_source(monkeypatch, get_quotes_ret={})
    ok, reason = _validate_new_stock(_stock())
    assert ok is False
    assert "价格" in reason


def test_validate_fails_when_quote_zero_price(monkeypatch):
    from app.main import _validate_new_stock

    _patch_source(
        monkeypatch,
        get_quotes_ret={"002415": Quote(symbol="002415", price=0, ts=datetime.now())},
    )
    ok, reason = _validate_new_stock(_stock())
    assert ok is False


def test_validate_fails_when_no_dividend_history(monkeypatch):
    from app.main import _validate_new_stock

    _patch_source(
        monkeypatch,
        get_quotes_ret={"002415": Quote(symbol="002415", price=33.5, ts=datetime.now())},
        get_dividend_history_ret=[],
    )
    ok, reason = _validate_new_stock(_stock())
    assert ok is False
    assert "分红" in reason


def test_validate_fails_when_quote_source_throws(monkeypatch):
    from app.main import _validate_new_stock

    _patch_source(monkeypatch, get_quotes_exc=RuntimeError("network down"))
    ok, reason = _validate_new_stock(_stock())
    assert ok is False
    assert "行情拉取异常" in reason


# ---------- _cleanup_caches_for ----------


def test_cleanup_clears_four_caches(monkeypatch, tmp_path):
    """_cleanup_caches_for 应当清掉 bars / static / dividend 三处文件缓存
    + price_service._last_good 内存条目。"""
    from app import main as main_mod

    bars = FileCache("bars_test", 60, cache_dir=tmp_path)
    static = FileCache("static_test", 60, cache_dir=tmp_path)
    div = FileCache("div_test", 60, cache_dir=tmp_path)

    bars.set("600519", {"x": 1})
    static.set("600519", {"y": 2})
    div.set("600519", [{"z": 3}])

    last_good = {"600519": Quote(symbol="600519", price=1, ts=datetime.now())}

    fake_history = MagicMock(bars_cache=bars, static_cache=static)
    fake_dividend = MagicMock(cache=div)
    fake_price = MagicMock(_last_good=last_good)

    monkeypatch.setattr(main_mod, "history_service", fake_history)
    monkeypatch.setattr(main_mod, "_dividend_service", fake_dividend)
    monkeypatch.setattr(main_mod, "_price_service", fake_price)

    main_mod._cleanup_caches_for("600519")

    assert bars.get("600519") is None
    assert static.get("600519") is None
    assert div.get("600519") is None
    assert "600519" not in last_good


# ---------- FileCache.delete 单元测试 ----------


def test_filecache_delete_returns_false_when_missing(tmp_path):
    fc = FileCache("missing_test", 60, cache_dir=tmp_path)
    assert fc.delete("nope") is False


def test_filecache_delete_returns_true_and_removes(tmp_path):
    fc = FileCache("remove_test", 60, cache_dir=tmp_path)
    fc.set("k1", "v1")
    fc.set("k2", "v2")
    assert fc.delete("k1") is True
    assert fc.get("k1") is None
    assert fc.get("k2") == "v2"


def test_memory_ttl_cache_clear():
    mc = MemoryTTLCache(60)
    mc.set("a", 1)
    mc.set("b", 2)
    mc.clear()
    assert mc.get("a") is None
    assert mc.get("b") is None
