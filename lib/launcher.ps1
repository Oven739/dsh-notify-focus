# dsh-notify launcher (Windows PowerShell 5.1).
# Registered as the "dshnotify" protocol handler. Invoked by the OS as:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "launcher.ps1" "%1"
#
# Two URL shapes:
#   dshnotify://answer?t=<token>&v=allow|reject   -> POST the decision to the
#                                                    host's loopback channel
#   dshnotify://open?u=<encoded-gui-url>          -> open/focus the DSH window
# An answer that fails to post falls back to opening the GUI, so a click never
# does nothing: the user still lands on the pending approval.
param(
  [Parameter(Mandatory = $true)][string]$ProtocolArgs
)

# ---------------------------------------------------------------------------
# Decision channel
# ---------------------------------------------------------------------------
function Read-DecisionEndpoint {
  # The plugin writes 127.0.0.1:<port> plus a request secret while it runs.
  # Returns $null when the host is gone (nothing to post a decision to).
  #
  # ONLY the host's private temp is a real candidate.
  #
  # The plugin writes to `tmpdir()` of the HOST process (decision-channel.mjs:29),
  # and the host runs with TEMP redirected to %LOCALAPPDATA%\DSH\temp. This script
  # runs under the protocol handler, whose $env:TEMP is the plain user temp. Those
  # two roots can never be equal, so "$env:TEMP\dsh-notify" is not a second
  # location the plugin might use — it is an orphan path the plugin never writes.
  #
  # It used to be probed first. A leftover file there (from any older build, any
  # previous TEMP layout) then hijacked every click: the file parses, it is
  # returned, and the click targets a port nothing listens on any more. On
  # 2026-11-06 that produced 12 consecutive "jump offer skipped" failures while
  # the real endpoint sat in the host temp, correct and live.
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "DSH\temp\dsh-notify\endpoint.json")
  )

  # A file that parses is not the same as a file that is CURRENT.
  #
  # These files outlive the process that wrote them: the plugin removes its own
  # endpoint on shutdown, but a kill or a crash leaves the file behind, still
  # holding a port that nothing listens on any more. Returning the first file
  # that merely parses then routes every click to a dead port, which reads on
  # screen as "the window comes forward but the conversation never changes".
  #
  # So candidates are ranked by freshness and each one is probed before use.
  $best = $null
  $bestRank = $null
  foreach ($file in $candidates) {
    try {
      if (-not (Test-Path $file)) { continue }
      $obj = (Get-Content -Path $file -Raw -ErrorAction Stop) | ConvertFrom-Json
      if (-not $obj.port -or -not $obj.secret) { continue }

      $fresh = (Get-Item $file).LastWriteTime
      # Reachability is the decisive test: a live listener on the recorded port
      # proves this endpoint belongs to a running plugin.
      $alive = $false
      try {
        $probe = New-Object System.Net.Sockets.TcpClient
        $alive = $probe.ConnectAsync('127.0.0.1', [int]$obj.port).Wait(300)
        $probe.Close()
      } catch {
        $alive = $false
      }
      Write-Trace ("[endpoint] candidate " + $file + " port=" + $obj.port + " alive=" + $alive + " mtime=" + $fresh.ToString('MM-dd HH:mm:ss'))

      # Only a live listener is usable. A file whose port is closed describes a
      # plugin that has already exited: posting to it can only fail, and failing
      # late looks like "the click did nothing". Returning nothing at least lets
      # the caller fall back to opening the GUI immediately.
      if (-not $alive) { continue }
      $rank = @{ alive = 1; fresh = $fresh }
      if ($best -eq $null -or $rank.fresh -gt $bestRank.fresh) {
        $best = $obj; $bestRank = $rank; $bestFile = $file
      }
    } catch {
      Write-Trace ("[warn] Read-DecisionEndpoint " + $file + ": " + $_.Exception.Message)
    }
  }

  if ($best -ne $null) {
    Write-Trace ("[endpoint] using " + $bestFile + " port=" + $best.port + " alive=" + $bestRank.alive)
    return $best
  }
  Write-Trace ("[fail] no usable endpoint file in: " + ($candidates -join " | "))
  return $null
}

