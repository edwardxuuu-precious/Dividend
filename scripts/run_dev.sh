#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# 启动日志落盘到 logs/uvicorn.log（追加），便于事后排查崩溃。
mkdir -p logs
{
    echo ""
    echo "=== uvicorn launch $(date '+%Y-%m-%d %H:%M:%S') ==="
} >> logs/uvicorn.log

uvicorn app.main:app --reload --host 127.0.0.1 --port 8000 2>&1 | tee -a logs/uvicorn.log
