#requires -Version 5
<#
  ccgo2dsapi —— 本地反代启动器 + 额度面板
  ────────────────────────────────────────
  窗口开着 = 代理在跑；关掉窗口 = 代理立即停止。

  不自动刷新。面板只在启动时画一次，之后只有你按键才重绘，
  所以控制台不会闪。

  按键：
    R  刷新额度与用量
    T  重新测速（实测 TPS）
    Q  退出（同时停止代理）

  用法：
    .\launch.ps1                      默认端口，见 config.json
    .\launch.ps1 -Port 8888           换端口
    .\launch.ps1 -ShowKey             显示完整上游 key
    .\launch.ps1 -NoTakeOver          端口被占用时不接管
    .\launch.ps1 -NoColor             纯文本输出
    .\launch.ps1 -LogPanel out.txt    把每帧面板追加写入文件

  测速不自动执行：启动时只拉模型清单与额度，TPS 一栏显示 -。
  按 T 才测速，因为每次测速都会真实发请求、消耗套餐额度。
#>
param(
  [int]$Port = 0,
  [string]$HostAddress = "",
  [switch]$ShowKey,
  [switch]$NoTakeOver,
  [switch]$NoPause,
  [switch]$NoColor,
  [switch]$NoSpeedTest,   # 兼容旧命令；启动时本来就不测速，此开关已无实际作用
  [string]$LogPanel,
  [int]$MaxFrames = 0
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$Root        = $PSScriptRoot
$LogDir      = Join-Path $Root "logs"
$LogFile     = Join-Path $LogDir "launcher.log"
$ModelsEverySeconds = 1800

# ══ 配置 ═══════════════════════════════════════════════════
# 用 JSON 而不是 .psd1：跨平台、无编码坑、任何语言都能生成。
$cfgPath = Join-Path $Root "config.json"
$cfg = $null
if (Test-Path $cfgPath) {
  try { $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $cfg = $null }
}

# 按名字取配置项，支持 a.b.c 形式的路径；缺失时返回默认值
function Cfg([string]$path, $default) {
  if (-not $cfg) { return $default }
  $node = $cfg
  foreach ($k in $path.Split('.')) {
    if ($null -eq $node) { return $default }
    $prop = $node.PSObject.Properties[$k]
    if ($null -eq $prop) { return $default }
    $node = $prop.Value
  }
  if ($null -eq $node) { return $default }
  return $node
}

if ($Port -le 0) { $Port = [int](Cfg "Port" 8787) }
if (-not $HostAddress) { $HostAddress = [string](Cfg "HostAddress" "127.0.0.1") }

$pkgName   = [string](Cfg "ProxyPackage" "commandcode-api-proxy")
$distEntry = Join-Path $Root "node_modules\$pkgName\dist\proxy.js"

$authRaw = [string](Cfg "AuthFile" "%USERPROFILE%\.commandcode\auth.json")
$authFile = [Environment]::ExpandEnvironmentVariables($authRaw)

$apiBase    = [string](Cfg "Upstream.ApiBase" "https://api.commandcode.ai")
$modelsPath = [string](Cfg "Upstream.ModelsPath" "/provider/v1/models")
$creditsPath= [string](Cfg "Upstream.CreditsPath" "/alpha/billing/credits")
$subsPath   = [string](Cfg "Upstream.SubscriptionPath" "/alpha/billing/subscriptions")
$planUrl    = [string](Cfg "Upstream.PlanPageUrl" "https://commandcode.ai/docs/plans/go")
$cliVersion    = [string](Cfg "Upstream.CliVersion" "")
$cliVersionReg = [string](Cfg "Upstream.CliVersionRegistry" "")

# 本项目只针对 DeepSeek 模型。过滤用锚定前缀，避免误收其它厂商模型。
$modelFilter = [string](Cfg "Panel.ModelFilter" "^deepseek/")
$speedModels = @(Cfg "Panel.SpeedTestModels" @())
$tpsGood     = [double](Cfg "Panel.TpsGood" 250)
$tpsLow      = [double](Cfg "Panel.TpsLow" 120)

# 套餐表转成大小写不敏感的字典，避免 planId 大小写不一致导致查不到
$planCredits = @{}
$pcNode = Cfg "PlanCredits" $null
if ($pcNode) {
  foreach ($p in $pcNode.PSObject.Properties) { $planCredits[$p.Name] = [double]$p.Value }
}
$planNames = @{}
$pnNode = Cfg "PlanNames" $null
if ($pnNode) {
  foreach ($p in $pnNode.PSObject.Properties) { $planNames[$p.Name] = [string]$p.Value }
}

# ══ 颜色 ═══════════════════════════════════════════════════
$ESC = [char]27
$script:UseColor = -not $NoColor
try { if ([Console]::IsOutputRedirected) { $script:UseColor = $false } } catch { $script:UseColor = $false }

$script:ANSI = @{
  Cyan = "$ESC[36m"; DarkCyan = "$ESC[2;36m"; White = "$ESC[97m"; Gray = "$ESC[37m"
  DarkGray = "$ESC[90m"; Green = "$ESC[92m"; DarkYellow = "$ESC[33m"; Yellow = "$ESC[93m"
  Red = "$ESC[91m"; DarkRed = "$ESC[2;31m"; Reset = "$ESC[0m"
}

# ══ 排版工具 ═══════════════════════════════════════════════
function Get-DisplayWidth([string]$s) {
  if (-not $s) { return 0 }
  $w = 0
  foreach ($ch in $s.ToCharArray()) {
    $c = [int][char]$ch
    if ($c -ge 0x1100 -and (
        ($c -le 0x115F) -or ($c -ge 0x2E80 -and $c -le 0x303E) -or
        ($c -ge 0x3041 -and $c -le 0x33FF) -or ($c -ge 0x3400 -and $c -le 0x4DBF) -or
        ($c -ge 0x4E00 -and $c -le 0x9FFF) -or ($c -ge 0xA000 -and $c -le 0xA4CF) -or
        ($c -ge 0xAC00 -and $c -le 0xD7A3) -or ($c -ge 0xF900 -and $c -le 0xFAFF) -or
        ($c -ge 0xFE30 -and $c -le 0xFE6F) -or ($c -ge 0xFF00 -and $c -le 0xFF60) -or
        ($c -ge 0xFFE0 -and $c -le 0xFFE6))) { $w += 2 } else { $w += 1 }
  }
  return $w
}
function PadR([string]$s, [int]$width) {
  $pad = $width - (Get-DisplayWidth $s); if ($pad -lt 0) { $pad = 0 }
  return $s + (" " * $pad)
}
function PadL([string]$s, [int]$width) {
  $pad = $width - (Get-DisplayWidth $s); if ($pad -lt 0) { $pad = 0 }
  return (" " * $pad) + $s
}
function Clip([string]$s, [int]$width) {
  if ((Get-DisplayWidth $s) -le $width) { return $s }
  $out = ""; $w = 0
  foreach ($ch in $s.ToCharArray()) {
    $cw = Get-DisplayWidth ([string]$ch)
    if ($w + $cw -gt $width - 1) { break }
    $out += $ch; $w += $cw
  }
  return $out + ".."
}
function Money([double]$v, [string]$fmt = "0.00") {
  return "$" + $v.ToString($fmt, [System.Globalization.CultureInfo]::InvariantCulture)
}
function FmtReset($resetAt) {
  if (-not $resetAt) { return "-" }
  try {
    if ($resetAt -is [string]) { return [DateTimeOffset]::Parse($resetAt).ToLocalTime().ToString("MM-dd HH:mm") }
    return [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$resetAt).ToLocalTime().ToString("MM-dd HH:mm")
  } catch { return "-" }
}
function Bar([double]$used, [double]$cap, [int]$cells = 10) {
  if ($cap -le 0) { return ("." * $cells) }
  $ratio = [Math]::Min(1.0, [Math]::Max(0.0, $used / $cap))
  $fill = [int][Math]::Round($ratio * $cells)
  if ($used -gt 0 -and $fill -eq 0) { $fill = 1 }
  if ($fill -gt $cells) { $fill = $cells }
  return ("#" * $fill) + ("." * ($cells - $fill))
}

function Fail($msg, $hint) {
  Write-Host ""
  Write-Host ("  x " + $msg) -ForegroundColor Red
  if ($hint) { Write-Host ("    " + $hint) -ForegroundColor DarkGray }
  Write-Host ""
  if (-not $NoPause) { try { Read-Host "  按回车退出" | Out-Null } catch { } }
  exit 1
}

# ══ 前置检查 ═══════════════════════════════════════════════
if (-not (Test-Path $distEntry)) {
  Fail "找不到代理入口：$distEntry" "请先在 $Root 执行：npm install"
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not (Test-Path $authFile)) {
  Fail "找不到凭据：$authFile" "请先登录对应 CLI（会生成 auth.json），或在 config.psd1 里改 AuthFile"
}
$apiKey = (Get-Content $authFile -Raw | ConvertFrom-Json).apiKey
if (-not $apiKey) { Fail "凭据里没有 apiKey" "请重新登录 CLI" }
$maskedKey = if ($ShowKey) { $apiKey } else { $apiKey.Substring(0, 12) + "..." + $apiKey.Substring($apiKey.Length - 6) }

# ══ 端口接管（只针对本端口）════════════════════════════════
function Get-ListenerPid([int]$p) {
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  if ($c) { return ($c | Select-Object -First 1).OwningProcess }
  return $null
}
$existingPid = Get-ListenerPid $Port
if ($existingPid) {
  $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$existingPid" -ErrorAction SilentlyContinue
  $isOurs = $procInfo -and ($procInfo.CommandLine -match [regex]::Escape($pkgName))
  if (-not $isOurs) {
    Fail "端口 $Port 被其它程序占用（PID $existingPid）" ("命令行：" + $procInfo.CommandLine)
  }
  if ($NoTakeOver) { Fail "端口 $Port 已有代理实例（PID $existingPid）" "去掉 -NoTakeOver 可接管" }
  Write-Host ("  接管：停止旧实例 PID " + $existingPid + " ...") -ForegroundColor Yellow
  Stop-Process -Id $existingPid -Force -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 24; $i++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-ListenerPid $Port)) { break }
  }
  if (Get-ListenerPid $Port) { Fail "旧实例未释放端口 $Port" "请手动检查 PID $existingPid" }
}

