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

# 在主线程预加载 py_mini_racer（akshare 间接依赖，用于解析东财加密 JS）。
# 必须在任何 Thread 启动前完成 V8 PartitionAlloc 单次初始化，否则 4 并发 prewarm
# 线程同时 lazy-load mini_racer.dll 时会触发 V8 致命断言：
#   [FATAL:partition_address_space.cc] Check failed: !IsConfigurablePoolInitialized()
# 进程立即崩溃，端口 8000 释放。预加载后第二次 import 会复用模块状态，安全。
try:  # noqa: SIM105
    import py_mini_racer  # noqa: F401
except Exception:
    pass

from datetime import datetime as _datetime
from io import BytesIO

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.config import (
    add_stock as _config_add_stock,
    load_config,
    remove_stock as _config_remove_stock,
    update_stock as _config_update_stock,
)
from app.data_sources.akshare_source import AkshareSource
from app.models import Stock
from app.services.dividend_service import DividendService
from app.services.history_service import HistoryService
from app.services.price_service import PriceService
from app.services.watcher import WatcherService

WEB_DIR = Path(__file__).resolve().parent / "web"

app = FastAPI(title="Dividend Watch")

config = load_config()
_source = AkshareSource()
_dividend_service = DividendService(_source)
_price_service = PriceService(_source, config=config)  # 持有 config 引用，watchlist 编辑后立即可见；缓存被 watcher + history 复用
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

    用 print() 而非 logging：uvicorn 的 root logger 默认 WARNING 级别，info 会被吞掉，
    导致 history prewarm 过去出现的 silent failure（cache 写入未完成但日志看不到）。
    """
    if not config.stocks:
        return
    print(f"[prewarm-history] 预热 {len(config.stocks)} 只历史数据…", flush=True)
    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = [ex.submit(_safe_prewarm, stock) for stock in config.stocks]
        # with 退出时会等所有 future 完成，但显式 wait 让异常更快冒出来
        for f in futures:
            try:
                f.result(timeout=60)
            except Exception as e:
                print(f"[prewarm-history] worker 异常: {e}", flush=True)
    print("[prewarm-history] 全部完成；启动 universe 预热…", flush=True)
    # universe 改在 history 完成后才跑，避免 akshare 内部 tqdm/session 等状态
    # 跟 history 的 stock_zh_a_daily 调用冲突导致部分股票 silent 失败。
    try:
        _load_stock_universe()
    except Exception as e:
        print(f"[prewarm-universe] 失败: {e}", flush=True)


def _safe_prewarm(stock):
    """单只股票预热 + 写入校验。失败时把 traceback 打到 stdout，便于诊断。"""
    try:
        history_service._get_static(stock)
    except Exception as e:
        import traceback
        print(f"[prewarm-history] {stock.symbol} 异常: {e}\n{traceback.format_exc()}", flush=True)
        return
    # 校验 cache 是真的写入了 fresh 条目（防止 series 空导致 silent skip）
    if history_service.static_cache.get(stock.symbol) is None:
        print(
            f"[prewarm-history] {stock.symbol} cache 写入失败 "
            f"(可能日 K 拉取返回空 → series 空 → _get_static 跳过 set)",
            flush=True,
        )
    else:
        print(f"[prewarm-history] {stock.symbol} ✓", flush=True)


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


# ---------- watchlist 编辑 API ----------
# 4 个端点 + 校验辅助 + 缓存级联清理。详见 plan 文件 D3-D6。

import re as _re  # noqa: E402

from app.cache import FileCache as _FileCache  # noqa: E402

_SYMBOL_RE = _re.compile(r"^\d{6}$")
_VALID_EXCHANGES = {"SH", "SZ"}


# ---------- 全 A 股名录搜索（支持 add modal 自动补全）----------
# 从 akshare 拉一次全 A 股 code+name（~5500 行，13s），24h 文件缓存。
# 通过 symbol 前缀推断交易所，避免再发一次 sh/sz 分别请求。
_UNIVERSE_CACHE = _FileCache("stock_universe", 24 * 3600)
_UNIVERSE_KEY = "all_a"
_universe_lock = threading.Lock()


def _infer_exchange(symbol: str) -> str | None:
    """A 股代码前缀 → 交易所。"""
    if not symbol or not symbol.isdigit() or len(symbol) != 6:
        return None
    if symbol[0] == "6":  # 主板（60）+ 科创板（688）+ B 股（900）
        return "SH"
    if symbol[0] in ("0", "3"):  # 主板（00/002）+ 创业板（30）
        return "SZ"
    return None  # 北交所 8/4 暂不支持


def _load_stock_universe() -> list[dict]:
    """返回 [{symbol, name, exchange}, ...]。命中缓存毫秒级，未命中拉 ~13s。"""
    cached = _UNIVERSE_CACHE.get(_UNIVERSE_KEY)
    if cached is not None:
        return cached

    with _universe_lock:
        # 双重检查，避免并发下重复拉
        cached = _UNIVERSE_CACHE.get(_UNIVERSE_KEY)
        if cached is not None:
            return cached
        log = logging.getLogger("universe")
        log.info("拉取全 A 股名录（首次或缓存过期）…")
        import akshare as ak
        df = ak.stock_info_a_code_name()
        items: list[dict] = []
        for _, row in df.iterrows():
            sym = str(row.get("code", "")).strip()
            name = str(row.get("name", "")).strip()
            if not sym or not name:
                continue
            ex = _infer_exchange(sym)
            if ex is None:
                continue  # 跳过北交所等
            items.append({"symbol": sym, "name": name, "exchange": ex})
        log.info("全 A 股名录就绪：%d 行（已剔除非沪深）", len(items))
        _UNIVERSE_CACHE.set(_UNIVERSE_KEY, items)
        return items


# 注意：universe 预热由 _prewarm_history 在所有股票预热完成后串行触发，
# 避免与 history-prewarm 的 stock_zh_a_daily 调用同时打 akshare 引发 silent 失败。
# 详见 _prewarm_history 注释。


@app.get("/api/stocks/search")
def api_stocks_search(q: str = "", limit: int = 10) -> dict:
    """模糊匹配股票。q 是代码片段或名称片段（大小写不敏感）。

    排序优先级：symbol 完全匹配 > symbol 前缀匹配 > name 子串匹配。
    """
    q = (q or "").strip()
    if not q:
        return {"results": []}
    limit = max(1, min(50, int(limit)))

    try:
        universe = _load_stock_universe()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"全 A 股名录暂不可用: {e}")

    q_lower = q.lower()
    q_is_digit = q.isdigit()

    exact_sym: list[dict] = []
    prefix_sym: list[dict] = []
    contains_name: list[dict] = []
    seen: set[str] = set()

    for item in universe:
        sym = item["symbol"]
        if sym in seen:
            continue
        if q_is_digit:
            if sym == q:
                exact_sym.append(item)
                seen.add(sym)
                continue
            if sym.startswith(q):
                prefix_sym.append(item)
                seen.add(sym)
                continue
        # 名称匹配（不区分大小写）
        if q_lower in item["name"].lower():
            contains_name.append(item)
            seen.add(sym)

    merged = exact_sym + prefix_sym + contains_name
    return {"results": merged[:limit]}


def _validate_new_stock(stock: Stock) -> tuple[bool, str]:
    """新加股票时双验证：行情 + 分红都能拉到才接受。

    避免脏数据进入 watchlist 后 watcher tick 一直报错。不拉历史日 K（耗时几秒），
    后续 prewarm 异步处理。
    """
    try:
        quotes = _source.get_quotes([stock])
    except Exception as e:
        return False, f"行情拉取异常: {e}"
    q = quotes.get(stock.symbol)
    if q is None or q.price <= 0:
        return False, "无法从行情源拿到价格（symbol/exchange 错？停牌？）"

    try:
        events = _source.get_dividend_history(stock)
    except Exception as e:
        return False, f"分红拉取异常: {e}"
    if not events:
        return False, "无历史分红记录（不适合分红率监控）"

    return True, ""


def _cleanup_caches_for(symbol: str) -> None:
    """删除股票时级联清理 4 处缓存条目（FileCache 三处 + 内存 last_good）。"""
    history_service.bars_cache.delete(symbol)
    history_service.static_cache.delete(symbol)
    _dividend_service.cache.delete(symbol)
    _price_service._last_good.pop(symbol, None)


def _stock_to_dict(s: Stock) -> dict:
    return {
        "symbol": s.symbol,
        "name": s.name,
        "exchange": s.exchange,
        "shares": s.shares,
    }


@app.get("/api/watchlist")
def api_watchlist_list() -> dict:
    return {
        "refresh_seconds": config.refresh_seconds,
        "stocks": [_stock_to_dict(s) for s in config.stocks],
    }


@app.post("/api/watchlist", status_code=201)
async def api_watchlist_add(request: Request) -> dict:
    body = await request.json()
    symbol = str(body.get("symbol", "")).strip()
    name = str(body.get("name", "")).strip()
    exchange = str(body.get("exchange", "")).strip().upper()
    shares_raw = body.get("shares", 0)
    try:
        shares = int(shares_raw or 0)
    except (TypeError, ValueError):
        raise HTTPException(status_code=422, detail="shares 必须是非负整数")
    if shares < 0:
        raise HTTPException(status_code=422, detail="shares 不能为负数")
    if not _SYMBOL_RE.match(symbol):
        raise HTTPException(status_code=422, detail="symbol 必须是 6 位数字")
    # exchange 缺失时从 symbol 前缀自动推断（前端搜索流程已用不到这个字段）
    if not exchange:
        inferred = _infer_exchange(symbol)
        if inferred is None:
            raise HTTPException(status_code=422, detail="无法从 symbol 推断交易所（仅支持沪深）")
        exchange = inferred
    if exchange not in _VALID_EXCHANGES:
        raise HTTPException(status_code=422, detail="exchange 必须是 SH 或 SZ")
    if not name:
        raise HTTPException(status_code=422, detail="name 不能为空")
    if any(s.symbol == symbol for s in config.stocks):
        raise HTTPException(status_code=409, detail=f"symbol 已存在: {symbol}")

    candidate = Stock(symbol=symbol, name=name, exchange=exchange, shares=shares)
    ok, reason = _validate_new_stock(candidate)
    if not ok:
        raise HTTPException(status_code=422, detail=reason)

    try:
        added = _config_add_stock(config, candidate)
    except ValueError as e:
        # 锁内重试碰到重复（极小概率）
        raise HTTPException(status_code=409, detail=str(e))

    # 异步 prewarm 新股的历史数据，前端几秒后能看到分位/估值
    threading.Thread(
        target=_safe_prewarm,
        args=(added,),
        daemon=True,
        name=f"prewarm-{added.symbol}",
    ).start()

    return {"stock": _stock_to_dict(added)}


@app.put("/api/watchlist/{symbol}")
async def api_watchlist_update(symbol: str, request: Request) -> dict:
    body = await request.json()
    name = body.get("name")
    shares_raw = body.get("shares")

    if name is not None:
        name = str(name).strip()
        if not name:
            raise HTTPException(status_code=422, detail="name 不能为空字符串")

    shares: int | None = None
    if shares_raw is not None:
        try:
            shares = int(shares_raw)
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail="shares 必须是非负整数")
        if shares < 0:
            raise HTTPException(status_code=422, detail="shares 不能为负数")

    if name is None and shares is None:
        raise HTTPException(status_code=422, detail="至少需要提供 name 或 shares")

    try:
        updated = _config_update_stock(config, symbol, name=name, shares=shares)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"未在 watchlist 中找到 {symbol}")

    return {"stock": _stock_to_dict(updated)}


@app.delete("/api/watchlist/{symbol}")
def api_watchlist_remove(symbol: str) -> dict:
    try:
        removed = _config_remove_stock(config, symbol)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"未在 watchlist 中找到 {symbol}")
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))

    _cleanup_caches_for(symbol)
    return {"stock": _stock_to_dict(removed)}
