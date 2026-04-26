(function () {
  const cardsGrid = document.getElementById("cards-grid");
  const lastUpdated = document.getElementById("last-updated");
  const statusDot = document.getElementById("status-dot");
  const notifyToggle = document.getElementById("notify-toggle");
  let refreshSeconds =
    parseInt(document.querySelector('meta[name="refresh-seconds"]').content, 10) || 10;

  const NOTIFY_THRESHOLD = 90; // P 分位 ≥ 此值触发通知
  const NOTIFY_PREF_KEY = "dividend-notify-enabled";
  const expanded = new Map(); // symbol -> { detailEl, abortController, liveTimer }
  // 已通知过的 symbol 集合，避免同会话内重复弹窗（每次进入"低估"区只通知 1 次）
  const notifiedAlerts = new Set();

  function fmtNumber(v, digits) {
    if (v === null || v === undefined) return "—";
    return Number(v).toFixed(digits);
  }

  // 千分位金额：12345678.5 → "12,345,678.50"
  function fmtMoney(v) {
    if (v === null || v === undefined) return "—";
    return Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // 紧凑金额：1458.49 → "1,458.49" / 8.323 → "8.32"
  function fmtPrice(v, digits) {
    if (v === null || v === undefined) return "—";
    return Number(v).toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  // ISO 时间戳 → 短格式 "11:46:02"
  function fmtTime(iso) {
    if (!iso) return "";
    const t = iso.split("T")[1];
    return t ? t.substring(0, 8) : iso;
  }

  function yieldClass(pct) {
    if (pct === null || pct === undefined) return "";
    if (pct >= 5) return "yield-great";
    if (pct >= 3) return "yield-good";
    if (pct < 1) return "yield-warn";
    return "";
  }

  // 行情是否陈旧：price_ts 比 snapshot updated_at 落后超过 1.5×刷新周期
  // → 这一 tick 没拉到新行情，回退到上次成功值。前端打 ⏱ 水印告知用户。
  function isPriceStale(row) {
    if (!row.price_ts || !row.updated_at) return false;
    const lagSec =
      (Date.parse(row.updated_at) - Date.parse(row.price_ts)) / 1000;
    return lagSec > refreshSeconds * 1.5;
  }

  // 卡片"现价"格内 HTML：陈旧时附带 ⏱ HH:MM:SS 水印，鼠标悬停看完整说明
  function priceCellHtml(row) {
    if (row.price === null || row.price === undefined) return "¥—";
    const base = `¥${fmtPrice(row.price, 2)}`;
    if (!isPriceStale(row)) return base;
    const t = fmtTime(row.price_ts);
    return `${base}<span class="stale-tag" title="行情拉取失败，仍显示 ${t} 的实盘价；下次刷新自动恢复">⏱ ${t}</span>`;
  }

  function cardKey(row) { return `c-${row.symbol}`; }
  function detailKey(symbol) { return `d-${symbol}`; }

  // 单口径徽章。tier="年化" 或 "TTM"；rank/label 对应该口径的分位与估值标签。
  // 未就绪 → 透明占位，保留布局位避免后续渲染抖动。
  function singleBadgeHtml(tier, rank, label, tooltip) {
    if (rank === null || rank === undefined) {
      return `<span class="badge valuation-neutral val-badge" style="opacity:.4" title="${tooltip}"><span class="val-tier">${tier}</span>—</span>`;
    }
    return `<span class="badge ${valuationClass(label)} val-badge" title="${tooltip}"><span class="val-tier">${tier}</span>P${Math.round(rank)} · ${label}</span>`;
  }

  // 估值徽章组：年化在上、TTM 在下，两套口径并列展示。
  function valuationBadgeHtml(row) {
    const annual = singleBadgeHtml(
      "年化",
      row.annual_percentile_rank,
      row.annual_valuation,
      "年化口径分位：当前年化股息率在历史样本中的位置"
    );
    const ttm = singleBadgeHtml(
      "TTM",
      row.percentile_rank,
      row.valuation,
      "TTM 口径分位：当前 TTM 股息率在历史样本中的位置"
    );
    return `<span class="valuation-stack">${annual}${ttm}</span>`;
  }

  function yieldHtml(row) {
    if (row.yield_pct === null || row.yield_pct === undefined) {
      return `<span class="card-yield-error">${row.error || "—"}</span>`;
    }
    const ttm = row.yield_ttm_pct;
    const ttmHtml =
      ttm === null || ttm === undefined
        ? '<span class="card-yield-ttm muted">TTM —</span>'
        : `<span class="card-yield-ttm ${yieldClass(ttm)}" title="TTM = 过去 365 天实际除权金额 ÷ 实时价">TTM ${fmtNumber(ttm, 2)}<span class="unit-sm">%</span></span>`;
    return `
      <span class="card-yield-stack">
        <span class="card-yield ${yieldClass(row.yield_pct)}" title="年化 = 派息年 ${row.dividend_year ?? "—"} 累计每股 ÷ 实时价">${fmtNumber(row.yield_pct, 2)}<span class="unit">%</span><span class="card-yield-tag">年化</span></span>
        ${ttmHtml}
      </span>`;
  }

  function positionHtml(row) {
    if (!row.shares || row.shares <= 0) return "";
    return `
      <div class="card-position" data-field="position">
        <div><span class="card-position-label">${row.shares.toLocaleString("zh-CN")} 股</span></div>
        <div><span class="card-position-label">市值</span><span class="card-position-value">¥${fmtMoney(row.position_value)}</span></div>
        <div><span class="card-position-label">年化</span><span class="card-position-value good">¥${fmtMoney(row.annual_cash)}</span></div>
      </div>`;
  }

  function buildCard(row) {
    const card = document.createElement("article");
    card.id = cardKey(row);
    card.dataset.symbol = row.symbol;
    card.classList.add("card");
    if (row.error && row.price === null && row.dividend === null) {
      card.classList.add("error");
    }
    card.innerHTML = `
      <div class="card-head">
        <div class="card-name">${row.name}</div>
        <div class="card-symbol">${row.symbol}</div>
      </div>
      <div class="card-headline">
        <div data-field="yield">${yieldHtml(row)}</div>
        <div data-field="valuation">${valuationBadgeHtml(row)}</div>
      </div>
      <div class="card-facts">
        <div class="card-fact"><span>现价</span><b data-field="price">${priceCellHtml(row)}</b></div>
        <div class="card-fact"><span>每股</span><b data-field="dividend">¥${fmtPrice(row.dividend, 4)}</b></div>
        <div class="card-fact"><span>派息年</span><b data-field="year">${row.dividend_year ?? "—"}</b></div>
      </div>
      ${positionHtml(row)}
      <div class="card-time" data-field="time">${fmtTime(row.updated_at)}</div>
    `;
    card.addEventListener("click", () => toggleDetail(row.symbol, row.name));
    return card;
  }

  function updateCard(card, row) {
    let changed = false;
    const setHtml = (selector, html) => {
      const el = card.querySelector(selector);
      if (el && el.innerHTML !== html) {
        el.innerHTML = html;
        changed = true;
      }
    };
    const setText = (selector, text) => {
      const el = card.querySelector(selector);
      if (el && el.textContent !== String(text)) {
        el.textContent = text;
        changed = true;
      }
    };

    setHtml('[data-field="yield"]', yieldHtml(row));
    setHtml('[data-field="valuation"]', valuationBadgeHtml(row));
    setHtml('[data-field="price"]', priceCellHtml(row));
    setText('[data-field="dividend"]', "¥" + fmtPrice(row.dividend, 4));
    setText('[data-field="year"]', row.dividend_year ?? "—");
    setText('[data-field="time"]', fmtTime(row.updated_at));

    // 持仓块需要整体替换（内含多元素）
    const existingPos = card.querySelector('[data-field="position"]');
    const newPos = positionHtml(row);
    if (existingPos && !newPos) {
      existingPos.remove();
      changed = true;
    } else if (!existingPos && newPos) {
      card.querySelector(".card-time").insertAdjacentHTML("beforebegin", newPos);
      changed = true;
    } else if (existingPos && newPos && existingPos.outerHTML !== newPos) {
      existingPos.outerHTML = newPos;
      changed = true;
    }

    if (changed) {
      card.classList.remove("flash");
      void card.offsetWidth;
      card.classList.add("flash");
    }
  }

  // -------------------- 排序 --------------------

  // 默认按股息率降序
  let sortKey = "yield_pct";
  let sortDesc = true;
  let lastRows = [];

  function compareRows(a, b) {
    const av = a[sortKey];
    const bv = b[sortKey];
    const aNull = av === null || av === undefined;
    const bNull = bv === null || bv === undefined;
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    if (typeof av === "string") {
      return sortDesc ? bv.localeCompare(av) : av.localeCompare(bv);
    }
    return sortDesc ? bv - av : av - bv;
  }

  function setupSortToolbar() {
    const pills = document.querySelectorAll("#sort-bar .sort-pill");
    pills.forEach((pill) => {
      pill.addEventListener("click", () => {
        const key = pill.dataset.sort;
        if (sortKey === key) {
          sortDesc = !sortDesc;
        } else {
          sortKey = key;
          // 文本列默认升序，数字/年度默认降序
          sortDesc = !["symbol", "name"].includes(key);
        }
        updateSortIndicators();
        if (lastRows.length) render(lastRows);
      });
    });
    updateSortIndicators();
  }

  function updateSortIndicators() {
    document.querySelectorAll("#sort-bar .sort-pill").forEach((pill) => {
      const isActive = pill.dataset.sort === sortKey;
      pill.classList.toggle("active", isActive);
      pill.classList.toggle("sort-asc", isActive && !sortDesc);
    });
  }

  function render(rows) {
    lastRows = rows;
    const sorted = [...rows].sort(compareRows);
    // 创建/更新卡片
    sorted.forEach((row) => {
      const existing = document.getElementById(cardKey(row));
      if (existing) {
        updateCard(existing, row);
      } else {
        const loading = cardsGrid.querySelector(".cards-loading");
        if (loading) loading.remove();
        cardsGrid.appendChild(buildCard(row));
      }
    });
    // 重排 DOM：每张卡片后跟随其 detail（如已展开）
    sorted.forEach((row) => {
      const card = document.getElementById(cardKey(row));
      if (!card) return;
      cardsGrid.appendChild(card);
      const detailEl = document.getElementById(detailKey(row.symbol));
      if (detailEl) cardsGrid.appendChild(detailEl);
    });
  }

  // -------------------- 详情面板 --------------------

  function toggleDetail(symbol, name) {
    if (expanded.has(symbol)) {
      const ctx = expanded.get(symbol);
      ctx.abortController.abort();
      if (ctx.liveTimer) clearInterval(ctx.liveTimer);
      ctx.detailEl.remove();
      expanded.delete(symbol);
      const card = document.getElementById(cardKey({ symbol }));
      if (card) card.classList.remove("expanded");
      return;
    }

    const card = document.getElementById(cardKey({ symbol }));
    if (!card) return;
    card.classList.add("expanded");

    const detailEl = document.createElement("div");
    detailEl.id = detailKey(symbol);
    detailEl.classList.add("card-detail");
    detailEl.innerHTML = `
      <div class="detail-panel">
        <div class="summary-card">
          <div class="summary-left">
            <div class="summary-stock">${name} <span class="muted">${symbol}</span></div>
            <div class="summary-dual-yield">
              <div class="dual-yield-block">
                <div class="dual-yield-label">年化 <span class="muted dual-yield-year"></span></div>
                <div class="dual-yield-value">
                  <span class="big-yield big-yield-annual">—</span><span class="big-suffix">%</span>
                </div>
                <div class="dual-yield-basis muted"></div>
                <div class="dual-yield-badge"><span class="valuation-badge-annual"></span></div>
              </div>
              <div class="dual-yield-divider"></div>
              <div class="dual-yield-block">
                <div class="dual-yield-label">TTM <span class="muted">（365 天滚动）</span></div>
                <div class="dual-yield-value">
                  <span class="big-yield big-yield-ttm">—</span><span class="big-suffix">%</span>
                </div>
                <div class="dual-yield-basis muted"></div>
                <div class="dual-yield-badge"><span class="valuation-badge-ttm"></span></div>
              </div>
              <div class="dual-yield-tags">
                <span class="lapsed-badge"></span>
              </div>
            </div>
            <div class="summary-meta muted"></div>
          </div>
        </div>

        <section class="chart-section">
          <h3 class="section-title">股息率走势 <span class="muted">(双口径：TTM 365 天滚动 vs 年化派息年累计 / 当日收盘价)</span></h3>
          <div class="chart-wrap"><div class="chart-loading">加载历史数据…</div></div>
        </section>

        <section class="two-col">
          <div class="col forecast-col"></div>
          <div class="col annual-col"></div>
        </section>

        <section class="events-section">
          <div class="events-wrap"></div>
        </section>
      </div>
    `;
    card.parentNode.insertBefore(detailEl, card.nextSibling);

    const ac = new AbortController();
    const ctx = { detailEl, abortController: ac, liveTimer: null };
    expanded.set(symbol, ctx);

    fetch(`/api/yields/${symbol}/history`, { signal: ac.signal, cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        renderDetail(ctx, data);
        ctx.liveTimer = setInterval(
          () => pollLiveCurrent(symbol, ctx),
          refreshSeconds * 1000
        );
      })
      .catch((e) => {
        if (e.name === "AbortError") return;
        const wrap = detailEl.querySelector(".chart-wrap");
        wrap.innerHTML = `<div class="chart-error">加载失败：${e.message}</div>`;
      });
  }

  async function pollLiveCurrent(symbol, ctx) {
    if (ctx.abortController.signal.aborted) return;
    try {
      const r = await fetch(`/api/yields/${symbol}/current`, {
        cache: "no-store",
        signal: ctx.abortController.signal,
      });
      if (!r.ok) return;
      const cur = await r.json();
      applyLiveCurrent(ctx, cur);
    } catch (e) {
      // 静默：保留旧显示
    }
  }

  function applyLiveCurrent(ctx, current) {
    if (!current) return;
    const dr = ctx.detailEl;
    if (!dr) return;

    // 双口径大字
    const annualEl = dr.querySelector(".big-yield-annual");
    if (annualEl && current.annual_yield_pct !== null && current.annual_yield_pct !== undefined) {
      annualEl.textContent = fmtNumber(current.annual_yield_pct, 2);
      annualEl.className = "big-yield big-yield-annual " + yieldClass(current.annual_yield_pct);
    }
    const ttmEl = dr.querySelector(".big-yield-ttm");
    if (ttmEl && current.yield_pct !== null && current.yield_pct !== undefined) {
      ttmEl.textContent = fmtNumber(current.yield_pct, 2);
      ttmEl.className = "big-yield big-yield-ttm " + yieldClass(current.yield_pct);
    }

    // 双口径分子说明
    const blocks = dr.querySelectorAll(".dual-yield-block");
    if (blocks.length >= 2 && current.live_price && current.live_price > 0) {
      const annualBasis = blocks[0].querySelector(".dual-yield-basis");
      if (annualBasis && current.annual_dividend !== null && current.annual_dividend !== undefined) {
        annualBasis.textContent = `每股 ¥${fmtNumber(current.annual_dividend, 4)} ÷ ¥${fmtNumber(current.live_price, 2)}`;
      }
      const yearLbl = blocks[0].querySelector(".dual-yield-year");
      if (yearLbl) yearLbl.textContent = current.annual_year ? `（派息年 ${current.annual_year}）` : "";

      const ttmBasis = blocks[1].querySelector(".dual-yield-basis");
      if (ttmBasis && current.ttm_dividend !== null && current.ttm_dividend !== undefined) {
        ttmBasis.textContent = `近 365 天 ¥${fmtNumber(current.ttm_dividend, 4)} ÷ ¥${fmtNumber(current.live_price, 2)}`;
      }
    }

    // 估值徽章（双口径：年化挂在年化块、TTM 挂在 TTM 块）
    setBadge(
      dr.querySelector(".valuation-badge-annual"),
      "valuation-badge-annual",
      current.annual_percentile_rank,
      current.annual_valuation
    );
    setBadge(
      dr.querySelector(".valuation-badge-ttm"),
      "valuation-badge-ttm",
      current.percentile_rank,
      current.valuation
    );

    // summary-meta 里的"当前价"
    const meta = dr.querySelector(".summary-meta");
    if (meta && current.live_price) {
      const priceEl = meta.querySelector(".live-price");
      if (priceEl) priceEl.textContent = fmtNumber(current.live_price, 2);
      const sourceEl = meta.querySelector(".live-source");
      if (sourceEl)
        sourceEl.textContent =
          current.source === "live" ? "" : "（昨收）";
    }

    // 三档预估的"按现价"列也跟着实时变（重新渲染整个 forecast 块）
    if (ctx.cachedForecast && current.live_price) {
      const forecastCol = dr.querySelector(".forecast-col");
      forecastCol.innerHTML = renderForecastCard(
        ctx.cachedForecast,
        current.live_price
      );
    }
  }

  // 把单口径分位/估值写入指定 .valuation-badge-* span。
  // 缺数据时隐藏；与 valuationClass 一致地维护颜色 class。
  function setBadge(el, baseClass, rank, label) {
    if (!el) return;
    if (rank === null || rank === undefined) {
      el.style.display = "none";
      el.textContent = "";
      return;
    }
    el.textContent = `P${rank.toFixed(0)} · ${label}`;
    el.className = `${baseClass} badge ` + valuationClass(label);
    el.style.display = "";
  }

  function renderLapsedBadge(summary) {
    if (!summary) return "";
    const days = summary.days_since_last_ex;
    const lastEx = summary.last_ex_date;
    if (summary.currently_lapsed) {
      const monthsTxt = days ? `（距上次除权 ${days} 天，约 ${(days / 30).toFixed(0)} 个月）` : "";
      return `<span class="lapsed-tag lapsed-current" title="超过 ${summary.stale_threshold_days} 天未派息，TTM 已置 0">⚠ 已停止分红 ${monthsTxt}</span>`;
    }
    if (summary.historical_lapsed_count > 0) {
      return `<span class="lapsed-tag lapsed-history" title="历史曾出现 ${summary.historical_lapsed_count} 段超过 ${summary.stale_threshold_days} 天的派息空窗（图上以断点展示）">历史曾断流 ${summary.historical_lapsed_count} 次</span>`;
    }
    return "";
  }

  function valuationClass(label) {
    return (
      {
        历史性低估: "valuation-deep-cheap",
        偏低估: "valuation-cheap",
        中性: "valuation-neutral",
        偏高估: "valuation-rich",
        历史性高估: "valuation-deep-rich",
      }[label] || ""
    );
  }

  function renderDetail(ctx, data) {
    const detailRow = ctx.detailEl;  // 沿用旧名，所有 detailRow.querySelector 的逻辑不变
    const series = data.series || [];
    const annualSeries = data.annual_series || [];
    const events = data.events || [];
    const percentiles = data.percentiles || {};
    const current = data.current || {};
    const annual = data.annual || [];
    const forecast = data.forecast;
    const eod = data.eod;
    const lapsedSummary = data.lapsed_summary;
    ctx.cachedForecast = forecast;

    // 只统计 source = window 的真实数据（carry 是估计，lapsed/pre_first 是 0）
    const windowPoints = series.filter(
      (p) => p[3] !== null && p[3] > 0 && (p[4] || "window") === "window"
    );
    const yields = windowPoints.map((p) => p[3]);

    // ---------- 顶部摘要卡（用 current 而非 series 末端，反映实时） ----------
    {
      const annualEl = detailRow.querySelector(".big-yield-annual");
      const ttmEl = detailRow.querySelector(".big-yield-ttm");

      const liveAnnual = current.annual_yield_pct;
      if (annualEl && liveAnnual !== null && liveAnnual !== undefined) {
        annualEl.textContent = fmtNumber(liveAnnual, 2);
        annualEl.className = "big-yield big-yield-annual " + yieldClass(liveAnnual);
      }
      const liveTtm = current.yield_pct;
      if (ttmEl && liveTtm !== null && liveTtm !== undefined) {
        ttmEl.textContent = fmtNumber(liveTtm, 2);
        ttmEl.className = "big-yield big-yield-ttm " + yieldClass(liveTtm);
      }

      const blocks = detailRow.querySelectorAll(".dual-yield-block");
      if (blocks.length >= 2 && current.live_price && current.live_price > 0) {
        const annualBasis = blocks[0].querySelector(".dual-yield-basis");
        if (annualBasis && current.annual_dividend !== null && current.annual_dividend !== undefined) {
          annualBasis.textContent = `每股 ¥${fmtNumber(current.annual_dividend, 4)} ÷ ¥${fmtNumber(current.live_price, 2)}`;
        }
        const yearLbl = blocks[0].querySelector(".dual-yield-year");
        if (yearLbl) yearLbl.textContent = current.annual_year ? `（派息年 ${current.annual_year}）` : "";

        const ttmBasis = blocks[1].querySelector(".dual-yield-basis");
        if (ttmBasis && current.ttm_dividend !== null && current.ttm_dividend !== undefined) {
          ttmBasis.textContent = `近 365 天 ¥${fmtNumber(current.ttm_dividend, 4)} ÷ ¥${fmtNumber(current.live_price, 2)}`;
        }
      }

      // 双口径估值徽章：年化挂在年化块、TTM 挂在 TTM 块
      setBadge(
        detailRow.querySelector(".valuation-badge-annual"),
        "valuation-badge-annual",
        current.annual_percentile_rank,
        current.annual_valuation
      );
      setBadge(
        detailRow.querySelector(".valuation-badge-ttm"),
        "valuation-badge-ttm",
        current.percentile_rank,
        current.valuation
      );

      const max = yields.length ? Math.max(...yields) : null;
      const min = yields.length ? Math.min(...yields) : null;
      const maxDate = max ? windowPoints.find((p) => p[3] === max)[0] : "—";
      const liveSource =
        current.source === "live" ? "" : '<span class="live-source">（昨收）</span>';
      detailRow.querySelector(".summary-meta").innerHTML = `
        当前价 <b class="live-price">${fmtNumber(current.live_price, 2)}</b>${liveSource} ·
        TTM 历史最高 ${fmtNumber(max, 2)}% (${maxDate}) ·
        最低 ${fmtNumber(min, 2)}% ·
        共 ${series.length.toLocaleString()} 个交易日
      `;

      const lapsedEl = detailRow.querySelector(".lapsed-badge");
      lapsedEl.innerHTML = renderLapsedBadge(lapsedSummary);
      lapsedEl.style.display = lapsedEl.innerHTML ? "" : "none";
    }

    // ---------- 折线图（双线：TTM + 年化，含双 EOD 点） ----------
    const chartWrap = detailRow.querySelector(".chart-wrap");
    chartWrap.innerHTML = "";
    if (series.length > 0) {
      chartWrap.appendChild(buildChart(series, percentiles, annualSeries).element);
    } else {
      chartWrap.innerHTML = `<div class="chart-error">没有历史数据</div>`;
    }

    // ---------- 预估卡 + 年度表（双栏） ----------
    const forecastCol = detailRow.querySelector(".forecast-col");
    const annualCol = detailRow.querySelector(".annual-col");
    forecastCol.innerHTML = renderForecastCard(
      forecast,
      current.live_price ?? (eod && eod.close)
    );
    annualCol.innerHTML = renderAnnualTable(annual);

    // ---------- 历史分红事件 ----------
    const eventsWrap = detailRow.querySelector(".events-wrap");
    if (events.length) {
      const rows = events
        .map(
          (e) =>
            `<tr><td>${e.ex_date}</td><td class="num">${fmtNumber(
              e.cash_per_share,
              4
            )}</td></tr>`
        )
        .join("");
      eventsWrap.innerHTML = `
        <h3 class="section-title">历史分红事件 <span class="muted">(共 ${events.length} 次)</span></h3>
        <div class="events-grid">
          <table class="events-table">
            <thead><tr><th>除权除息日</th><th class="num">每股税前分红 (元)</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    } else {
      eventsWrap.innerHTML = `<div class="chart-error">无历史分红记录</div>`;
    }
  }

  function renderForecastCard(forecast, currentPrice) {
    if (!forecast) return "";
    const projYield = (cash) =>
      currentPrice && currentPrice > 0
        ? ((cash / currentPrice) * 100).toFixed(2) + "%"
        : "—";
    const conf =
      { high: "高", medium: "中", low: "低" }[forecast.confidence] || "—";
    const confClass =
      { high: "conf-high", medium: "conf-mid", low: "conf-low" }[
        forecast.confidence
      ] || "";

    return `
      <h3 class="section-title">
        ${forecast.next_year} 年分红预估
        <span class="conf-pill ${confClass}">置信度 ${conf}</span>
      </h3>
      <div class="forecast-grid">
        <div class="forecast-tier conservative">
          <div class="tier-label">保守</div>
          <div class="tier-value">${fmtNumber(forecast.conservative, 2)} <span class="tier-unit">元/股</span></div>
          <div class="tier-yield muted">按现价 ${projYield(forecast.conservative)}</div>
          <div class="tier-note">与去年持平</div>
        </div>
        <div class="forecast-tier mid highlight">
          <div class="tier-label">中位 <span class="badge-base">推荐</span></div>
          <div class="tier-value">${fmtNumber(forecast.mid, 2)} <span class="tier-unit">元/股</span></div>
          <div class="tier-yield">按现价 <b>${projYield(forecast.mid)}</b></div>
          <div class="tier-note">近 3 年均速 ${fmtNumber(forecast.avg_yoy_3y, 1)}%</div>
        </div>
        <div class="forecast-tier optimistic">
          <div class="tier-label">乐观</div>
          <div class="tier-value">${fmtNumber(forecast.optimistic, 2)} <span class="tier-unit">元/股</span></div>
          <div class="tier-yield muted">按现价 ${projYield(forecast.optimistic)}</div>
          <div class="tier-note">近 3 年最高 YoY</div>
        </div>
      </div>
      <div class="forecast-note muted">
        基线 ${forecast.based_on_year} 年实派 ${fmtNumber(forecast.based_on_total, 4)} 元/股
      </div>
    `;
  }

  function renderAnnualTable(annual) {
    if (!annual.length) return "";
    const rows = [...annual]
      .reverse()
      .slice(0, 10)
      .map((a) => {
        const yoyCell =
          a.yoy_pct === null
            ? '<span class="muted">—</span>'
            : `<span class="${a.yoy_pct >= 0 ? "yoy-up" : "yoy-down"}">${
                a.yoy_pct >= 0 ? "+" : ""
              }${fmtNumber(a.yoy_pct, 1)}%</span>`;
        return `<tr><td>${a.year}</td><td class="num">${fmtNumber(
          a.total,
          4
        )}</td><td class="num">${yoyCell}</td></tr>`;
      })
      .join("");
    return `
      <h3 class="section-title">年度分红 <span class="muted">(每股合计)</span></h3>
      <table class="events-table annual-table">
        <thead><tr><th>年度</th><th class="num">每股 (元)</th><th class="num">同比</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // -------------------- SVG 折线图 --------------------

  // 时间窗口预设
  const CHART_PRESETS = [
    { label: "全部", years: null },
    { label: "10年", years: 10 },
    { label: "5年", years: 5 },
    { label: "3年", years: 3 },
    { label: "1年", years: 1 },
  ];

  function sourceOf(p) {
    return p[4] || "window"; // 兼容旧 4 元素 series
  }

  function sourceLabel(src) {
    return (
      {
        carry: "兜底估计",
        lapsed: "已停止分红",
        pre_first: "公司未分红期",
      }[src] || ""
    );
  }

  function buildChart(series, percentiles = {}, annualSeries = []) {
    // 剔除 lapsed / pre_first（视为图上的断点），保留 window + carry
    const allPoints = series.filter((p) => {
      if (p[3] === null) return false;
      const src = sourceOf(p);
      return src === "window" || src === "carry";
    });
    // 年化：剔除 yield_pct = null/0（pre_first 期）的点
    const annualPoints = annualSeries.filter(
      (p) => p[3] !== null && p[3] !== undefined && p[3] > 0
    );
    // 同日索引：tooltip 锚定 TTM 日期后能立刻查到对应年化点
    const annualByDate = new Map(annualPoints.map((p) => [p[0], p]));

    if (!allPoints.length) {
      const empty = document.createElement("div");
      empty.className = "chart-error";
      empty.textContent = "无可绘制的数据";
      return { element: empty };
    }

    const fullT0 = Date.parse(allPoints[0][0]);
    const fullT1 = Date.parse(allPoints[allPoints.length - 1][0]);

    // 外壳（按钮栏 + 图例 + SVG 槽 + tooltip）
    const wrap = document.createElement("div");
    wrap.className = "chart-container";

    const bar = document.createElement("div");
    bar.className = "chart-controls";
    const presetButtons = CHART_PRESETS.map((p) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chart-btn";
      btn.textContent = p.label;
      btn.addEventListener("click", () => setPreset(p));
      bar.appendChild(btn);
      return { ...p, btn };
    });

    const zoomHint = document.createElement("span");
    zoomHint.className = "chart-zoom-hint muted";
    zoomHint.textContent = "拖选区间放大";
    bar.appendChild(zoomHint);

    // 双口径图例
    const legend = document.createElement("span");
    legend.className = "chart-legend";
    legend.innerHTML = `
      <span class="legend-item"><span class="legend-swatch legend-ttm"></span>TTM 365 天滚动</span>
      <span class="legend-item"><span class="legend-swatch legend-annual"></span>年化派息年累计</span>
    `;
    bar.appendChild(legend);

    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "chart-btn chart-btn-reset";
    resetBtn.textContent = "重置缩放";
    resetBtn.style.display = "none";
    resetBtn.addEventListener("click", () => setPreset(currentPreset));
    bar.appendChild(resetBtn);

    wrap.appendChild(bar);

    const svgWrap = document.createElement("div");
    svgWrap.className = "chart-svg-wrap";
    wrap.appendChild(svgWrap);

    const tooltip = document.createElement("div");
    tooltip.className = "chart-tooltip";
    tooltip.style.display = "none";
    wrap.appendChild(tooltip);

    let currentPreset = CHART_PRESETS[0];
    let viewT0 = fullT0;
    let viewT1 = fullT1;

    function setPreset(preset) {
      currentPreset = preset;
      if (preset.years === null) {
        viewT0 = fullT0;
      } else {
        viewT0 = Math.max(fullT0, fullT1 - preset.years * 365.25 * 86400000);
      }
      viewT1 = fullT1;
      resetBtn.style.display = "none";
      presetButtons.forEach((b) => b.btn.classList.toggle("active", b.years === preset.years));
      rebuild();
    }

    function setRange(t0, t1) {
      viewT0 = Math.max(fullT0, t0);
      viewT1 = Math.min(fullT1, t1);
      resetBtn.style.display = "";
      presetButtons.forEach((b) => b.btn.classList.remove("active"));
      rebuild();
    }

    function rebuild() {
      tooltip.style.display = "none";
      svgWrap.innerHTML = "";
      renderChartSvg({
        container: svgWrap,
        tooltip,
        wrapEl: wrap,
        allPoints,
        annualPoints,
        annualByDate,
        percentiles,
        viewT0,
        viewT1,
        onZoom: setRange,
      });
    }

    setPreset(CHART_PRESETS[0]);

    return { element: wrap };
  }

  function renderChartSvg({
    container,
    tooltip,
    wrapEl,
    allPoints,
    annualPoints = [],
    annualByDate = new Map(),
    percentiles,
    viewT0,
    viewT1,
    onZoom,
  }) {
    const svgNS = "http://www.w3.org/2000/svg";
    const W = 960;
    const H = 280;
    const PAD_L = 50;
    const PAD_R = 60;
    const PAD_T = 16;
    const PAD_B = 28;
    const innerW = W - PAD_L - PAD_R;
    const innerH = H - PAD_T - PAD_B;

    const points = allPoints.filter((p) => {
      const t = Date.parse(p[0]);
      return t >= viewT0 && t <= viewT1;
    });
    const annualVisible = annualPoints.filter((p) => {
      const t = Date.parse(p[0]);
      return t >= viewT0 && t <= viewT1;
    });

    if (!points.length) {
      const msg = document.createElement("div");
      msg.className = "chart-error";
      msg.textContent = "该时间窗口无数据";
      container.appendChild(msg);
      return;
    }

    const ttmMax = Math.max(...points.map((p) => p[3]));
    const annualMax = annualVisible.length
      ? Math.max(...annualVisible.map((p) => p[3]))
      : 0;
    const pctMax = Math.max(
      ...["p10", "p25", "p50", "p75", "p90"]
        .map((k) => percentiles[k])
        .filter((v) => v !== null && v !== undefined),
      0
    );
    const yMax = Math.max(ttmMax, annualMax, pctMax) * 1.1 || 1;
    const yMin = 0;

    const xOf = (dStrOrTime) => {
      const t = typeof dStrOrTime === "number" ? dStrOrTime : Date.parse(dStrOrTime);
      return PAD_L + ((t - viewT0) / (viewT1 - viewT0)) * innerW;
    };
    const yOf = (v) => PAD_T + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

    // 把 points 按 source 拆段：window 段画实线，carry 段画虚线
    // 边界处让两段共享端点，视觉上无缝衔接（虚线在端点接到实线）
    const segments = [];
    let cur = null;
    let prevValid = null;
    for (const p of points) {
      const src = sourceOf(p);
      if (!cur || cur.source !== src) {
        cur = { source: src, points: prevValid ? [prevValid] : [] };
        segments.push(cur);
      }
      cur.points.push(p);
      prevValid = p;
    }
    function pathD(pts) {
      if (!pts.length) return "";
      let s = `M ${xOf(pts[0][0]).toFixed(1)} ${yOf(pts[0][3]).toFixed(1)}`;
      for (let i = 1; i < pts.length; i++) {
        s += ` L ${xOf(pts[i][0]).toFixed(1)} ${yOf(pts[i][3]).toFixed(1)}`;
      }
      return s;
    }

    const yTicks = [];
    const Y_STEPS = 5;
    for (let i = 0; i <= Y_STEPS; i++) {
      const v = yMin + ((yMax - yMin) * i) / Y_STEPS;
      yTicks.push({ v, y: yOf(v) });
    }

    const xTicks = makeXTicks(viewT0, viewT1, xOf);

    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "yield-chart");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    const bg = document.createElementNS(svgNS, "rect");
    bg.setAttribute("x", PAD_L);
    bg.setAttribute("y", PAD_T);
    bg.setAttribute("width", innerW);
    bg.setAttribute("height", innerH);
    bg.setAttribute("class", "chart-bg");
    svg.appendChild(bg);

    yTicks.forEach((t) => {
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", PAD_L);
      line.setAttribute("x2", W - PAD_R);
      line.setAttribute("y1", t.y);
      line.setAttribute("y2", t.y);
      line.setAttribute("class", "chart-grid");
      svg.appendChild(line);

      const lbl = document.createElementNS(svgNS, "text");
      lbl.setAttribute("x", PAD_L - 6);
      lbl.setAttribute("y", t.y + 4);
      lbl.setAttribute("text-anchor", "end");
      lbl.setAttribute("class", "chart-axis");
      lbl.textContent = t.v.toFixed(1) + "%";
      svg.appendChild(lbl);
    });

    xTicks.forEach((t) => {
      const lbl = document.createElementNS(svgNS, "text");
      lbl.setAttribute("x", t.x);
      lbl.setAttribute("y", H - 10);
      lbl.setAttribute("text-anchor", "middle");
      lbl.setAttribute("class", "chart-axis");
      lbl.textContent = t.label;
      svg.appendChild(lbl);
    });

    const pctLines = [
      { key: "p25", label: "P25" },
      { key: "p50", label: "P50" },
      { key: "p75", label: "P75" },
      { key: "p90", label: "P90" },
    ];
    pctLines.forEach((pl) => {
      const v = percentiles[pl.key];
      if (v === null || v === undefined) return;
      const y = yOf(v);
      if (y < PAD_T || y > PAD_T + innerH) return;
      const line = document.createElementNS(svgNS, "line");
      line.setAttribute("x1", PAD_L);
      line.setAttribute("x2", W - PAD_R);
      line.setAttribute("y1", y);
      line.setAttribute("y2", y);
      line.setAttribute("class", `pct-line pct-line-${pl.key}`);
      svg.appendChild(line);

      const lbl = document.createElementNS(svgNS, "text");
      lbl.setAttribute("x", W - PAD_R + 6);
      lbl.setAttribute("y", y + 4);
      lbl.setAttribute("class", `pct-label pct-label-${pl.key}`);
      lbl.textContent = `${pl.label} ${v.toFixed(2)}%`;
      svg.appendChild(lbl);
    });

    segments.forEach((seg) => {
      if (seg.points.length < 2) return;
      const p = document.createElementNS(svgNS, "path");
      p.setAttribute("d", pathD(seg.points));
      p.setAttribute(
        "class",
        seg.source === "carry" ? "chart-line-carry" : "chart-line"
      );
      svg.appendChild(p);
    });

    // 年化曲线（紫色实线，从 annualVisible 一次性画出）
    if (annualVisible.length >= 2) {
      const annualPath = document.createElementNS(svgNS, "path");
      annualPath.setAttribute("d", pathD(annualVisible));
      annualPath.setAttribute("class", "chart-line-annual");
      svg.appendChild(annualPath);
    }

    // EOD / Live —— 仅在 EOD 在可见窗口内时绘制（TTM 蓝点 + 年化紫点）
    const lastFullPoint = allPoints[allPoints.length - 1];
    const eodT = Date.parse(lastFullPoint[0]);
    if (eodT >= viewT0 && eodT <= viewT1) {
      const eodDot = document.createElementNS(svgNS, "circle");
      eodDot.setAttribute("cx", xOf(lastFullPoint[0]));
      eodDot.setAttribute("cy", yOf(lastFullPoint[3]));
      eodDot.setAttribute("r", 3.5);
      eodDot.setAttribute("class", "chart-eod-dot");
      eodDot.appendChild(
        _svgTitle(`昨收 ${lastFullPoint[0]}\nTTM 股息率 ${lastFullPoint[3].toFixed(2)}%`)
      );
      svg.appendChild(eodDot);
    }
    if (annualVisible.length) {
      const lastAnnual = annualVisible[annualVisible.length - 1];
      const annualDot = document.createElementNS(svgNS, "circle");
      annualDot.setAttribute("cx", xOf(lastAnnual[0]));
      annualDot.setAttribute("cy", yOf(lastAnnual[3]));
      annualDot.setAttribute("r", 3.5);
      annualDot.setAttribute("class", "chart-eod-dot-annual");
      annualDot.appendChild(
        _svgTitle(`昨收 ${lastAnnual[0]}\n年化股息率 ${lastAnnual[3].toFixed(2)}%`)
      );
      svg.appendChild(annualDot);
    }

    // 悬浮元素（双圆点：TTM + 年化）
    const hoverDot = document.createElementNS(svgNS, "circle");
    hoverDot.setAttribute("r", 4);
    hoverDot.setAttribute("class", "chart-hover-dot");
    hoverDot.style.display = "none";
    svg.appendChild(hoverDot);

    const hoverDotAnnual = document.createElementNS(svgNS, "circle");
    hoverDotAnnual.setAttribute("r", 4);
    hoverDotAnnual.setAttribute("class", "chart-hover-dot-annual");
    hoverDotAnnual.style.display = "none";
    svg.appendChild(hoverDotAnnual);

    const hoverLine = document.createElementNS(svgNS, "line");
    hoverLine.setAttribute("class", "chart-hover-line");
    hoverLine.setAttribute("y1", PAD_T);
    hoverLine.setAttribute("y2", PAD_T + innerH);
    hoverLine.style.display = "none";
    svg.appendChild(hoverLine);

    // 拖选矩形
    const brushRect = document.createElementNS(svgNS, "rect");
    brushRect.setAttribute("class", "chart-brush");
    brushRect.setAttribute("y", PAD_T);
    brushRect.setAttribute("height", innerH);
    brushRect.style.display = "none";
    svg.appendChild(brushRect);

    // overlay 必须在最上方接收事件
    const overlay = document.createElementNS(svgNS, "rect");
    overlay.setAttribute("x", PAD_L);
    overlay.setAttribute("y", PAD_T);
    overlay.setAttribute("width", innerW);
    overlay.setAttribute("height", innerH);
    overlay.setAttribute("fill", "transparent");
    overlay.style.cursor = "crosshair";
    svg.appendChild(overlay);

    let brushStart = null;

    function eventToSvgX(ev) {
      const rect = svg.getBoundingClientRect();
      return ((ev.clientX - rect.left) / rect.width) * W;
    }
    function pxToTime(xPx) {
      return viewT0 + ((xPx - PAD_L) / innerW) * (viewT1 - viewT0);
    }

    overlay.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      brushStart = Math.max(PAD_L, Math.min(W - PAD_R, eventToSvgX(ev)));
      brushRect.setAttribute("x", brushStart);
      brushRect.setAttribute("width", 0);
      brushRect.style.display = "";
      hoverDot.style.display = "none";
      hoverDotAnnual.style.display = "none";
      hoverLine.style.display = "none";
      tooltip.style.display = "none";
      ev.preventDefault();
    });

    overlay.addEventListener("mousemove", (ev) => {
      if (brushStart !== null) {
        const cur = Math.max(PAD_L, Math.min(W - PAD_R, eventToSvgX(ev)));
        const x = Math.min(brushStart, cur);
        const w = Math.abs(cur - brushStart);
        brushRect.setAttribute("x", x);
        brushRect.setAttribute("width", w);
        return;
      }
      const xPx = eventToSvgX(ev);
      const targetT = pxToTime(xPx);
      let lo = 0;
      let hi = points.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (Date.parse(points[mid][0]) < targetT) lo = mid + 1;
        else hi = mid;
      }
      const p = points[lo];
      const px = xOf(p[0]);
      const py = yOf(p[3]);
      hoverDot.setAttribute("cx", px);
      hoverDot.setAttribute("cy", py);
      hoverDot.style.display = "";
      hoverLine.setAttribute("x1", px);
      hoverLine.setAttribute("x2", px);
      hoverLine.style.display = "";

      // 同日年化点：用日期 string 索引，避免双 series 长度对不齐时错位
      const ap = annualByDate.get(p[0]);
      let annualLine = "";
      if (ap && ap[3] !== null && ap[3] !== undefined && ap[3] > 0) {
        const apy = yOf(ap[3]);
        hoverDotAnnual.setAttribute("cx", px);
        hoverDotAnnual.setAttribute("cy", apy);
        hoverDotAnnual.style.display = "";
        const yearTag = ap[4] ? ` <span class="muted">(${ap[4]} 年)</span>` : "";
        annualLine = `
          <div class="tt-row">
            <span class="legend-swatch legend-annual"></span>
            年化${yearTag}
            <b class="${yieldClass(ap[3])}" style="margin-left:6px">${fmtNumber(ap[3], 2)}%</b>
            <span class="muted" style="margin-left:6px">每股 ${fmtNumber(ap[2], 4)}</span>
          </div>`;
      } else {
        hoverDotAnnual.style.display = "none";
      }

      const srcLabel = sourceLabel(sourceOf(p));
      const srcLine = srcLabel
        ? `<div class="muted">${srcLabel}</div>`
        : "";
      tooltip.innerHTML = `
        <div class="tt-date">${p[0]}</div>
        <div class="tt-row"><span class="muted">价</span> <b>${fmtNumber(p[1], 2)}</b></div>
        <div class="tt-row">
          <span class="legend-swatch legend-ttm"></span>
          TTM
          <b class="${yieldClass(p[3])}" style="margin-left:6px">${fmtNumber(p[3], 2)}%</b>
          <span class="muted" style="margin-left:6px">近 365 天 ${fmtNumber(p[2], 4)}</span>
        </div>
        ${annualLine}
        ${srcLine}
      `;
      tooltip.style.display = "";
      const wrapRect = wrapEl.getBoundingClientRect();
      tooltip.style.left = ev.clientX - wrapRect.left + 12 + "px";
      tooltip.style.top = ev.clientY - wrapRect.top + 12 + "px";
    });

    overlay.addEventListener("mouseup", (ev) => {
      if (brushStart === null) return;
      const endX = Math.max(PAD_L, Math.min(W - PAD_R, eventToSvgX(ev)));
      const x0 = Math.min(brushStart, endX);
      const x1 = Math.max(brushStart, endX);
      brushStart = null;
      brushRect.style.display = "none";
      if (x1 - x0 < 6) return; // 视为点击
      const t0 = pxToTime(x0);
      const t1 = pxToTime(x1);
      if (t1 - t0 < 86400000 * 7) return; // 至少一周
      onZoom(t0, t1);
    });

    overlay.addEventListener("mouseleave", () => {
      if (brushStart !== null) {
        brushStart = null;
        brushRect.style.display = "none";
      }
      hoverDot.style.display = "none";
      hoverDotAnnual.style.display = "none";
      hoverLine.style.display = "none";
      tooltip.style.display = "none";
    });

    container.appendChild(svg);
  }

  function makeXTicks(viewT0, viewT1, xOf) {
    const spanMs = viewT1 - viewT0;
    const spanDays = spanMs / 86400000;
    const ticks = [];

    if (spanDays > 365 * 5) {
      const startYear = new Date(viewT0).getFullYear();
      const endYear = new Date(viewT1).getFullYear();
      const step = Math.max(1, Math.ceil((endYear - startYear) / 10));
      for (let y = startYear; y <= endYear; y += step) {
        const ts = new Date(y, 0, 1).getTime();
        if (ts < viewT0 || ts > viewT1) continue;
        ticks.push({ label: String(y), x: xOf(ts) });
      }
    } else if (spanDays > 365 * 1.5) {
      const startYear = new Date(viewT0).getFullYear();
      const endYear = new Date(viewT1).getFullYear();
      for (let y = startYear; y <= endYear; y++) {
        for (const m of [1, 7]) {
          const ts = new Date(y, m - 1, 1).getTime();
          if (ts < viewT0 || ts > viewT1) continue;
          ticks.push({ label: m === 1 ? String(y) : `${y}-07`, x: xOf(ts) });
        }
      }
    } else {
      const cur = new Date(viewT0);
      cur.setDate(1);
      cur.setMonth(cur.getMonth() + 1);
      while (cur.getTime() <= viewT1) {
        const ts = cur.getTime();
        const label = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`;
        ticks.push({ label, x: xOf(ts) });
        cur.setMonth(cur.getMonth() + 1);
      }
      if (ticks.length > 12) {
        const step = Math.ceil(ticks.length / 8);
        return ticks.filter((_, i) => i % step === 0);
      }
    }
    return ticks;
  }

  function _svgTitle(text) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "title");
    el.textContent = text;
    return el;
  }

  // -------------------- 持仓摘要条 --------------------
  // 卡片布局下每张卡片自己的 .card-position 块负责显示 per-stock 持仓；
  // 这里只管顶部的总览条。

  function renderPortfolio(portfolio) {
    const bar = document.getElementById("portfolio-bar");
    if (!portfolio) {
      bar.style.display = "none";
      return;
    }
    bar.style.display = "";
    document.getElementById("portfolio-value").textContent =
      "¥ " + fmtMoney(portfolio.total_value);
    document.getElementById("portfolio-cash").textContent =
      "¥ " + fmtMoney(portfolio.annual_cash);
    document.getElementById("portfolio-yield").textContent =
      portfolio.weighted_yield_pct !== null
        ? portfolio.weighted_yield_pct.toFixed(2) + "%"
        : "—";
    document.getElementById("portfolio-count").textContent =
      String(portfolio.stock_count);
  }

  // -------------------- 主刷新循环 --------------------

  async function tick() {
    try {
      const resp = await fetch("/api/yields", { cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.refresh_seconds) refreshSeconds = data.refresh_seconds;
      render(data.rows);
      renderPortfolio(data.portfolio);
      maybeNotify(data.rows);
      lastUpdated.textContent = "上次刷新 " + new Date().toLocaleTimeString();
      statusDot.className = "dot ok";
    } catch (e) {
      statusDot.className = "dot err";
      lastUpdated.textContent = "刷新失败：" + e.message;
    }
  }

  // -------------------- 桌面通知 --------------------

  function notifyEnabled() {
    return (
      notifyToggle &&
      "Notification" in window &&
      Notification.permission === "granted" &&
      localStorage.getItem(NOTIFY_PREF_KEY) === "1"
    );
  }

  function refreshNotifyToggle() {
    if (!notifyToggle) return;
    if (!("Notification" in window)) {
      notifyToggle.style.display = "none";
      return;
    }
    const on = notifyEnabled();
    notifyToggle.textContent = on ? "通知 开" : "通知 关";
    notifyToggle.classList.toggle("notify-on", on);
  }

  function setupNotifyToggle() {
    if (!notifyToggle || !("Notification" in window)) {
      if (notifyToggle) notifyToggle.style.display = "none";
      return;
    }
    notifyToggle.addEventListener("click", async () => {
      if (notifyEnabled()) {
        // 关闭（仅清偏好；浏览器权限本身需用户手动撤销）
        localStorage.setItem(NOTIFY_PREF_KEY, "0");
        notifiedAlerts.clear();
      } else {
        const perm = await Notification.requestPermission();
        if (perm === "granted") {
          localStorage.setItem(NOTIFY_PREF_KEY, "1");
        } else {
          alert("浏览器拒绝了通知权限，无法开启。");
        }
      }
      refreshNotifyToggle();
    });
    refreshNotifyToggle();
  }

  function maybeNotify(rows) {
    if (!notifyEnabled()) return;
    rows.forEach((row) => {
      // 任一口径达到阈值即视为触发；body 同时列出双口径的分位
      const annualHit =
        row.annual_percentile_rank !== null &&
        row.annual_percentile_rank !== undefined &&
        row.annual_percentile_rank >= NOTIFY_THRESHOLD;
      const ttmHit =
        row.percentile_rank !== null &&
        row.percentile_rank !== undefined &&
        row.percentile_rank >= NOTIFY_THRESHOLD;
      const isAlert = annualHit || ttmHit;
      if (!isAlert) {
        notifiedAlerts.delete(row.symbol); // 跌出阈值，下次再进可以重新通知
        return;
      }
      if (notifiedAlerts.has(row.symbol)) return;
      notifiedAlerts.add(row.symbol);
      const annualPart =
        row.annual_percentile_rank !== null && row.annual_percentile_rank !== undefined
          ? `年化 ${row.yield_pct?.toFixed(2)}% · P${Math.round(row.annual_percentile_rank)} ${row.annual_valuation || ""}`
          : null;
      const ttmPart =
        row.percentile_rank !== null && row.percentile_rank !== undefined
          ? `TTM ${row.yield_ttm_pct?.toFixed(2)}% · P${Math.round(row.percentile_rank)} ${row.valuation || ""}`
          : null;
      const body = [annualPart, ttmPart].filter(Boolean).join("\n");
      try {
        new Notification(`${row.name} (${row.symbol}) 历史性低估`, {
          body,
          tag: `dividend-${row.symbol}`,
          icon: "/static/favicon.ico",
        });
      } catch (e) {
        // Notification 构造异常（如不支持），静默
      }
    });
  }

  setupSortToolbar();
  setupNotifyToggle();
  tick();
  setInterval(tick, refreshSeconds * 1000);
})();
