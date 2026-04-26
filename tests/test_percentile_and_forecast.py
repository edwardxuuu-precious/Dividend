import pytest

from app.models import DividendEvent
from app.services.history_service import (
    compute_annual_history,
    compute_percentiles,
    forecast_next_year,
    percentile_rank,
    valuation_label,
)


# ---------------- Percentiles ----------------

def _series(values):
    """生成一个 [date, close, ttm, yield] 序列，只填 yield 一栏。"""
    return [["2024-01-01", 1.0, 0.0, v] for v in values]


def test_percentiles_filters_zero():
    # 包含一些 0 应被剔除；剩余 [1, 2, 3, 4, 5]
    s = _series([0, 0, 1, 2, 3, 4, 5])
    p = compute_percentiles(s)
    # n=5: p50 = 3 (中位数), p10 = 1 + 0.4*(2-1) = 1.4, p90 = 4 + 0.6*(5-4) = 4.6
    assert p["p50"] == pytest.approx(3.0)
    assert p["p10"] == pytest.approx(1.4)
    assert p["p90"] == pytest.approx(4.6)


def test_percentiles_too_few_returns_none():
    p = compute_percentiles(_series([1.0]))
    assert all(v is None for v in p.values())


def test_percentile_rank():
    s = _series([1, 2, 3, 4, 5])
    assert percentile_rank(0.5, s) == 0.0
    assert percentile_rank(3.0, s) == 40.0  # 2 个 < 3 → 2/5 = 40%
    assert percentile_rank(5.5, s) == 100.0


def test_percentile_rank_handles_none():
    assert percentile_rank(None, _series([1, 2])) is None
    assert percentile_rank(0, _series([1, 2])) is None
    assert percentile_rank(5.0, _series([])) is None


def test_valuation_label():
    assert valuation_label(95) == "历史性低估"
    assert valuation_label(80) == "偏低估"
    assert valuation_label(50) == "中性"
    assert valuation_label(20) == "偏高估"
    assert valuation_label(5) == "历史性高估"
    assert valuation_label(None) is None


# ---------------- Annual history ----------------

def test_annual_history_aggregates_by_ex_year():
    events = [
        DividendEvent(ex_date="2024-06-19", cash_per_share=30.876),
        DividendEvent(ex_date="2024-12-20", cash_per_share=23.882),  # 同年
        DividendEvent(ex_date="2025-06-26", cash_per_share=27.673),
    ]
    a = compute_annual_history(events)
    # 历史只 2 年，无法判断 2025 完整性，原样保留
    assert len(a) == 2
    assert a[0]["year"] == 2024 and a[0]["total"] == pytest.approx(54.758)
    assert a[1]["year"] == 2025 and a[1]["total"] == pytest.approx(27.673)
    # YoY
    assert a[0]["yoy_pct"] is None  # 首年无前值
    assert a[1]["yoy_pct"] == pytest.approx(-49.46, abs=0.01)


def test_annual_history_drops_incomplete_latest():
    """3+ 年历史时，最新年派息次数偏少 → 视为进行中、剔除。"""
    events = [
        DividendEvent(ex_date="2023-06-19", cash_per_share=30.0),
        DividendEvent(ex_date="2023-12-20", cash_per_share=20.0),
        DividendEvent(ex_date="2024-06-19", cash_per_share=32.0),
        DividendEvent(ex_date="2024-12-20", cash_per_share=22.0),
        DividendEvent(ex_date="2025-06-26", cash_per_share=33.0),
        DividendEvent(ex_date="2025-12-20", cash_per_share=23.0),
        DividendEvent(ex_date="2026-06-15", cash_per_share=15.0),  # 只有中期
    ]
    a = compute_annual_history(events)
    assert [r["year"] for r in a] == [2023, 2024, 2025]
    assert a[-1]["year"] == 2025
    assert a[-1]["total"] == pytest.approx(56.0)


# ---------------- Forecast ----------------

def test_forecast_uses_recent_yoy():
    annual = [
        {"year": 2021, "total": 36.0, "yoy_pct": None},
        {"year": 2022, "total": 40.0, "yoy_pct": 11.11},
        {"year": 2023, "total": 44.0, "yoy_pct": 10.0},
        {"year": 2024, "total": 48.0, "yoy_pct": 9.09},
        {"year": 2025, "total": 51.6, "yoy_pct": 7.5},
    ]
    f = forecast_next_year(annual)
    assert f["next_year"] == 2026
    assert f["based_on_year"] == 2025
    assert f["conservative"] == 51.6
    # 近 3 年 YoY: 10, 9.09, 7.5 → avg ≈ 8.86
    assert f["avg_yoy_3y"] == pytest.approx(8.86, abs=0.01)
    assert f["mid"] == pytest.approx(51.6 * 1.0886, abs=0.05)
    # 近 3 年最大 YoY = 10 → optimistic
    assert f["optimistic"] == pytest.approx(51.6 * 1.10, abs=0.05)
    assert f["confidence"] == "high"  # 5 连续年


def test_forecast_low_confidence_with_few_years():
    annual = [
        {"year": 2024, "total": 10.0, "yoy_pct": None},
        {"year": 2025, "total": 12.0, "yoy_pct": 20.0},
    ]
    f = forecast_next_year(annual)
    assert f["confidence"] == "low"


def test_forecast_handles_empty():
    assert forecast_next_year([]) is None
