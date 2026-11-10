// Session-scoped suppression tests.
//
// These import the REAL module used by index.js. An earlier version mirrored the
// logic inside the test, which let it drift: the mirror lacked the
// lastKnownSessionId fallback while the shipped code had it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionGate, ACTIVE_SESSION_STALE_MS } from "../lib/session-gate.mjs";

const clock = (start = 1_000_000) => {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
};

test("before any report, nothing counts as on-screen", () => {
  const gate = createSessionGate();
  assert.equal(gate.isOnScreen("s1"), false);
});

test("the reported session is on-screen", () => {
  const gate = createSessionGate();
  gate.report("s1");
  assert.equal(gate.isOnScreen("s1"), true);
});

test("REGRESSION: a different session is NOT on-screen", () => {
  const gate = createSessionGate();
  gate.report("s1");
  // Reading s1 while s2 raises a request: s2 must still notify.
  assert.equal(gate.isOnScreen("s2"), false);
});

test("REGRESSION: an empty report keeps the last known session", () => {
  const c = clock();
  const gate = createSessionGate({ now: c.now });
  gate.report("s1");
  // Re-render blip: the main view momentarily retains nothing.
  gate.report("");
  assert.equal(gate.isOnScreen("s1"), true, "a blip must not look like the user left");
  assert.equal(gate.state().reported, "", "but the raw report is still recorded");
});

test("a stale report is not trusted", () => {
  const c = clock();
  const gate = createSessionGate({ now: c.now });
  gate.report("s1");
  c.advance(ACTIVE_SESSION_STALE_MS + 1);
  assert.equal(gate.isOnScreen("s1"), false, "stale means cannot tell, so notify");
});

test("a stale report does not resurrect a session via lastKnown", () => {
  const c = clock();
  const gate = createSessionGate({ now: c.now });
  gate.report("s1");
  gate.report("");
  c.advance(ACTIVE_SESSION_STALE_MS + 1);
  assert.equal(gate.isOnScreen("s1"), false);
});

test("an empty request id is never on-screen", () => {
  const gate = createSessionGate();
  gate.report("s1");
  assert.equal(gate.isOnScreen(""), false);
  assert.equal(gate.isOnScreen(undefined), false);
});

test("switching sessions updates the answer immediately", () => {
  const gate = createSessionGate();
  gate.report("s1");
  gate.report("s2");
  assert.equal(gate.isOnScreen("s1"), false);
  assert.equal(gate.isOnScreen("s2"), true);
});
