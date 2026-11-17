# Toast-suppression probe (Windows PowerShell 5.1).
#
# Shared by notify.ps1 and notify-actions.ps1 -- it used to be pasted inline in
# both (2026-11-17 audit, Standards-1), which meant every probe fix had to be
# made three times (this file, the two senders) and one missed copy silently
# changed when toasts were suppressed. This is now the only implementation.
#
# Prints exactly one line:
#   "skipped foreground"  -> the given pid/name OWNS the foreground window; the
#                            caller must not show the toast and must exit 0.
#   "show toast"          -> probe ran and the window is not theirs; show it.
#
# ANY failure prints "show toast" and exits 0: an unknown state must never
# suppress -- a missed notification is recoverable (the browser card is still
# there); a wrongly-suppressed one is not.
#
# The marker strings are the JS-side contract: index.js matches /skipped
# foreground/ and /toast shown/ against stdout. Change them in lockstep with
# lib/index.js sendToast() or suppression breaks silently.
param(
  # $Pid is a read-only PowerShell automatic variable, so the pid arrives as
  # -HostPid. Using $Pid here fails at bind time with VariableNotWritable.
  [int]$HostPid = 0,
  [string[]]$Name = @()
)
$ErrorActionPreference = 'Stop'
try {
  if ($HostPid -le 0 -and $Name.Count -eq 0) {
    # Nothing to test: the caller passed no suppression criteria, so show.
    Write-Output 'show toast'
    exit 0
  }
  if (-not ("W.Fg" -as [type])) {
    Add-Type -Namespace W -Name Fg -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint pid);
'@
  }
  $h = [W.Fg]::GetForegroundWindow()
  $fgPid = 0
  if ($h -ne [System.IntPtr]::Zero) {
    [void][W.Fg]::GetWindowThreadProcessId($h, [ref]$fgPid)
  }
  $hit = $false
  if ($HostPid -gt 0 -and $fgPid -eq $HostPid) { $hit = $true }
  if (-not $hit -and $Name.Count -gt 0 -and $fgPid -gt 0) {
    $p = Get-Process -Id $fgPid -ErrorAction SilentlyContinue
    if ($p -and ($Name -contains $p.ProcessName)) { $hit = $true }
  }
  if ($hit) { Write-Output 'skipped foreground' } else { Write-Output 'show toast' }
} catch {
  # Unknown state must not suppress: report "show" so the toast still goes out.
  Write-Warning ("foreground probe failed, showing toast: " + $_.Exception.Message)
  Write-Output 'show toast'
}