# ══ 拉起代理（附着控制台 → 关窗口即停）═════════════════════
$env:CC_API_KEY = $apiKey
$env:PORT       = "$Port"
$env:HOST       = $HostAddress
$env:LOG_LEVEL  = [string](Cfg "LogLevel" "info")

$errFile = Join-Path $LogDir "launcher.err.log"
$proxy = Start-Process node -ArgumentList @("`"$distEntry`"") `
  -WorkingDirectory $Root -NoNewWindow -PassThru `
  -RedirectStandardOutput $LogFile -RedirectStandardError $errFile

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Milliseconds 250
  if ($proxy.HasExited) { break }
  try { $null = Invoke-RestMethod "http://${HostAddress}:${Port}/health" -TimeoutSec 1; $ready = $true; break } catch { }
}
if (-not $ready) {
  if (-not $proxy.HasExited) { Stop-Process -Id $proxy.Id -Force -ErrorAction SilentlyContinue }
  Write-Host ""
  Write-Host "  x 代理启动失败，日志末尾：" -ForegroundColor Red
  Get-Content $LogFile -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ("    " + $_) -ForegroundColor DarkGray }
  Get-Content $errFile -Tail 12 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ("    " + $_) -ForegroundColor DarkRed }
  if (-not $NoPause) { try { Read-Host "`n  按回车退出" | Out-Null } catch { } }
  exit 1
}

