#requires -Version 5
<#
  ccgo2dsapi / 代理控制

  启动本地反代进程。凭据从 CLI 自己写的 auth.json 里读，不经过本仓库，
  所以这个文件可以安全地提交到公开仓库。

  用法：
    .\scripts\start-proxy.ps1                 前台运行，Ctrl+C 停止
    .\scripts\start-proxy.ps1 -Hidden         后台运行，日志写 logs\
    .\scripts\start-proxy.ps1 -Port 8888      指定端口
#>
param(
  [int]$Port = 0,
  [string]$HostAddress = "127.0.0.1",
  [switch]$Hidden
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

# ── 读取配置（可选）────────────────────────────────────────
$cfgPath = Join-Path $root "config.json"
$cfg = $null
if (Test-Path $cfgPath) { $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json }

if ($Port -le 0) { $Port = if ($cfg -and $cfg.Port) { [int]$cfg.Port } else { 8787 } }
if (-not $PSBoundParameters.ContainsKey("HostAddress") -and $cfg -and $cfg.HostAddress) { $HostAddress = $cfg.HostAddress }

$authPath = if ($cfg -and $cfg.AuthFile) {
  [Environment]::ExpandEnvironmentVariables($cfg.AuthFile)
} else {
  Join-Path $env:USERPROFILE ".commandcode\auth.json"
}
$pkgName = if ($cfg -and $cfg.ProxyPackage) { $cfg.ProxyPackage } else { "commandcode-api-proxy" }

# ── 凭据 ───────────────────────────────────────────────────
if (-not (Test-Path $authPath)) {
  throw "未找到凭据文件 $authPath —— 请先安装并登录对应 CLI。"
}
$auth = Get-Content $authPath -Raw | ConvertFrom-Json
if (-not $auth.apiKey) { throw "$authPath 里没有 apiKey，请重新登录。" }

$env:CC_API_KEY = $auth.apiKey
$env:LOG_LEVEL = if ($cfg -and $cfg.LogLevel) { $cfg.LogLevel } else { "info" }

# ── 依赖检查 ───────────────────────────────────────────────
$node = (Get-Command node -ErrorAction Stop).Source
$proxyScript = Join-Path $root "node_modules\$pkgName\dist\proxy.js"
if (-not (Test-Path $proxyScript)) {
  throw "未找到代理程序：$proxyScript`n请先在 $root 执行 npm install。"
}

$logs = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null

# ── 端口占用 ───────────────────────────────────────────────
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  $ownerPid = ($existing | Select-Object -First 1).OwningProcess
  Write-Host "端口 $Port 已被 PID $ownerPid 占用，可能代理已在运行。"
  Write-Host "验证：http://${HostAddress}:${Port}/health"
  return
}

# ── 启动 ───────────────────────────────────────────────────
if ($Hidden) {
  $outLog = Join-Path $logs "proxy.log"
  $errLog = Join-Path $logs "proxy.err.log"
  $p = Start-Process -FilePath $node `
    -ArgumentList @($proxyScript, "--host", $HostAddress, "--port", "$Port") `
    -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
  Set-Content -Path (Join-Path $root "proxy.pid") -Value $p.Id
  Write-Host "已后台启动，PID $($p.Id) → http://${HostAddress}:${Port}"
  Write-Host "日志：$outLog"
} else {
  Write-Host "前台启动 → http://${HostAddress}:${Port}（Ctrl+C 停止）"
  & $node $proxyScript --host $HostAddress --port "$Port"
}
