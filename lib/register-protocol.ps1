# dsh-notify-focus: register the dshnotify:// protocol handler.
#
# ONE implementation, called by both toast senders. It used to live inline in
# notify.ps1 only, which meant approval toasts - the ones that arrive first on a
# fresh machine, because buttons are enabled by default - never wrote the key.
# On a machine that had never seen a plain notification, clicking Allow did
# nothing at all and left no trace.
#
# Windows PowerShell 5.1. ASCII-only, no BOM.
param()
$ErrorActionPreference = "Stop"

# Resolve the forwarder next to THIS file: the plugin is installed wherever the
# profile puts it, and the registry command must point at that exact location.
$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# wscript.exe by absolute path. The bare name relies on PATH resolution at
# CreateProcess time, which is one more thing that can be wrong on someone
# else's machine for no benefit.
$wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
if (-not (Test-Path $wscript)) {
  $wscript = "wscript.exe"
}

$progId = "HKCU:\Software\Classes\dshnotify"
if (-not (Test-Path $progId)) {
  New-Item -Path $progId -Force | Out-Null
}
Set-Item -Path $progId -Value 'dshnotify' -Force
Set-ItemProperty -Path $progId -Name 'URL Protocol' -Value '' -Force

$cmdKey = "HKCU:\Software\Classes\dshnotify\shell\open\command"
if (-not (Test-Path $cmdKey)) {
  New-Item -Path $cmdKey -Force | Out-Null
}

$vbsPath = Join-Path $PSScriptRoot "forward.vbs"
if (Test-Path $vbsPath) {
  $command = ('"' + $wscript + '" //B //Nologo "' + $vbsPath + '" "%1"')
} else {
  # No forwarder shipped: fall back to powershell directly. This flashes a
  # console, but a working click beats a silent one.
  $launcherPath = Join-Path $PSScriptRoot "launcher.ps1"
  $command = ('"powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherPath + '" "%1"')
}

Set-Item -Path $cmdKey -Value $command -Force
Write-Output ("registered: " + $command)