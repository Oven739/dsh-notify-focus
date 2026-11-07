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

/** Mirrors the ranking in Read-DecisionEndpoint. */
const pickEndpoint = (candidates) => {
  let best = null;
  for (const c of candidates) {
    if (!c.port || !c.secret) continue;
    if (best === null) { best = c; continue; }
    if (c.alive !== best.alive) {
      if (c.alive) best = c;
      continue;
    }
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

test("with only a dead endpoint, nothing live is invented", () => {
  const chosen = pickEndpoint([{ port: 8801, secret: "s", alive: false, mtime: 100 }]);
  assert.equal(chosen.port, 8801, "still returns the best available; caller reports unreachable");
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
});