# ══ 拉起 Responses API 适配层 ══════════════════════════════
# Responses 走独立端口，内部把请求转发到上面这个 Port，复用上游协议与鉴权。
$responsesEnabled = [bool](Cfg "Responses.Enabled" $true)
$responsesPort = [int](Cfg "Responses.Port" 8788)
$responsesProc = $null

if ($responsesEnabled -and $responsesPort -gt 0) {
  $rsScript = Join-Path $Root "tools\responses-server.mjs"
  if (Test-Path $rsScript) {
    # 端口被旧实例占用就先清掉
    $oldRs = Get-ListenerPid $responsesPort
    if ($oldRs) {
      $oldInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$oldRs" -ErrorAction SilentlyContinue
      if ($oldInfo -and $oldInfo.CommandLine -match 'responses-server') {
        Stop-Process -Id $oldRs -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
      }
    }
    $rsOut = Join-Path $LogDir "responses.log"
    $responsesProc = Start-Process node -ArgumentList @(
      "`"$rsScript`"", "--port", "$responsesPort",
      "--host", $HostAddress, "--upstream", "http://${HostAddress}:${Port}"
    ) -WorkingDirectory $Root -NoNewWindow -PassThru `
      -RedirectStandardOutput $rsOut -RedirectStandardError (Join-Path $LogDir "responses.err.log")

    $rsReady = $false
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 250
      if ($responsesProc.HasExited) { break }
      try {
        $null = Invoke-RestMethod "http://${HostAddress}:${responsesPort}/health" -TimeoutSec 1
        $rsReady = $true; break
      } catch { }
    }
    if (-not $rsReady) {
      if (-not $responsesProc.HasExited) { Stop-Process -Id $responsesProc.Id -Force -ErrorAction SilentlyContinue }
      $responsesProc = $null
    }
  }
}

