import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecisionRegistry } from "../lib/decision-registry.mjs";

const clock = (start = 1_000_000) => {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
};

test("wasToasted is false before any park", () => {
  const reg = createDecisionRegistry();
  assert.equal(reg.wasToasted("pwsh"), false);
});

test("REGRESSION: a parked approval suppresses the duplicate audit toast", () => {
  const c = clock();
  const reg = createDecisionRegistry({ now: c.now });
  reg.park({ toolName: "pwsh" });
  reg.markToasted("pwsh");
  // The audit event arrives milliseconds later for the same approval.
  c.advance(300);
  assert.equal(reg.wasToasted("pwsh"), true, "must not toast twice");
});

test("dedupe is per tool name, not global", () => {
  const reg = createDecisionRegistry();
  reg.markToasted("pwsh");
  assert.equal(reg.wasToasted("bash"), false, "a different tool must still toast");
});

test("dedupe expires so a later approval still toasts", () => {
  const c = clock();
  const reg = createDecisionRegistry({ now: c.now });
  reg.markToasted("pwsh");
  c.advance(20_000);
  assert.equal(reg.wasToasted("pwsh"), false, "stale dedupe must not silence a new approval");
});
