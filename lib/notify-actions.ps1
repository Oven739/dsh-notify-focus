# dsh-notify-focus: decision button support.
# Adds "Allow" / "Deny" buttons to the approval and question toasts, and routes
# a click back to the running host through the loopback channel
# (lib/decision-channel.mjs) instead of only opening the browser.
#
# Windows PowerShell 5.1 (WinRT projection). ASCII-only, no BOM: parameters are
# bound from the process argument vector.
#
# The param block IS the command-line interface index.js invokes; the shared
# subset (Title/Body/Aumid/AppName/Url/LaunchProtocol/ForegroundPid/
# ForegroundName) must stay in the same order and with the same defaults as
# notify.ps1's block -- they are one logical interface split across two entry
# points because PS 5.1 has no cross-file parameter objects.
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body,
  [string]$Aumid = "DeepSeekHarness.Notify",
  [string]$AppName = "DeepSeek Harness",
  [string]$Url = "",
  [int]$LaunchProtocol = 1,
  [int]$ForegroundPid = 0,
  [string[]]$ForegroundName = @(),
  # Decision buttons. Empty -Token means "plain toast, no buttons".
  [string]$Token = "",
  [string]$AllowLabel = "Allow",
  [string]$DenyLabel = "Deny",
  [string]$Verdict = ""
)
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Foreground suppression, via the SHARED probe (lib/foreground-probe.ps1).
#
# When the DSH host owns the foreground window the user is already looking at
# the approval/question panel, so a toast would cover it. The probe prints
# "skipped foreground" when the pid/name owns the foreground window and
# "show toast" otherwise; any failure prints "show toast", because an unknown
# state must never suppress.
#
# This block used to be pasted inline here AND in notify.ps1 (audit 2026-11-17,
# Standards-1): three copies of one probe, every fix applied three times. It is
# one implementation now.
# ---------------------------------------------------------------------------
if ($ForegroundPid -gt 0 -or $ForegroundName.Count -gt 0) {
  $probeScript = Join-Path $PSScriptRoot "foreground-probe.ps1"
  if (Test-Path $probeScript) {
    $probeArgs = @("-File", $probeScript, "-HostPid", $ForegroundPid)
    foreach ($n in $ForegroundName) { $probeArgs += @("-Name", $n) }
    $verdict = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass @probeArgs 2>$null
    if ("$verdict" -match "skipped foreground") {
      Write-Output "skipped foreground"
      exit 0
    }
  } else {
    # Probe script missing: fail open and show the toast (never suppress on a
    # broken install -- a duplicated toast beats a swallowed one).
    Write-Warning "foreground-probe.ps1 missing; suppression check skipped"
  }
}

# ---------------------------------------------------------------------------
# AppUserModelId: register once under HKCU so Win32 toasts are allowed.
# ---------------------------------------------------------------------------
$key = "HKCU:\SOFTWARE\Classes\AppUserModelId\$Aumid"
try {
  if (-not (Test-Path $key)) {
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name DisplayName -Value $AppName -PropertyType String -Force | Out-Null
  }
} catch {
  Write-Warning ("AUMID registration failed: " + $_.Exception.Message)
}

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null

# ---------------------------------------------------------------------------
# Build the toast.
#   - buttons -> ToastGeneric with <actions>; each action activates
#                dshnotify://answer?t=<token>&v=<verdict>
#   - no buttons -> ToastGeneric with a single clickable body (same protocol
#                   activation the upstream plugin used), which only opens DSH.
# The upstream script used ToastText02, which cannot carry <actions>.
# ---------------------------------------------------------------------------
$xml = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]::new()

$esc = {
  param([string]$s)
  $s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace('"', "&quot;")
}

$launch = ""
if ($Url -ne "") {
  if ($LaunchProtocol -eq 1) {
    # Register the protocol handler before the toast carries a protocol launch.
    #
    # This file sends approval toasts, and on a machine that has never seen a
    # plain notification those are the first ones to arrive - because buttons
    # are enabled by default. Without this call the registry key was never
    # written, so clicking Allow did nothing at all and left no trace.
    try {
      $registerScript = Join-Path $PSScriptRoot "register-protocol.ps1"
      if (Test-Path $registerScript) {
        & $registerScript | Out-Null
      } else {
        Write-Warning "register-protocol.ps1 missing; approval clicks may not resolve"
      }
    } catch {
      Write-Warning ("protocol registration failed: " + $_.Exception.Message)
    }
    $launch = "dshnotify://open?u=" + [uri]::EscapeDataString($Url)
  } else {
    $launch = $Url
  }
}

$sb = New-Object System.Text.StringBuilder
[void]$sb.Append('<toast duration="long"')
if ($launch -ne "") {
  [void]$sb.Append(' activationType="protocol" launch="' + (& $esc $launch) + '"')
}
[void]$sb.Append('>')
[void]$sb.Append('<visual><binding template="ToastGeneric">')
[void]$sb.Append('<text>' + (& $esc $Title) + '</text>')
[void]$sb.Append('<text>' + (& $esc $Body) + '</text>')
[void]$sb.Append('</binding></visual>')

if ($Token -ne "") {
  $allowArgs = "dshnotify://answer?t=" + [uri]::EscapeDataString($Token) + "&v=allow"
  $denyArgs  = "dshnotify://answer?t=" + [uri]::EscapeDataString($Token) + "&v=reject"
  [void]$sb.Append('<actions>')
  [void]$sb.Append('<action content="' + (& $esc $AllowLabel) + '" arguments="' + (& $esc $allowArgs) + '" activationType="protocol"/>')
  [void]$sb.Append('<action content="' + (& $esc $DenyLabel) + '" arguments="' + (& $esc $denyArgs) + '" activationType="protocol"/>')
  [void]$sb.Append('</actions>')
}

[void]$sb.Append('<audio src="ms-winsoundevent:Notification.Default"/>')
[void]$sb.Append('</toast>')

$xml.LoadXml($sb.ToString())

$toast = New-Object Windows.UI.Notifications.ToastNotification($xml)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid)
$notifier.Show($toast)

if ($Token -ne "") {
  Write-Output "toast shown with buttons"
} else {
  Write-Output "toast shown"
}
