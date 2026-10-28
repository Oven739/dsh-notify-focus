// Regression tests for session-scoped suppression.
//
// The bug: suppression was app-level, so reading conversation A silently
// dropped every approval/question raised by conversation B.
import { test } from "node:test";
import assert from "node:assert/strict";

const STALE_MS = 10_000;

// Mirrors isOnScreen() in index.js.
const makeGate = ({ now = () => 1_000_000 } = {}) => {
  let mainViewSessionId = "";
  let mainViewReportedAt = 0;
  const report = (id, at = now()) => { mainViewSessionId = id; mainViewReportedAt = at; };
  const isOnScreen = (sessionId) => {
    if (typeof sessionId !== "string" || sessionId === "") return false;
    if (mainViewSessionId === "") return false;
    if (now() - mainViewReportedAt > STALE_MS) return false;
    return mainViewSessionId === sessionId;
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
