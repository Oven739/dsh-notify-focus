# Foreground probe (Windows PowerShell 5.1).
#
# ONE implementation, TWO callers with different vocabularies. It prints a
# single line containing BOTH markers so neither side has to parse the other's
# language:
#
#     fg <-> skipped foreground   ... the host owns the foreground window
#     bg <-> show toast           ... it does not
#
# lib/index.js (focus gate) matches /(^|\s)fg(\s|$)/ and treats anything else as
# "background"; lib/notify.ps1 and lib/notify-actions.ps1 (toast senders) match
# "skipped foreground". Both substrings are present in the winning line on
# purpose -- see the 2026-11-17 regression below.
#
# REGRESSION THIS FILE FIXES (2026-11-18)
# When the probe was consolidated from three copies into this one file, it was
# rewritten to print only "skipped foreground" / "show toast". The toast senders
# were updated in the same commit; index.js's focus gate was not consulted, and
# it still expected "fg"/"bg". The regex therefore never matched, every sample
# read "bg", and the gate concluded the user was never at the computer. Result:
# every approval was parked even with the window in front of the user, and the
# browser card never appeared. The marker contract test covered toast markers
# only, so nothing went red.
#
# The rule that prevents a repeat: this file's output is a PUBLIC contract with
# two independent consumers. Change it only together with
# test/toast-marker-contract.test.mjs, which now asserts both vocabularies.
#
# ANY failure prints the background line and exits 0: an unknown state must
# never suppress a toast and must never park (both degraded paths are safe, the
# opposite of each is not).
param(
  # $Pid is a read-only PowerShell automatic variable, so the pid arrives as
  # -HostPid. Using $Pid here fails at bind time with VariableNotWritable.
  [int]$HostPid = 0,
  [string[]]$Name = @()
)
$ErrorActionPreference = 'Stop'

# Both protocols, always, on one line. Keep the order stable: "fg" first so the
# focus gate's leading-boundary regex sees it, the toast marker after it.
$LINE_FOREGROUND = 'fg skipped foreground'
$LINE_BACKGROUND = 'bg show toast'

try {
  if ($HostPid -le 0 -and $Name.Count -eq 0) {
    # Nothing to test: the caller passed no criteria, so report background
    # (show the toast, hand the prompt to the browser).
    Write-Output $LINE_BACKGROUND
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
  if ($hit) { Write-Output $LINE_FOREGROUND } else { Write-Output $LINE_BACKGROUND }
} catch {
  # Unknown state must not suppress and must not park: background is the safe
  # answer for both consumers (toast shown; prompt handed to the browser).
  Write-Warning ("foreground probe failed, reporting background: " + $_.Exception.Message)
  Write-Output $LINE_BACKGROUND
}
