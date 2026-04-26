from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml

from app.models import Stock

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "watchlist.yaml"


@dataclass(frozen=True)
class AppConfig:
    refresh_seconds: int
    stocks: list[Stock]
    # TTM 兜底失效阈值：距上次除权超过此天数仍无新分红 → 视为停止分红（lapsed）
    # A 股一年最多分两次，常见间隔 ≤ 15 个月；540 天 ≈ 18 个月给一次容错
    carry_stale_days: int = 540


def load_config(path: Path | str | None = None) -> AppConfig:
    cfg_path = Path(path) if path else DEFAULT_CONFIG_PATH
    raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))

    refresh_seconds = int(raw.get("refresh_seconds", 10))
    carry_stale_days = int(raw.get("carry_stale_days", 540))
    stocks = [
        Stock(
            symbol=str(item["symbol"]),
            name=item["name"],
            exchange=item["exchange"],
            shares=int(item.get("shares", 0) or 0),
        )
        for item in raw.get("stocks", [])
    ]
    if not stocks:
        raise ValueError(f"watchlist 为空：{cfg_path}")
    return AppConfig(
        refresh_seconds=refresh_seconds,
        stocks=stocks,
        carry_stale_days=carry_stale_days,
    )
