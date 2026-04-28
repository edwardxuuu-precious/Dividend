from datetime import date

from app.models import DividendEvent
from app.services.dividend_service import (
    analyze_latest_annual,
    annual_payment_groups,
    drop_incomplete_latest_year,
    latest_annual_from_events,
)


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


def test_drops_incomplete_when_amount_far_below_history():
    """招行场景：前几年都是 1 次/年（年度），2025 财年首次中报除权日跨到 2026-01。

    次数法对 1 次/年股票无效（max(prior_counts)=1，latest_count=1 不<）；
    金额成色法应剔除 2026 当年的 ¥1.013（远低于前 3 年中位 ¥1.972 × 70%），
    回落到 2025 的 ¥2.00。
    """
    events = [
        DividendEvent(ex_date="2023-07-13", cash_per_share=1.738),
        DividendEvent(ex_date="2024-07-11", cash_per_share=1.972),
        DividendEvent(ex_date="2025-07-11", cash_per_share=2.00),
        DividendEvent(ex_date="2026-01-16", cash_per_share=1.013),  # 2025 财年中报
    ]
    annual = latest_annual_from_events(events, today=date(2026, 4, 27))
    assert annual.year == 2025
    assert annual.cash_per_share == 2.00


def test_keeps_low_amount_year_when_well_past_recency_window():
    """业绩真下滑：金额低但距最早除权日已 > 9 个月 → 不再视为 in-progress，按现状显示。"""
    events = [
        DividendEvent(ex_date="2022-07-15", cash_per_share=2.0),
        DividendEvent(ex_date="2023-07-13", cash_per_share=2.0),
        DividendEvent(ex_date="2024-07-11", cash_per_share=2.0),
        DividendEvent(ex_date="2025-03-05", cash_per_share=0.5),  # 大跌但 14+ 月前
    ]
    annual = latest_annual_from_events(events, today=date(2026, 6, 1))
    assert annual.year == 2025
    assert annual.cash_per_share == 0.5


def test_keeps_when_amount_only_slightly_below_median():
    """当年金额仅小幅低于历史（80% 中位）→ 不剔除，避免业绩小幅下滑被误判。"""
    events = [
        DividendEvent(ex_date="2023-07-15", cash_per_share=1.0),
        DividendEvent(ex_date="2024-07-15", cash_per_share=1.0),
        DividendEvent(ex_date="2025-07-15", cash_per_share=1.0),
        DividendEvent(ex_date="2026-02-01", cash_per_share=0.85),  # 85% > 70%
    ]
    annual = latest_annual_from_events(events, today=date(2026, 4, 27))
    assert annual.year == 2026
    assert annual.cash_per_share == 0.85


# ---------- 判据 C：expected_count 人工 override ----------


def test_expected_count_override_drops_latest():
    """边界场景：A/B 都不剔，但人工配 expected=2 强制把"今年仅 1 次"判为 in-progress。

    构造金额相对前几年并不低的事件，确保 B 不命中（避免与 C 重合）。
    """
    events = [
        DividendEvent(ex_date="2023-07-13", cash_per_share=1.0),
        DividendEvent(ex_date="2024-07-11", cash_per_share=1.0),
        DividendEvent(ex_date="2025-07-11", cash_per_share=1.0),
        # 2026 中期 0.9 ≈ 历史中位 90%，B 不剔；A 也不剔（1<1 False）
        DividendEvent(ex_date="2026-01-16", cash_per_share=0.9),
    ]
    annual_default = latest_annual_from_events(events, today=date(2026, 4, 27))
    assert annual_default.year == 2026
    annual_override = latest_annual_from_events(
        events, today=date(2026, 4, 27), expected_count=2
    )
    assert annual_override.year == 2025


def test_expected_count_works_with_short_history():
    """历史不足 3 年时，A/B 都不参与判断；只要 override 命中仍可剔除。"""
    events = [
        DividendEvent(ex_date="2024-07-15", cash_per_share=1.0),
        DividendEvent(ex_date="2025-07-15", cash_per_share=1.1),
        DividendEvent(ex_date="2026-01-15", cash_per_share=0.5),
    ]
    by_year = annual_payment_groups(events)
    out = drop_incomplete_latest_year(
        by_year,
        latest_first_ex_date=date(2026, 1, 15),
        today=date(2026, 4, 27),
        expected_count=2,
    )
    assert 2026 not in out


def test_expected_count_zero_falls_back_to_legacy():
    """expected_count=0 与不传等价，行为不变（长电场景仍剔 2026）。"""
    events = [
        DividendEvent(ex_date="2023-05-19", cash_per_share=0.42),
        DividendEvent(ex_date="2023-12-15", cash_per_share=0.40),
        DividendEvent(ex_date="2024-05-17", cash_per_share=0.45),
        DividendEvent(ex_date="2024-12-13", cash_per_share=0.42),
        DividendEvent(ex_date="2025-05-16", cash_per_share=0.47),
        DividendEvent(ex_date="2025-12-19", cash_per_share=0.43),
        DividendEvent(ex_date="2026-05-15", cash_per_share=0.21),
    ]
    a = latest_annual_from_events(events, today=date(2026, 6, 1), expected_count=0)
    assert a.year == 2025


# ---------- analyze_latest_annual：unusually_high 标志 ----------


def test_unusually_high_detects_special_dividend_year():
    """五粮液 2025 含特别股利场景：当年合计 ≈ 历史中位数 × 1.78，应标 high。"""
    events = [
        DividendEvent(ex_date="2020-06-22", cash_per_share=2.20),
        DividendEvent(ex_date="2021-07-09", cash_per_share=2.58),
        DividendEvent(ex_date="2022-06-29", cash_per_share=3.023),
        DividendEvent(ex_date="2023-06-27", cash_per_share=3.782),
        DividendEvent(ex_date="2024-07-12", cash_per_share=4.67),
        # 2025 自然年三笔合计 8.323（含特别股利）
        DividendEvent(ex_date="2025-01-23", cash_per_share=2.576),
        DividendEvent(ex_date="2025-07-18", cash_per_share=3.169),
        DividendEvent(ex_date="2025-12-18", cash_per_share=2.578),
    ]
    a = analyze_latest_annual(events, today=date(2026, 4, 27))
    assert a.annual.year == 2025
    assert round(a.annual.cash_per_share, 3) == 8.323
    assert a.unusually_high is True
    assert a.historical_median is not None


def test_unusually_high_normal_growth_not_flagged():
    """正常 YoY 增长（< 1.5x）不应触发标签。"""
    events = [
        DividendEvent(ex_date="2021-07-13", cash_per_share=1.253),
        DividendEvent(ex_date="2022-07-15", cash_per_share=1.522),
        DividendEvent(ex_date="2023-07-13", cash_per_share=1.738),
        DividendEvent(ex_date="2024-07-11", cash_per_share=1.972),
        DividendEvent(ex_date="2025-07-11", cash_per_share=2.000),
    ]
    a = analyze_latest_annual(events, today=date(2025, 12, 1))
    assert a.annual.year == 2025
    assert a.unusually_high is False


def test_unusually_high_silent_with_short_history():
    """历史完整年 < 3 时无法判中位数，unusually_high 一律 False。"""
    events = [
        DividendEvent(ex_date="2024-07-15", cash_per_share=1.0),
        DividendEvent(ex_date="2025-07-15", cash_per_share=2.5),
    ]
    a = analyze_latest_annual(events, today=date(2025, 12, 1))
    assert a.annual.year == 2025
    assert a.unusually_high is False
    assert a.historical_median is None
