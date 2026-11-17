// Regression tests for endpoint selection (launcher.ps1).
//
// The bug: Read-DecisionEndpoint returned the FIRST file that parsed, without
// checking that anything still listened on its port. A leftover file from a
// previous run pointed at a dead port, so every toast click focused the window
// and then silently dropped the jump.
//
// The selection logic is mirrored here because the surrounding script needs
// Win32/registry access that a unit test cannot provide; the ranking rules are
// the part that was wrong, so they are the part under test.
import { test } from "node:test";
import assert from "node:assert/strict";

/** Mirrors the ranking in Read-DecisionEndpoint.
 *
 * The implementation skips every candidate whose port is not LIVE
 * (`if (-not $alive) { continue }`) and returns $null when none are: posting a
 * decision to a dead port can only fail late, which reads on screen as "the
 * click did nothing", so no candidate beats no candidate. This mirror must
 * follow that rule exactly -- the 2026-11-17 audit caught the two drifting
 * apart (the mirror used to keep a dead endpoint as best-available).
 */
const pickEndpoint = (candidates) => {
  let best = null;
  for (const c of candidates) {
    if (!c.port || !c.secret) continue;
    if (!c.alive) continue; // dead ports are skipped, never ranked
    if (best === null) { best = c; continue; }
    // Same liveness: newer file wins.
    if (c.mtime > best.mtime) best = c;
  }
  return best;
};

test("REGRESSION: a stale dead endpoint must not win over a live one", () => {
  const stale = { port: 8801, secret: "s", alive: false, mtime: 100 };
  const live = { port: 13000, secret: "s", alive: true, mtime: 50 };
  // The stale file is listed FIRST and is NEWER, exactly as on the real machine.
  const chosen = pickEndpoint([stale, live]);
  assert.equal(chosen.port, 13000, "liveness must outrank list order and recency");
});

test("with only a dead endpoint, nothing is returned at all", () => {
  // The implementation skips dead candidates outright, so a dead-only list
  // yields $null and the caller falls back to opening the GUI immediately --
  // it must NOT return a port nothing listens on.
  const chosen = pickEndpoint([{ port: 8801, secret: "s", alive: false, mtime: 100 }]);
  assert.equal(chosen, null, "a dead endpoint is never returned, not even as best-available");
});

test("among live endpoints the newer file wins", () => {
  const older = { port: 1, secret: "s", alive: true, mtime: 10 };
  const newer = { port: 2, secret: "s", alive: true, mtime: 20 };
  assert.equal(pickEndpoint([older, newer]).port, 2);
});

test("incomplete files are ignored", () => {
  const chosen = pickEndpoint([
    { port: 0, secret: "s", alive: false, mtime: 99 },
    { port: 5, secret: "", alive: false, mtime: 99 },
    { port: 13000, secret: "s", alive: true, mtime: 1 },
  ]);
  assert.equal(chosen.port, 13000);
});

test("no usable candidate returns null", () => {
  assert.equal(pickEndpoint([]), null);
  assert.equal(pickEndpoint([{ port: 0, secret: "", alive: false, mtime: 1 }]), null);
  // dead-only, all fields present: still null
  assert.equal(pickEndpoint([{ port: 8801, secret: "s", alive: false, mtime: 1 }]), null);
});
