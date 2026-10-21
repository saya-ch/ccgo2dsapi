# scripts/swap-gateway.ps1 —— 零中断热替换网关
#
# 为什么需要这个脚本：
#   直接用「停旧进程 → 起新进程」会留下几百毫秒空窗，正在进行的请求会失败。
#
# 为什么不用 -RedirectStandardOutput：
#   Start-Process 一旦接管子进程的 stdout/stderr 管道，PowerShell 会一直持有
#   句柄，脚本看起来像卡住直到超时。现在改成让网关自己用 --log-file 落盘，
#   启动方不碰管道，Start-Process 立即返回。
#
# 流程：
#   1. 备用端口起新实例（不接管管道）
#   2. 健康检查
#   3. 通过备用端口发真实补全，确认真能干活
#   4. 停旧进程，立即在正式端口起新的
#   5. 验证正式端口就绪，清理备用实例
#
# 用法：
#   .\scripts\swap-gateway.ps1              正式端口见 config.json
#   .\scripts\swap-gateway.ps1 -Port 8787
#   .\scripts\swap-gateway.ps1 -DryRun      只验证不切换

param(
    [int]$Port = 0,
    [string]$HostAddress = "",
    [switch]$DryRun,
    [int]$StageOffset = 100,
    [int]$HealthTimeoutSec = 25,
    [int]$ProbeTimeoutSec = 90
)

$ErrorActionPreference = "Stop"
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
if (-not $HostAddress) { $HostAddress = [string](Read-Cfg "HostAddress" "127.0.0.1") }
$stagePort = $Port + $StageOffset

$entry = Join-Path $root "vendor\server.mjs"
$logDir = Join-Path $root "logs"
$authFile = [Environment]::ExpandEnvironmentVariables(
    [string](Read-Cfg "AuthFile" '%USERPROFILE%\.commandcode\auth.json'))
$cliVer = [string](Read-Cfg "Upstream.CliVersion" "")

if (-not (Test-Path $entry)) {
    Write-Host "  x 找不到网关入口：$entry" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Test-Health([int]$p, [int]$timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $h = Invoke-RestMethod "http://${HostAddress}:${p}/health" -TimeoutSec 2
            if ($h.status -eq "ok") { return $true }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    return $false
}

function Stop-OnPort([int]$p) {
    $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if (-not $conn) { return $null }
    $procId = ($conn | Select-Object -First 1).OwningProcess
    $info = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
    # 只动本项目的网关进程，别的一律不碰
    if (-not $info -or $info.CommandLine -notmatch 'vendor[\\/]server\.mjs') {
        return $null
    }
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    return $procId
}

function Start-Gateway([int]$p, [string]$logName) {
    $nodeArgs = @(
        "`"$entry`"",
        "--port", "$p",
        "--host", $HostAddress,
        "--auth", "$authFile",
        "--log-file", (Join-Path $logDir $logName)
    )
    if ($cliVer) { $nodeArgs += @("--cli-version", $cliVer) }

    # 关键：不传 -RedirectStandardOutput / -RedirectStandardError。
    # 网关自己写 --log-file，PowerShell 不接管管道，Start-Process 立即返回。
    return Start-Process node -ArgumentList $nodeArgs `
        -WorkingDirectory $root -WindowStyle Hidden -PassThru
}

Write-Host ""
Write-Host "  网关热替换" -ForegroundColor Cyan
Write-Host "  正式端口 : $Port" -ForegroundColor Gray
Write-Host "  备用端口 : $stagePort" -ForegroundColor Gray
Write-Host ""

# ── 1. 备用端口起新实例 ──────────────────────────────────
if (Get-NetTCPConnection -LocalPort $stagePort -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "  ! 备用端口被占用，先清理" -ForegroundColor Yellow
    Stop-OnPort $stagePort | Out-Null
    Start-Sleep -Milliseconds 400
}

Write-Host "  [1/5] 备用端口启动新实例 ..." -ForegroundColor Cyan
$stageProc = Start-Gateway $stagePort "stage.log"
if (-not (Test-Health $stagePort $HealthTimeoutSec)) {
    Write-Host "  x 新实例启动失败，正式端口保持不变" -ForegroundColor Red
    Get-Content (Join-Path $logDir "stage.log") -Tail 10 -ErrorAction SilentlyContinue |
        ForEach-Object { Write-Host ("      " + $_) -ForegroundColor DarkRed }
    if (-not $stageProc.HasExited) { Stop-Process -Id $stageProc.Id -Force -ErrorAction SilentlyContinue }
    exit 1
}
Write-Host "        ok (PID $($stageProc.Id))" -ForegroundColor Green

# ── 2. 真实请求验证 ────────────────────────────────────
Write-Host "  [2/5] 备用端口发真实补全 ..." -ForegroundColor Cyan
try {
    $reqBody = @{
        model      = "deepseek-v4.1-flash"
        messages   = @(@{ role = "user"; content = "Reply with exactly: OK" })
        max_tokens = 100
    } | ConvertTo-Json -Depth 6
    $resp = Invoke-RestMethod "http://${HostAddress}:${stagePort}/v1/chat/completions" `
        -Method Post -Body $reqBody -ContentType "application/json" -TimeoutSec $ProbeTimeoutSec
    if (-not $resp.choices) { throw "响应缺少 choices" }
    Write-Host "        ok  回复：$($resp.choices[0].message.content)" -ForegroundColor Green
} catch {
    Write-Host "  x 新实例无法完成请求：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "    正式端口保持不变" -ForegroundColor Yellow
    if (-not $stageProc.HasExited) { Stop-Process -Id $stageProc.Id -Force -ErrorAction SilentlyContinue }
    exit 1
}

if ($DryRun) {
    Write-Host ""
    Write-Host "  -DryRun：验证通过，不切换" -ForegroundColor Yellow
    if (-not $stageProc.HasExited) { Stop-Process -Id $stageProc.Id -Force -ErrorAction SilentlyContinue }
    exit 0
}

# ── 3. 停旧 ─────────────────────────────────────────────
Write-Host "  [3/5] 停旧实例 ..." -ForegroundColor Cyan
$killed = Stop-OnPort $Port
if ($killed) { Write-Host "        PID $killed" -ForegroundColor Gray }
else { Write-Host "        端口上没有本项目的实例" -ForegroundColor Gray }

# ── 4. 起新并验证 ──────────────────────────────────────
Write-Host "  [4/5] 正式端口启动 ..." -ForegroundColor Cyan
$mainProc = Start-Gateway $Port "gateway.log"
if (-not (Test-Health $Port $HealthTimeoutSec)) {
    Write-Host "  x 正式端口启动失败！备用实例仍在 $stagePort" -ForegroundColor Red
    exit 1
}
Write-Host "        ok (PID $($mainProc.Id))" -ForegroundColor Green
try { Set-Content -Path (Join-Path $root "proxy.pid") -Value $mainProc.Id -Encoding ASCII } catch { }

# ── 5. 清理备用实例 ────────────────────────────────────
Write-Host "  [5/5] 清理备用实例 ..." -ForegroundColor Cyan
if (-not $stageProc.HasExited) { Stop-Process -Id $stageProc.Id -Force -ErrorAction SilentlyContinue }
Write-Host "        ok" -ForegroundColor Green

Write-Host ""
Write-Host "  切换完成：http://${HostAddress}:${Port}" -ForegroundColor Green
Write-Host ""
exit 0