function Send-Decision {
  # POSTs one verdict to the host. Returns $true only when the host confirmed
  # it applied the decision to a live (non-expired) pending request.
  param([string]$Token, [string]$Verdict)
  $endpoint = Read-DecisionEndpoint
  if ($endpoint -eq $null) {
    Write-Trace "[decision] no endpoint file (host not running with button support)"
    return $false
  }
  $url = "http://127.0.0.1:" + $endpoint.port + "/decide"
  $body = @{ token = $Token; verdict = $Verdict } | ConvertTo-Json -Compress
  try {
    $resp = Invoke-RestMethod -Uri $url -Method Post -Body $body -TimeoutSec 5 `
      -ContentType "application/json" `
      -Headers @{ "x-dsh-notify-secret" = $endpoint.secret }
    Write-Trace ("[decision] ok=" + $resp.ok + " reason=" + $resp.reason)
    return [bool]$resp.ok
  } catch {
    Write-Trace ("[fail] Send-Decision: " + $_.Exception.Message)
    return $false
  }
}

function Write-Trace {
  param([string]$Message)
  try {
    $dir = Join-Path $env:TEMP "dsh-notify"
    if (-not (Test-Path $dir)) { New-Item -Path $dir -ItemType Directory -Force | Out-Null }
    $line = (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff") + " " + $Message
    Add-Content -Path (Join-Path $dir "launcher.log") -Value $line -Encoding UTF8
  } catch {
    # diagnostics must never break the flow
  }
}

function Invoke-CdpNavigate {
  # Tries CDP on the standard debug ports plus any port discovered from a
  # running chrome.exe command line. Returns $true if it navigated a page.
  param([string]$TargetUrl, [string]$HostPort)
  $ports = @(9222, 9223, 9229)
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $procs) {
      if ($p.CommandLine -match "--remote-debugging-port=(\d+)") {
        $ports += [int]$Matches[1]
      }
    }
  } catch {}
  $ports = $ports | Sort-Object -Unique

  foreach ($port in $ports) {
    try {
      $ver = $null
      try {
        $ver = Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 1 -UseBasicParsing
      } catch {}
      if ($ver -eq $null) { continue }
      $list = Invoke-WebRequest -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 1 -UseBasicParsing
      $targets = $list.Content | ConvertFrom-Json
      $hit = $null
      foreach ($t in $targets) {
        if ($t.type -eq "page" -and $t.url -match [regex]::Escape($HostPort)) {
          $hit = $t
          break
        }
      }
      if ($hit -eq $null) { continue }
      $wsUrl = "ws://127.0.0.1:$port/devtools/page/$($hit.id)"
      $json = '{"id":1,"method":"Page.navigate","params":{"url":"' + $TargetUrl.Replace('\', '\\').Replace('"', '\"') + '"}}'
      Write-Trace ("[cdp] navigate target id=" + $hit.id + " port=" + $port)
      if (Send-WebSocketJson -WsUrl $wsUrl -Json $json) {
        return $true
      }
    } catch {
      Write-Trace ("[fail step] Invoke-CdpNavigate port=$port : " + $_.Exception.Message)
    }
  }
  return $false
}

