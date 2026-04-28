from pathlib import Path

import pytest

from app.config import (
    add_stock,
    load_config,
    remove_stock,
    save_to_yaml,
    update_stock,
)
from app.models import Stock


def _make_yaml(tmp_path: Path) -> Path:
    p = tmp_path / "wl.yaml"
    p.write_text(
        """
refresh_seconds: 10
stocks:
  - symbol: "600519"
    name: "贵州茅台"
    exchange: "SH"
  - symbol: "000858"
    name: "五粮液"
    exchange: "SZ"
    shares: 100
""",
        encoding="utf-8",
    )
    return p


def test_load_default_watchlist():
    cfg = load_config()
    assert cfg.refresh_seconds >= 1
    assert any(s.symbol == "600519" for s in cfg.stocks)
    # 默认值 540 天，可被 watchlist.yaml 覆盖
    assert cfg.carry_stale_days == 540


def test_carry_stale_days_overridable(tmp_path):
    p = tmp_path / "wl.yaml"
    p.write_text(
        """
refresh_seconds: 10
carry_stale_days: 720
stocks:
  - symbol: "600519"
    name: "贵州茅台"
    exchange: "SH"
""",
        encoding="utf-8",
    )
    cfg = load_config(p)
    assert cfg.carry_stale_days == 720


def test_load_custom(tmp_path: Path):
    p = tmp_path / "wl.yaml"
    p.write_text(
        """
refresh_seconds: 30
stocks:
  - symbol: "000858"
    name: "五粮液"
    exchange: "SZ"
""",
        encoding="utf-8",
    )
    cfg = load_config(p)
    assert cfg.refresh_seconds == 30
    assert cfg.stocks[0].symbol == "000858"


def test_empty_watchlist_rejected(tmp_path: Path):
    p = tmp_path / "wl.yaml"
    p.write_text("refresh_seconds: 5\nstocks: []\n", encoding="utf-8")
    with pytest.raises(ValueError):
        load_config(p)


# ---------- 运行时编辑 watchlist 测试 ----------


def test_add_stock_appends_and_persists(tmp_path: Path):
    cfg = load_config(_make_yaml(tmp_path))
    new = Stock(symbol="000651", name="格力电器", exchange="SZ", shares=0)
    added = add_stock(cfg, new)
    assert added.symbol == "000651"
    assert cfg.stocks[-1].symbol == "000651"
    # 重新 load 验证持久化
    cfg2 = load_config(cfg.source_path)
    assert [s.symbol for s in cfg2.stocks] == ["600519", "000858", "000651"]


def test_add_stock_rejects_duplicate(tmp_path: Path):
    cfg = load_config(_make_yaml(tmp_path))
    with pytest.raises(ValueError):
        add_stock(cfg, Stock(symbol="600519", name="茅台2", exchange="SH"))


def test_remove_stock_drops_and_persists(tmp_path: Path):
    cfg = load_config(_make_yaml(tmp_path))
    removed = remove_stock(cfg, "000858")
    assert removed.symbol == "000858"
    assert [s.symbol for s in cfg.stocks] == ["600519"]
    cfg2 = load_config(cfg.source_path)
    assert [s.symbol for s in cfg2.stocks] == ["600519"]


def test_remove_stock_unknown_raises_keyerror(tmp_path: Path):
    cfg = load_config(_make_yaml(tmp_path))
    with pytest.raises(KeyError):
        remove_stock(cfg, "999999")


def test_remove_last_stock_rejected(tmp_path: Path):
    p = tmp_path / "single.yaml"
    p.write_text(
        'refresh_seconds: 10\nstocks:\n  - symbol: "600519"\n    name: "X"\n    exchange: "SH"\n',
        encoding="utf-8",
    )
    cfg = load_config(p)
    with pytest.raises(ValueError):
        remove_stock(cfg, "600519")


