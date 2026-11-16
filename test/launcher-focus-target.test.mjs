// Regression guard for launcher.ps1 window targeting.
//
// THE BUG THIS FILE EXISTS FOR
//
// Invoke-Win32Focus builds its candidate pid set from chrome.exe, msedge.exe AND
// "DeepSeek Harness":
//
//     foreach ($p in (Get-Process chrome ...))  { [void]$candPids.Add($p.Id) }
//     foreach ($p in (Get-Process msedge ...))  { [void]$candPids.Add($p.Id) }
//     foreach ($p in (Get-Process ...)) { if ($p.ProcessName -eq "DeepSeek Harness") { ... } }
//
// It then tries to prefer a DSH window by title:
//
//     foreach ($mt in $MatchTitles) { if ($title.Contains($mt)) { $best = $w; break } }
//     if ($best -eq $null) { $best = $wins[0] }
//
// A DSH window's title is the PAGE TITLE ("根据这条用户消息… — Claude"), never the
// app name, so the cue never matches and the code falls back to $wins[0] -- the
// first visible Chrome-family window, normally Edge or Chrome.
//
// Measured consequence (2026-11-15, outside the sandbox):
//   click a toast with DSH hidden  ->  Edge came to the foreground,
//                                      DSH stayed vis=False
// The user sees "the window did not come back, nothing happened".
//
// These assertions are purely lexical: they read launcher.ps1 and fail if a
// browser process name is used to BUILD the candidate set, or if the selection
// falls back to "first window" instead of requiring a DSH-owned window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");
const LAUNCHER = join(LIB, "launcher.ps1");

const source = readFileSync(LAUNCHER, "utf8");
const lines = source.split(/\r?\n/);

/** True when the line is a PowerShell comment (not code). */
const isComment = (line) => /^\s*#/.test(line);

/** Candidate-set construction region: the `$candPids` block. */
const candPidsBlock = (() => {
  const start = lines.findIndex((l) => /^\s*\$candPids\s*=/.test(l));
  assert.notEqual(start, -1, "launcher.ps1 must still build a $candPids set");
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    out.push({ line: lines[i], no: i + 1 });
    // The set is finished once the enumeration call that consumes it appears.
    if (/FindByPid/.test(lines[i]) && i > start) break;
  }
  return out;
})();

test("candidate pids must NOT be seeded from browser processes", () => {
  // chrome.exe and msedge.exe share Chrome_WidgetWin_* with Electron, so adding
  // them makes a browser window a legitimate focus target for a DSH toast.
  const offenders = candPidsBlock.filter(
    ({ line }) => !isComment(line) && /Get-Process\s+["']?(chrome|msedge)\b/i.test(line),
  );
  assert.deepEqual(
    offenders.map((o) => o.no),
    [],
    "launcher.ps1 must not add chrome.exe/msedge.exe to $candPids: a toast click " +
      "then focuses whichever browser window comes first instead of DSH",
  );
});

test("candidate pids must be restricted to DSH processes", () => {
  const addsDsh = candPidsBlock.some(
    ({ line }) => !isComment(line) && /ProcessName\s+-eq\s+["']DeepSeek Harness["']/i.test(line),
  );
  assert.ok(addsDsh, "launcher.ps1 must add DeepSeek Harness pids to $candPids");
});

test("window selection must not fall back to the first window blindly", () => {
  // `$best = $wins[0]` is the line that picks Edge. A DSH-only candidate set
  // makes it harmless, but keeping it lets the same bug return the moment a
  // browser pid is added back -- so the fallback must be guarded by an explicit
  // DSH check, and the bare form is rejected.
  // Matches BOTH the bare form and the inline-if form, because the shipped code
  // writes it inline: `if ($best -eq $null) { $best = $wins[0] }`.
  const fallback = lines
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => !isComment(line) && /\$best\s*=\s*\$wins\s*\[\s*0\s*\]/.test(line));
  assert.deepEqual(
    fallback.map((f) => f.no),
    [],
    "launcher.ps1 must not do a bare `$best = $wins[0]`: DSH window titles never " +
      "contain 'DeepSeek Harness', so this is the line that focuses Edge",
  );
});

test("the jump offer must not be gated on focus success alone", () => {
  // `if ($handled -and $targetUrl ...)` means that when focusing picks the wrong
  // app (still "handled"), the session jump is still offered -- to a page the
  // user cannot see -- while when focusing fails, no jump is offered at all.
  // Offering the jump must depend on the session id, not on focus success.
  const gated = lines
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => !isComment(line) && /\$handled\s+-and\s+\$targetUrl\s+-match/.test(line));
  assert.deepEqual(
    gated.map((g) => g.no),
    [],
    "the jump offer must not be conditional on $handled: focusing the wrong app " +
      "sets $handled=true while DSH is still hidden",
  );
});
