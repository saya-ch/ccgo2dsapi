#requires -Version 5
<#
  ccgo2dsapi / 创建桌面快捷方式

  双击快捷方式 = 启动代理并显示面板；关闭窗口 = 停止代理。

  用法：
    .\scripts\make-shortcut.ps1
    .\scripts\make-shortcut.ps1 -Name "My Panel" -Port 8888
    .\scripts\make-shortcut.ps1 -Remove
#>
param(
  [string]$Name = "ccgo2dsapi",
  [int]$Port = 0,
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$desktop = [Environment]::GetFolderPath("Desktop")
$lnkPath = Join-Path $desktop "$Name.lnk"

if ($Remove) {
  if (Test-Path $lnkPath) { Remove-Item $lnkPath -Force; Write-Host "removed $lnkPath" }
  else { Write-Host "no shortcut at $lnkPath" }
  return
}

$launcher = Join-Path $root "launch.ps1"
if (-not (Test-Path $launcher)) { throw "launch.ps1 not found at $launcher" }

$argLine = '-NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '"'
if ($Port -gt 0) { $argLine += " -Port $Port" }

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = "powershell.exe"
$lnk.Arguments = $argLine
$lnk.WorkingDirectory = $root
$lnk.Description = "Start local proxy with quota panel (closing the window stops it)"
$lnk.IconLocation = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe,0"
$lnk.Save()

Write-Host ("created: " + $lnkPath) -ForegroundColor Green
Write-Host "double-click it to start; close the window to stop." -ForegroundColor DarkGray
