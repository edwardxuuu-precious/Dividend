from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from threading import RLock

import yaml

from app.models import Stock

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "watchlist.yaml"

# 进程级写锁：所有运行时修改 watchlist 的路径都必须持锁。
# 读路径不持锁——Python list 的元素赋值/读取是原子操作，watcher 迭代时
# 看到的是某一时刻的快照（list 长度变化期间最多多/少一个元素，不会撕裂）。
_CONFIG_LOCK = RLock()


@dataclass
class AppConfig:
    """运行时可变的应用配置。

    历史上是 frozen dataclass，但前端运行时编辑 watchlist 功能要求 stocks list
    可在不重启服务的情况下增删改。通过 _CONFIG_LOCK 串行化所有写操作；
    PriceService / WatcherService 等持有同一个 AppConfig 引用，list 引用不变，
    内容变化即时可见。
    """
    refresh_seconds: int
    stocks: list[Stock] = field(default_factory=list)
    # TTM 兜底失效阈值：距上次除权超过此天数仍无新分红 → 视为停止分红（lapsed）
    # A 股一年最多分两次，常见间隔 ≤ 15 个月；540 天 ≈ 18 个月给一次容错
    carry_stale_days: int = 540
    # 当前配置加载自/写回的文件路径。save_to_yaml 默认写这里。
    source_path: Path | None = None


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
            expected_payments_per_year=int(item.get("expected_payments_per_year", 0) or 0),
        )
        for item in raw.get("stocks", [])
    ]
    if not stocks:
        raise ValueError(f"watchlist 为空：{cfg_path}")
    return AppConfig(
        refresh_seconds=refresh_seconds,
        stocks=stocks,
        carry_stale_days=carry_stale_days,
        source_path=cfg_path,
    )


def save_to_yaml(config: AppConfig, path: Path | str | None = None) -> None:
    """原子写回 watchlist.yaml（同目录 tempfile + os.replace）。注释会丢失。"""
    target = Path(path) if path else config.source_path
    if target is None:
        raise ValueError("save_to_yaml: 未指定写入路径，且 config.source_path 为空")

    payload: dict = {
        "refresh_seconds": config.refresh_seconds,
        "carry_stale_days": config.carry_stale_days,
        "stocks": [
            {
                "symbol": s.symbol,
                "name": s.name,
                "exchange": s.exchange,
                **({"shares": s.shares} if s.shares > 0 else {}),
                **(
                    {"expected_payments_per_year": s.expected_payments_per_year}
                    if s.expected_payments_per_year > 0
                    else {}
                ),
            }
            for s in config.stocks
        ],
    }
    target.parent.mkdir(parents=True, exist_ok=True)
    with _CONFIG_LOCK:
        # 同目录写临时文件再原子 rename，避免半写状态被读到
        fd, tmp_name = tempfile.mkstemp(
            prefix=".watchlist.",
            suffix=".tmp",
            dir=str(target.parent),
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                yaml.safe_dump(payload, f, allow_unicode=True, sort_keys=False)
            os.replace(tmp_name, target)
        except Exception:
            # 临时文件残留清理
            if os.path.exists(tmp_name):
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass
            raise


def add_stock(config: AppConfig, stock: Stock) -> Stock:
    """追加 stock 到 watchlist 末尾并写回 yaml。重复 symbol 会抛 ValueError。"""
    with _CONFIG_LOCK:
        if any(s.symbol == stock.symbol for s in config.stocks):
            raise ValueError(f"symbol 已存在: {stock.symbol}")
        config.stocks.append(stock)
        save_to_yaml(config)
        return stock


def remove_stock(config: AppConfig, symbol: str) -> Stock:
    """从 watchlist 删除一只 stock 并写回 yaml。

    返回被删的 Stock 对象。如果 symbol 不存在抛 KeyError；
    如果删除后 watchlist 会变空抛 ValueError（保留 load_config 的非空校验）。
    """
    with _CONFIG_LOCK:
        if len(config.stocks) <= 1:
            raise ValueError("不能删除最后一只股票，watchlist 不能为空")
        for i, s in enumerate(config.stocks):
            if s.symbol == symbol:
                removed = config.stocks.pop(i)
                save_to_yaml(config)
                return removed
        raise KeyError(symbol)


def update_stock(
    config: AppConfig,
    symbol: str,
    *,
    name: str | None = None,
    shares: int | None = None,
) -> Stock:
    """修改一只 stock 的 name 或 shares（symbol 和 exchange 不可改）。"""
    with _CONFIG_LOCK:
        for i, s in enumerate(config.stocks):
            if s.symbol == symbol:
                new = Stock(
                    symbol=s.symbol,
                    name=name if name is not None else s.name,
                    exchange=s.exchange,
                    shares=shares if shares is not None else s.shares,
                    expected_payments_per_year=s.expected_payments_per_year,
                )
                config.stocks[i] = new
                save_to_yaml(config)
                return new
        raise KeyError(symbol)