# Win32 P/Invoke type compiled once for Step B.
$win32Source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class Win32WindowFinder {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);

  public static List<IntPtr> Find(string className, HashSet<int> pids, string titleCue, string[] matchTitles) {
    var result = new List<IntPtr>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      try {
        if (!IsWindowVisible(hWnd)) return true;
        var cls = new StringBuilder(256);
        GetClassName(hWnd, cls, cls.Capacity);
        if (cls.ToString() != className) return true;
        int pid;
        GetWindowThreadProcessId(hWnd, out pid);
        if (!pids.Contains(pid)) return true;
        var title = new StringBuilder(512);
        GetWindowText(hWnd, title, title.Capacity);
        var t = title.ToString();
        bool titleOk = false;
        foreach (var mt in matchTitles) { if (t.Contains(mt)) { titleOk = true; break; } }
        if (titleOk || t.Contains(titleCue)) result.Add(hWnd);
      } catch {}
      return true;
    }, IntPtr.Zero);
    return result;
  }

  // Match on the window TITLE only. The DSH desktop app runs as
  // "DeepSeek Harness", which a chrome-only pid set would never include, but its
  // window title carries the app name and the host:port cue.
  public static List<IntPtr> FindByTitle(string className, HashSet<int> pids, string titleCue, string[] matchTitles) {
    var result = new List<IntPtr>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      try {
        if (!IsWindowVisible(hWnd)) return true;
        var cls = new StringBuilder(256);
        GetClassName(hWnd, cls, cls.Capacity);
        if (cls.ToString() != className) return true;
        var title = new StringBuilder(512);
        GetWindowText(hWnd, title, title.Capacity);
        var t = title.ToString();
        if (t.Length == 0) return true;
        bool titleOk = false;
        foreach (var mt in matchTitles) { if (t.Contains(mt)) { titleOk = true; break; } }
        if (titleOk || t.Contains(titleCue)) result.Add(hWnd);
      } catch {}
      return true;
    }, IntPtr.Zero);
    return result;
  }

  // Focus candidates by owning process id. This is what actually identifies a
  // DSH window: title text is the page title, so it carries no port cue.
  public static List<IntPtr> FindByPid(string classNamePrefix, HashSet<int> pids) {
    var visible = new List<IntPtr>();
    var hidden = new List<IntPtr>();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      try {
        // Hidden windows are collected too, and ranked after visible ones.
        // The app's "minimized" state is a hidden window (measured:
        // vis=False iconic=False), so filtering invisible windows here meant
        // the very window we needed to restore was never a candidate.
        bool isVisible = IsWindowVisible(hWnd);
        var cls = new StringBuilder(256);
        GetClassName(hWnd, cls, cls.Capacity);
        // Prefix match, not equality: Electron tags its windows
        // Chrome_WidgetWin_0 / _1 depending on role and state, and pinning _1
        // made the finder miss a perfectly good main window.
        if (!cls.ToString().StartsWith(classNamePrefix, System.StringComparison.Ordinal)) return true;
        int pid;
        GetWindowThreadProcessId(hWnd, out pid);
        if (!pids.Contains(pid)) return true;
        var title = new StringBuilder(512);
        GetWindowText(hWnd, title, title.Capacity);
        if (title.Length == 0) return true;
        if (isVisible) visible.Add(hWnd); else hidden.Add(hWnd);
      } catch {}
      return true;
    }, IntPtr.Zero);
    // Visible first: never hide a window that was already on screen.
    visible.AddRange(hidden);
    return visible;
  }

  public static string GetTitle(IntPtr hWnd) {
    var sb = new StringBuilder(512);
    GetWindowText(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }
}
'@

