import pytest

from app.services.yield_calculator import calc_yield_pct


def test_basic():
    assert calc_yield_pct(30, 1500) == pytest.approx(2.0)


def test_zero_dividend():
    assert calc_yield_pct(0, 1500) == 0.0


def test_invalid_price():
    with pytest.raises(ValueError):
        calc_yield_pct(10, 0)
    with pytest.raises(ValueError):
        calc_yield_pct(10, -1)
