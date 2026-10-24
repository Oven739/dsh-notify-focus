# Foreground probe (Windows PowerShell 5.1).
# Prints exactly one token: 'fg' when the given pid (or image name) owns the
# foreground window, otherwise 'bg'.
#
# The plugin calls this synchronously before deciding whether to park an
# approval waterfall. Parking hides the prompt from the browser (see
# CONTEXT.md), so it must never happen while the user is looking at DSH.
param(
  # $Pid is a read-only PowerShell automatic variable, so the pid arrives as
  # -HostPid. Using $Pid here fails at bind time with VariableNotWritable.
  [int]$HostPid = 0,
  [string[]]$Name = @()
)
$ErrorActionPreference = 'Stop'
try {
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
  if ($hit) { Write-Output 'fg' } else { Write-Output 'bg' }
} catch {
  # Unknown state must not park: report background so the browser keeps the
  # prompt, which is the safe default.
  Write-Output 'bg'
}
