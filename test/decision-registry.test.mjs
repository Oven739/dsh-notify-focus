// Tests for the parked-decision registry (see CONTEXT.md).
// Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecisionRegistry, VERDICTS } from "../lib/decision-registry.mjs";

const makeClock = (start = 1_000_000) => {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
};

test("park returns a token and a pending promise", async () => {
  const reg = createDecisionRegistry({ generateToken: () => "t1" });
  const { token, settled } = reg.park({ toolName: "bash" });
  assert.equal(token, "t1");
  assert.equal(reg.size, 1);
  assert.equal(reg.has("t1"), true);
  reg.settle("t1", VERDICTS.allow);
  assert.equal(await settled, "allow");
});

test("settle applies a verdict once and clears the entry", () => {
  const reg = createDecisionRegistry({ generateToken: () => "t1" });
  reg.park();
  assert.equal(reg.settle("t1", "allow"), true);
  assert.equal(reg.size, 0);
  // Second click on the same toast: the decision is already made.
  assert.equal(reg.settle("t1", "reject"), false);
});

test("settle rejects an unknown token without throwing", () => {
  const reg = createDecisionRegistry();
  assert.equal(reg.settle("nope", "allow"), false);
});

test("settle rejects a malformed verdict", () => {
  const reg = createDecisionRegistry({ generateToken: () => "t1" });
  reg.park();
  assert.equal(reg.settle("t1", "maybe"), false);
  assert.equal(reg.size, 1, "a bad verdict must not consume the entry");
});

test("concurrent parks keep independent tokens", async () => {
  let n = 0;
  const reg = createDecisionRegistry({ generateToken: () => `t${++n}` });
  const a = reg.park({ toolName: "read" });
  const b = reg.park({ toolName: "write" });
  assert.equal(reg.size, 2);
  // Answer the SECOND one first: the first must stay parked.
  reg.settle(b.token, "allow");
  assert.equal(reg.has(a.token), true);
  reg.settle(a.token, "reject");
  assert.equal(await a.settled, "reject");
  assert.equal(await b.settled, "allow");
});

test("an expired entry is not answerable", () => {
  const clock = makeClock();
  const expired = [];
  const reg = createDecisionRegistry({
    generateToken: () => "t1",
    now: clock.now,
    ttlMs: 1000,
    onExpire: (token) => expired.push(token),
  });
  reg.park();
  clock.advance(1001);
  assert.equal(reg.settle("t1", "allow"), false);
  assert.deepEqual(expired, ["t1"]);
  assert.equal(reg.size, 0);
});

test("sweep expires stale entries and keeps fresh ones", () => {
  const clock = makeClock();
  let n = 0;
  const expired = [];
  const reg = createDecisionRegistry({
    generateToken: () => `t${++n}`,
    now: clock.now,
    ttlMs: 1000,
    onExpire: (token) => expired.push(token),
  });
  reg.park();
  clock.advance(600);
  reg.park();
  clock.advance(600);
  reg.sweep();
  assert.deepEqual(expired, ["t1"]);
  assert.equal(reg.size, 1);
});

test("abandon clears an entry and runs its callback", () => {
  const reg = createDecisionRegistry({ generateToken: () => "t1" });
  reg.park();
  let ran = false;
  reg.onAbandoned("t1", () => { ran = true; });
  assert.equal(reg.abandon("t1"), true);
  assert.equal(ran, true);
  assert.equal(reg.size, 0);
  assert.equal(reg.settle("t1", "allow"), false, "an abandoned token cannot be answered");
});
