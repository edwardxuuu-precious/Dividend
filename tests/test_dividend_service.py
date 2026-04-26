from app.models import DividendEvent
from app.services.dividend_service import latest_annual_from_events


def test_picks_latest_year():
    events = [
        DividendEvent(ex_date="2023-06-30", cash_per_share=2.5),
        DividendEvent(ex_date="2024-06-28", cash_per_share=3.0),
    ]
    annual = latest_annual_from_events(events)
    assert annual is not None
    assert annual.year == 2024
    assert annual.cash_per_share == 3.0


def test_sums_multiple_dividends_in_same_year():
    events = [
        DividendEvent(ex_date="2024-06-28", cash_per_share=3.0),
        DividendEvent(ex_date="2024-12-20", cash_per_share=1.5),  # 中期分红
    ]
    annual = latest_annual_from_events(events)
    assert annual.year == 2024
    assert annual.cash_per_share == 4.5


def test_empty():
    assert latest_annual_from_events([]) is None


def test_ignores_invalid_dates():
    events = [
        DividendEvent(ex_date="--", cash_per_share=10),
        DividendEvent(ex_date="2024-06-28", cash_per_share=3.0),
    ]
    annual = latest_annual_from_events(events)
    assert annual.year == 2024
    assert annual.cash_per_share == 3.0


def test_drops_incomplete_latest_year():
    """长电场景：每年 2 次派息，最新年只派了 1 次（中期）→ 跳过最新年。"""
    events = [
        DividendEvent(ex_date="2023-05-19", cash_per_share=0.42),
        DividendEvent(ex_date="2023-12-15", cash_per_share=0.40),
        DividendEvent(ex_date="2024-05-17", cash_per_share=0.45),
        DividendEvent(ex_date="2024-12-13", cash_per_share=0.42),
        DividendEvent(ex_date="2025-05-16", cash_per_share=0.47),
        DividendEvent(ex_date="2025-12-19", cash_per_share=0.43),
        DividendEvent(ex_date="2026-05-15", cash_per_share=0.21),  # 只有中期
    ]
    annual = latest_annual_from_events(events)
    assert annual.year == 2025
    assert annual.cash_per_share == round(0.47 + 0.43, 6)


def test_keeps_complete_latest_year():
    """每年 2 次派息且最新年也是 2 次 → 保留。"""
    events = [
        DividendEvent(ex_date="2023-06-19", cash_per_share=30.876),
        DividendEvent(ex_date="2023-12-20", cash_per_share=23.882),
        DividendEvent(ex_date="2024-06-26", cash_per_share=27.673),
        DividendEvent(ex_date="2024-12-19", cash_per_share=23.957),
        DividendEvent(ex_date="2025-06-26", cash_per_share=28.0),
        DividendEvent(ex_date="2025-12-19", cash_per_share=24.0),
    ]
    annual = latest_annual_from_events(events)
    assert annual.year == 2025
    assert annual.cash_per_share == round(28.0 + 24.0, 6)


def test_keeps_incomplete_when_too_few_history():
    """只有 2 年历史 → 无法判断完整性，原样返回最新年（避免对新股误伤）。"""
    events = [
        DividendEvent(ex_date="2024-06-28", cash_per_share=3.0),
        DividendEvent(ex_date="2024-12-15", cash_per_share=2.0),
        DividendEvent(ex_date="2025-06-28", cash_per_share=1.5),  # 只有 1 次
    ]
    annual = latest_annual_from_events(events)
    assert annual.year == 2025
    assert annual.cash_per_share == 1.5