# ══ 实时数据 ═══════════════════════════════════════════════
# CLI 版本：优先 config，其次查 npm，最后回落到空（不带该头）
if (-not $cliVersion -and $cliVersionReg) {
  try {
    $reg = Invoke-RestMethod $cliVersionReg -TimeoutSec 8
    if ($reg.version) { $cliVersion = [string]$reg.version }
  } catch { }
}

$ccHeaders = @{
  "Authorization" = "Bearer $apiKey"
  "Accept"        = "application/json"
  "x-session-id"  = "panel-" + [guid]::NewGuid().ToString()
  "x-project-slug" = "ccgo2dsapi"
  "x-taste-learning" = "false"
  "x-co-flag" = "false"
}
if ($cliVersion) {
  $ccHeaders["x-command-code-version"] = $cliVersion
  $ccHeaders["x-cli-environment"] = "production"
  $ccHeaders["User-Agent"] = "commandcode-cli/$cliVersion Node.js/$($PSVersionTable.PSVersion)"
}

$script:catalog = @(); $script:srcModels = "..."
$script:reqTable = @{}; $script:srcQuota = "..."
$script:usage = $null; $script:planId = $null; $script:subStatus = $null; $script:periodEnd = $null
$script:quotaError = $null; $script:quotaAt = $null
$script:speed = @{}; $script:speedAt = $null
$script:speedFail = @{}
$script:modelsAt = $null

