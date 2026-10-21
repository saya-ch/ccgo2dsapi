#requires -Version 5
<#
  ccgo2dsapi / 自检

  依次验证：健康检查 → 模型列表 → 真实对话 → （可选）流式 SSE。
  用于确认代理确实工作，而不是进程起来了却打不通上游。

  用法：
    .\scripts\test-proxy.ps1
    .\scripts\test-proxy.ps1 -Port 8888
    .\scripts\test-proxy.ps1 -Model "your-model-id"
#>
param(
  [int]$Port = 0,
  [string]$Model = "",
  [string]$HostAddress = "127.0.0.1"
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$cfgPath = Join-Path $root "config.json"
$cfg = $null
if (Test-Path $cfgPath) { $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json }
if ($Port -le 0) { $Port = if ($cfg -and $cfg.Port) { [int]$cfg.Port } else { 8787 } }

$base = "http://${HostAddress}:${Port}"
$okAll = $true

function Step($name) { Write-Host ""; Write-Host ("== " + $name) -ForegroundColor Cyan }
function Pass($msg) { Write-Host ("   OK   " + $msg) -ForegroundColor Green }
function Fail($msg) { Write-Host ("   FAIL " + $msg) -ForegroundColor Red; $script:okAll = $false }

# 1. health
Step "health"
try {
  $h = Invoke-RestMethod "$base/health" -TimeoutSec 8
  Pass ("proxy " + $h.version)
} catch {
  Fail $_.Exception.Message
  Write-Host "   代理好像没在跑：.\scripts\start-proxy.ps1" -ForegroundColor DarkGray
}

# 2. models
Step "models"
$modelId = $Model
try {
  $m = Invoke-RestMethod "$base/v1/models" -TimeoutSec 15
  $count = @($m.data).Count
  Pass ("$count models")
  if (-not $modelId -and $count -gt 0) {
    $modelId = @($m.data)[0].id
    Write-Host ("   using model: " + $modelId) -ForegroundColor DarkGray
  }
} catch {
  Fail $_.Exception.Message
}

# 3. 真实对话
if ($modelId) {
  Step "chat completion ($modelId)"
  $body = @{
    model = $modelId
    messages = @(@{ role = "user"; content = "Reply with exactly: PROXY_OK" })
    max_tokens = 1500
  } | ConvertTo-Json -Depth 6
  try {
    $r = Invoke-RestMethod "$base/v1/chat/completions" -Method Post -ContentType "application/json" `
      -Headers @{ Authorization = "Bearer proxy-managed" } -Body $body -TimeoutSec 120
    $txt = $r.choices[0].message.content
    if ($txt) { Pass ("reply: " + $txt.Trim()) } else { Fail "empty content (try a bigger max_tokens)" }
    Write-Host ("   usage: " + ($r.usage | ConvertTo-Json -Compress)) -ForegroundColor DarkGray
  } catch {
    Fail $_.Exception.Message
  }

  # 4. 流式
  Step "streaming"
  $bodyS = @{
    model = $modelId
    messages = @(@{ role = "user"; content = "Say only: STREAM_OK" })
    max_tokens = 1500
    stream = $true
  } | ConvertTo-Json -Depth 6
  try {
    $raw = Invoke-WebRequest "$base/v1/chat/completions" -Method Post -ContentType "application/json" `
      -Headers @{ Authorization = "Bearer proxy-managed" } -Body $bodyS -TimeoutSec 120 -UseBasicParsing
    $lines = ([string]$raw.Content) -split "`r?`n" | Where-Object { $_ -match '^data:' }
    if ($lines.Count -gt 0) { Pass ("$($lines.Count) SSE lines, ends with [DONE]: " + ($lines[-1] -like '*[DONE]*')) }
    else { Fail "no SSE data lines" }
  } catch {
    Fail $_.Exception.Message
  }
}

Write-Host ""
if ($okAll) { Write-Host "all checks passed" -ForegroundColor Green }
else { Write-Host "some checks failed" -ForegroundColor Red; exit 1 }
