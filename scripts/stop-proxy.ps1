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
  # 没有 pid 文件时按端口兜底：用 /health 自报的版本确认归属，再停掉
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $conn) {
    Write-Host "端口 $Port 没有监听，代理应该已经停了。"
  } else {
    $pidFromPort = ($conn | Select-Object -First 1).OwningProcess
    $procFromPort = Get-CimInstance Win32_Process -Filter "ProcessId = $pidFromPort" -ErrorAction SilentlyContinue
    $looksOurs = $procFromPort -and $procFromPort.CommandLine -match [regex]::Escape($pkgName)
    try {
      $h = Invoke-RestMethod "http://${HostAddress}:${Port}/health" -TimeoutSec 2
      if (-not $h -or -not $h.version) { $looksOurs = $false }
    } catch { $looksOurs = $false }
    if ($looksOurs) {
      Stop-Process -Id $pidFromPort -Force
      Write-Host "已按端口停止代理（PID $pidFromPort）。"
    } else {
      Write-Host "端口 $Port 被 PID $pidFromPort 占用，但不是本代理，未处理。"
    }
  }
} else {
  $proxyPid = (Get-Content $pidFile -Raw).Trim()
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $proxyPid" -ErrorAction SilentlyContinue
  if (-not $proc) {
    Write-Host "PID $proxyPid 已不存在，清理 pid 文件。"
    Remove-Item $pidFile -Force
  } elseif ($proc.CommandLine -notmatch [regex]::Escape($pkgName)) {
    Write-Host "PID $proxyPid 不是本代理进程，拒绝操作：$($proc.CommandLine)"
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  } else {
    Stop-Process -Id $proxyPid -Force
    Remove-Item $pidFile -Force
    Write-Host "已停止代理（PID $proxyPid）。"
  }
}



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
