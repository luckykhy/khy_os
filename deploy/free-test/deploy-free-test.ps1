#!/usr/bin/env pwsh
# khy-os free-test 一键部署 (Windows PowerShell)
# 在 D:\Portable\khy-os\deploy\free-test\ 下运行: pwsh .\deploy-free-test.ps1
# 需要: Supabase CLI (npm i -g supabase), git, corepack

param(
  [string]$SupabaseRef = 'REPLACE_WITH_PROJECT_REF',
  [string]$GithubUser  = 'luckykhy',
  [string]$RepoName    = 'khy-os'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent   # D:\Portable\khy-os

Write-Host '=== [1/6] copy generated files into repo ===' -ForegroundColor Cyan
# 1. supabase functions (already under deploy/free-test/supabase/)
# 2. copy workflow
Copy-Item -Force "$PSScriptRoot\.github\workflows\deploy-pages.yml" "$repoRoot\.github\workflows\deploy-pages.yml"
# 3. copy frontend env
Copy-Item -Force "$PSScriptRoot\apps\ai-frontend\.env.production" "$repoRoot\apps\ai-frontend\.env.production"
# 4. patch .env.production with the real Supabase ref
$envFile = "$repoRoot\apps\ai-frontend\.env.production"
(Get-Content $envFile -Raw) -replace 'REPLACE_WITH_SUPABASE_REF', $SupabaseRef | Set-Content $envFile
Write-Host "  patched .env.production with ref=$SupabaseRef"

Write-Host '=== [2/6] Supabase: apply schema ===' -ForegroundColor Cyan
Push-Location $repoRoot
supabase db push 2>&1 | Out-Null
# 兜底: 若 CLI db push 不可用, 提示手动跑 schema.sql
Write-Host "  schema.sql at $PSScriptRoot\supabase\schema.sql — if `supabase db push` fails, run it in the Supabase SQL Editor manually."
Write-Host '=== [3/6] Supabase: deploy Edge Functions ===' -ForegroundColor Cyan
supabase functions deploy khyos-api
supabase functions deploy khyos-ai

Write-Host '=== [4/6] Supabase: set secrets ===' -ForegroundColor Cyan
# 提示用户交互设置 (避免把 key 写进脚本)
Write-Host '  Now set these secrets (run in a terminal, do NOT commit keys):'
Write-Host "    supabase secrets set LLM_UPSTREAM_URL=``https://openrouter.ai/api/v1`` LLM_API_KEY=``<your-key>`` ALLOW_ORIGIN=``https://${GithubUser}.github.io`` --project-ref ${SupabaseRef}"
Write-Host '    (also create the LLM_API_KEY secret with your real key)'

Write-Host '=== [5/6] verify API health ===' -ForegroundColor Cyan
$apiUrl = "https://${SupabaseRef}.supabase.co/functions/v1/khyos-api/api/health"
Write-Host "  GET ${apiUrl}"
try {
  $r = Invoke-WebRequest -Uri $apiUrl -UseBasicParsing -TimeoutSec 30
  Write-Host "  status=$($r.StatusCode) body=$($r.Content.Substring(0, [Math]::Min(200, $r.Content.Length)))"
} catch {
  Write-Warning "health check failed: $_"
}

Write-Host '=== [6/6] GitHub: push to trigger Pages ===' -ForegroundColor Cyan
Write-Host '  Add VITE_AI_API_BASE_URL / VITE_AI_STREAM_URL to Repo Settings → Variables:'
Write-Host "    VITE_AI_API_BASE_URL = https://${SupabaseRef}.supabase.co/functions/v1/khyos-api"
Write-Host "    VITE_AI_STREAM_URL   = https://${SupabaseRef}.supabase.co/functions/v1/khyos-ai"
Write-Host '  Then commit + push to main (the workflow auto-deploys Pages).'
Pop-Location

Write-Host ''
Write-Host '=== done. Visit: https://'$GithubUser'.github.io/' -ForegroundColor Green
Write-Host 'Test AI chat (SSE) and dashboard. WebSocket cross-device sync is disabled in free-test.'
