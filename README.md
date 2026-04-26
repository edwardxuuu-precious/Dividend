# Dividend Watch — A 股分红率实时监控

根据最新股价计算分红率（股息率）的本地仪表盘。当前 watchlist 跑 7 只长期分红股（茅台 / 五粮液 / 招行 / 工行 / 长电 / 格力 / 平安），主表横向对比 + 详情面板有 24 年 TTM 走势图、历史分位估值、明年分红三档预估、停止分红警报、CSV 导出、P 分位破位桌面通知。通过修改 `config/watchlist.yaml` 即可扩展。

> **完整功能清单、数据流、缓存策略、路线图见 [docs/项目档案.md](docs/项目档案.md)**（活文档，每次迭代会同步更新）。

## 分红率口径

```
分红率 = 最近一个完整年度的每股税前分红 / 当前股价
```

## 快速开始

```bash
# 1. 创建虚拟环境（推荐）
python -m venv .venv
.\.venv\Scripts\activate          # Windows PowerShell
# source .venv/bin/activate       # macOS / Linux

# 2. 安装
pip install -e .[dev]

# 3. 启动
./scripts/run_dev.ps1             # Windows
# 或
uvicorn app.main:app --reload

# 4. 浏览器打开 http://localhost:8000
```

## 添加股票

编辑 [config/watchlist.yaml](config/watchlist.yaml)：

```yaml
refresh_seconds: 10        # 主表轮询节奏（秒）
carry_stale_days: 540      # 可选，停止分红判定阈值（天）；详见档案 §3.16
stocks:
  - symbol: "600519"
    name: "贵州茅台"
    exchange: "SH"
  - symbol: "000858"
    name: "五粮液"
    exchange: "SZ"
```

重启服务即可。

## 数据源

- **行情**（实时现价）：直连新浪 `hq.sinajs.cn/list=...`，批量一次拉完整个 watchlist。不走 akshare 包装是因为东财/akshare 在某些 Windows 客户端下 TLS 兼容性差。
- **历史分红**：akshare `stock_history_dividend_detail()`（东财）
- **历史日 K**（不复权）：akshare `stock_zh_a_daily()`（新浪）

A 股数据源都在国内，启动时会主动清掉 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量与 Windows 注册表里的 IE 代理，避免 Clash/V2ray 破坏 TLS 握手。详见档案 §5。

## 项目结构

```
app/
├── main.py                # FastAPI 入口（含 csv 导出端点等）
├── config.py              # watchlist.yaml 加载
├── models.py              # 数据类
├── cache.py               # 文件 + 内存缓存
├── data_sources/          # 行情/分红抽象 + akshare 实现
├── services/              # 业务逻辑：dividend / price / history / watcher
└── web/                   # 前端模板 + 单页 JS + SVG 图表
config/watchlist.yaml      # 唯一需要编辑的配置
docs/项目档案.md           # 主文档（活文档，每次迭代同步）
docs/TODO.md               # 待验证清单
```

## 测试

```bash
pytest -q   # 期望 44 passed
```
