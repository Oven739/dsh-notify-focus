// Regression tests for the focus gate (the "approval never parks" bug).
//
// The bug: the sampler recorded a FAILED probe as a fresh sample with
// focused=false, and a stale-but-not-failed path then answered "focused".
// Net effect in the host: approvals were always handed to the browser and the
// toast-button path never ran.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFocusGate } from "../lib/focus-gate.mjs";

const clock = (start = 1_000_000) => {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
};

test("before any sample, the gate never parks", () => {
  const gate = createFocusGate({ probe: () => "bg" });
  assert.equal(gate.shouldHandToBrowser(), true);
});

test("a background sample allows parking", () => {
  const c = clock();
  const gate = createFocusGate({ probe: () => "bg", now: c.now });
  gate.sampleOnce();
  assert.equal(gate.shouldHandToBrowser(), false, "bg must permit park");
});

test("a foreground sample hands to the browser", () => {
  const c = clock();
  const gate = createFocusGate({ probe: () => "fg", now: c.now });
  gate.sampleOnce();
  assert.equal(gate.shouldHandToBrowser(), true);
});

test("REGRESSION: a failed probe must not become a background sample", () => {
  const c = clock();
  let mode = "bg";
  const gate = createFocusGate({ probe: () => (mode === "fail" ? null : mode), now: c.now });
  gate.sampleOnce();
  assert.equal(gate.shouldHandToBrowser(), false);
  // The probe breaks. If the gate recorded the failure as focused=false the
  // next decision would park — hiding the prompt from the user.
  mode = "fail";
  gate.sampleOnce();
  c.advance(1000);
  assert.equal(gate.shouldHandToBrowser(), false, "keeps the last good sample");
  // Once that last good sample goes stale, the gate must answer safely.
  c.advance(20_000);
  assert.equal(gate.shouldHandToBrowser(), true, "stale sample falls back to focused");
});

test("REGRESSION: a probe that returns empty output is a failure, not 'background'", () => {
  const c = clock();
  const gate = createFocusGate({ probe: () => "", now: c.now });
  gate.sampleOnce();
  assert.equal(gate.current.at, 0, "no sample recorded");
  assert.equal(gate.shouldHandToBrowser(), true);
});

test("a throwing probe does not corrupt the sample", () => {
  const c = clock();
  let explode = false;
  const gate = createFocusGate({
    probe: () => { if (explode) throw new Error("EPERM"); return "fg"; },
    now: c.now,
  });
  gate.sampleOnce();
  explode = true;
  gate.sampleOnce();
  assert.equal(gate.shouldHandToBrowser(), true);
});

test("disabled gate always hands to the browser", () => {
  const c = clock();
  const gate = createFocusGate({ probe: () => "bg", now: c.now, enabled: false });
  gate.sampleOnce();
  assert.equal(gate.shouldHandToBrowser(), true);
});

test("skipWhenFocused=false always allows parking", () => {
  const gate = createFocusGate({ probe: () => "fg", skipWhenFocused: false });
  gate.sampleOnce();
  assert.equal(gate.shouldHandToBrowser(), false);
});
