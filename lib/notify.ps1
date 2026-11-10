# dsh-notify toast sender (Windows PowerShell 5.1 required: WinRT projection).
# Parameters are bound by PowerShell from the process argument vector, so this
# file stays ASCII-only and needs no BOM.
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

# Foreground suppression. When the DSH host already owns the foreground window
# the user is looking straight at the approval/question panel, so a toast would
# cover it. Print a distinct marker (not "toast shown") so the caller can log a
# clean skip. Best effort: any probe failure falls through and shows the toast.
if ($ForegroundPid -gt 0 -or $ForegroundName.Count -gt 0) {
  try {
    if (-not ("W.U" -as [type])) {
      Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
'@
    }
    $fgHandle = [W.U]::GetForegroundWindow()
    $fgPid = 0
    if ($fgHandle -ne [System.IntPtr]::Zero) {
      [void][W.U]::GetWindowThreadProcessId($fgHandle, [ref]$fgPid)
    }
    $skip = $false
    if ($ForegroundPid -gt 0 -and $fgPid -eq $ForegroundPid) { $skip = $true }
    if (-not $skip -and $ForegroundName.Count -gt 0 -and $fgPid -gt 0) {
      $fgProc = Get-Process -Id $fgPid -ErrorAction SilentlyContinue
      if ($fgProc -and ($ForegroundName -contains $fgProc.ProcessName)) { $skip = $true }
    }
    if ($skip) {
      Write-Output "skipped foreground"
      exit 0
    }
  } catch {
    Write-Warning ("foreground probe failed, showing toast: " + $_.Exception.Message)
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
      # Register the dshnotify:// protocol handler idempotently (best effort).
      try {
        $progId = "HKCU:\Software\Classes\dshnotify"
        if (-not (Test-Path $progId)) {
          New-Item -Path $progId -Force | Out-Null
        }
        # Default (unnamed) value names the protocol.
        Set-Item -Path $progId -Value 'dshnotify' -Force
        # "URL Protocol" marker value (presence marks the key as a protocol handler).
        Set-ItemProperty -Path $progId -Name 'URL Protocol' -Value '' -Force
        $cmdKey = "HKCU:\Software\Classes\dshnotify\shell\open\command"
        if (-not (Test-Path $cmdKey)) {
          New-Item -Path $cmdKey -Force | Out-Null
        }
        # Register through wscript.exe, not powershell.exe directly.
        #
        # powershell.exe is a WINDOWS_CUI image: the OS creates its console
        # before the script runs, so -WindowStyle Hidden can only shrink the
        # flash to ~250ms, never remove it. wscript.exe is WINDOWS_GUI and owns
        # no console; forward.vbs passes SW_HIDE into CreateProcess so the child
        # console is hidden from the moment it exists.
        #
        # This block used to rewrite the value unconditionally on every toast,
        # which silently reverted any manual change back to the flashing form.
        $vbsPath = Join-Path $PSScriptRoot "forward.vbs"
        if (Test-Path $vbsPath) {
          $command = ('"wscript.exe" //B //Nologo "' + $vbsPath + '" "%1"')
        } else {
          # No forwarder shipped: fall back to the original command.
          $launcherPath = Join-Path $PSScriptRoot "launcher.ps1"
          $command = ('"powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcherPath + '" "%1"')
        }
        Set-Item -Path $cmdKey -Value $command -Force
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