function Update-Models {
  $cat = $null
  try {
    $r = Invoke-RestMethod ($apiBase + $modelsPath) -Headers $ccHeaders -TimeoutSec 15
    if ($r.data) {
      $cat = $r.data | Where-Object { $_.id -match $modelFilter } |
        Select-Object id, @{n='ctx';e={[int64]$_.context_length}}, @{n='name';e={$_.name}}
    }
  } catch { }
  if ($cat) { $script:catalog = @($cat | Sort-Object { -$_.ctx }, id); $script:srcModels = "live" }
  elseif ($script:catalog.Count -eq 0) { $script:srcModels = "unavailable" }

  # 抓套餐页上的「估算请求条数」
  $tbl = @{}
  try {
    $html = [string](Invoke-WebRequest $planUrl -UseBasicParsing -TimeoutSec 20).Content
    $t = [regex]::Replace($html, '(?is)<(script|style)[^>]*>.*?</\1>', ' ')
    $t = [regex]::Replace($t, '(?s)<[^>]+>', ' ')
    $t = [System.Net.WebUtility]::HtmlDecode($t)
    $t = [regex]::Replace($t, '\s+', ' ')
    $i1 = $t.IndexOf('estimated request counts'); $i2 = $t.IndexOf('How is 10x possible', [Math]::Max($i1, 0))
    if ($i1 -ge 0 -and $i2 -gt $i1) {
      $seg = $t.Substring($i1, $i2 - $i1)
      foreach ($m in [regex]::Matches($seg, '([A-Z][A-Za-z0-9\.\-\(\) ]{2,40}?)\s+([\d][\d,]*)\s+([\d][\d,]*)\s+([\d][\d,]*)')) {
        $tbl[(($m.Groups[1].Value -replace '\s+', ' ').Trim())] = @($m.Groups[2].Value, $m.Groups[3].Value, $m.Groups[4].Value)
      }
    }
  } catch { }
  if ($tbl.Count -gt 0) { $script:reqTable = $tbl; $script:srcQuota = "live" }
  $script:modelsAt = Get-Date
}

function Update-Quota {
  try {
    $script:usage = Invoke-RestMethod ($apiBase + $creditsPath) -Headers $ccHeaders -TimeoutSec 12
    $script:quotaError = $null
  } catch { $script:quotaError = $_.Exception.Message }

  try {
    $sub = Invoke-RestMethod ($apiBase + $subsPath) -Headers $ccHeaders -TimeoutSec 12
    $sd = if ($sub.data) { $sub.data } else { $sub }
    $script:planId = $sd.planId; $script:subStatus = $sd.status; $script:periodEnd = $sd.currentPeriodEnd
  } catch { }
  $script:quotaAt = Get-Date
}

# 测速交给 tools\measure-speed.mjs：真流式计时。
# PowerShell 的 Invoke-WebRequest 会缓冲整个响应，用它算 TPS 会把首字延迟
# 也算进分母，结果严重偏低（实测能从 300 掉到 40）。
# 只在用户按 T 时调用——每次测速都会真实发请求并消耗套餐额度。
function Update-Speed {
  try {
    $sp = Join-Path $Root "tools\measure-speed.mjs"
    if (-not (Test-Path $sp)) { return }
    $models = if ($speedModels.Count -gt 0) { $speedModels } else {
      @($script:catalog | ForEach-Object { $_.id })
    }
    if ($models.Count -eq 0) { return }

    $raw = & node $sp --port $Port --models ($models -join ",") 2>$null
    if (-not $raw) { return }
    $obj = (($raw | Out-String).Trim()) | ConvertFrom-Json
    foreach ($m in $models) {
      $v = $obj.$m
      if ($null -eq $v) { continue }
      if ($v.error) {
        # 记下失败原因，面板上显示 E 而不是让这一格空着（否则看着像"没测"）
        $script:speedFail[$m] = [string]$v.error
        continue
      }
      if ($null -ne $v.tps) {
        $script:speed[$m] = [pscustomobject]@{ tps = [double]$v.tps; ttft = $v.ttft; total = $v.total; tokens = $v.tokens }
        $script:speedFail.Remove($m)
      }
    }
    $script:speedAt = Get-Date
  } catch { }
}

function Get-ReqRow($modelName) {
  if (-not $modelName) { return $null }
  $target = ($modelName -replace '\(latest\)','' -replace '\(exp\)','' -replace '\s+',' ').Trim().ToLower()
  foreach ($k in $script:reqTable.Keys) {
    $kt = ($k -replace '\(latest\)','' -replace '\(exp\)','' -replace '\s+',' ').Trim().ToLower()
    if ($kt -eq $target) { return $script:reqTable[$k] }
  }
  return $null
}

