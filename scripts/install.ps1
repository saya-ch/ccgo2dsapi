#requires -Version 5
<#
  ccgo2dsapi / 一键安装

  做两件事：
    1. 检查 Node.js（>= 24）
    2. 生成 config.json（若不存在，从 config.example.json 复制）
  本项目不依赖任何第三方 Command Code 包：协议层在 vendor/ 下自研，
  因此无需 npm install，也没有需要重打的补丁。
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
Write-Host "[1/3] checking node ..." -ForegroundColor Cyan
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
Write-Host "[2/3] config.json ..." -ForegroundColor Cyan
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
Write-Host "[3/3] gateway self-check ..." -ForegroundColor Cyan
$gwFiles = @("vendor\wire.mjs", "vendor\translate.mjs", "vendor\responses.mjs", "vendor\server.mjs")
$missing = @()
foreach ($f in $gwFiles) {
  if (-not (Test-Path (Join-Path $root $f))) { $missing += $f }
}
if ($missing.Count -gt 0) {
  Write-Host "  x 缺少网关文件：" -ForegroundColor Red
  foreach ($m in $missing) { Write-Host "      $m" -ForegroundColor Red }
  throw "gateway incomplete"
}
$syntaxOk = $true
foreach ($f in $gwFiles) {
  & node --check (Join-Path $root $f) 2>$null
  if ($LASTEXITCODE -ne 0) { $syntaxOk = $false; Write-Host "  x 语法错误：$f" -ForegroundColor Red }
}
if (-not $syntaxOk) { throw "gateway syntax error" }
Write-Host "  ok   vendor/ 网关就绪（wire + translate + responses + server）" -ForegroundColor Green

Write-Host ""
Write-Host "  next steps:" -ForegroundColor Cyan
Write-Host "    1. log in with the vendor CLI so auth.json exists" -ForegroundColor Gray
Write-Host "    2. .\launch.ps1          (starts gateway + panel)" -ForegroundColor Gray
Write-Host "    3. .\scripts\test-proxy.ps1   (optional self-check)" -ForegroundColor Gray
Write-Host ""
Write-Host "  optional: create a desktop shortcut ->  .\scripts\make-shortcut.ps1" -ForegroundColor DarkGray
Write-Host "" -ForegroundColor Gray
Write-Host ""
Write-Host "  note: re-run this installer after npm upgrade (it re-applies the patch)" -ForegroundColor DarkGray
Write-Host ""
