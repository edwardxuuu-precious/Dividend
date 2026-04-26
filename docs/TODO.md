# 待办与待验证清单

> 本文档收录"代码已交付、但还有遗留验证或边角任务待手工处理"的事项。
> 已完成功能见 [项目档案.md](项目档案.md)。
> 临时性的工作过程见 [Work_Progress/](../Work_Progress/) 按日期分目录。

最后更新：2026-04-26

---

## TODO-1：currently_lapsed 红色徽章浏览器实测

- **状态**：待验证
- **优先级**：低（功能已交付且单测通过；仅缺一次端到端目检）
- **关联**：[项目档案.md §3.16](项目档案.md)

### 原因

方案 D 引入了两档 lapsed 警报徽章：

- `currently_lapsed=true` → 红底白字 "⚠ 已停止分红 (距上次除权 X 天，约 Y 个月)"
- `historical_lapsed_count>0` → 橙色 "历史曾断流 X 次"

**橙色档**已用格力电器（000651，3 段历史 lapsed）在浏览器实测通过。

**红色档**——即 EOD 当前正处于 lapsed 状态——当前 watchlist 7 只股票（茅台/五粮液/招行/工行/长电/格力/平安）都没有触发，因为它们近期都还在正常分红。所以红色徽章的渲染只在单元测试 `test_summarize_lapsed_currently_lapsed` 里验证过后端字段，没有在浏览器里实际看过最终样式。

不实测的风险：
- 红色背景 `#b91c1c` 对深色主题的对比度、徽章占位是否撑出 summary-yield 行
- "⚠" 警告符号在不同字体回退下是否渲染正常
- title 悬浮文案的措辞是否清楚

### 功能详情

代码位置：

- 后端：[app/services/history_service.py](../app/services/history_service.py) `summarize_lapsed()`
- 前端渲染：[app/web/static/app.js](../app/web/static/app.js) `renderLapsedBadge()`
- 样式：[app/web/static/app.css](../app/web/static/app.css) `.lapsed-current`

触发条件（任选其一即可在浏览器看到红色徽章）：

**方案 A**：临时调小阈值

```yaml
# config/watchlist.yaml
carry_stale_days: 200   # 从 540 调到 200
```

效果：茅台（最近一次除权 2025-12-19，距今约 128 天）虽然不会触发，但任何 watchlist 里 last_ex_date 距今 > 200 天的股票都会变 lapsed。可能要把阈值调到 100 才能让茅台触发。**注意：这会影响曲线和分位计算，验证完务必改回 540。**

**方案 B**：临时加一只长期未分红的股票

在 [config/watchlist.yaml](../config/watchlist.yaml) 加一只历史上有派息但近 2 年彻底不分红的股票，比如某些 ST 股或亏损周期里的周期股。可用 akshare 离线挑选：找最后一笔 cash_per_share>0 的 ex_date 距今 > 540 天的 A 股。

**方案 C**（最干净）：构造端到端测试 fixture

写一个测试用 mock 数据源（DividendSource + HistoricalPriceSource），让 series 末尾 source = lapsed，启 server → playwright 截图。改动量最小，不污染生产 watchlist。

### 预期结果

红色徽章呈现：

- 详情面板顶部，紧跟 `.big-yield`（大字股息率）和 `.valuation-badge`（估值徽章）后面同行
- 红底（`#b91c1c`）白字，圆角 4px，padding 4-10px
- 文案："⚠ 已停止分红 （距上次除权 N 天，约 M 个月）"，N/M 数字正确
- 鼠标悬浮显示 title：`超过 540 天未派息，TTM 已置 0`

附带行为：

- 该股票的图表上 EOD 之前一段会以"断点"形式断开（lapsed 段不画线）
- 图表上 EOD dot 不应被绘制（因为 yield_pct=0）—— 这点也需要顺便检查
- 分位数计算不受影响（`_meaningful_yields` 仅取 source=window）
- 该股票在主表的"股息率"列应该显示 0%（因为 EOD ttm_dividend=0）

### 验收流程标准

1. 准备：选方案 A/B/C 任一种构造一只 currently_lapsed 的股票
2. 跑测试：`pytest -q` → 期望 43 passed（不应因构造改动破坏既有测试）
3. 启服务：`./scripts/run_dev.sh` 或 `./scripts/run_dev.ps1`
4. 浏览器目检：
   - 主表行点击展开
   - 顶部应看到红色 "⚠ 已停止分红" 徽章
   - 鼠标悬浮该徽章 → 显示 title 文案
   - 图表上对应区段是断开的（不是 0% 直线）
   - 截图保存到 `Work_Progress/<日期>/lapsed_red_badge.png`
5. 接口检查：

   ```bash
   curl --noproxy '*' http://127.0.0.1:8765/api/yields/<symbol>/history | \
     python -c "import json,sys; d=json.load(sys.stdin); print(d['lapsed_summary'])"
   ```

   期望输出：`{'currently_lapsed': True, 'days_since_last_ex': N, 'last_ex_date': 'YYYY-MM-DD', 'historical_lapsed_count': K, 'stale_threshold_days': 540}`
6. 还原：恢复 `carry_stale_days` 或 watchlist
7. 在本文件的"状态"行从"待验证"改成"已验证（YYYY-MM-DD，截图位置）"

---

## 模板：新增 TODO 时使用

```markdown
## TODO-N：<简短任务名>

- **状态**：待开始 / 进行中 / 待验证 / 已验证（YYYY-MM-DD）
- **优先级**：高 / 中 / 低
- **关联**：相关功能在项目档案.md 里的章节链接 / 相关 commit / issue

### 原因
为什么需要做这件事，留它没做有什么风险/损失。

### 功能详情
具体做什么。涉及哪些文件、哪些字段、哪些接口。

### 预期结果
完成后用户能看到什么、系统行为发生什么变化。

### 验收流程标准
1. 准备步骤
2. 执行命令
3. 浏览器/接口目检要点（包含截图位置）
4. 状态字段更新
```