$script:ver = "?"
try { $script:ver = (Invoke-RestMethod "http://${HostAddress}:${Port}/health" -TimeoutSec 5).version } catch { }

# ══ 渲染 ═══════════════════════════════════════════════════
$INNER = 74

function Render {
  $L = [System.Collections.Generic.List[object]]::new()
  $script:__L = $L
  function AddRow([string]$c, [string]$col) {
    $script:__L.Add([pscustomobject]@{ t = ("  |" + (PadR ("  " + $c) $INNER) + "|"); c = $col })
  }
  function AddSep { $script:__L.Add([pscustomobject]@{ t = ("  +" + ("-" * $INNER) + "+"); c = "Cyan" }) }
  function AddDiv { $script:__L.Add([pscustomobject]@{ t = ("  |  " + ("-" * ($INNER - 4)) + "  |"); c = "DarkGray" }) }

  AddSep
  $titleL = "  ccgo2dsapi"
  $titleR = "v$($script:ver) :$Port"
  $gap = $INNER - (Get-DisplayWidth $titleL) - (Get-DisplayWidth $titleR); if ($gap -lt 1) { $gap = 1 }
  $L.Add([pscustomobject]@{ t = ("  |" + $titleL + (" " * $gap) + $titleR + "|"); c = "Cyan" })
  AddSep

  AddRow "Connection" "Cyan"
  AddRow "OpenAI      http://${HostAddress}:${Port}/v1" "White"
  AddRow "Anthropic   http://${HostAddress}:${Port}" "White"
  if ($responsesProc -and -not $responsesProc.HasExited) {
    AddRow "Responses   http://${HostAddress}:${responsesPort}/v1" "White"
  }
  AddRow "API Key     proxy-managed" "White"
  AddRow ("Upstream    " + $maskedKey) "DarkYellow"
  if (-not $ShowKey) { AddRow "            (-ShowKey to reveal)" "DarkGray" }
  AddSep

  $idW = 40
  # 测速状态动态显示：未测时不能写 measured
  $speedState = if ($script:speedAt) { "measured " + $script:speedAt.ToString("HH:mm") } else { "press T" }
  AddRow ("Models   source:" + $script:srcModels + "   speed:" + $speedState) "Cyan"
  AddRow ((PadR "Model ID" $idW) + (PadL "Ctx" 7) + (PadL "TPS" 7) + (PadL "5h" 7) + (PadL "month" 8)) "DarkGray"
  AddDiv
  foreach ($m in $script:catalog) {
    $ctxTxt = if ($m.ctx -ge 1000000) { ("{0:0.##}M" -f ($m.ctx / 1e6)) } else { ("{0:0}K" -f ($m.ctx / 1e3)) }
    # 面板只显示短名（去掉 deepseek/ 前缀），内部仍用完整 id 做键
    $shortId = $m.id -replace '^[^/]+/', ''
    $qr = Get-ReqRow $m.name
    if (-not $qr) { $qr = Get-ReqRow $shortId }
    $c1 = if ($qr) { $qr[0] } else { "-" }
    $c3 = if ($qr) { $qr[2] } else { "-" }
    $tps = "-"; $col = "White"
    if ($script:speed.ContainsKey($m.id)) {
      $tps = ("{0:0}" -f $script:speed[$m.id].tps)
      if ($script:speed[$m.id].tps -ge $tpsGood) { $col = "Green" }
      elseif ($script:speed[$m.id].tps -lt $tpsLow) { $col = "DarkYellow" }
    }
    elseif ($script:speedFail.ContainsKey($m.id)) {
      # E = 测速失败（多半是套餐不含该模型，或该模型不支持纯文本小请求）
      $tps = "E"; $col = "DarkRed"
    }
    AddRow ((PadR (Clip $shortId $idW) $idW) + (PadL $ctxTxt 7) + (PadL $tps 7) + (PadL $c1 7) + (PadL $c3 8)) $col
  }
  if ($script:catalog.Count -eq 0) { AddRow "(model list unavailable - check config.json)" "DarkRed" }
  AddRow "TPS measured | E = failed | counts are vendor estimates" "DarkGray"
  AddSep

  $u = $script:usage
  $f5 = $null; $wk = $null; $h5Cap = 3.0; $wkCap = 6.0
  if ($u -and $u.windowLimits) {
    $f5 = $u.windowLimits.fiveHour; $wk = $u.windowLimits.weekly
    if ($f5 -and $f5.cap) { $h5Cap = [double]$f5.cap }
    if ($wk -and $wk.cap) { $wkCap = [double]$wk.cap }
  }
  $mc = if ($u -and $u.credits) { [double]$u.credits.monthlyCredits } else { $null }
  $monthCap = if ($script:planId -and $planCredits.ContainsKey($script:planId)) { [double]$planCredits[$script:planId] } else { $null }
  $usedMo = $null
  if ($null -ne $mc -and $null -ne $monthCap) { $usedMo = $monthCap - $mc; if ($usedMo -lt 0) { $usedMo = 0 } }
  $planLabel = if ($script:planId) { if ($planNames.ContainsKey($script:planId)) { $planNames[$script:planId] } else { $script:planId } } else { "-" }
  $stTxt = if ($script:subStatus) { $script:subStatus } else { "-" }

  AddRow ("Quota   plan:" + $planLabel + "   status:" + $stTxt + "   source:" + $script:srcQuota) "Cyan"
  AddRow ((PadR "Window" 10) + (PadL "Used" 8) + (PadL "Left" 8) + "  " + (PadR "Usage" 12) + (PadL "%" 6) + "  " + (PadR "Resets" 11)) "DarkGray"
  AddDiv

  function AddQuotaRow([string]$label, $used, $cap, $resetAt, [string]$color) {
    if ($null -eq $used -or $null -eq $cap) {
      AddRow ((PadR $label 10) + (PadL "-" 8) + (PadL "-" 8) + "  " + (PadR ("." * 10) 12) + (PadL "-" 6) + "  " + (PadR "-" 11)) "DarkGray"
      return
    }
    $remain = $cap - $used; if ($remain -lt 0) { $remain = 0 }
    $pct = if ($cap -gt 0) { 100.0 * $used / $cap } else { 0 }
    AddRow ((PadR $label 10) + (PadL (Money $used) 8) + (PadL (Money $remain) 8) + "  " + (PadR (Bar $used $cap) 12) + (PadL ("{0:0}%" -f $pct) 6) + "  " + (PadR (FmtReset $resetAt) 11)) $color
  }
  AddQuotaRow "5-hour" $f5.used $h5Cap $f5.resetAt "White"
  AddQuotaRow "weekly" $wk.used $wkCap $wk.resetAt "White"
  AddQuotaRow "monthly" $usedMo $monthCap $script:periodEnd "White"

  if ($script:quotaError) { AddRow ("refresh failed: " + (Clip $script:quotaError 50)) "DarkRed" }
  AddSep

  $L.Add([pscustomobject]@{ t = ("  |" + (PadR ("  log  " + (Clip $LogFile ($INNER - 8))) $INNER) + "|"); c = "DarkGray" })
  $L.Add([pscustomobject]@{ t = ("  |" + (PadR "  close this window = stop the proxy" $INNER) + "|"); c = "Green" })
  AddSep

  $lastTxt = if ($script:quotaAt) { $script:quotaAt.ToString("HH:mm:ss") } else { "-" }
  $spTxt = if ($script:speedAt) { "  |  speed " + $script:speedAt.ToString("HH:mm") } else { "" }
  $status = "  updated " + $lastTxt + "  |  R refresh   T speed   Q quit" + $spTxt
  $L.Add([pscustomobject]@{ t = (PadR $status ($INNER + 4)); c = "DarkCyan" })

  return ,$L
}

