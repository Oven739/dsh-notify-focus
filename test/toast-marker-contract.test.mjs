// Contract test for the stdout markers between index.js and the PowerShell
// senders.
//
// WHY THIS EXISTS (audit 2026-11-17, Standards-6)
// index.js decides "was the toast shown?" / "was it suppressed?" by matching
// regexes against the senders' stdout. The literal strings live on both sides
// of a process boundary with no shared constant -- renaming the marker in one
// sender would make every toast look failed or every suppression look shown,
// silently. This test pins both sides so a one-sided rename goes red here
// instead of in production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");
const read = (name) => readFileSync(join(LIB, name), "utf8");

const INDEX = read("index.js");
const NOTIFY = read("notify.ps1");
const ACTIONS = read("notify-actions.ps1");
const PROBE = read("foreground-probe.ps1");

const SUPPRESS = "skipped foreground";
const SHOWN = "toast shown";

test("index.js matches the suppression marker the senders print", () => {
  assert.ok(
    INDEX.includes(`/${SUPPRESS}/`),
    "index.js must match /skipped foreground/ against sender stdout",
  );
  for (const [name, src] of [["notify.ps1", NOTIFY], ["notify-actions.ps1", ACTIONS]]) {
    assert.ok(
      src.includes(`"${SUPPRESS}"`),
      `${name} must print the suppression marker exactly as index.js matches it`,
    );
  }
});

test("index.js matches the success marker the senders print", () => {
  assert.ok(
    INDEX.includes(`/${SHOWN}/`),
    "index.js must match /toast shown/ against sender stdout",
  );
  assert.ok(
    NOTIFY.includes(`"${SHOWN}"`),
    "notify.ps1 must print the success marker exactly as index.js matches it",
  );
  // notify-actions.ps1 prints the suffixed variant for buttoned toasts; the
  // /toast shown/ regex must keep matching it (it is a prefix, not a full-line
  // match), and the bare marker must stay as the buttonless variant.
  assert.ok(
    ACTIONS.includes(`"${SHOWN} with buttons"`),
    "notify-actions.ps1 must print the buttoned success marker",
  );
});

test("the shared probe prints the suppression marker, not a new one", () => {
  // foreground-probe.ps1 is the single implementation both senders now call;
  // its verdict line is what flows through the senders' own stdout.
  assert.ok(
    PROBE.includes(`"${SUPPRESS}"`),
    "foreground-probe.ps1 must emit the same suppression marker",
  );
});

// --- the SECOND consumer of the probe -------------------------------------
//
// REGRESSION THIS GUARDS (2026-11-18)
// When the probe was consolidated it was rewritten to speak only the toast
// senders' vocabulary ("skipped foreground" / "show toast"). index.js's focus
// gate was the other consumer and still parsed "fg"/"bg", so every sample read
// "bg": the gate believed the user was never at the computer, parked every
// approval, and the browser card never appeared -- even with the window in
// front of the user. The tests below pin BOTH vocabularies on one line, which
// is what makes a one-sided rewrite go red here instead of in production.
const FG = "fg";
const BG = "bg";

test("the probe emits the fg marker the focus gate parses", () => {
  assert.ok(
    INDEX.includes("fg"),
    "index.js focus gate must parse the 'fg' marker",
  );
  assert.ok(
    new RegExp(`"${FG}\\b`).test(PROBE) || PROBE.includes(`'${FG}`) || PROBE.includes(`"${FG}`),
    "foreground-probe.ps1 must emit the 'fg' marker for the focus gate",
  );
});

test("REGRESSION: one probe line satisfies BOTH consumers", () => {
  // The winning lines must contain the focus-gate token AND the toast token,
  // so neither consumer can be broken by serving only the other one.
  const lines = (PROBE.match(/\$LINE_[A-Z]+ = '([^']+)'/g) ?? []).map((m) =>
    m.replace(/^\$LINE_[A-Z]+ = '/, "").replace(/'$/, ""),
  );
  assert.equal(lines.length, 2, "probe must define both verdict lines");

  const foreground = lines.find((l) => l.startsWith(FG));
  const background = lines.find((l) => l.startsWith(BG));
  assert.ok(foreground, `a line must start with "${FG}"`);
  assert.ok(background, `a line must start with "${BG}"`);

  // focus gate: /(^|\s)fg(\s|$)/ -- "fg" must be a whole word
  assert.match(foreground, /(^|\s)fg(\s|$)/, "foreground line must satisfy the focus-gate regex");
  // toast senders: /skipped foreground/
  assert.match(foreground, /skipped foreground/, "foreground line must carry the toast marker");
  // and the background line must NOT look focused to either side
  assert.doesNotMatch(background, /(^|\s)fg(\s|$)/, "background line must not match fg");
  assert.doesNotMatch(background, /skipped foreground/, "background line must not suppress toasts");
});

test("index.js documents the contract next to the regexes", () => {
  assert.ok(
    INDEX.includes("STDOUT MARKER CONTRACT"),
    "the marker contract comment must stay adjacent to the matching code",
  );
});

test("REGRESSION: the verdict literals stay identical across the wire", () => {
  // decision-registry.mjs owns VERDICTS; decision-channel validates against it;
  // launcher.ps1 (a separate process) validates against the same literals. The
  // launcher cannot import the constant, so this test is the shared anchor
  // (audit 2026-11-17, Standards-5).
  const REGISTRY = read("decision-registry.mjs");
  const CHANNEL = read("decision-channel.mjs");
  const LAUNCHER = read("launcher.ps1");

  for (const verdict of ["allow", "reject"]) {
    assert.ok(REGISTRY.includes(`"${verdict}"`), `VERDICTS must define "${verdict}"`);
    assert.ok(CHANNEL.includes(verdict), `decision-channel must reference "${verdict}"`);
    assert.ok(LAUNCHER.includes(`-eq "${verdict}"`), `launcher.ps1 must accept "${verdict}"`);
  }
});

test("REGRESSION: the two senders expose the same shared parameter interface", () => {
  // The shared subset of the two param blocks must keep the same order and the
  // same defaults: index.js builds one argument vector shape for both (audit
  // 2026-11-17, Standards-5/Data Clumps; PS 5.1 has no cross-file parameter
  // objects, so the blocks stay separate and this test is the anchor).
  const SHARED = [
    "[string]$Aumid = \"DeepSeekHarness.Notify\"",
    "[string]$AppName = \"DeepSeek Harness\"",
    "[string]$Url = \"\"",
    "[int]$LaunchProtocol = 1",
    "[int]$ForegroundPid = 0",
    "[string[]]$ForegroundName = @()",
  ];
  for (const line of SHARED) {
    assert.ok(NOTIFY.includes(line), `notify.ps1 param must match: ${line}`);
    assert.ok(ACTIONS.includes(line), `notify-actions.ps1 param must match: ${line}`);
  }
  // Shared params must appear in the same order in both blocks.
  const order = (src) => SHARED.map((s) => src.indexOf(s));
  const a = order(NOTIFY), b = order(ACTIONS);
  assert.deepEqual(a, [...a].sort((x, y) => x - y), "notify.ps1 param order");
  assert.deepEqual(b, [...b].sort((x, y) => x - y), "notify-actions.ps1 param order");
});