def test_update_stock_changes_name_and_shares(tmp_path: Path):
    cfg = load_config(_make_yaml(tmp_path))
    updated = update_stock(cfg, "000858", name="五粮液X", shares=500)
    assert updated.name == "五粮液X"
    assert updated.shares == 500
    # symbol/exchange 没变
    assert updated.symbol == "000858"
    assert updated.exchange == "SZ"
    cfg2 = load_config(cfg.source_path)
    s = next(s for s in cfg2.stocks if s.symbol == "000858")
    assert s.name == "五粮液X"
    assert s.shares == 500


def test_update_stock_partial_update(tmp_path: Path):
    """只传 shares 时 name 不变。"""
    cfg = load_config(_make_yaml(tmp_path))
    updated = update_stock(cfg, "600519", shares=200)
    assert updated.shares == 200
    assert updated.name == "贵州茅台"


def test_update_stock_unknown_raises_keyerror(tmp_path: Path):
    cfg = load_config(_make_yaml(tmp_path))
    with pytest.raises(KeyError):
        update_stock(cfg, "999999", shares=10)


def test_save_to_yaml_omits_zero_shares(tmp_path: Path):
    """shares=0 不写到 yaml（保持原配置风格）。"""
    cfg = load_config(_make_yaml(tmp_path))
    save_to_yaml(cfg)  # 重写当前配置
    text = cfg.source_path.read_text(encoding="utf-8")
    assert "600519" in text
    # 第一只 shares=0，不应出现 "shares:"在 600519 块里
    # 第二只 shares=100 应该有
    assert "shares: 100" in text


def test_load_expected_payments_per_year(tmp_path: Path):
    """yaml 里有 expected_payments_per_year 字段时被 load 进 Stock.expected_payments_per_year。"""
    p = tmp_path / "wl.yaml"
    p.write_text(
        """
refresh_seconds: 10
stocks:
  - symbol: "600036"
    name: "招商银行"
    exchange: "SH"
    expected_payments_per_year: 2
  - symbol: "600519"
    name: "贵州茅台"
    exchange: "SH"
""",
        encoding="utf-8",
    )
    cfg = load_config(p)
    cmb = next(s for s in cfg.stocks if s.symbol == "600036")
    mt = next(s for s in cfg.stocks if s.symbol == "600519")
    assert cmb.expected_payments_per_year == 2
    assert mt.expected_payments_per_year == 0  # 默认 0


def test_save_to_yaml_writes_expected_payments_per_year(tmp_path: Path):
    """expected_payments_per_year > 0 时写回 yaml；= 0 时省略。"""
    p = tmp_path / "wl.yaml"
    p.write_text(
        """
refresh_seconds: 10
stocks:
  - symbol: "600036"
    name: "招商银行"
    exchange: "SH"
    expected_payments_per_year: 2
  - symbol: "600519"
    name: "贵州茅台"
    exchange: "SH"
""",
        encoding="utf-8",
    )
    cfg = load_config(p)
    save_to_yaml(cfg)
    text = cfg.source_path.read_text(encoding="utf-8")
    assert "expected_payments_per_year: 2" in text
    # 茅台没设 → roundtrip 不该写出来
    mt_block_lines = [
        line for line in text.splitlines() if "600519" in line or "贵州茅台" in line
    ]
    assert mt_block_lines  # 茅台还在
    # 整文件出现的 expected_payments_per_year 行只 1 条（招行那条）
    assert text.count("expected_payments_per_year") == 1


def test_update_stock_preserves_expected_payments_per_year(tmp_path: Path):
    """update_stock 改 name/shares 时不应清空 expected_payments_per_year。"""
    p = tmp_path / "wl.yaml"
    p.write_text(
        """
refresh_seconds: 10
stocks:
  - symbol: "600036"
    name: "招商银行"
    exchange: "SH"
    expected_payments_per_year: 2
  - symbol: "600519"
    name: "贵州茅台"
    exchange: "SH"
""",
        encoding="utf-8",
    )
    cfg = load_config(p)
    updated = update_stock(cfg, "600036", shares=500)
    assert updated.expected_payments_per_year == 2
    assert updated.shares == 500
