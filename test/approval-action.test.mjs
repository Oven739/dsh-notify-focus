// Which action an incoming approval gets. See lib/approval-action.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideApprovalAction, ACTION } from "../lib/approval-action.mjs";

test("REGRESSION: focused but reading another conversation must NOT park", () => {
  // The original bug: this combination parked, so a user sitting at the
  // keyboard lost the approval card and kept only a toast.
  const action = decideApprovalAction({ hostFocused: true, onScreen: false });
  assert.equal(action, ACTION.NOTIFY);
  assert.notEqual(action, ACTION.PARK);
});

test("the conversation on screen gets no notification at all", () => {
  assert.equal(
    decideApprovalAction({ hostFocused: true, onScreen: true }),
    ACTION.SILENT,
  );
});

test("parking happens only when nobody is at the computer", () => {
  assert.equal(
    decideApprovalAction({ hostFocused: false, onScreen: false }),
    ACTION.PARK,
  );
});

test("not focused still parks even if the last known session matches", () => {
  // A stale on-screen belief must not make us skip the only buttoned path.
  assert.equal(
    decideApprovalAction({ hostFocused: false, onScreen: true }),
    ACTION.PARK,
  );
});

test("exactly one action parks", () => {
  const combos = [];
  for (const hostFocused of [true, false]) {
    for (const onScreen of [true, false]) {
      combos.push(decideApprovalAction({ hostFocused, onScreen }));
    }
  }
  assert.equal(combos.filter((a) => a === ACTION.PARK).length, 2, "only the not-focused cases");
});
