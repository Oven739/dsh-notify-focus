// Regression tests for endpoint selection (launcher.ps1).
//
// The bug this guards: Read-DecisionEndpoint returned the FIRST file that
// parsed, without checking that anything still listened on its port. A leftover
// file from a previous run pointed at a dead port, so every toast click focused
// the window and then silently dropped the jump.
//
// CONTRACT UNDER TEST: a candidate is usable only while its port answers. When
// nothing answers, the function returns nothing - it must NOT fall back to the
// newest dead file, because posting to a dead port fails late and looks like
// "the click did nothing".
//
// This mirrors the ranking in Read-DecisionEndpoint. The surrounding script
// needs Win32/registry access a unit test cannot provide, so the mirror is of
// the decision rule itself - the part that was wrong.
import { test } from "node:test";
import assert from "node:assert/strict";

/** Mirrors Read-DecisionEndpoint: only live candidates compete; none live -> null. */
const pickEndpoint = (candidates) => {
  let best = null;
  for (const c of candidates) {
    if (!c.port || !c.secret) continue;
    if (!c.alive) continue; // a parsed file whose port is closed is not a plugin
    if (best === null || c.mtime > best.mtime) best = c;
  }
  return best;
};

test("REGRESSION: a dead endpoint never wins, even if it is listed first", () => {
  const stale = { port: 8801, secret: "s", alive: false, mtime: 100 };
  const live = { port: 13000, secret: "s", alive: true, mtime: 50 };
  // The real machine: stale file first AND newer, live file second and older.
  assert.equal(pickEndpoint([stale, live]).port, 13000);
});

test("REGRESSION: with only dead endpoints the result is nothing, not the newest", () => {
  const chosen = pickEndpoint([{ port: 8801, secret: "s", alive: false, mtime: 100 }]);
  assert.equal(chosen, null, "a dead port must not be handed to the caller");
});

test("among live endpoints the newer file wins", () => {
  const older = { port: 1, secret: "s", alive: true, mtime: 10 };
  const newer = { port: 2, secret: "s", alive: true, mtime: 20 };
  assert.equal(pickEndpoint([older, newer]).port, 2);
});

test("incomplete files are ignored even when live", () => {
  const chosen = pickEndpoint([
    { port: 0, secret: "s", alive: true, mtime: 99 },
    { port: 5, secret: "", alive: true, mtime: 99 },
    { port: 13000, secret: "s", alive: true, mtime: 1 },
  ]);
  assert.equal(chosen.port, 13000);
});

test("no candidates at all returns null", () => {
  assert.equal(pickEndpoint([]), null);
});
