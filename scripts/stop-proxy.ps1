#requires -Version 5
<#
  ccgo2dsapi / 停止代理

  只停止由 start-proxy.ps1 -Hidden 启动、并记录在 proxy.pid 里的那个进程。
  会先核对命令行，避免 PID 被系统复用后误杀无关进程。

  用法：
    .\scripts\stop-proxy.ps1
    .\scripts\stop-proxy.ps1 -Port 8888
#>
param([int]$Port = 0)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

$cfgPath = Join-Path $root "config.json"
$cfg = $null
if (Test-Path $cfgPath) { $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json }
if ($Port -le 0) { $Port = if ($cfg -and $cfg.Port) { [int]$cfg.Port } else { 8787 } }
$pkgName = if ($cfg -and $cfg.ProxyPackage) { $cfg.ProxyPackage } else { "commandcode-api-proxy" }

$pidFile = Join-Path $root "proxy.pid"

if (-not (Test-Path $pidFile)) {
  Write-Host "没有 $pidFile —— 代理大概不是用 start-proxy.ps1 -Hidden 启动的。"
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($conn) {
    Write-Host "端口 $Port 当前被 PID $(($conn | Select-Object -First 1).OwningProcess) 占用，请自行确认后处理。"
  }
  return
}

$proxyPid = (Get-Content $pidFile -Raw).Trim()
$proc = Get-CimInstance Win32_Process -Filter "ProcessId = $proxyPid" -ErrorAction SilentlyContinue

if (-not $proc) {
  Write-Host "PID $proxyPid 已不存在，清理 pid 文件。"
  Remove-Item $pidFile -Force
  return
}

if ($proc.CommandLine -notmatch [regex]::Escape($pkgName)) {
  Write-Host "PID $proxyPid 不是本代理进程，拒绝操作：$($proc.CommandLine)"
  return
}

Stop-Process -Id $proxyPid -Force
Remove-Item $pidFile -Force
Write-Host "已停止代理（PID $proxyPid）。"

# Responses 适配层是独立进程，一并停掉，避免只剩它在监听
$rsPort = if ($cfg -and $cfg.Responses -and $cfg.Responses.Port) { [int]$cfg.Responses.Port } else { 8788 }
$rsConn = Get-NetTCPConnection -LocalPort $rsPort -State Listen -ErrorAction SilentlyContinue
if ($rsConn) {
  $rsPid = ($rsConn | Select-Object -First 1).OwningProcess
  $rsProc = Get-CimInstance Win32_Process -Filter "ProcessId = $rsPid" -ErrorAction SilentlyContinue
  if ($rsProc -and $rsProc.CommandLine -match 'responses-server') {
    Stop-Process -Id $rsPid -Force
    Write-Host "已停止 Responses 适配层（PID $rsPid，端口 $rsPort）。"
  }
}
