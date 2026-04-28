#!/usr/bin/env pwsh
# Dev server launcher for Dividend Watch
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

# 启动日志落盘到 logs/uvicorn.log（追加），便于事后排查崩溃。
# Tee 双发：终端仍实时显示，关闭终端 / 进程被杀也不丢日志。
New-Item -ItemType Directory -Force -Path "logs" | Out-Null
Add-Content -Path "logs/uvicorn.log" -Value ""
Add-Content -Path "logs/uvicorn.log" -Value "=== uvicorn launch $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ==="

# PS 5.1 下 native exe 的 stderr 经 PowerShell 自身 2>&1 会被包成 NativeCommandError，
# 配合 ErrorActionPreference=Stop 会让脚本在 uvicorn 第一行 INFO 处直接夭折。
# 绕路：让 cmd.exe 先做 stderr→stdout 合并，PS 只看到普通文本，再交给 Tee-Object 双发。
cmd /c "uvicorn app.main:app --reload --host 127.0.0.1 --port 8000 2>&1" |
    Tee-Object -FilePath "logs/uvicorn.log" -Append