# 只在启动和按键时按行输出 —— 不做定时重绘，所以不会闪
function DrawPanel([string]$prefix) {
  if ($prefix) { Write-Host ""; Write-Host ("  " + $prefix) -ForegroundColor DarkGray }
  $plain = [System.Collections.Generic.List[string]]::new()
  if ($prefix) { $plain.Add("  " + $prefix) }
  foreach ($x in (Render)) {
    if ($script:UseColor -and $script:ANSI.ContainsKey($x.c)) {
      Write-Host ($script:ANSI[$x.c] + $x.t + $script:ANSI.Reset)
    } else { Write-Host $x.t }
    $plain.Add($x.t)
  }
  if ($LogPanel) {
    try {
      $plain.Add("")
      [System.IO.File]::AppendAllLines($LogPanel, $plain.ToArray(), [System.Text.Encoding]::UTF8)
    } catch { }
  }
}

# ══ 主循环：只响应按键，不自动刷新 ══════════════════════════
# 启动时不测速：测速要实际发请求、消耗套餐额度，只应由用户按 T 主动触发。
Update-Models
Update-Quota

DrawPanel ""
$frames = 1

$canReadKeys = $true
try { $null = [Console]::KeyAvailable } catch { $canReadKeys = $false }
if (-not $canReadKeys) {
  Write-Host ""
  Write-Host "  [note] No interactive console: R/T/Q disabled, proxy keeps running." -ForegroundColor DarkYellow
  Write-Host "         Close this window (or kill the process) to stop it." -ForegroundColor DarkGray
}

