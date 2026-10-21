#requires -Version 5
<#
  ccgo2dsapi / 一键安装

  做三件事：
    1. 检查 Node.js
    2. 生成 config.json（若不存在，从 config.example.json 复制）
    3. npm install 拉取上游代理包
  不会碰你的凭据 —— 凭据由 CLI 自己管理。

  用法：
    .\scripts\install.ps1
    .\scripts\install.ps1 -SkipNpm
#>
param([switch]$SkipNpm)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host ""
Write-Host "  ccgo2dsapi installer" -ForegroundColor Cyan
Write-Host ("  target: " + $root) -ForegroundColor DarkGray
Write-Host ""

# 1. Node
Write-Host "[1/4] checking node ..." -ForegroundColor Cyan
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Host "  x node not found. install Node.js >= 24 first." -ForegroundColor Red
  Write-Host "    https://nodejs.org/" -ForegroundColor DarkGray
  exit 1
}
$nodeVer = (& node --version).Trim()
$major = 0
if ($nodeVer -match '^v(\d+)') { $major = [int]$Matches[1] }
if ($major -lt 24) {
  Write-Host "  x node $nodeVer is too old, need >= 24" -ForegroundColor Red
  Write-Host "    upstream commandcode-api-proxy requires >=24, and the JSON import" -ForegroundColor DarkGray
  Write-Host "    attribute syntax used by the parity patch fails on Node 18/20." -ForegroundColor DarkGray
  exit 1
}
Write-Host ("  ok   node " + $nodeVer) -ForegroundColor Green

# 2. config
Write-Host "[2/4] config.json ..." -ForegroundColor Cyan
$cfg = Join-Path $root "config.json"
$example = Join-Path $root "config.example.json"
if (Test-Path $cfg) {
  Write-Host "  ok   already exists, left untouched" -ForegroundColor Green
} elseif (Test-Path $example) {
  Copy-Item $example $cfg
  Write-Host "  ok   created from config.example.json" -ForegroundColor Green
  Write-Host "       -> edit it if your port / paths / plan ids differ" -ForegroundColor DarkGray
} else {
  Write-Host "  ! config.example.json missing, panel will use built-in defaults" -ForegroundColor Yellow
}

# 3. npm
Write-Host "[3/4] npm install ..." -ForegroundColor Cyan
if ($SkipNpm) {
  Write-Host "  skipped (-SkipNpm)" -ForegroundColor Yellow
} else {
  Push-Location $root
  try {
    & npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  x npm install failed (exit $LASTEXITCODE)" -ForegroundColor Red
      Pop-Location
      exit 1
    }
  } finally {
    Pop-Location
  }
  Write-Host "  ok   dependencies installed" -ForegroundColor Green
}

# 4. 推理默认值补丁
# 上游只有收到 reasoning_effort 才会产生推理内容，不打这个补丁就看不到 CoT。
# 补丁改的是 node_modules 里的文件，npm install 会覆盖，所以每次装完都要跑。
Write-Host "[4/4] reasoning default patch ..." -ForegroundColor Cyan
if ($SkipNpm) {
  Write-Host "  skipped (-SkipNpm)" -ForegroundColor Yellow
} else {
  Push-Location $root
  try {
    # 必须先跑 reasoning 补丁（改 openai.js），再跑 parity 补丁（改 server.js）
    $patchFailed = @()
    foreach ($ps in @("tools\patch-reasoning.mjs", "tools\patch-parity.mjs", "tools\patch-anthropic.mjs", "tools\patch-alias.mjs")) {
      $patchScript = Join-Path $root $ps
      if (-not (Test-Path $patchScript)) {
        Write-Host "  ! $ps not found, skipped" -ForegroundColor Yellow
        $patchFailed += $ps
        continue
      }
      & node $patchScript
      if ($LASTEXITCODE -ne 0) {
        Write-Host "  ! $ps failed (exit $LASTEXITCODE)" -ForegroundColor Red
        $patchFailed += $ps
      }
    }
    if ($patchFailed.Count -gt 0) {
      Write-Host ""
      Write-Host "  x 有 $($patchFailed.Count) 个补丁未完整应用：" -ForegroundColor Red
      foreach ($pf in $patchFailed) { Write-Host "      $pf" -ForegroundColor Red }
      Write-Host "    回复仍可用，但协议行为可能与官方不一致。" -ForegroundColor Yellow
      Write-Host "    多半是上游 commandcode-api-proxy 版本变化导致锚点失配。" -ForegroundColor Yellow
      throw "patches incomplete"
    }
  } finally {
    Pop-Location
  }
}

Write-Host ""
Write-Host "  next steps:" -ForegroundColor Cyan
Write-Host "    1. log in with the vendor CLI so auth.json exists" -ForegroundColor Gray
Write-Host "    2. .\launch.ps1          (starts proxy + panel)" -ForegroundColor Gray
Write-Host "    3. .\scripts\test-proxy.ps1   (optional self-check)" -ForegroundColor Gray
Write-Host ""
Write-Host "  optional: create a desktop shortcut ->  .\scripts\make-shortcut.ps1" -ForegroundColor DarkGray
Write-Host "" -ForegroundColor Gray
Write-Host ""
Write-Host "  note: re-run this installer after npm upgrade (it re-applies the patch)" -ForegroundColor DarkGray
Write-Host ""
