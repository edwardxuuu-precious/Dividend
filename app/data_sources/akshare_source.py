from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Any

import akshare as ak
import pandas as pd
import requests

from app.data_sources.base import DividendSource, HistoricalPriceSource, PriceSource
from app.models import DailyBar, DividendEvent, Quote, Stock

logger = logging.getLogger(__name__)

_SINA_HQ_URL = "https://hq.sinajs.cn/list={codes}"
_SINA_HEADERS = {
    "Referer": "https://finance.sina.com.cn",
    "User-Agent": "Mozilla/5.0",
}


class AkshareSource(PriceSource, DividendSource, HistoricalPriceSource):
    """基于 akshare 的行情 + 分红 + 历史 K 线数据源。"""

    # ---------- 行情 ----------

    def get_quotes(self, stocks: list[Stock]) -> dict[str, Quote]:
        """
        直连新浪 hq 接口批量取行情。
        - 不用东财（stock_zh_a_spot_em）：在某些 Windows 客户端下会 TLS 重协商后断流。
        - 不用 akshare 的 stock_zh_a_spot：分页 60+ 次拉全市场，慢且浪费。
        - 新浪 hq.sinajs.cn 批量接口：一次请求拿到 watchlist 全部股票，毫秒级。
        """
        if not stocks:
            return {}
        # 编码为 sh600519 / sz000858 形式，逗号拼接
        sina_codes = [f"{s.exchange.lower()}{s.symbol}" for s in stocks]
        url = _SINA_HQ_URL.format(codes=",".join(sina_codes))

        try:
            resp = requests.get(url, headers=_SINA_HEADERS, timeout=5)
            resp.encoding = "gbk"
            text = resp.text
        except Exception as e:
            logger.warning("新浪行情请求失败: %s", e)
            return {}

        now = datetime.now()
        result: dict[str, Quote] = {}
        for stock, sina_code in zip(stocks, sina_codes):
            price = _parse_sina_price(text, sina_code)
            if price is not None:
                result[stock.symbol] = Quote(symbol=stock.symbol, price=price, ts=now)
        return result

    # ---------- 历史 K 线 ----------

    def get_daily_bars(
        self, stock: Stock, start_date: str | None = None
    ) -> list[DailyBar]:
        """
        akshare stock_zh_a_daily (新浪源) 返回不复权日 K：
          列 date / open / close / high / low / volume / ...
        股息率必须用 **不复权** 的真实价格（adjust=''）。
        不用 stock_zh_a_hist (东财源)：在某些 Windows 客户端下会
        RemoteDisconnected，是同一个 TLS 兼容性家族的问题。
        新浪需要传带交易所前缀的代码，如 sh600519。

        start_date 用于增量拉取（YYYY-MM-DD），akshare 接收 YYYYMMDD。
        """
        sina_code = f"{stock.exchange.lower()}{stock.symbol}"
        kwargs: dict = {"symbol": sina_code, "adjust": ""}
        if start_date:
            kwargs["start_date"] = start_date.replace("-", "")
        try:
            df = ak.stock_zh_a_daily(**kwargs)
        except Exception as e:
            logger.warning("akshare 拉取 %s 日 K 失败: %s", stock.symbol, e)
            return []

        if df is None or df.empty:
            return []

        bars: list[DailyBar] = []
        for _, row in df.iterrows():
            d = _to_date_str(row.get("date"))
            if not d:
                continue
            close = _to_float(row.get("close"))
            if close is None or close <= 0:
                continue
            bars.append(DailyBar(date=d, close=close))
        return bars

    # ---------- 分红 ----------

    def get_dividend_history(self, stock: Stock) -> list[DividendEvent]:
        try:
            df = ak.stock_history_dividend_detail(symbol=stock.symbol, indicator="分红")
        except Exception as e:  # akshare 偶发网络/解析失败
            logger.warning("akshare 拉取 %s 分红失败: %s", stock.symbol, e)
            return []

        if df is None or df.empty:
            return []

        return _parse_dividend_dataframe(df)


def _parse_dividend_dataframe(df: pd.DataFrame) -> list[DividendEvent]:
    """
    akshare stock_history_dividend_detail(indicator="分红") 返回列：
      公告日期 | 送股 | 转增 | 派息 | 进度 | 除权除息日 | 股权登记日 | 红股上市日
    其中 "派息" 为每 10 股税前现金分红（元），需除以 10 得到每股。
    """
    events: list[DividendEvent] = []
    for _, row in df.iterrows():
        ex_date = _to_date_str(row.get("除权除息日"))
        if not ex_date:
            # 未实施的分红预案没有除权除息日，跳过
            continue
        cash_per_10 = _to_float(row.get("派息"))
        if cash_per_10 is None or cash_per_10 <= 0:
            continue
        events.append(
            DividendEvent(ex_date=ex_date, cash_per_share=cash_per_10 / 10.0)
        )
    return events


def _parse_sina_price(text: str, sina_code: str) -> float | None:
    """
    从新浪 hq 响应中解析单只股票的最新价。
    格式：var hq_str_sh600519="名称,开,昨收,现价,最高,最低,..."；现价是第 4 个字段（index 3）。
    """
    marker = f'hq_str_{sina_code}="'
    start = text.find(marker)
    if start < 0:
        return None
    start += len(marker)
    end = text.find('"', start)
    if end < 0:
        return None
    fields = text[start:end].split(",")
    if len(fields) < 4:
        return None
    try:
        price = float(fields[3])
    except ValueError:
        return None
    # 新浪在停牌或非交易时段会返回 0；停牌时才忽略，闭市后用昨收（fields[2]）兜底。
    if price > 0:
        return price
    try:
        prev_close = float(fields[2])
        return prev_close if prev_close > 0 else None
    except ValueError:
        return None


def _to_date_str(value: Any) -> str | None:
    if value is None or pd.isna(value):
        return None
    if isinstance(value, str):
        s = value.strip()
        if not s or s in {"--", "-"}:
            return None
        # akshare 偶尔返回 YYYYMMDD 或 YYYY-MM-DD
        if len(s) == 8 and s.isdigit():
            return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"
        return s
    if isinstance(value, (datetime, date, pd.Timestamp)):
        return value.strftime("%Y-%m-%d")
    return None


def _to_float(value: Any) -> float | None:
    if value is None or pd.isna(value):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None
