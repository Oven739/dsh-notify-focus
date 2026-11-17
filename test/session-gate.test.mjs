// Regression tests for session-scoped suppression.
//
// The bug: suppression was app-level, so reading conversation A silently
// dropped every approval/question raised by conversation B.
//
// This file mirrors isOnScreen() and the active-session report handler in
// index.js -- including the two branches the 2026-11-17 audit caught the old
// mirror missing:
//   1. a BLANK report means "re-render blip", remembered via lastKnownSessionId
//      rather than treated as "the user closed everything";
//   2. isOnScreen() falls back to that last-known id while the current report
//      is blank, so a flicker does not make the on-screen session look closed.
import { test } from "node:test";
import assert from "node:assert/strict";

const STALE_MS = 10_000;

// Mirrors the active-session handler + isOnScreen() in index.js.
const makeGate = ({ now = () => 1_000_000 } = {}) => {
  let mainViewSessionId = "";
  let mainViewReportedAt = 0;
  let lastKnownSessionId = "";

  // Mirrors the POST /api/dsh-notify/active-session handler.
  const report = (id, at = now()) => {
    // Log only real switches; blank reports are re-render artefacts.
    if (id !== "") lastKnownSessionId = id;
    mainViewSessionId = id;
    mainViewReportedAt = at;
  };

  const isOnScreen = (sessionId) => {
    if (typeof sessionId !== "string" || sessionId === "") return false;
    if (now() - mainViewReportedAt > STALE_MS) return false;
    const current = mainViewSessionId !== "" ? mainViewSessionId : lastKnownSessionId;
    if (current === "") return false;
    return current === sessionId;
  };
  return { report, isOnScreen };
};

test("unknown active session never counts as on-screen", () => {
  const g = makeGate();
  assert.equal(g.isOnScreen("s1"), false);
});

test("the session being read is on-screen", () => {
  const g = makeGate();
  g.report("s1");
  assert.equal(g.isOnScreen("s1"), true);
});

test("REGRESSION: a different session is NOT on-screen", () => {
  const g = makeGate();
  g.report("s1");
  // Reading s1 while s2 raises a request: s2 must still notify.
  assert.equal(g.isOnScreen("s2"), false);
});

test("a stale report is not trusted", () => {
  let at = 1_000_000;
  const g = makeGate({ now: () => at });
  g.report("s1");
  at += STALE_MS + 1;
  assert.equal(g.isOnScreen("s1"), false, "stale means 'cannot tell', so notify");
});

test("an empty request session is never on-screen", () => {
  const g = makeGate();
  g.report("");
  assert.equal(g.isOnScreen(""), false);
});

test("REGRESSION: a blank report is a re-render blip, not 'nothing is open'", () => {
  // The page alternates id/blank every second on panel switches (measured).
  // After s1 was on screen, a blank report must NOT make isOnScreen(s1) false
  // -- that let duplicate notifications through while s1 was still being read.
  const g = makeGate();
  g.report("s1");
  g.report(""); // re-render blip
  assert.equal(g.isOnScreen("s1"), true, "blank falls back to lastKnownSessionId");
});

test("REGRESSION: the blip fallback does not survive staleness", () => {
  let at = 1_000_000;
  const g = makeGate({ now: () => at });
  g.report("s1");
  g.report(""); // blip: mainView blank, lastKnown still s1
  at += STALE_MS + 1;
  assert.equal(g.isOnScreen("s1"), false, "a stale report is unknown, notify anyway");
});

test("REGRESSION: blip fallback switches to the NEW session once it reports", () => {
  const g = makeGate();
  g.report("s1");
  g.report(""); // blip while switching
  g.report("s2"); // the switch completed
  assert.equal(g.isOnScreen("s1"), false, "s1 is no longer the main view");
  assert.equal(g.isOnScreen("s2"), true);
});
