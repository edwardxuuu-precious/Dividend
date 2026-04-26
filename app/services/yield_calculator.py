from __future__ import annotations


def calc_yield_pct(cash_per_share: float, price: float) -> float:
    if price <= 0:
        raise ValueError("price must be positive")
    return cash_per_share / price * 100.0
