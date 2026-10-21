#requires -Version 5
<#
  ccgo2dsapi / 停止网关

  优先读 proxy.pid；没有 pid 文件时按端口 + /health + 命令行兜底。
  会先核对命令行，避免 PID 被系统复用后误杀无关进程。

  用法：
    .\scripts\stop-proxy.ps1
    .\scripts\stop-proxy.ps1 -Port 8888
#>
param([int]$Port = 0)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Read-Cfg([string]$dotted, $default) {
  $p = Join-Path $root "config.json"
  if (-not (Test-Path $p)) { return $default }
  try {
    $cur = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($seg in $dotted.Split('.')) {
      if ($null -eq $cur) { return $default }
      $cur = $cur.$seg
    }
    if ($null -eq $cur) { return $default }
    return $cur
  } catch { return $default }
}

if ($Port -le 0) { $Port = [int](Read-Cfg "Port" 8787) }
$HostAddress = [string](Read-Cfg "HostAddress" "127.0.0.1")

# 自研网关的识别特征：命令行里出现 vendor\server.mjs 或 vendor/server.mjs
$marker = 'vendor[\\/]server\.mjs'

function Test-IsOurs([int]$procId) {
  if (-not $procId) { return $false }
  $info = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
  if (-not $info) { return $false }
  return ($info.CommandLine -match $marker)
}

$pidFile = Join-Path $root "proxy.pid"
$stopped = $false

# ── 优先按 pid 文件 ────────────────────────────────────────
if (Test-Path $pidFile) {
  $proxyPid = (Get-Content $pidFile -Raw).Trim()
  if ($proxyPid -match '^\d+$') {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $proxyPid" -ErrorAction SilentlyContinue
    if (-not $proc) {
      Write-Host "PID $proxyPid 已不存在，清理 pid 文件。"
    } elseif (Test-IsOurs $proxyPid) {
      Stop-Process -Id $proxyPid -Force -ErrorAction SilentlyContinue
      Write-Host "已停止网关（PID $proxyPid）。"
      $stopped = $true
    } else {
      Write-Host "PID $proxyPid 不是本项目的网关进程，未处理：$($proc.CommandLine)"
    }
  }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

# ── 兜底：按端口找 ─────────────────────────────────────────
if (-not $stopped) {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (-not $conn) {
    Write-Host "端口 $Port 没有监听，网关应该已经停了。"
  } else {
    $pidFromPort = ($conn | Select-Object -First 1).OwningProcess
    if (Test-IsOurs $pidFromPort) {
      Stop-Process -Id $pidFromPort -Force -ErrorAction SilentlyContinue
      Write-Host "已按端口停止网关（PID $pidFromPort）。"
      $stopped = $true
    } else {
      $info = Get-CimInstance Win32_Process -Filter "ProcessId = $pidFromPort" -ErrorAction SilentlyContinue
      Write-Host "端口 $Port 被 PID $pidFromPort 占用，但不是本项目的网关，未处理。"
      if ($info) { Write-Host "  命令行：$($info.CommandLine)" -ForegroundColor DarkGray }
    }
  }
}

# ── 顺手清理备用端口上的残留实例 ──────────────────────────
$stagePort = $Port + 100
$stageConn = Get-NetTCPConnection -LocalPort $stagePort -State Listen -ErrorAction SilentlyContinue
if ($stageConn) {
  $stagePid = ($stageConn | Select-Object -First 1).OwningProcess
  if (Test-IsOurs $stagePid) {
    Stop-Process -Id $stagePid -Force -ErrorAction SilentlyContinue
    Write-Host "已清理备用端口 $stagePort 上的实例（PID $stagePid）。"
  }
}

# ── 旧版本可能留下的 8788 适配层 ──────────────────────────
$legacyPort = 8788
if ($legacyPort -ne $Port) {
  $legacyConn = Get-NetTCPConnection -LocalPort $legacyPort -State Listen -ErrorAction SilentlyContinue
  if ($legacyConn) {
    $legacyPid = ($legacyConn | Select-Object -First 1).OwningProcess
    $legacyInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $legacyPid" -ErrorAction SilentlyContinue
    if ($legacyInfo -and $legacyInfo.CommandLine -match 'responses-server') {
      Stop-Process -Id $legacyPid -Force -ErrorAction SilentlyContinue
      Write-Host "已清理旧版 Responses 适配层（PID $legacyPid）。"
    }
  }
}