function Invoke-Win32Focus {
  # Enumerates top-level Chrome windows and focuses the best DSH candidate.
  # Returns $true if a window was focused (navigation is not possible without
  # CDP, so this is focus-only by design).
  param([string]$HostPort, [string[]]$MatchTitles)
  try {
    if (-not ("Win32WindowFinder" -as [type])) {
      Add-Type -TypeDefinition $win32Source -Language CSharp
    }
    # Electron apps share Chrome's window class, so the DSH desktop host is a
    # legitimate target. Enumerating chrome.exe alone meant every click opened a
    # brand-new browser tab instead of focusing the already-open app.
    #
    # Processes are matched by IMAGE NAME through the finder itself rather than
    # by a Get-Process lookup: querying another user's process by name can stall
    # under a restricted token, which made this whole script hang.
    # Candidate processes: browsers, plus every DSH host process. The desktop
    # app is Electron, so its windows use Chrome's window class but its process
    # is "DeepSeek Harness" — a chrome-only list never matched it.
    $candPids = New-Object System.Collections.Generic.HashSet[int]
    foreach ($p in (Get-Process chrome -ErrorAction SilentlyContinue)) { [void]$candPids.Add($p.Id) }
    foreach ($p in (Get-Process msedge -ErrorAction SilentlyContinue)) { [void]$candPids.Add($p.Id) }
    # Get-Process -Name with a spaced name can stall under a restricted token;
    # enumerating all processes and filtering is reliable and fast enough here.
    try {
      foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
        if ($p.ProcessName -eq "DeepSeek Harness") { [void]$candPids.Add($p.Id) }
      }
    } catch {
      Write-Trace ("[warn] could not enumerate DSH processes: " + $_.Exception.Message)
    }

    # Match on process id, NOT on title. A DSH window's title is the page title
    # ("Greeting — Claude"), never "127.0.0.1:<port>", so a title cue misses the
    # very window the user wants focused.
    $wins = [Win32WindowFinder]::FindByPid("Chrome_WidgetWin_", $candPids)
    if ($wins -eq $null -or $wins.Count -eq 0) {
      Write-Trace ("[win32] no candidate window (pids=" + $candPids.Count + ")")
      return $false
    }
    # Prefer a window whose title mentions the app, else the first one.
    $best = $null
    foreach ($w in $wins) {
      $title = [Win32WindowFinder]::GetTitle($w)
      foreach ($mt in $MatchTitles) {
        if ($title.Contains($mt)) { $best = $w; break }
      }
      if ($best -ne $null) { break }
    }
    if ($best -eq $null) { $best = $wins[0] }

    # Restore/show ONLY when the window is actually hidden or minimised.
    #
    # Calling ShowWindow unconditionally re-applies the requested placement, which
    # rewrites the window's current shape: a maximised window snapped back to its
    # restored size, and a window the user had sized deliberately lost that size.
    # The observed symptom was "jumping changes the window's form instead of just
    # covering it".
    #
    # The app's "minimized" state is a HIDDEN window, not an iconic one (measured
    # vis=False iconic=False), so both states are handled, and each call is gated
    # on the state it fixes.
    $wasVisible = [Win32WindowFinder]::IsWindowVisible($best)
    $wasIconic = [Win32WindowFinder]::IsIconic($best)
    if ($wasIconic) {
      [void][Win32WindowFinder]::ShowWindow($best, 9)  # SW_RESTORE
    }
    if (-not $wasVisible) {
      [void][Win32WindowFinder]::ShowWindow($best, 5)  # SW_SHOW
    }
    $ok = [Win32WindowFinder]::SetForegroundWindow($best)
    if (-not $ok) {
      # Foreground rights can be refused; the window is at least visible now.
      Write-Trace ("[win32] SetForegroundWindow refused, window shown but not raised")
    }
    $visible = [Win32WindowFinder]::IsWindowVisible($best)
    $iconic = [Win32WindowFinder]::IsIconic($best)
    Write-Trace ("[win32] focused hwnd=" + $best.ToString() + " ok=" + $ok + " visible=" + $visible + " iconic=" + $iconic)
    return ($ok -or $visible)
  } catch {
    Write-Trace ("[fail step] Invoke-Win32Focus: " + $_.Exception.Message)
    return $false
  }
}
# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
function Main {
  Write-Trace ("[start] args='" + $ProtocolArgs + "'")

  # Space-separated args arrive as one token, but rejoin defensively.
  $raw = $ProtocolArgs
  if ($args -and $args.Count -gt 0) {
    $raw = (@($ProtocolArgs) + $args) -join " "
  }

  $stripped = $raw
  if ($stripped -match "^dshnotify://") {
    $stripped = $stripped.Substring("dshnotify://".Length)
  } elseif ($stripped -match "^dshnotify:") {
    $stripped = $stripped.Substring("dshnotify:".Length)
  }

  # --- answer activation: post the decision, then no window work on success ---
  # Windows normalises a protocol URL: "dshnotify://answer?t=x" arrives as
  # "dshnotify://answer/?t=x", so the optional slash is part of the shape and
  # not a mistake in the notification. Matching only "^answer\?" silently sent
  # every button click down the "open the GUI" fallback instead of answering.
  if ($stripped -match "^answer/?\?") {
    # Start AFTER the "?" — keeping it would make the first key "?t" instead of
    # "t", so the token would never be found and every click would fall through
    # to "bad answer activation".
    $query = $stripped.Substring($stripped.IndexOf("?") + 1)
    $token = ""
    $verdict = ""
    foreach ($pair in ($query -split "&")) {
      $kv = $pair -split "=", 2
      if ($kv.Count -ne 2) { continue }
      $key = $kv[0].Trim()
      $decoded = $kv[1]
      try { $decoded = [uri]::UnescapeDataString($kv[1]) } catch {}
      if ($key -eq "t") { $token = $decoded }
      elseif ($key -eq "v") { $verdict = $decoded }
    }
    if ($token -ne "" -and ($verdict -eq "allow" -or $verdict -eq "reject")) {
      if (Send-Decision -Token $token -Verdict $verdict) {
        Write-Trace "[ok] decision applied, no window action needed"
        return $true
      }
      # A stale token (already answered or cancelled) is a normal race. Fall
      # through so the click still lands the user on the conversation.
      Write-Trace "[step] decision not applied; falling back to GUI"
    } else {
      Write-Trace ("[fail] bad answer activation: " + $stripped)
      return $false
    }
  }

  # --- open activation ---
  $targetUrl = ""
  if ($stripped -match "\?u=") {
    $encoded = $stripped -split "\?u=" | Select-Object -Last 1
    try { $targetUrl = [uri]::UnescapeDataString($encoded) } catch { $targetUrl = $encoded }
  }
  if ([string]::IsNullOrWhiteSpace($targetUrl)) {
    Write-Trace ("[fail] no targetUrl parsed from '" + $raw + "'")
    return $false
  }

  # Origin info from the decoded URL (best-effort).
  $HostPort = ""
  try {
    $parsed = [Uri]$targetUrl
    $HostPort = "$($parsed.Host):$($parsed.Port)"
  } catch {
    Write-Trace ("[warn] could not parse targetUrl as Uri: " + $targetUrl)
  }
  $MatchTitles = @("DeepSeek Harness")

  $handled = $false

  # Step A: focus first, navigate second.
  #
  # Order matters for latency: the user clicks a toast to get back to DSH, and
  # focusing an existing window achieves that immediately. CDP navigation is an
  # upgrade (jump to the exact session) that costs ~5 s of connection timeouts
  # when no debugger is listening — which is always the case for the packaged
  # desktop app. Running it first made every click flash a console for ~8 s
  # before the window even came forward.
  $focusedAlready = $false
  try {
    if (Invoke-Win32Focus -HostPort $HostPort -MatchTitles $MatchTitles) {
      Write-Trace ("[ok] Step B focused existing DSH window (focus-only)")
      $handled = $true
      $focusedAlready = $true
    } else {
      Write-Trace ("[step] Step B no candidate")
    }
  } catch {
    Write-Trace ("[fail step] Step B: " + $_.Exception.Message)
  }

  # Tell the page which conversation to reveal.
  #
  # Focusing the window is only half the job: DSH's frontend ignores the
  # ?session= query parameter, so the conversation stays wherever it was. The
  # plugin's browser half polls and calls uiWorkspace.openSession().
  #
  # This goes through the plugin's authenticated loopback port, not the page's
  # same-origin fetch routes: those require the browser's auth cookie, and an
  # external process POSTing to them gets 401.
  if ($handled -and $targetUrl -match "[?&]session=([^&]+)") {
    $sessionId = [uri]::UnescapeDataString($Matches[1])
    $endpoint = Read-DecisionEndpoint
    if ($sessionId -ne "" -and $endpoint -ne $null) {
      try {
        $url = "http://127.0.0.1:" + $endpoint.port + "/jump"
        $payload = ConvertTo-Json -Compress @{ sessionId = $sessionId }
        $resp = Invoke-RestMethod -Uri $url -Method Post -Body $payload `
          -ContentType "application/json" -TimeoutSec 3 `
          -Headers @{ "x-dsh-notify-secret" = $endpoint.secret } -ErrorAction Stop
        Write-Trace ("[jump] offered " + $sessionId + " -> " + $resp.ok)
      } catch {
        # Host gone or plugin without the browser half: the window is already
        # focused, which is the pre-jump behaviour.
        Write-Trace ("[step] jump offer skipped: " + $_.Exception.Message)
      }
    } elseif ($endpoint -eq $null) {
      Write-Trace "[step] jump skipped: no endpoint file"
    }
  }

  # Step A: CDP navigate — opt-in only.
  #
  # Probing three debug ports costs ~1 s each (~3.1 s total) and can never
  # succeed for the packaged desktop app, which exposes no debugger. It stays
  # available for browser-attached setups via DSH_NOTIFY_CDP=1, but the default
  # is off so a toast click focuses the window immediately.
  if ($HostPort -ne "" -and $env:DSH_NOTIFY_CDP -eq "1") {
    try {
      if (Invoke-CdpNavigate -TargetUrl $targetUrl -HostPort $HostPort) {
        Write-Trace ("[ok] Step A CDP navigate succeeded for " + $HostPort)
        $handled = $true
      } else {
        Write-Trace ("[step] Step A skipped/failed")
      }
    } catch {
      Write-Trace ("[fail step] Step A: " + $_.Exception.Message)
    }
  }

  # Step C: fallback open in default browser. Always runs if A and B failed.
  if (-not $handled) {
    try {
      Write-Trace ("[fallback] Start-Process " + $targetUrl)
      Start-Process $targetUrl
      $handled = $true
    } catch {
      Write-Trace ("[fail step] Step C: " + $_.Exception.Message)
    }
  }

  return $handled
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
$success = $false
try {
  $success = Main
} catch {
  Write-Trace ("[fatal] " + $_.Exception.Message)
  # Last resort: try to open a URL found in the raw protocol argument.
  try {
    if ($ProtocolArgs -match "u=([^&\s]+)") {
      $u = [uri]::UnescapeDataString($Matches[1])
      Start-Process $u
      $success = $true
    }
  } catch {}
}

if ($success) {
  exit 0
} else {
  exit 1
}