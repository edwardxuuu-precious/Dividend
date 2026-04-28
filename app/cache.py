from __future__ import annotations

import json
import time
from pathlib import Path
from threading import Lock
from typing import Any

DEFAULT_CACHE_DIR = Path(__file__).resolve().parent.parent / "data"


class FileCache:
    """简单的 JSON 文件缓存，按 key 存储 {value, expires_at}。线程安全。"""

    def __init__(self, name: str, ttl_seconds: int, cache_dir: Path | None = None) -> None:
        self.path = (cache_dir or DEFAULT_CACHE_DIR) / f"{name}.json"
        self.ttl = ttl_seconds
        self._lock = Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}

    def _write(self, data: dict[str, Any]) -> None:
        self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

    def get(self, key: str) -> Any | None:
        with self._lock:
            data = self._read()
            entry = data.get(key)
            if not entry:
                return None
            if entry["expires_at"] < time.time():
                return None
            return entry["value"]

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            data = self._read()
            data[key] = {"value": value, "expires_at": time.time() + self.ttl}
            self._write(data)

    def get_stale(self, key: str) -> Any | None:
        """忽略 TTL 拿历史值（用于数据源失败时降级）。"""
        with self._lock:
            entry = self._read().get(key)
            return entry["value"] if entry else None

    def delete(self, key: str) -> bool:
        """删除指定 key。返回是否删了东西。watchlist 删股票时级联清缓存用。"""
        with self._lock:
            data = self._read()
            if key not in data:
                return False
            del data[key]
            self._write(data)
            return True


class MemoryTTLCache:
    """内存 TTL 缓存，用于行情这种高频但短时效的数据。"""

    def __init__(self, ttl_seconds: float) -> None:
        self.ttl = ttl_seconds
        self._store: dict[str, tuple[float, Any]] = {}
        self._lock = Lock()

    def get(self, key: str) -> Any | None:
        with self._lock:
            entry = self._store.get(key)
            if not entry:
                return None
            expires_at, value = entry
            if expires_at < time.time():
                return None
            return value

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._store[key] = (time.time() + self.ttl, value)

    def clear(self) -> None:
        with self._lock:
            self._store.clear()