try {
  while ($true) {
    if ($proxy.HasExited) { break }
    if ($MaxFrames -gt 0 -and $frames -ge $MaxFrames) { break }

    if (-not $canReadKeys) {
      Wait-Process -Id $proxy.Id -ErrorAction SilentlyContinue
      break
    }

    $action = $null
    while ($null -eq $action) {
      if ($proxy.HasExited) { break }
      try {
        if ([Console]::KeyAvailable) {
          switch ([Console]::ReadKey($true).Key) {
            "R" { $action = "refresh" }
            "T" { $action = "speed" }
            "Q" { $action = "quit" }
            default { }
          }
        }
      } catch {
        $canReadKeys = $false
        break
      }
      if ($null -eq $action) { Start-Sleep -Milliseconds 150 }
    }
    if ($proxy.HasExited) { break }
    if ($action -eq "quit") { break }
    if (-not $canReadKeys) { continue }

    if ($action -eq "refresh") {
      Update-Quota
      if ($script:modelsAt -and ((Get-Date) - $script:modelsAt).TotalSeconds -ge $ModelsEverySeconds) { Update-Models }
      DrawPanel ("refreshed " + (Get-Date).ToString("HH:mm:ss"))
    }
    elseif ($action -eq "speed") {
      Write-Host ""
      Write-Host "  measuring speed (~10s) ..." -ForegroundColor DarkGray
      Update-Speed
      DrawPanel ("speed updated " + (Get-Date).ToString("HH:mm:ss"))
    }
    $frames++
  }
} finally {
  if ($responsesProc -and -not $responsesProc.HasExited) {
    try { Stop-Process -Id $responsesProc.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
  if ($proxy -and -not $proxy.HasExited) {
    try { Stop-Process -Id $proxy.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
}

if ($MaxFrames -eq 0) {
  Write-Host ""
  if ($proxy.HasExited) {
    Write-Host "  proxy exited. last log lines:" -ForegroundColor Yellow
    Get-Content $LogFile -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ("    " + $_) -ForegroundColor DarkGray }
  } else {
    Write-Host "  quit - proxy stopped." -ForegroundColor Yellow
  }
}
if (-not $NoPause) {
  try { if (-not [Console]::IsOutputRedirected) { Read-Host "`n  press Enter to close" | Out-Null } } catch { }
}
