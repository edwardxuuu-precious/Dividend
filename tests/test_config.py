from pathlib import Path

import pytest

from app.config import load_config


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
