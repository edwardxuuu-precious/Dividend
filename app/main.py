from __future__ import annotations

import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path

# A 股数据源（东方财富/新浪/交易所）都在国内，不能走系统 HTTP(S) 代理。
# 否则 Clash/V2ray 这类代理会破坏 TLS 握手，触发 SSL DECRYPTION_FAILED_OR_BAD_RECORD_MAC。
# 同时清掉 env var 与 Windows 注册表里的 IE 代理（urllib.request.getproxies 在 Win 上会读注册表）。
for _v in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
    os.environ.pop(_v, None)

import urllib.request as _urllib_request  # noqa: E402

_urllib_request.getproxies = lambda: {}

from datetime import datetime as _datetime
from io import BytesIO

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.config import load_config
from app.data_sources.akshare_source import AkshareSource
from app.services.dividend_service import DividendService
from app.services.history_service import HistoryService
from app.services.price_service import PriceService
from app.services.watcher import WatcherService

WEB_DIR = Path(__file__).resolve().parent / "web"

app = FastAPI(title="Dividend Watch")

config = load_config()
_source = AkshareSource()
_dividend_service = DividendService(_source)
_price_service = PriceService(_source)  # 共用一个实例，让 5s 内存缓存被 watcher + history 复用
history_service = HistoryService(
    bars_source=_source,
    dividend_service=_dividend_service,
    price_service=_price_service,
    carry_stale_days=config.carry_stale_days,
)
watcher = WatcherService(
    config=config,
    price_service=_price_service,
    dividend_service=_dividend_service,
    history_service=history_service,  # 让主表能填 P 分位 + 估值
)


def _prewarm_history() -> None:
    """启动时后台并行预热每只股票的 history 静态缓存（series/分位/年度/预估）。

    冷启动时 watcher.snapshot() 的 P 分位列暂为空，预热完成后下个 tick 自动填上。
    每只 ~0.5s 拉分红 + ~1s 拉日 K（缓存命中后毫秒级），4 并发约 2-3s。
    """
    log = logging.getLogger("prewarm")
    if not config.stocks:
        return
    log.info("预热 %d 只历史数据…", len(config.stocks))
    with ThreadPoolExecutor(max_workers=4) as ex:
        for stock in config.stocks:
            ex.submit(_safe_prewarm, stock, log)


def _safe_prewarm(stock, log):
    try:
        history_service._get_static(stock)
        log.info("预热完成 %s", stock.symbol)
    except Exception as e:
        log.warning("预热失败 %s: %s", stock.symbol, e)


threading.Thread(target=_prewarm_history, daemon=True, name="history-prewarm").start()

templates = Jinja2Templates(directory=str(WEB_DIR / "templates"))
app.mount("/static", StaticFiles(directory=str(WEB_DIR / "static")), name="static")


def _yield_class(pct: float | None) -> str:
    if pct is None:
        return ""
    if pct >= 5:
        return "yield-great"
    if pct >= 3:
        return "yield-good"
    if pct < 1:
        return "yield-warn"
    return ""


def _valuation_class(label: str | None) -> str:
    return {
        "历史性低估": "v-deep-cheap",
        "偏低估": "v-cheap",
        "中性": "v-neutral",
        "偏高估": "v-rich",
        "历史性高估": "v-deep-rich",
    }.get(label or "", "")


templates.env.globals["yield_class"] = _yield_class
templates.env.globals["valuation_class"] = _valuation_class


@app.get("/")
def index(request: Request):
    return templates.TemplateResponse(
        request,
        "index.html",
        {"refresh_seconds": config.refresh_seconds},
    )


@app.get("/api/yields")
def api_yields() -> JSONResponse:
    rows = watcher.snapshot()
    payload = []
    for r in rows:
        d = asdict(r)
        d["updated_at"] = r.updated_at.isoformat(timespec="seconds")
        d["price_ts"] = r.price_ts.isoformat(timespec="seconds") if r.price_ts else None
        payload.append(d)
    return JSONResponse(
        {
            "refresh_seconds": config.refresh_seconds,
            "rows": payload,
            "portfolio": watcher.portfolio_summary(rows),
        }
    )


@app.get("/api/yields.csv", response_class=PlainTextResponse)
def api_yields_csv() -> PlainTextResponse:
    """主表当前快照导出 CSV。Excel 兼容：UTF-8 BOM + CRLF。"""
    rows = watcher.snapshot()
    headers = [
        "代码", "名称", "现价", "最近年度每股分红", "派息年度",
        "年化股息率%", "TTM 股息率%",
        "P 分位（年化）", "估值（年化）",
        "P 分位（TTM）", "估值（TTM）",
        "更新时间",
    ]

    def cell(v):
        if v is None:
            return ""
        s = str(v)
        if any(c in s for c in (",", '"', "\n", "\r")):
            return '"' + s.replace('"', '""') + '"'
        return s

    lines = [",".join(headers)]
    for r in rows:
        lines.append(",".join(cell(v) for v in [
            r.symbol, r.name, r.price, r.dividend, r.dividend_year,
            r.yield_pct, r.yield_ttm_pct,
            r.annual_percentile_rank, r.annual_valuation,
            r.percentile_rank, r.valuation,
            r.updated_at.isoformat(timespec="seconds"),
        ]))
    body = "﻿" + "\r\n".join(lines) + "\r\n"  # BOM 让 Excel 自动识别 UTF-8
    return PlainTextResponse(
        body,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": "attachment; filename=dividend_watch.csv",
        },
    )


@app.get("/api/report.pdf")
def api_report_pdf() -> Response:
    """渲染 watchlist 当前快照为 PDF（A4 打印就绪）。

    用 xhtml2pdf（纯 Python，Windows 无需额外 runtime）。
    """
    from xhtml2pdf import pisa

    rows = watcher.snapshot()
    portfolio = watcher.portfolio_summary(rows)
    now = _datetime.now()
    html = templates.get_template("report.html").render({
        "rows": rows,
        "portfolio": portfolio,
        "generated_at": now.strftime("%Y-%m-%d %H:%M:%S"),
    })
    buf = BytesIO()
    status = pisa.CreatePDF(html, dest=buf, encoding="utf-8")
    if status.err:
        raise HTTPException(status_code=500, detail="PDF 渲染失败")
    return Response(
        content=buf.getvalue(),
        media_type="application/pdf",
        headers={
            "Content-Disposition": (
                f"attachment; filename=dividend_report_{now.strftime('%Y%m%d_%H%M')}.pdf"
            ),
        },
    )


@app.get("/api/yields/{symbol}/history")
def api_history(symbol: str) -> dict:
    stock = next((s for s in config.stocks if s.symbol == symbol), None)
    if not stock:
        raise HTTPException(status_code=404, detail=f"未在 watchlist 中找到 {symbol}")
    return history_service.get_history(stock)


@app.get("/api/yields/{symbol}/current")
def api_current(symbol: str) -> dict:
    """轻量端点：仅返回实时 current（用于盘中前端轮询，避免重传 series）。"""
    stock = next((s for s in config.stocks if s.symbol == symbol), None)
    if not stock:
        raise HTTPException(status_code=404, detail=f"未在 watchlist 中找到 {symbol}")
    cur = history_service.get_live_current(stock)
    if cur is None:
        raise HTTPException(status_code=503, detail="历史数据未就绪")
    return cur


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "stocks": len(config.stocks)}
