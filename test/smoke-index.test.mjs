// Smoke test: load the real plugin and exercise the paths that crashed.
//
// Why this exists: commit f152864 extracted session gating into
// lib/session-gate.mjs but only updated 2 of 8 call sites. The remaining bare
// `isOnScreen(...)` references are valid syntax, so `node --check` passed and
// every unit test passed - they import the module, not index.js. The break only
// surfaced at runtime, inside a setTimeout callback that fires when an approval
// appears, and it crashed the host process.
//
// This test imports index.js and drives the approval paths, so a missing
// symbol fails here instead of on the user's desktop.
//
// SANDBOX NOTES:
//  - the notification paths spawn powershell, which a restricted sandbox denies
//    with EPERM; that is an environment limit, not a defect.
//  - apply() starts a loopback HTTP server, so the test must dispose it or the
//    process never exits.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

const isSpawnDenied = (error) => /spawn EPERM|ENOENT|EPERM/i.test(String(error?.message ?? error));

const disposers = [];

const boot = async (config = {}) => {
  const handlers = new Map();
  const routes = [];
  const ctx = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    inject(_deps, cb) {
      cb({ webServer: { register(r) { routes.push(r.path); return () => {}; } } });
    },
    effect(fn) {
      try {
        const dispose = fn();
        if (typeof dispose === "function") disposers.push(dispose);
      } catch {}
    },
    get() { return undefined; },
    logger: { warn() {}, info() {}, error() {} },
    connection: { fetch: { register() { return () => {}; } } },
    webServer: { host: "127.0.0.1", register(r) { routes.push(r.path); return () => {}; } },
  };
  await apply(ctx, {
    enabled: true,
    buttonsEnabled: true,
    notifyOnApproval: true,
    notifyOnAskUser: true,
    jumpEnabled: true,
    skipWhenHostFocused: true,
    log: false,
    ...config,
  });
  return { handlers, routes };
};

after(async () => {
  for (const dispose of disposers) { try { dispose(); } catch {} }
  // Give the loopback server a tick to close before the runner exits.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test("SMOKE: apply() wires both hooks and all three routes", async () => {
  const { handlers, routes } = await boot();
  assert.ok(handlers.has("approval/request"), "approval/request hook missing");
  assert.ok(handlers.has("session/event"), "session/event hook missing");
  assert.equal(routes.length, 3, "expected pending/outcome/active-session routes");
});

test("SMOKE: the approval waterfall resolves every bare symbol it calls", async () => {
  const { handlers } = await boot();
  const [onApproval] = handlers.get("approval/request");
  let reachedDownstream = false;
  const request = {
    toolName: "Bash",
    reason: "smoke test",
    sessionId: "session-smoke",
    signal: { addEventListener() {} },
  };
  let result;
  try {
    result = onApproval(request, () => { reachedDownstream = true; return "downstream"; });
    if (result && typeof result.then === "function") await Promise.race([result, Promise.resolve()]);
  } catch (error) {
    if (!isSpawnDenied(error)) throw error;
  }
  assert.equal(reachedDownstream || typeof result?.then === "function", true);
});

test("REGRESSION: approval/asked deferred toast must not throw", async () => {
  const { handlers } = await boot({ approvalDedupeDelayMs: 10 });
  const [onEvent] = handlers.get("session/event");
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  try {
    // The exact path that crashed the host: a setTimeout inside this branch,
    // whose callback called the removed local isOnScreen and then spawn.
    await onEvent(
      { id: "session-smoke", policy: "ask" },
      { type: "approval/asked", data: { id: "a1", toolName: "Bash", reason: "smoke" } },
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  // A ReferenceError means a call site was not updated after a refactor; a
  // spawn denial is this sandbox refusing child processes.
  const real = uncaught.filter((e) => !isSpawnDenied(e));
  assert.deepEqual(real.map((e) => `${e.constructor.name}: ${e.message}`), []);
});

test("SMOKE: turn/end handler runs (spawn denial tolerated)", async () => {
  const { handlers } = await boot();
  const [onEvent] = handlers.get("session/event");
  try {
    await onEvent(
      { id: "session-smoke" },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" }, text: "done" } },
    );
  } catch (error) {
    if (!isSpawnDenied(error)) throw error;
  }
  assert.ok(true, "turn/end handler completed");
});
