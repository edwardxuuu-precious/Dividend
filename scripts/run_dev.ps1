#!/usr/bin/env pwsh
# Dev server launcher for Dividend Watch
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
