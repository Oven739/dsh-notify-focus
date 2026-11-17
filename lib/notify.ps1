# dsh-notify toast sender (Windows PowerShell 5.1 required: WinRT projection).
# Parameters are bound by PowerShell from the process argument vector, so this
# file stays ASCII-only and needs no BOM.
#
# The param block IS the command-line interface index.js invokes; the shared
# subset (Title/Body/Aumid/AppName/Url/LaunchProtocol/ForegroundPid/
# ForegroundName) must stay in the same order and with the same defaults as
# notify-actions.ps1's block -- they are one logical interface split across two
# entry points because PS 5.1 has no cross-file parameter objects. A shared
# object here would break the argument vector both callers pass positionally.
param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Body,
  [string]$Aumid = "DeepSeekHarness.Notify",
  [string]$AppName = "DeepSeek Harness",
  [string]$Url = "",
  [int]$LaunchProtocol = 1,  # 1 = route via dshnotify:// launcher (prefer existing); 0 = open targetUrl directly
  [int]$ForegroundPid = 0,   # when > 0: skip the toast if this pid owns the foreground window
  [string[]]$ForegroundName = @()  # when non-empty: skip if the foreground process name matches
)
$ErrorActionPreference = "Stop"

# Foreground suppression, via the SHARED probe (lib/foreground-probe.ps1).
#
# When the DSH host already owns the foreground window the user is looking
# straight at the approval/question panel, so a toast would cover it. The probe
# prints "skipped foreground" when the pid/name owns the foreground window and
# "show toast" otherwise; any failure prints "show toast", because an unknown
# state must never suppress.
#
# This block used to be pasted inline here AND in notify-actions.ps1 (audit
# 2026-11-17, Standards-1): three copies of one probe, every fix applied three
# times. It is one implementation now.
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

# Register the AppUserModelId once under HKCU so Win32 toasts are allowed.
# Best effort: if the write is denied we still try to show the toast below.
$key = "HKCU:\SOFTWARE\Classes\AppUserModelId\$Aumid"
try {
  if (-not (Test-Path $key)) {
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name DisplayName -Value $AppName -PropertyType String -Force | Out-Null
  }
} catch {
  Write-Warning ("AUMID registration failed: " + $_.Exception.Message)
}

# Project the WinRT toast API (supported natively by .NET Framework).
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null

# Optional clickable activation: when $Url is set we make the toast open a URL
# on click. Best effort - any failure here degrades gracefully (either to a
# direct protocol activation or to a plain non-clickable toast) and never
# aborts the Show below.
$clickable = $false
$launchValue = ""
if ($Url -ne "") {
  try {
    if ($LaunchProtocol -eq 1) {
      # Register the dshnotify:// protocol handler via the shared script.
      #
      # The implementation used to live here, which is why approval toasts -
      # sent by notify-actions.ps1, which had no copy of it - never wrote the
      # key. Both senders now call lib/register-protocol.ps1.
      try {
        $registerScript = Join-Path $PSScriptRoot "register-protocol.ps1"
        if (Test-Path $registerScript) {
          & $registerScript | Out-Null
        } else {
          Write-Warning "register-protocol.ps1 missing; protocol handler not refreshed"
        }
      } catch {
        Write-Warning ("dshnotify protocol registration failed, falling back to direct URL: " + $_.Exception.Message)
        # Fall back to direct-URL activation for this toast.
        $LaunchProtocol = 0
      }
    }

    if ($LaunchProtocol -eq 1) {
      $launchValue = ("dshnotify://open?u=" + [uri]::EscapeDataString($Url))
    } else {
      $launchValue = $Url
    }
    $clickable = $true
  } catch {
    Write-Warning ("Toast activation setup failed, showing plain toast: " + $_.Exception.Message)
    $clickable = $false
  }
}

$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $xml.GetElementsByTagName("text")
$texts.Item(0).AppendChild($xml.CreateTextNode($Title)) | Out-Null
$texts.Item(1).AppendChild($xml.CreateTextNode($Body)) | Out-Null

if ($clickable) {
  try {
    $root = $xml.DocumentElement
    # XmlElement.Name is EMPTY under the PowerShell 5.1 WinRT projection (the
    # tag name lives on TagName), so guarding on -eq "toast" silently skipped
    # every attribute and the toast shipped with no launch target - a click then
    # did nothing at all. Compare TagName instead, and fall back to setting the
    # attributes unconditionally: worst case the document is not a toast and
    # SetAttribute throws into the catch below.
    $tag = $null
    try { $tag = $root.TagName } catch {}
    if ([string]::IsNullOrEmpty($tag)) { $tag = $root.Name }
    if ([string]::IsNullOrEmpty($tag) -or $tag -eq "toast") {
      $root.SetAttribute("activationType", "protocol") | Out-Null
      $root.SetAttribute("duration", "long") | Out-Null
      $root.SetAttribute("launch", $launchValue) | Out-Null
      # Optional explicit audio cue.
      $audio = $xml.CreateElement("audio")
      $audio.SetAttribute("src", "ms-winsoundevent:Notification.Default") | Out-Null
      $root.AppendChild($audio) | Out-Null
    }
  } catch {
    Write-Warning ("Failed to attach activation attributes: " + $_.Exception.Message)
  }
}

$toast = New-Object Windows.UI.Notifications.ToastNotification($xml)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($Aumid)
$notifier.Show($toast)
Write-Output "toast shown"
