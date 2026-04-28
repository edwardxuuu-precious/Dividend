(function () {
  const cardsGrid = document.getElementById("cards-grid");
  const lastUpdated = document.getElementById("last-updated");
  const statusDot = document.getElementById("status-dot");
  const notifyToggle = document.getElementById("notify-toggle");
  let refreshSeconds =
    parseInt(document.querySelector('meta[name="refresh-seconds"]').content, 10) || 10;

  const NOTIFY_THRESHOLD = 90; // P 分位 ≥ 此值触发通知
  const NOTIFY_PREF_KEY = "dividend-notify-enabled";
  const BANDS_PREF_KEY = "dividend-chart-bands-mode"; // "static" | "rolling"，默认 rolling
  const LINES_PREF_KEY = "dividend-chart-lines-visibility"; // 折线/分位线可见性偏好
  const DEFAULT_LINE_VIS = {
    ttm: true, annual: true, price: true,
    // 静态分位水平线：四档独立开关
    p25: true, p50: true, p75: true, p90: true,
    // 滚动带：3 个视觉组件（外带 P10–P90 / 内带 P25–P75 / 中位 P50），合并开关
    band_outer: true, band_inner: true, band_median: true,
  };
  // 滚动分位窗口长度（年），默认 3 年（与后端 _ROLLING_WINDOW_DAYS = 750 对齐）
  // 改这个值会触发前端 computeRollingBands 重算，覆盖 API 返回的预算 bands
  const WINDOW_PREF_KEY = "dividend-chart-rolling-window-years";
  const DEFAULT_WINDOW_YEARS = 3;
  const TRADING_DAYS_PER_YEAR = 250;
  const ROLLING_PCTS = [10, 25, 50, 75, 90];
  const expanded = new Map(); // symbol -> { detailEl, abortController, liveTimer }
  // 已通知过的 symbol 集合，避免同会话内重复弹窗（每次进入"低估"区只通知 1 次）
  const notifiedAlerts = new Set();

  // 编辑模式：顶部"编辑"按钮触发；普通点击=展开详情，编辑模式下=切换勾选
  let editMode = false;
  const selectedSymbols = new Set();

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

  // 卡片"现价"格内 HTML。
  // 注：单行不再展示 ⏱ HH:MM:SS 拉取失败水印；陈旧状态由右上角全局 statusDot 聚合提示。
  function priceCellHtml(row) {
    if (row.price === null || row.price === undefined) return "¥—";
    return `¥${fmtPrice(row.price, 2)}`;
  }

  // 详情面板"当前价"后缀：仅区分昨收兜底，不再为陈旧行情打 ⏱ 标签。
  function liveSourceHtml(current) {
    if (!current) return "";
    if (current.source !== "live") {
      return '<span class="live-source muted">（昨收）</span>';
    }
    return "";
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

  // 卡片大字口径选择：取年化/TTM 中数值较低者作为主指标（更稳健的视角，不被特别股利抬高）。
  // 两者皆缺失返回 null；只有一个就用那个；相等时默认 annual（避免 tie 时 UI 反复切换）。
  function pickPrimaryYieldKind(row) {
    const a = row.yield_pct;
    const t = row.yield_ttm_pct;
    const aOk = a !== null && a !== undefined;
    const tOk = t !== null && t !== undefined;
    if (!aOk && !tOk) return null;
    if (!aOk) return "ttm";
    if (!tOk) return "annual";
    return t < a ? "ttm" : "annual";
  }

  // 卡片单徽章：只渲染主指标对应的分位/估值，避免年化+TTM 双行徽章过于拥挤。
  function valuationBadgeHtml(row) {
    const primary = pickPrimaryYieldKind(row) || "annual";
    if (primary === "ttm") {
      return singleBadgeHtml(
        "TTM",
        row.percentile_rank,
        row.valuation,
        "TTM 口径分位：当前 TTM 股息率在历史样本中的位置"
      );
    }
    return singleBadgeHtml(
      "年化",
      row.annual_percentile_rank,
      row.annual_valuation,
      "年化口径分位：当前年化股息率在历史样本中的位置"
    );
  }

  // 列表视图专用：分位单独一列。
  // 数字像「年化%」那样平铺呈现，估值状态由一个小圆点 icon 表示，
  // 颜色含义在页脚 legend 里说明（5 档统一）。鼠标 hover 看完整文字。
  function tierStatusCellHtml(rank, label, tooltipPrefix) {
    if (rank === null || rank === undefined) {
      return `<span class="lr-tier"><span class="lr-tier-text muted">—</span></span>`;
    }
    const cls = valuationClass(label);
    const dotTitle = label ? `${tooltipPrefix} · 当前 ${label}` : tooltipPrefix;
    const num = `<span class="lr-tier-text" title="${tooltipPrefix}">P${Math.round(rank)}</span>`;
    const dot = `<span class="lr-status-dot ${cls}" title="${dotTitle}" aria-label="${label || ""}"></span>`;
    return `<span class="lr-tier">${num}${dot}</span>`;
  }
  function valuationAnnualCellHtml(row) {
    return tierStatusCellHtml(
      row.annual_percentile_rank,
      row.annual_valuation,
      "年化口径分位：当前年化股息率在历史样本中的位置"
    );
  }
  function valuationTtmCellHtml(row) {
    return tierStatusCellHtml(
      row.percentile_rank,
      row.valuation,
      "TTM 口径分位：当前 TTM 股息率在历史样本中的位置"
    );
  }

  function yieldHtml(row) {
    const primary = pickPrimaryYieldKind(row);
    if (primary === null) {
      return `<span class="card-yield-error">${row.error || "—"}</span>`;
    }
    const annual = row.yield_pct;
    const ttm = row.yield_ttm_pct;
    const annualOk = annual !== null && annual !== undefined;
    const ttmOk = ttm !== null && ttm !== undefined;
    const unusual = row.annual_unusually_high === true;
    const dy = row.dividend_year ?? "—";
    const annualTitle = unusual
      ? `派息年 ${dy} 合计明显高于历史中位数（含特别股利或节奏过渡），不代表常态化股息率`
      : `年化 = 派息年 ${dy} 累计每股 ÷ 实时价`;
    const ttmTitle = "TTM = 过去 365 天实际除权金额 ÷ 实时价";

    function bigLine(kind) {
      if (kind === "annual") {
        const tagClass = unusual ? "card-yield-tag warn" : "card-yield-tag";
        const tagText = unusual ? "含特别 ⚠" : "年化";
        return `<span class="card-yield ${yieldClass(annual)}" title="${annualTitle}">${fmtNumber(annual, 2)}<span class="unit">%</span><span class="${tagClass}">${tagText}</span></span>`;
      }
      return `<span class="card-yield ${yieldClass(ttm)}" title="${ttmTitle}">${fmtNumber(ttm, 2)}<span class="unit">%</span><span class="card-yield-tag">TTM</span></span>`;
    }

    function smallLine(kind) {
      if (kind === "annual") {
        if (!annualOk) return "";
        const warn = unusual
          ? ` <span class="card-yield-tag warn">含特别 ⚠</span>`
          : "";
        return `<span class="card-yield-ttm ${yieldClass(annual)}" title="${annualTitle}">年化 ${fmtNumber(annual, 2)}<span class="unit-sm">%</span>${warn}</span>`;
      }
      if (!ttmOk) return "";
      return `<span class="card-yield-ttm ${yieldClass(ttm)}" title="${ttmTitle}">TTM ${fmtNumber(ttm, 2)}<span class="unit-sm">%</span></span>`;
    }

    const secondaryKind = primary === "annual" ? "ttm" : "annual";
    return `
      <span class="card-yield-stack">
        ${bigLine(primary)}
        ${smallLine(secondaryKind)}
      </span>`;
  }

  // 列表视图专用：年化股息率单独一列。
  // "含特别" 改成纯图标 + hover tooltip，避免在窄列里挤占空间。
  function yieldAnnualCellHtml(row) {
    if (row.yield_pct === null || row.yield_pct === undefined) {
      return `<span class="card-yield-error">${row.error || "—"}</span>`;
    }
    const unusual = row.annual_unusually_high === true;
    const yieldTitle = `年化 = 派息年 ${row.dividend_year ?? "—"} 累计每股 ÷ 实时价`;
    const warnTitle = `派息年 ${row.dividend_year ?? "—"} 合计明显高于历史中位数（含特别股利或节奏过渡），不代表常态化股息率`;
    const warnIcon = unusual
      ? `<span class="lr-warn-icon" title="${warnTitle}" aria-label="含特别股利警告">⚠</span>`
      : "";
    return `<span class="card-yield ${yieldClass(row.yield_pct)}" title="${unusual ? warnTitle : yieldTitle}">${fmtNumber(row.yield_pct, 2)}<span class="unit">%</span></span>${warnIcon}`;
  }

  // 列表视图专用：TTM 股息率单独一列。
  function yieldTtmCellHtml(row) {
    const ttm = row.yield_ttm_pct;
    if (ttm === null || ttm === undefined) {
      return `<span class="card-yield-ttm muted">—</span>`;
    }
    return `<span class="card-yield-ttm ${yieldClass(ttm)}" title="TTM = 过去 365 天实际除权金额 ÷ 实时价">${fmtNumber(ttm, 2)}<span class="unit-sm">%</span></span>`;
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
    if (viewMode === "list") return buildListRow(row);
    const card = document.createElement("article");
    card.id = cardKey(row);
    card.dataset.symbol = row.symbol;
    card.classList.add("card");
    if (row.error && row.price === null && row.dividend === null) {
      card.classList.add("error");
    }
    card.innerHTML = `
      <div class="card-actions">
        <button type="button" class="btn-icon" data-act="edit" title="编辑" aria-label="编辑">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
        </button>
        <button type="button" class="btn-icon danger" data-act="delete" title="删除" aria-label="删除">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      </div>
      <label class="select-checkbox card-select" aria-hidden="true" tabindex="-1">
        <input type="checkbox" data-act="select" tabindex="-1" />
        <span class="select-box"></span>
      </label>
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
    card.addEventListener("click", (e) => handleCardClick(e, row));
    return card;
  }

  // 列表行 / 卡片共用的点击分派：
  //   - 编辑模式：忽略 detail，单击切换勾选；也阻断单股 edit/delete 按钮（仍 stopPropagation）
  //   - 普通模式：按钮触发对应 modal，否则展开详情
  function handleCardClick(e, row) {
    const actBtn = e.target.closest('[data-act]');
    if (editMode) {
      // 编辑模式下整张卡/行视为一块勾选区；按钮和 input 都不再单独响应（避免误操作）
      if (actBtn) e.stopPropagation();
      toggleSelected(row.symbol);
      return;
    }
    if (actBtn) {
      e.stopPropagation();
      const act = actBtn.dataset.act;
      if (act === "edit") openEditModal(row);
      else if (act === "delete") openDeleteModal(row);
      return;
    }
    toggleDetail(row.symbol, row.name);
  }

  function buildListRow(row) {
    const el = document.createElement("article");
    el.id = cardKey(row);
    el.dataset.symbol = row.symbol;
    el.classList.add("list-row");
    if (row.error && row.price === null && row.dividend === null) {
      el.classList.add("error");
    }
    el.innerHTML = `
      <div class="lr-name">
        <label class="select-checkbox" aria-hidden="true" tabindex="-1">
          <input type="checkbox" data-act="select" tabindex="-1" />
          <span class="select-box"></span>
        </label>
        <div class="lr-name-text">
          <span class="lr-stock">${row.name}</span>
          <span class="lr-symbol">${row.symbol}</span>
        </div>
      </div>
      <div class="lr-cell" data-field="yield-annual">${yieldAnnualCellHtml(row)}</div>
      <div class="lr-cell" data-field="yield-ttm">${yieldTtmCellHtml(row)}</div>
      <div class="lr-cell" data-field="valuation-annual">${valuationAnnualCellHtml(row)}</div>
      <div class="lr-cell lr-hide-md" data-field="valuation-ttm">${valuationTtmCellHtml(row)}</div>
      <div class="lr-cell" data-field="price">${priceCellHtml(row)}</div>
      <div class="lr-cell"><b data-field="dividend">¥${fmtPrice(row.dividend, 4)}</b></div>
      <div class="lr-cell lr-hide-sm"><b data-field="year">${row.dividend_year ?? "—"}</b></div>
    `;
    el.addEventListener("click", (e) => handleCardClick(e, row));
    return el;
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

    // 卡片视图：合并的 yield / valuation
    if (card.querySelector('[data-field="yield"]')) {
      setHtml('[data-field="yield"]', yieldHtml(row));
    }
    if (card.querySelector('[data-field="valuation"]')) {
      setHtml('[data-field="valuation"]', valuationBadgeHtml(row));
    }
    // 列表视图：拆分后的四个独立列
    if (card.querySelector('[data-field="yield-annual"]')) {
      setHtml('[data-field="yield-annual"]', yieldAnnualCellHtml(row));
    }
    if (card.querySelector('[data-field="yield-ttm"]')) {
      setHtml('[data-field="yield-ttm"]', yieldTtmCellHtml(row));
    }
    if (card.querySelector('[data-field="valuation-annual"]')) {
      setHtml('[data-field="valuation-annual"]', valuationAnnualCellHtml(row));
    }
    if (card.querySelector('[data-field="valuation-ttm"]')) {
      setHtml('[data-field="valuation-ttm"]', valuationTtmCellHtml(row));
    }
    setHtml('[data-field="price"]', priceCellHtml(row));
    setText('[data-field="dividend"]', "¥" + fmtPrice(row.dividend, 4));
    setText('[data-field="year"]', row.dividend_year ?? "—");
    setText('[data-field="time"]', fmtTime(row.updated_at));

    // 持仓块需要整体替换（内含多元素）—— 仅卡片视图渲染（list-row 没有 .card-time）
    const cardTime = card.querySelector(".card-time");
    if (cardTime) {
      const existingPos = card.querySelector('[data-field="position"]');
      const newPos = positionHtml(row);
      if (existingPos && !newPos) {
        existingPos.remove();
        changed = true;
      } else if (!existingPos && newPos) {
        cardTime.insertAdjacentHTML("beforebegin", newPos);
        changed = true;
      } else if (existingPos && newPos && existingPos.outerHTML !== newPos) {
        existingPos.outerHTML = newPos;
        changed = true;
      }
    }

    if (changed) {
      card.classList.remove("flash");
      void card.offsetWidth;
      card.classList.add("flash");
    }
  }

  // -------------------- 排序 + 视图 --------------------

  const SORT_KEY_PREF = "dividend-sort-key";
  const SORT_DIR_PREF = "dividend-sort-desc";
  const VIEW_MODE_PREF = "dividend-view-mode";
  const TEXT_SORT_KEYS = ["symbol", "name"];

  // 默认按年化股息率降序
  let sortKey = localStorage.getItem(SORT_KEY_PREF) || "yield_pct";
  let sortDesc = localStorage.getItem(SORT_DIR_PREF) !== "false";
  let viewMode = localStorage.getItem(VIEW_MODE_PREF) === "list" ? "list" : "cards";
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
    const select = document.getElementById("sort-key");
    const dirBtn = document.getElementById("sort-dir");
    const viewToggle = document.getElementById("view-toggle");

    if (select) {
      select.value = sortKey;
      select.addEventListener("change", () => {
        sortKey = select.value;
        sortDesc = !TEXT_SORT_KEYS.includes(sortKey);
        persistSortPrefs();
        updateSortIndicators();
        if (lastRows.length) render(lastRows);
      });
    }
    if (dirBtn) {
      dirBtn.addEventListener("click", () => {
        sortDesc = !sortDesc;
        persistSortPrefs();
        updateSortIndicators();
        if (lastRows.length) render(lastRows);
      });
    }
    if (viewToggle) {
      viewToggle.querySelectorAll(".view-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const mode = btn.dataset.view;
          if (mode && mode !== viewMode) {
            switchViewMode(mode);
          }
        });
      });
    }
    applyViewMode();
    updateSortIndicators();
  }

  function persistSortPrefs() {
    localStorage.setItem(SORT_KEY_PREF, sortKey);
    localStorage.setItem(SORT_DIR_PREF, String(sortDesc));
  }

  function updateSortIndicators() {
    const dirBtn = document.getElementById("sort-dir");
    if (dirBtn) {
      dirBtn.textContent = sortDesc ? "▼" : "▲";
      dirBtn.title = sortDesc ? "当前：降序（点击切换升序）" : "当前：升序（点击切换降序）";
    }
  }

  function listHeaderHtml() {
    return `
      <div class="list-header">
        <div class="lh-cell lh-name">股票</div>
        <div class="lh-cell" title="年化股息率：派息年累计每股 ÷ 实时价">年化%</div>
        <div class="lh-cell" title="TTM 股息率：过去 365 天实际除权金额 ÷ 实时价">TTM%</div>
        <div class="lh-cell" title="年化口径分位 + 高低估状态">年化分位</div>
        <div class="lh-cell lr-hide-md" title="TTM 口径分位 + 高低估状态">TTM 分位</div>
        <div class="lh-cell">现价</div>
        <div class="lh-cell">每股</div>
        <div class="lh-cell lr-hide-sm">派息年</div>
      </div>
    `;
  }

  function ensureListHeader() {
    let header = cardsGrid.querySelector(":scope > .list-header");
    if (viewMode === "list") {
      if (!header) {
        cardsGrid.insertAdjacentHTML("afterbegin", listHeaderHtml());
      }
    } else if (header) {
      header.remove();
    }
  }

  function applyViewMode() {
    cardsGrid.classList.toggle("view-list", viewMode === "list");
    document.querySelectorAll("#view-toggle .view-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === viewMode);
    });
    ensureListHeader();
  }

  function switchViewMode(mode) {
    // 切换前先关闭所有展开的详情面板（避免两种布局间的视觉错位）
    Array.from(expanded.keys()).forEach((symbol) => {
      const ctx = expanded.get(symbol);
      ctx.abortController.abort();
      if (ctx.liveTimer) clearInterval(ctx.liveTimer);
      ctx.detailEl.remove();
      expanded.delete(symbol);
    });
    // 清空所有卡片/行，重新渲染
    cardsGrid.innerHTML = "";
    viewMode = mode;
    localStorage.setItem(VIEW_MODE_PREF, viewMode);
    applyViewMode();
    if (lastRows.length) render(lastRows);
  }

  function render(rows) {
    lastRows = rows;
    const sorted = [...rows].sort(compareRows);
    // watchlist 中已不存在的 symbol 从勾选集中剔除（外部删除 / 批量删除后回流）
    const live = new Set(sorted.map((r) => r.symbol));
    Array.from(selectedSymbols).forEach((s) => {
      if (!live.has(s)) selectedSymbols.delete(s);
    });
    // DOM 中已不存在于 rows 的卡片直接移除（批量删除后立即生效，不必等到下一 tick）
    cardsGrid.querySelectorAll(".card, .list-row").forEach((el) => {
      if (el.dataset.symbol && !live.has(el.dataset.symbol)) el.remove();
    });
    // 创建/更新卡片
    sorted.forEach((row) => {
      const existing = document.getElementById(cardKey(row));
      if (existing) {
        updateCard(existing, row);
      } else {
        const loading = cardsGrid.querySelector(".cards-loading");
        if (loading) loading.remove();
        const fresh = buildCard(row);
        cardsGrid.appendChild(fresh);
        syncCardSelection(fresh, row.symbol);
      }
    });
    if (editMode) updateEditToolbarCount();
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
                <div class="lapsed-badge"></div>
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

    // summary-meta 里的"当前价" + 行情陈旧水印
    const meta = dr.querySelector(".summary-meta");
    if (meta && current.live_price) {
      const priceEl = meta.querySelector(".live-price");
      if (priceEl) priceEl.textContent = fmtNumber(current.live_price, 2);
      const wrap = meta.querySelector(".live-source-wrap");
      if (wrap) wrap.innerHTML = liveSourceHtml(current);
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

  function escapeHtml(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderLapsedDetailPanel(summary) {
    const segments = summary.segments || [];
    const threshold = summary.stale_threshold_days;
    const intro = `
      <div class="lapsed-detail-intro">
        判定规则：相邻两次除权之间间隔超过 <b>${threshold}</b> 天的区间，视为一段"派息断流"。
        TTM 在断流期间会被强制置 0（因为窗口里没有真实分红支撑）；折线图上对应位置以断点呈现。
      </div>`;

    if (segments.length === 0) {
      return `<div class="lapsed-detail-panel" hidden>${intro}<div class="lapsed-detail-empty muted">未取到段明细。</div></div>`;
    }

    const headerRow = `
      <div class="lapsed-detail-thead">
        <div>段号</div>
        <div>起止区间</div>
        <div>跨度</div>
        <div>触发（上一次派息）</div>
        <div>恢复（重启派息）</div>
      </div>`;

    const rows = segments
      .map((seg, i) => {
        const days = seg.days;
        const spanCell = (days !== null && days !== undefined)
          ? `<b>${days}</b> <span class="muted">天 (≈${(days / 365).toFixed(1)} 年)</span>`
          : "—";
        const triggerCell = seg.prev_ex_date
          ? `<b>${escapeHtml(seg.prev_ex_date)}</b> <span class="muted">+ ${threshold} 天未派息</span>`
          : `<span class="muted">首次除权前</span>`;
        const resumedCell = seg.ongoing
          ? `<span class="lapsed-detail-ongoing">⚠ 至今未恢复</span>`
          : seg.resumed_ex_date
            ? `<b>${escapeHtml(seg.resumed_ex_date)}</b>`
            : "—";
        const rangeCell = `${escapeHtml(seg.start_date || "—")} <span class="muted">→</span> ${escapeHtml(seg.end_date || "—")}`;
        return `
          <div class="lapsed-detail-row${seg.ongoing ? " is-ongoing" : ""}">
            <div class="lapsed-detail-no">第 ${i + 1} 段</div>
            <div class="lapsed-detail-range">${rangeCell}</div>
            <div class="lapsed-detail-span">${spanCell}</div>
            <div class="lapsed-detail-trigger">${triggerCell}</div>
            <div class="lapsed-detail-resumed">${resumedCell}</div>
          </div>`;
      })
      .join("");

    return `
      <div class="lapsed-detail-panel" hidden>
        ${intro}
        <div class="lapsed-detail-table">${headerRow}${rows}</div>
        <div class="lapsed-detail-footer muted">
          数据来源：本地按交易日逐日扫描的 TTM series（source=lapsed 的连续段），与上方折线图断点一一对应。
        </div>
      </div>`;
  }

  function renderLapsedBadge(summary) {
    if (!summary) return "";
    const days = summary.days_since_last_ex;
    const threshold = summary.stale_threshold_days;
    const segCount = summary.historical_lapsed_count || 0;

    let triggerHtml = "";
    if (summary.currently_lapsed) {
      const monthsTxt = days ? `（距上次除权 ${days} 天，约 ${(days / 30).toFixed(0)} 个月）` : "";
      const tip = `超过 ${threshold} 天未派息，TTM 已置 0。点击查看明细`;
      triggerHtml = `<button type="button" class="lapsed-tag lapsed-current lapsed-clickable" aria-expanded="false" title="${tip}">⚠ 已停止分红 ${monthsTxt}<span class="lapsed-caret" aria-hidden="true">▾</span></button>`;
    } else if (segCount > 0) {
      const tip = `历史曾出现 ${segCount} 段超过 ${threshold} 天的派息空窗，点击查看每段起止与触发原因`;
      triggerHtml = `<button type="button" class="lapsed-tag lapsed-history lapsed-clickable" aria-expanded="false" title="${tip}">历史曾断流 ${segCount} 次<span class="lapsed-caret" aria-hidden="true">▾</span></button>`;
    } else {
      return "";
    }

    return triggerHtml + renderLapsedDetailPanel(summary);
  }

  function wireLapsedBadge(rootEl) {
    if (!rootEl) return;
    const trigger = rootEl.querySelector(".lapsed-clickable");
    const panel = rootEl.querySelector(".lapsed-detail-panel");
    if (!trigger || !panel) return;
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = trigger.getAttribute("aria-expanded") === "true";
      const next = !isOpen;
      trigger.setAttribute("aria-expanded", String(next));
      panel.hidden = !next;
      trigger.classList.toggle("is-open", next);
    });
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
      detailRow.querySelector(".summary-meta").innerHTML = `
        当前价 <b class="live-price">${fmtNumber(current.live_price, 2)}</b><span class="live-source-wrap">${liveSourceHtml(current)}</span> ·
        TTM 历史最高 ${fmtNumber(max, 2)}% (${maxDate}) ·
        最低 ${fmtNumber(min, 2)}% ·
        共 ${series.length.toLocaleString()} 个交易日
      `;

      const lapsedEl = detailRow.querySelector(".lapsed-badge");
      lapsedEl.innerHTML = renderLapsedBadge(lapsedSummary);
      lapsedEl.style.display = lapsedEl.innerHTML ? "" : "none";
      wireLapsedBadge(lapsedEl);
    }

    // ---------- 折线图（双线：TTM + 年化，含双 EOD 点） ----------
    const chartWrap = detailRow.querySelector(".chart-wrap");
    chartWrap.innerHTML = "";
    if (series.length > 0) {
      chartWrap.appendChild(
        buildChart(series, percentiles, annualSeries, {
          bands: data.bands || [],
          annualBands: data.annual_bands || [],
        }).element
      );
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
        .map((e) => {
          const tag = e.unusual
            ? ` <span class="event-unusual-tag" title="该派息年合计较历史中位数高 ≥50%（含特别股利或节奏过渡），不代表常态化股息率">含特别 ⚠</span>`
            : "";
          const trCls = e.unusual ? ' class="event-unusual-row"' : "";
          return `<tr${trCls}><td>${e.ex_date}${tag}</td><td class="num">${fmtNumber(
            e.cash_per_share,
            4
          )}</td></tr>`;
        })
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

    const tier = (cls, label, badge, cash, note) => `
      <div class="forecast-tier ${cls}">
        <div class="tier-head">
          <span class="tier-label">${label}</span>
          ${badge ? `<span class="badge-base">${badge}</span>` : ""}
          <span class="tier-note">${note}</span>
        </div>
        <div class="tier-metrics">
          <div class="tier-metric tier-metric-yield">
            <div class="tier-metric-num">${projYield(cash)}</div>
            <div class="tier-metric-cap">按现价折算</div>
          </div>
          <div class="tier-metric-sep"></div>
          <div class="tier-metric tier-metric-cash">
            <div class="tier-metric-num">${fmtNumber(cash, 2)}<span class="tier-metric-unit"> 元/股</span></div>
            <div class="tier-metric-cap">预估分红</div>
          </div>
        </div>
      </div>
    `;

    return `
      <h3 class="section-title">
        ${forecast.next_year} 年分红预估
        <span class="conf-pill ${confClass}">置信度 ${conf}</span>
      </h3>
      <div class="forecast-grid">
        ${tier("conservative", "保守", "", forecast.conservative, "与去年持平")}
        ${tier("mid highlight", "中位", "推荐", forecast.mid, `近 3 年均速 ${fmtNumber(forecast.avg_yoy_3y, 1)}%`)}
        ${tier("optimistic", "乐观", "", forecast.optimistic, "近 3 年最高 YoY")}
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
    const moreHint =
      annual.length > 10
        ? `<div class="annual-more-hint muted">默认显示最近 10 年，向下滑动查看更早年度</div>`
        : "";
    return `
      <h3 class="section-title">年度分红 <span class="muted">(每股合计)</span></h3>
      <div class="annual-grid">
        <table class="events-table annual-table">
          <thead><tr><th>年度</th><th class="num">每股 (元)</th><th class="num">同比</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${moreHint}
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

  // ---------- JS 版滚动分位带 ----------
  // 镜像 history_service.py:compute_rolling_bands。仅当用户改了窗口长度时才在前端重算，
  // 默认 3 年直接用 API 返回的 bands（首屏零计算）。
  // O(n × log w + n × w) — 6651×750 实测 ~150ms，可接受。
  function _insortAsc(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < x) lo = mid + 1; else hi = mid;
    }
    arr.splice(lo, 0, x);
  }
  function _bisectLeftJs(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
  }
  function _interpPctRow(sortedWindow) {
    const m = sortedWindow.length;
    return ROLLING_PCTS.map((pct) => {
      const rank = (pct / 100) * (m - 1);
      const lo = Math.floor(rank);
      const hi = Math.min(lo + 1, m - 1);
      const frac = rank - lo;
      return Math.round((sortedWindow[lo] * (1 - frac) + sortedWindow[hi] * frac) * 100) / 100;
    });
  }
  function _computeRollingBandsCore(items, windowDays, minSamples, isValidSample) {
    const n = items.length;
    const out = [];
    const sortedWindow = [];
    const fifo = []; // {idx, val|null}，按插入序
    let head = 0;
    for (let i = 0; i < n; i++) {
      const p = items[i];
      const ypct = p && p.length >= 4 ? p[3] : null;
      const ok = ypct != null && ypct > 0 && isValidSample(p);
      if (ok) {
        _insortAsc(sortedWindow, ypct);
        fifo.push({ idx: i, val: ypct });
      } else {
        fifo.push({ idx: i, val: null });
      }
      const cutoff = i - windowDays + 1;
      while (head < fifo.length && fifo[head].idx < cutoff) {
        const old = fifo[head];
        head++;
        if (old.val != null) {
          const j = _bisectLeftJs(sortedWindow, old.val);
          if (j < sortedWindow.length && sortedWindow[j] === old.val) {
            sortedWindow.splice(j, 1);
          }
        }
      }
      if (sortedWindow.length < minSamples) {
        out.push([null, null, null, null, null]);
      } else {
        out.push(_interpPctRow(sortedWindow));
      }
    }
    return out;
  }
  // TTM series 元素 [date, close, ttm_dividend, yield_pct, source]：仅 source==="window" 入样本
  function computeRollingBandsTtmJs(series, windowDays, minSamples) {
    return _computeRollingBandsCore(series, windowDays, minSamples, (p) => {
      const src = p.length >= 5 ? (p[4] || "window") : "window";
      return src === "window";
    });
  }
  // 年化 series 元素 [date, close, annual_dividend, annual_yield_pct, annual_year]：annual_year 非 null 入样本
  function computeRollingBandsAnnualJs(annualSeries, windowDays, minSamples) {
    return _computeRollingBandsCore(annualSeries, windowDays, minSamples, (p) => {
      return p.length >= 5 && p[4] !== null && p[4] !== undefined;
    });
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

  function loadLineVis() {
    try {
      const obj = JSON.parse(localStorage.getItem(LINES_PREF_KEY) || "{}");
      return { ...DEFAULT_LINE_VIS, ...obj };
    } catch (e) {
      return { ...DEFAULT_LINE_VIS };
    }
  }
  function saveLineVis(vis) {
    try { localStorage.setItem(LINES_PREF_KEY, JSON.stringify(vis)); } catch (e) {}
  }

  function buildChart(series, percentiles = {}, annualSeries = [], opts = {}) {
    const rawBandsDefault = opts.bands || [];          // 后端预算的 3 年带，首屏直接用
    const rawAnnualBandsDefault = opts.annualBands || [];
    // 剔除 lapsed / pre_first（视为图上的断点），保留 window + carry
    // 同时记下每个 allPoints 对应的原始 series 下标，以便 bands 同步对齐
    const allPoints = [];
    const allPointsSrcIdx = [];
    series.forEach((p, i) => {
      if (p[3] === null) return;
      const src = sourceOf(p);
      if (src !== "window" && src !== "carry") return;
      allPoints.push(p);
      allPointsSrcIdx.push(i);
    });
    // 年化：剔除 yield_pct = null/0（pre_first 期）的点
    const annualPoints = [];
    const annualPointsSrcIdx = [];
    annualSeries.forEach((p, i) => {
      if (p[3] === null || p[3] === undefined || p[3] <= 0) return;
      annualPoints.push(p);
      annualPointsSrcIdx.push(i);
    });
    // 同日索引：tooltip 锚定 TTM 日期后能立刻查到对应年化点
    const annualByDate = new Map(annualPoints.map((p) => [p[0], p]));

    // 滚动带数组：跟着 windowYears 变。默认 3y 用后端预算的；改了就在 JS 里重算。
    // 用 let 而非 const，因为 applyWindowYears 会重新赋值；rebuild() 通过闭包每次取最新引用。
    let allBands = [];
    let annualBands = [];
    let windowYears = parseFloat(localStorage.getItem(WINDOW_PREF_KEY));
    if (!isFinite(windowYears) || windowYears < 0.5 || windowYears > 10) {
      windowYears = DEFAULT_WINDOW_YEARS;
    }
    function applyWindowYears(years) {
      let rawTtm, rawAnn;
      const usingDefault = years === DEFAULT_WINDOW_YEARS
        && rawBandsDefault.length === series.length
        && rawAnnualBandsDefault.length === annualSeries.length;
      if (usingDefault) {
        rawTtm = rawBandsDefault;
        rawAnn = rawAnnualBandsDefault;
      } else {
        const windowDays = Math.max(60, Math.round(years * TRADING_DAYS_PER_YEAR));
        const minSamples = Math.max(60, Math.floor(windowDays / 3));
        rawTtm = computeRollingBandsTtmJs(series, windowDays, minSamples);
        rawAnn = computeRollingBandsAnnualJs(annualSeries, windowDays, minSamples);
      }
      allBands = allPointsSrcIdx.map((i) => rawTtm[i] || null);
      annualBands = annualPointsSrcIdx.map((i) => rawAnn[i] || null);
    }
    applyWindowYears(windowYears);

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

    // 可见性图例：每条曲线/分位线都是一个独立 chip，点击切换显示
    const lineVis = loadLineVis();
    const legend = document.createElement("span");
    legend.className = "chart-legend";
    bar.appendChild(legend);

    // 分位模式切换：静态全历史水平线 / 滚动 750 日带状区
    let bandsMode = localStorage.getItem(BANDS_PREF_KEY) || "rolling";
    const hasBands = allBands.some((b) => b && b[0] != null);
    if (!hasBands && bandsMode === "rolling") {
      // 后端字段缺失或全 null（如冷启动期、上市不足 1 年），本次渲染回退到静态，但不持久化
      bandsMode = "static";
    }
    const bandsToggleWrap = document.createElement("span");
    bandsToggleWrap.className = "chart-bands-toggle";
    const bandsBtns = [
      { mode: "static", label: "静态分位" },
      { mode: "rolling", label: "滚动分位" },
    ].map(({ mode, label }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chart-btn chart-btn-bands";
      btn.textContent = label;
      btn.classList.toggle("active", mode === bandsMode);
      btn.addEventListener("click", () => {
        if (bandsMode === mode) return;
        bandsMode = mode;
        localStorage.setItem(BANDS_PREF_KEY, mode);
        bandsBtns.forEach((b) => b.btn.classList.toggle("active", b.mode === mode));
        applyLegendModeVisibility();
        updateWindowInputVisibility();
        rebuild();
      });
      bandsToggleWrap.appendChild(btn);
      return { mode, btn };
    });
    bar.appendChild(bandsToggleWrap);

    // 滚动窗口长度手动输入：年。默认 3，仅在 rolling 模式下显示。
    // 改值时在前端 JS 里重算 bands（不重新请求后端），即时生效。
    const windowInputWrap = document.createElement("span");
    windowInputWrap.className = "chart-window-wrap";
    const windowInputLabel = document.createElement("span");
    windowInputLabel.className = "chart-window-label muted";
    windowInputLabel.textContent = "窗口";
    const windowInput = document.createElement("input");
    windowInput.type = "number";
    windowInput.className = "chart-window-input";
    windowInput.min = "0.5";
    windowInput.max = "10";
    windowInput.step = "0.5";
    windowInput.value = String(windowYears);
    windowInput.title = "滚动分位窗口长度（年）。0.5–10，每 0.5 年一档。改值即时在前端重算 P10–P90，无需后端请求。";
    const windowInputUnit = document.createElement("span");
    windowInputUnit.className = "chart-window-unit muted";
    windowInputUnit.textContent = "年";
    windowInputWrap.appendChild(windowInputLabel);
    windowInputWrap.appendChild(windowInput);
    windowInputWrap.appendChild(windowInputUnit);
    function updateWindowInputVisibility() {
      windowInputWrap.style.display = bandsMode === "rolling" ? "" : "none";
    }
    function commitWindowChange() {
      let v = parseFloat(windowInput.value);
      if (!isFinite(v)) v = DEFAULT_WINDOW_YEARS;
      v = Math.max(0.5, Math.min(10, Math.round(v * 2) / 2)); // 吸到 0.5 倍数
      windowInput.value = String(v);
      if (v === windowYears) return;
      windowYears = v;
      localStorage.setItem(WINDOW_PREF_KEY, String(v));
      applyWindowYears(v);
      rebuild();
    }
    windowInput.addEventListener("change", commitWindowChange);
    windowInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commitWindowChange(); windowInput.blur(); }
    });
    updateWindowInputVisibility();
    bar.appendChild(windowInputWrap);

    // legend chip：scope=any 始终显示；scope=rolling 仅滚动模式显示；scope=static 仅静态模式显示
    // 滚动带视觉只有 3 层（外带/内带/中位），所以滚动模式下用 3 个组件 chip 而非 5 个分位 chip
    // 静态模式仍是 4 条独立水平线，保留 P25/P50/P75/P90 各自的 chip
    const legendDefs = [
      { key: "ttm",         label: "TTM 365 天滚动", swatch: "legend-ttm",         scope: "any" },
      { key: "annual",      label: "年化派息年累计", swatch: "legend-annual",      scope: "any" },
      { key: "price",       label: "股价 (右轴)",     swatch: "legend-price",       scope: "any" },
      { key: "band_outer",  label: "外带 P10–P90",   swatch: "legend-band-outer",  scope: "rolling" },
      { key: "band_inner",  label: "内带 P25–P75",   swatch: "legend-band-inner",  scope: "rolling" },
      { key: "band_median", label: "中位 P50",        swatch: "legend-band-median", scope: "rolling" },
      { key: "p25",         label: "P25",             swatch: "legend-p25",         scope: "static" },
      { key: "p50",         label: "P50",             swatch: "legend-p50",         scope: "static" },
      { key: "p75",         label: "P75",             swatch: "legend-p75",         scope: "static" },
      { key: "p90",         label: "P90",             swatch: "legend-p90",         scope: "static" },
    ];
    const legendChips = legendDefs.map((def) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "legend-chip";
      chip.title = `点击切换 ${def.label} 显示`;
      chip.innerHTML =
        `<span class="legend-swatch ${def.swatch}"></span>` +
        `<span class="legend-label">${def.label}</span>`;
      const sync = () => chip.classList.toggle("off", !lineVis[def.key]);
      sync();
      chip.addEventListener("click", () => {
        lineVis[def.key] = !lineVis[def.key];
        sync();
        saveLineVis(lineVis);
        rebuild();
      });
      legend.appendChild(chip);
      return { ...def, el: chip };
    });
    function applyLegendModeVisibility() {
      legendChips.forEach((c) => {
        if (c.scope === "static") {
          c.el.style.display = bandsMode === "static" ? "" : "none";
        } else if (c.scope === "rolling") {
          c.el.style.display = bandsMode === "rolling" ? "" : "none";
        }
      });
    }
    applyLegendModeVisibility();

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
        bandsMode,
        allBands,
        annualBands,
        windowYears,
        viewT0,
        viewT1,
        onZoom: setRange,
        lineVis,
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
    bandsMode = "static",
    allBands = [],
    annualBands = [],
    windowYears = DEFAULT_WINDOW_YEARS,
    viewT0,
    viewT1,
    onZoom,
    lineVis = DEFAULT_LINE_VIS,
  }) {
    const visTTM = lineVis.ttm !== false;
    const visAnnual = lineVis.annual !== false;
    const visPrice = lineVis.price !== false;
    const visPct = (k) => lineVis[k] !== false;
    const svgNS = "http://www.w3.org/2000/svg";
    const W = 960;
    const H = 280;
    const PAD_L = 50;
    const PAD_R = 70; // 增宽：右侧腾出空间给股价右轴
    const PAD_T = 16;
    const PAD_B = 28;
    const innerW = W - PAD_L - PAD_R;
    const innerH = H - PAD_T - PAD_B;

    // 视口内 points + bands 同步对齐（按相同的 viewT0..viewT1 过滤）
    const points = [];
    const visibleBands = [];
    allPoints.forEach((p, i) => {
      const t = Date.parse(p[0]);
      if (t >= viewT0 && t <= viewT1) {
        points.push(p);
        visibleBands.push(allBands[i] || null);
      }
    });
    const annualVisible = [];
    const annualVisibleBands = [];
    annualPoints.forEach((p, i) => {
      const t = Date.parse(p[0]);
      if (t >= viewT0 && t <= viewT1) {
        annualVisible.push(p);
        annualVisibleBands.push(annualBands[i] || null);
      }
    });

    if (!points.length) {
      const msg = document.createElement("div");
      msg.className = "chart-error";
      msg.textContent = "该时间窗口无数据";
      container.appendChild(msg);
      return;
    }

    // 滚动模式 tooltip 用：按日期反查年化带（年化 series 与 TTM 不一定逐行对齐，所以只能按日期 join）
    const annualBandByDate = new Map();
    annualVisible.forEach((p, i) => {
      const b = annualVisibleBands[i];
      if (b && b[0] != null) annualBandByDate.set(p[0], b);
    });

    const ttmMax = visTTM ? Math.max(...points.map((p) => p[3])) : 0;
    const annualMax = visAnnual && annualVisible.length
      ? Math.max(...annualVisible.map((p) => p[3]))
      : 0;
    // 静态分位模式下，仅当对应分位线开启时才参与 y 轴上界
    let pctMax = 0;
    if (bandsMode === "static") {
      ["p25", "p50", "p75", "p90"].forEach((k) => {
        if (!visPct(k)) return;
        const v = percentiles[k];
        if (v !== null && v !== undefined && v > pctMax) pctMax = v;
      });
    }
    // 滚动模式下取实际会绘制的最高组件作为 y 轴上界候选：
    //   外带开 → 用 P90 (idx 4)；否则内带开 → 用 P75 (idx 3)；否则中位开 → P50 (idx 2)；都关 → 跳过
    let bandsMax = 0;
    if (bandsMode === "rolling") {
      let topIdx = -1;
      if (visPct("band_outer")) topIdx = 4;
      else if (visPct("band_inner")) topIdx = 3;
      else if (visPct("band_median")) topIdx = 2;
      if (topIdx >= 0) {
        const collect = (arr) =>
          arr.forEach((b) => {
            const v = b && b[topIdx];
            if (v != null && v > bandsMax) bandsMax = v;
          });
        if (visTTM) collect(visibleBands);
        if (visAnnual) collect(annualVisibleBands);
      }
    }
    const yMax = Math.max(ttmMax, annualMax, pctMax, bandsMax) * 1.1 || 1;
    const yMin = 0;

    // 右轴：股价范围。可见窗口内取 min/max，再加 8% padding；不强制零基线（股价没有零基线含义）
    let priceMin = Infinity;
    let priceMax = -Infinity;
    for (const p of points) {
      const v = p[1];
      if (v != null && v > 0) {
        if (v < priceMin) priceMin = v;
        if (v > priceMax) priceMax = v;
      }
    }
    const hasPrice = visPrice && priceMin !== Infinity && priceMax > 0;
    let priceLow = 0;
    let priceHigh = 1;
    if (hasPrice) {
      const span = Math.max(priceMax - priceMin, priceMax * 0.02);
      const pad = span * 0.08;
      priceLow = Math.max(0, priceMin - pad);
      priceHigh = priceMax + pad;
    }

    const xOf = (dStrOrTime) => {
      const t = typeof dStrOrTime === "number" ? dStrOrTime : Date.parse(dStrOrTime);
      return PAD_L + ((t - viewT0) / (viewT1 - viewT0)) * innerW;
    };
    const yOf = (v) => PAD_T + innerH - ((v - yMin) / (yMax - yMin)) * innerH;
    const yPriceOf = (v) => PAD_T + innerH - ((v - priceLow) / (priceHigh - priceLow)) * innerH;

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

    // 右轴：股价刻度（与左轴 grid 共用横线，仅追加文字）
    if (hasPrice) {
      const priceFmt = (v) => {
        if (v >= 1000) return v.toFixed(0);
        if (v >= 100) return v.toFixed(1);
        return v.toFixed(2);
      };
      for (let i = 0; i <= Y_STEPS; i++) {
        const v = priceLow + ((priceHigh - priceLow) * i) / Y_STEPS;
        const y = PAD_T + innerH - ((v - priceLow) / (priceHigh - priceLow)) * innerH;
        const lbl = document.createElementNS(svgNS, "text");
        lbl.setAttribute("x", W - 6);
        lbl.setAttribute("y", y + 4);
        lbl.setAttribute("text-anchor", "end");
        lbl.setAttribute("class", "chart-axis chart-axis-price");
        lbl.textContent = "¥" + priceFmt(v);
        svg.appendChild(lbl);
      }
    }

    xTicks.forEach((t) => {
      const lbl = document.createElementNS(svgNS, "text");
      lbl.setAttribute("x", t.x);
      lbl.setAttribute("y", H - 10);
      lbl.setAttribute("text-anchor", "middle");
      lbl.setAttribute("class", "chart-axis");
      lbl.textContent = t.label;
      svg.appendChild(lbl);
    });

    if (bandsMode === "static") {
      const pctLines = [
        { key: "p25", label: "P25" },
        { key: "p50", label: "P50" },
        { key: "p75", label: "P75" },
        { key: "p90", label: "P90" },
      ];
      pctLines.forEach((pl) => {
        if (!visPct(pl.key)) return;
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
    } else {
      // 滚动分位带：TTM 蓝带 + 年化紫带，z-order 在曲线之下；隐藏的系列连同其分位带一起隐藏
      // 3 个组件 chip 直接控制对应层是否绘制
      const bandVis = {
        outer: visPct("band_outer"),
        inner: visPct("band_inner"),
        median: visPct("band_median"),
      };
      if (visTTM) drawRollingBands(svg, points, visibleBands, xOf, yOf, "ttm", bandVis);
      if (visAnnual) drawRollingBands(svg, annualVisible, annualVisibleBands, xOf, yOf, "annual", bandVis);
    }

    // 股价折线（右轴）：先画，让股息率主线压在上面
    if (hasPrice) {
      const priceSegs = [];
      let curSeg = null;
      for (const p of points) {
        if (p[1] != null && p[1] > 0) {
          if (!curSeg) { curSeg = []; priceSegs.push(curSeg); }
          curSeg.push(p);
        } else {
          curSeg = null;
        }
      }
      priceSegs.forEach((seg) => {
        if (seg.length < 2) return;
        let d = `M ${xOf(seg[0][0]).toFixed(1)} ${yPriceOf(seg[0][1]).toFixed(1)}`;
        for (let i = 1; i < seg.length; i++) {
          d += ` L ${xOf(seg[i][0]).toFixed(1)} ${yPriceOf(seg[i][1]).toFixed(1)}`;
        }
        const path = document.createElementNS(svgNS, "path");
        path.setAttribute("d", d);
        path.setAttribute("class", "chart-line-price");
        svg.appendChild(path);
      });
    }

    if (visTTM) {
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
    }

    // 年化曲线（紫色实线，从 annualVisible 一次性画出）
    if (visAnnual && annualVisible.length >= 2) {
      const annualPath = document.createElementNS(svgNS, "path");
      annualPath.setAttribute("d", pathD(annualVisible));
      annualPath.setAttribute("class", "chart-line-annual");
      svg.appendChild(annualPath);
    }

    // EOD / Live —— 仅在 EOD 在可见窗口内、且对应系列开启时绘制
    const lastFullPoint = allPoints[allPoints.length - 1];
    const eodT = Date.parse(lastFullPoint[0]);
    if (visTTM && eodT >= viewT0 && eodT <= viewT1) {
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
    if (visAnnual && annualVisible.length) {
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

    const hoverDotPrice = document.createElementNS(svgNS, "circle");
    hoverDotPrice.setAttribute("r", 4);
    hoverDotPrice.setAttribute("class", "chart-hover-dot-price");
    hoverDotPrice.style.display = "none";
    svg.appendChild(hoverDotPrice);

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
      hoverDotPrice.style.display = "none";
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
      if (visTTM) {
        hoverDot.setAttribute("cx", px);
        hoverDot.setAttribute("cy", py);
        hoverDot.style.display = "";
      } else {
        hoverDot.style.display = "none";
      }
      hoverLine.setAttribute("x1", px);
      hoverLine.setAttribute("x2", px);
      hoverLine.style.display = "";

      // 同日年化点：用日期 string 索引，避免双 series 长度对不齐时错位
      const ap = annualByDate.get(p[0]);
      let annualLine = "";
      if (visAnnual && ap && ap[3] !== null && ap[3] !== undefined && ap[3] > 0) {
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

      // 股价 hover 点（与 TTM 同一日期，固定走右轴）
      if (hasPrice && p[1] != null && p[1] > 0) {
        hoverDotPrice.setAttribute("cx", px);
        hoverDotPrice.setAttribute("cy", yPriceOf(p[1]));
        hoverDotPrice.style.display = "";
      } else {
        hoverDotPrice.style.display = "none";
      }

      const srcLabel = sourceLabel(sourceOf(p));
      const srcLine = srcLabel
        ? `<div class="muted">${srcLabel}</div>`
        : "";
      const ttmLine = visTTM
        ? `<div class="tt-row">
            <span class="legend-swatch legend-ttm"></span>
            TTM
            <b class="${yieldClass(p[3])}" style="margin-left:6px">${fmtNumber(p[3], 2)}%</b>
            <span class="muted" style="margin-left:6px">近 365 天 ${fmtNumber(p[2], 4)}</span>
          </div>`
        : "";

      // 滚动模式专属：在对应曲线下方画一个分位网格
      // 哪些 P 值显示，跟 3 个组件 chip 走：外带 → P10/P90；内带 → P25/P75；中位 → P50
      const ttmBand = bandsMode === "rolling" && visTTM ? visibleBands[lo] : null;
      const annualBand = bandsMode === "rolling" && visAnnual ? annualBandByDate.get(p[0]) : null;
      const winLabel = `${windowYears % 1 === 0 ? windowYears : windowYears.toFixed(1)}y 滚动带`;
      const visibleBandKeys = (() => {
        const keys = [];
        if (visPct("band_outer"))  keys.push({ key: "p10", idx: 0 });
        if (visPct("band_inner"))  keys.push({ key: "p25", idx: 1 });
        if (visPct("band_median")) keys.push({ key: "p50", idx: 2 });
        if (visPct("band_inner"))  keys.push({ key: "p75", idx: 3 });
        if (visPct("band_outer"))  keys.push({ key: "p90", idx: 4 });
        return keys;
      })();
      const renderBandGrid = (band, scopeClass, titleSuffix) => {
        if (!band || !visibleBandKeys.length) return "";
        const cells = visibleBandKeys
          .filter((b) => band[b.idx] != null)
          .map((b) => `
            <div class="tt-band-cell tt-band-cell-${b.key}">
              <span class="tt-band-k">${b.key.toUpperCase()}</span>
              <span class="tt-band-v">${fmtNumber(band[b.idx], 2)}</span>
            </div>`)
          .join("");
        if (!cells) return "";
        return `
          <div class="tt-band ${scopeClass}">
            <div class="tt-band-title">${winLabel}${titleSuffix}</div>
            <div class="tt-band-grid">${cells}</div>
          </div>`;
      };
      const ttmBandLine = renderBandGrid(ttmBand, "tt-band-ttm", " · TTM");
      const annualBandLine = renderBandGrid(annualBand, "tt-band-annual", " · 年化");

      const priceLine = `
        <div class="tt-row">
          <span class="legend-swatch legend-price"></span>
          股价
          <b style="margin-left:6px">¥${fmtNumber(p[1], 2)}</b>
        </div>`;
      tooltip.innerHTML = `
        <div class="tt-date">${p[0]}</div>
        ${priceLine}
        ${ttmLine}
        ${ttmBandLine}
        ${annualLine}
        ${annualBandLine}
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
      hoverDotPrice.style.display = "none";
      hoverLine.style.display = "none";
      tooltip.style.display = "none";
    });

    container.appendChild(svg);
  }

  // 绘制滚动分位带：每段连续非 null 的 bands 输出 P10-P90 外带 + P25-P75 内带 + P50 中位虚线
  // points 与 bands 等长（已按视口同步过滤），bands[i] 形如 [p10,p25,p50,p75,p90] 或 null/全 null
  // bandVis 控制哪些组件参与绘制：{outer, inner, median}
  function drawRollingBands(svg, points, bands, xOf, yOf, color, bandVis) {
    if (!points.length || !bands.length) return;
    const vis = bandVis || { outer: true, inner: true, median: true };
    if (!vis.outer && !vis.inner && !vis.median) return;
    const svgNS = "http://www.w3.org/2000/svg";

    // 切分连续非 null 段。"有效"判定按当前要绘制的最低组件所需的索引集合走，
    // 例如只有 median 时只需 idx 2 非 null，无需 P10/P90 也存在
    const requiredIdx = [];
    if (vis.outer) { requiredIdx.push(0, 4); }
    if (vis.inner) { requiredIdx.push(1, 3); }
    if (vis.median) { requiredIdx.push(2); }
    const segments = [];
    let cur = null;
    for (let i = 0; i < points.length; i++) {
      const b = bands[i];
      const valid = b && requiredIdx.every((idx) => b[idx] != null);
      if (valid) {
        if (!cur) {
          cur = [];
          segments.push(cur);
        }
        cur.push({ p: points[i], b });
      } else {
        cur = null;
      }
    }
    if (!segments.length) return;

    const polygonD = (seg, loIdx, hiIdx) => {
      // 上沿 loIdx 正向 → 下沿 hiIdx 逆序闭合
      let d = "";
      seg.forEach((row, k) => {
        const x = xOf(row.p[0]).toFixed(1);
        const y = yOf(row.b[loIdx]).toFixed(1);
        d += k === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
      });
      for (let k = seg.length - 1; k >= 0; k--) {
        const row = seg[k];
        const x = xOf(row.p[0]).toFixed(1);
        const y = yOf(row.b[hiIdx]).toFixed(1);
        d += ` L ${x} ${y}`;
      }
      d += " Z";
      return d;
    };
    const medianD = (seg) => {
      let d = "";
      seg.forEach((row, k) => {
        const x = xOf(row.p[0]).toFixed(1);
        const y = yOf(row.b[2]).toFixed(1);
        d += k === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
      });
      return d;
    };

    segments.forEach((seg) => {
      if (seg.length < 2) return;
      if (vis.outer) {
        const outer = document.createElementNS(svgNS, "path");
        outer.setAttribute("d", polygonD(seg, 0, 4));
        outer.setAttribute("class", `band-${color}-outer`);
        svg.appendChild(outer);
      }
      if (vis.inner) {
        const inner = document.createElementNS(svgNS, "path");
        inner.setAttribute("d", polygonD(seg, 1, 3));
        inner.setAttribute("class", `band-${color}-inner`);
        svg.appendChild(inner);
      }
      if (vis.median) {
        const median = document.createElementNS(svgNS, "path");
        median.setAttribute("d", medianD(seg));
        median.setAttribute("class", `band-${color}-median`);
        svg.appendChild(median);
      }
    });
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

  // 单行"已刷新到位"判定：行情 + 分红 + 计算结果三项齐全，且行情未陈旧。
  // 与 isPriceStale 对齐：避免出现"快照成功返回 / 但其中某只回退到上次成功值"被算成正常。
  function isRowFresh(row) {
    if (row.error) return false;
    if (row.price === null || row.price === undefined) return false;
    if (row.dividend === null || row.dividend === undefined) return false;
    if (row.yield_pct === null || row.yield_pct === undefined) return false;
    if (isPriceStale(row)) return false;
    return true;
  }

  // 把 freshness 摘要反映到顶部状态点 + 文字。tooltip 列出待更新 symbol 便于诊断。
  function applyFreshness(rows) {
    const total = rows.length;
    const stale = rows.filter((r) => !isRowFresh(r));
    const freshN = total - stale.length;
    const stamp = new Date().toLocaleTimeString();

    if (total === 0) {
      statusDot.className = "dot";
      statusDot.title = "watchlist 为空";
      lastUpdated.textContent = "上次刷新 " + stamp;
      return;
    }
    if (stale.length === 0) {
      statusDot.className = "dot ok";
      statusDot.title = `全部 ${total} 只数据已刷新`;
      lastUpdated.textContent = `上次刷新 ${stamp} · ${freshN}/${total} 已更新`;
    } else {
      statusDot.className = "dot warn";
      const names = stale
        .slice(0, 8)
        .map((r) => `${r.name}(${r.symbol})`)
        .join("、");
      const more = stale.length > 8 ? `… 等 ${stale.length} 只` : "";
      statusDot.title = `仍待更新 ${stale.length} 只：${names}${more}`;
      lastUpdated.textContent = `上次刷新 ${stamp} · ${freshN}/${total} 已更新`;
    }
  }

  async function tick() {
    try {
      const resp = await fetch("/api/yields", { cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      if (data.refresh_seconds) refreshSeconds = data.refresh_seconds;
      render(data.rows);
      renderPortfolio(data.portfolio);
      maybeNotify(data.rows);
      applyFreshness(data.rows);
    } catch (e) {
      statusDot.className = "dot err";
      statusDot.title = "刷新失败：" + e.message;
      lastUpdated.textContent = "刷新失败：" + e.message;
    }
  }

  // -------------------- 编辑模式（多选删除） --------------------

  function setupEditMode() {
    const btn = document.getElementById("edit-mode-btn");
    const toolbar = document.getElementById("edit-toolbar");
    const cancelBtn = document.getElementById("edit-cancel");
    const selectAllBtn = document.getElementById("edit-select-all");
    const clearBtn = document.getElementById("edit-clear");
    const bulkDelBtn = document.getElementById("edit-bulk-delete");
    if (!btn || !toolbar) return;

    btn.addEventListener("click", () => setEditMode(!editMode));
    cancelBtn?.addEventListener("click", () => setEditMode(false));
    selectAllBtn?.addEventListener("click", () => {
      lastRows.forEach((r) => selectedSymbols.add(r.symbol));
      syncAllCardsSelection();
      updateEditToolbarCount();
    });
    clearBtn?.addEventListener("click", () => {
      selectedSymbols.clear();
      syncAllCardsSelection();
      updateEditToolbarCount();
    });
    bulkDelBtn?.addEventListener("click", openBulkDeleteModal);
  }

  function setEditMode(on) {
    editMode = !!on;
    document.body.classList.toggle("edit-mode", editMode);
    const toolbar = document.getElementById("edit-toolbar");
    const btn = document.getElementById("edit-mode-btn");
    if (toolbar) toolbar.hidden = !editMode;
    if (btn) {
      btn.textContent = editMode ? "完成" : "编辑";
      btn.classList.toggle("active", editMode);
    }
    if (!editMode) {
      // 退出时清空，避免下次进入残留旧勾选
      selectedSymbols.clear();
      // 关闭所有展开的详情面板（编辑模式期间不该有，进入时可能已有）
    } else {
      // 进入编辑模式：先合上详情，避免与勾选交互重叠
      Array.from(expanded.keys()).forEach((symbol) => {
        const ctx = expanded.get(symbol);
        ctx.abortController.abort();
        if (ctx.liveTimer) clearInterval(ctx.liveTimer);
        ctx.detailEl.remove();
        expanded.delete(symbol);
        const card = document.getElementById(cardKey({ symbol }));
        if (card) card.classList.remove("expanded");
      });
    }
    syncAllCardsSelection();
    updateEditToolbarCount();
  }

  function toggleSelected(symbol) {
    if (selectedSymbols.has(symbol)) selectedSymbols.delete(symbol);
    else selectedSymbols.add(symbol);
    const card = document.getElementById(cardKey({ symbol }));
    if (card) syncCardSelection(card, symbol);
    updateEditToolbarCount();
  }

  function syncCardSelection(card, symbol) {
    const sel = selectedSymbols.has(symbol);
    card.classList.toggle("selected", sel);
    const cb = card.querySelector('input[data-act="select"]');
    if (cb) cb.checked = sel;
  }

  function syncAllCardsSelection() {
    cardsGrid.querySelectorAll(".card, .list-row").forEach((el) => {
      const symbol = el.dataset.symbol;
      if (symbol) syncCardSelection(el, symbol);
    });
  }

  function updateEditToolbarCount() {
    const countEl = document.getElementById("edit-selected-count");
    const bulkBtn = document.getElementById("edit-bulk-delete");
    if (countEl) countEl.textContent = String(selectedSymbols.size);
    if (bulkBtn) bulkBtn.disabled = selectedSymbols.size === 0;
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
  setupAddStockButton();
  setupEditMode();
  tick();
  setInterval(tick, refreshSeconds * 1000);

  // ---------- watchlist 编辑：modal 系统 ----------

  const modalRoot = document.getElementById("modal-root");

  function closeModal() {
    modalRoot.innerHTML = "";
  }

  function openModal(html) {
    modalRoot.innerHTML = html;
    const overlay = modalRoot.querySelector(".modal-overlay");
    if (overlay) {
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeModal();
      });
    }
    document.addEventListener("keydown", escClose);
  }

  function escClose(e) {
    if (e.key === "Escape") {
      closeModal();
      document.removeEventListener("keydown", escClose);
    }
  }

  function showError(formEl, message) {
    let el = formEl.querySelector(".modal-error");
    if (!el) {
      el = document.createElement("div");
      el.className = "modal-error";
      formEl.appendChild(el);
    }
    el.textContent = message;
  }

  function setupAddStockButton() {
    const btn = document.getElementById("add-stock-btn");
    if (btn) btn.addEventListener("click", openAddModal);
  }

  function openAddModal() {
    openModal(`
      <div class="modal-overlay">
        <form class="modal-card modal-form" id="add-form">
          <div class="modal-title">添加股票</div>
          <label>搜索（代码 / 名称）</label>
          <div class="search-box">
            <input name="search" id="add-search" autocomplete="off"
                   placeholder="如: 600519 或 茅台" />
            <div class="search-results" id="add-search-results" hidden></div>
          </div>
          <input type="hidden" name="symbol" />
          <input type="hidden" name="name" />
          <input type="hidden" name="exchange" />
          <div class="search-selected" id="add-selected" hidden></div>
          <label>持仓股数 (可选)</label>
          <input name="shares" type="number" min="0" value="0" />
          <div class="modal-hint">
            选中候选项后再提交。系统会试拉一次行情 + 历史分红，都成功才接受。
          </div>
          <div class="modal-actions">
            <button type="button" data-act="cancel">取消</button>
            <button type="submit" class="primary" data-act="submit" disabled>添加</button>
          </div>
        </form>
      </div>
    `);
    const form = document.getElementById("add-form");
    const searchInput = document.getElementById("add-search");
    const resultsEl = document.getElementById("add-search-results");
    const selectedEl = document.getElementById("add-selected");
    const submitBtn = form.querySelector('[data-act="submit"]');
    let activeIdx = -1;
    let currentResults = [];
    let debounceTimer = null;
    let lastQuery = "";

    function selectStock(item) {
      form.querySelector('[name="symbol"]').value = item.symbol;
      form.querySelector('[name="name"]').value = item.name;
      form.querySelector('[name="exchange"]').value = item.exchange;
      searchInput.value = `${item.name} ${item.symbol}`;
      selectedEl.hidden = false;
      selectedEl.innerHTML = `<span class="pill">${item.exchange}</span> <b>${item.name}</b> <span class="muted">${item.symbol}</span>`;
      resultsEl.hidden = true;
      submitBtn.disabled = false;
    }

    function clearSelection() {
      form.querySelector('[name="symbol"]').value = "";
      form.querySelector('[name="name"]').value = "";
      form.querySelector('[name="exchange"]').value = "";
      selectedEl.hidden = true;
      submitBtn.disabled = true;
    }

    function renderResults(items) {
      currentResults = items;
      activeIdx = items.length > 0 ? 0 : -1;
      if (items.length === 0) {
        resultsEl.innerHTML = `<div class="search-empty">无匹配，请检查代码或名称</div>`;
        resultsEl.hidden = false;
        return;
      }
      resultsEl.innerHTML = items
        .map(
          (it, i) => `
        <div class="search-item${i === activeIdx ? " active" : ""}" data-idx="${i}">
          <span class="pill">${it.exchange}</span>
          <b>${it.name}</b>
          <span class="muted">${it.symbol}</span>
        </div>
      `
        )
        .join("");
      resultsEl.hidden = false;
      resultsEl.querySelectorAll(".search-item").forEach((el) => {
        el.addEventListener("mousedown", (e) => {
          e.preventDefault(); // 防 input blur 先于 click
          const idx = parseInt(el.dataset.idx, 10);
          selectStock(currentResults[idx]);
        });
      });
    }

    async function doSearch(q) {
      if (!q || q.length < 1) {
        resultsEl.hidden = true;
        currentResults = [];
        return;
      }
      try {
        const resp = await fetch(`/api/stocks/search?q=${encodeURIComponent(q)}&limit=10`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const j = await resp.json();
        // 异步竞态保护：query 已经变了就丢弃这次结果
        if (q !== lastQuery) return;
        renderResults(j.results || []);
      } catch (err) {
        if (q !== lastQuery) return;
        resultsEl.innerHTML = `<div class="search-empty">搜索出错：${err.message}</div>`;
        resultsEl.hidden = false;
      }
    }

    searchInput.addEventListener("input", () => {
      clearSelection();
      const q = searchInput.value.trim();
      lastQuery = q;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => doSearch(q), 200);
    });

    searchInput.addEventListener("keydown", (e) => {
      if (resultsEl.hidden || currentResults.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIdx = Math.min(activeIdx + 1, currentResults.length - 1);
        updateActive();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIdx = Math.max(activeIdx - 1, 0);
        updateActive();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeIdx >= 0 && currentResults[activeIdx]) {
          selectStock(currentResults[activeIdx]);
        }
      }
    });

    function updateActive() {
      resultsEl.querySelectorAll(".search-item").forEach((el, i) => {
        el.classList.toggle("active", i === activeIdx);
      });
      // 滚动选中项到可见区域
      const activeEl = resultsEl.querySelector(".search-item.active");
      if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
    }

    searchInput.addEventListener("blur", () => {
      // 200ms 延迟，让 mousedown 选中先生效
      setTimeout(() => (resultsEl.hidden = true), 200);
    });
    searchInput.addEventListener("focus", () => {
      if (currentResults.length > 0) resultsEl.hidden = false;
    });

    form.querySelector('[data-act="cancel"]').addEventListener("click", closeModal);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const symbol = form.querySelector('[name="symbol"]').value;
      if (!symbol) {
        showError(form, "请先从下拉列表中选中一只股票");
        return;
      }
      const fd = new FormData(form);
      const inputs = form.querySelectorAll("input");
      submitBtn.disabled = true;
      inputs.forEach((i) => (i.disabled = true));
      submitBtn.textContent = "校验中…";
      try {
        const resp = await fetch("/api/watchlist", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: symbol,
            name: fd.get("name"),
            exchange: fd.get("exchange"),
            shares: parseInt(fd.get("shares") || "0", 10) || 0,
          }),
        });
        if (!resp.ok) {
          const j = await resp.json().catch(() => ({}));
          throw new Error(j.detail || `HTTP ${resp.status}`);
        }
        closeModal();
        tick();
      } catch (err) {
        showError(form, err.message);
        submitBtn.disabled = false;
        inputs.forEach((i) => (i.disabled = false));
        submitBtn.textContent = "添加";
      }
    });
    setTimeout(() => searchInput.focus(), 50);
  }

  function openEditModal(row) {
    openModal(`
      <div class="modal-overlay">
        <form class="modal-card modal-form" id="edit-form">
          <div class="modal-title">编辑 ${row.name} (${row.symbol})</div>
          <label>名称</label>
          <input name="name" value="${row.name}" required autocomplete="off" />
          <label>持仓股数</label>
          <input name="shares" type="number" min="0" value="${row.shares || 0}" />
          <div class="modal-hint">代码与交易所不能修改。如要换股请删除后重新添加。</div>
          <div class="modal-actions">
            <button type="button" data-act="cancel">取消</button>
            <button type="submit" class="primary" data-act="submit">保存</button>
          </div>
        </form>
      </div>
    `);
    const form = document.getElementById("edit-form");
    form.querySelector('[data-act="cancel"]').addEventListener("click", closeModal);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const submitBtn = form.querySelector('[data-act="submit"]');
      const inputs = form.querySelectorAll("input");
      submitBtn.disabled = true;
      inputs.forEach((i) => (i.disabled = true));
      submitBtn.textContent = "保存中…";
      try {
        const resp = await fetch(`/api/watchlist/${row.symbol}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: fd.get("name").toString().trim(),
            shares: parseInt(fd.get("shares") || "0", 10) || 0,
          }),
        });
        if (!resp.ok) {
          const j = await resp.json().catch(() => ({}));
          throw new Error(j.detail || `HTTP ${resp.status}`);
        }
        closeModal();
        tick();
      } catch (err) {
        showError(form, err.message);
        submitBtn.disabled = false;
        inputs.forEach((i) => (i.disabled = false));
        submitBtn.textContent = "保存";
      }
    });
  }

  function openDeleteModal(row) {
    openModal(`
      <div class="modal-overlay">
        <form class="modal-card modal-form" id="delete-form">
          <div class="modal-title">删除 ${row.name} (${row.symbol}) ?</div>
          <div class="modal-hint">
            将从 watchlist 移除并清掉相关缓存（日 K / 分红 / 历史分位）。
            重新添加同 symbol 时需重新拉取历史数据。
          </div>
          <div class="modal-actions">
            <button type="button" data-act="cancel">取消</button>
            <button type="submit" class="danger" data-act="submit">删除</button>
          </div>
        </form>
      </div>
    `);
    const form = document.getElementById("delete-form");
    form.querySelector('[data-act="cancel"]').addEventListener("click", closeModal);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submitBtn = form.querySelector('[data-act="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = "删除中…";
      try {
        const resp = await fetch(`/api/watchlist/${row.symbol}`, { method: "DELETE" });
        if (!resp.ok) {
          const j = await resp.json().catch(() => ({}));
          throw new Error(j.detail || `HTTP ${resp.status}`);
        }
        closeModal();
        // 删除后立即从 DOM 移除卡片，下次 tick 主表自然不再返回
        const card = document.getElementById(`c-${row.symbol}`);
        if (card) card.remove();
        tick();
      } catch (err) {
        showError(form, err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = "删除";
      }
    });
  }

  function openBulkDeleteModal() {
    if (selectedSymbols.size === 0) return;
    const targets = lastRows.filter((r) => selectedSymbols.has(r.symbol));
    if (!targets.length) return;
    const listHtml = targets
      .map(
        (r) =>
          `<div class="bulk-del-item"><b>${r.name}</b> <span class="muted">${r.symbol}</span></div>`
      )
      .join("");
    openModal(`
      <div class="modal-overlay">
        <form class="modal-card modal-form" id="bulk-delete-form">
          <div class="modal-title">删除选中 ${targets.length} 只股票 ?</div>
          <div class="modal-hint">
            将从 watchlist 批量移除并清理对应缓存。重新添加需要重拉历史数据。
          </div>
          <div class="bulk-del-list">${listHtml}</div>
          <div class="modal-actions">
            <button type="button" data-act="cancel">取消</button>
            <button type="submit" class="danger" data-act="submit">删除 ${targets.length} 只</button>
          </div>
        </form>
      </div>
    `);
    const form = document.getElementById("bulk-delete-form");
    form.querySelector('[data-act="cancel"]').addEventListener("click", closeModal);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const submitBtn = form.querySelector('[data-act="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = "删除中…";
      // 串行 DELETE：watchlist 写入端有进程级锁；同时也避免一次发起 N 个并发请求触发 tick 风暴
      const failed = [];
      for (const r of targets) {
        try {
          const resp = await fetch(`/api/watchlist/${r.symbol}`, { method: "DELETE" });
          if (!resp.ok) {
            const j = await resp.json().catch(() => ({}));
            failed.push(`${r.symbol}: ${j.detail || `HTTP ${resp.status}`}`);
            continue;
          }
          selectedSymbols.delete(r.symbol);
          const card = document.getElementById(`c-${r.symbol}`);
          if (card) card.remove();
        } catch (err) {
          failed.push(`${r.symbol}: ${err.message}`);
        }
      }
      if (failed.length) {
        showError(form, "部分失败：\n" + failed.join("\n"));
        submitBtn.disabled = false;
        submitBtn.textContent = `删除 ${selectedSymbols.size} 只`;
        updateEditToolbarCount();
        tick();
        return;
      }
      closeModal();
      setEditMode(false);
      tick();
    });
  }
})();
