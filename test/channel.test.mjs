// End-to-end checks for the loopback decision channel.
//
// This was a console.log script that no test runner ever collected: the npm
// test glob is "test/*.test.mjs" and the file was channel.e2e.mjs, so the
// channel - the path every approval button click actually travels - had no
// automated coverage at all. Converted to node:test so it runs with the rest.
//
// It starts a real loopback server and posts to it, so it is slower than the
// pure-logic tests, but it is the only coverage of the HTTP surface.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDecisionChannel } from "../lib/decision-channel.mjs";
import { createDecisionRegistry, VERDICTS } from "../lib/decision-registry.mjs";

const channels = [];

after(async () => {
  for (const ch of channels) {
    try { ch.stop(); } catch {}
  }
  // Give the listener a tick to close so the runner can exit.
  await new Promise((r) => setTimeout(r, 50));
});

const boot = async () => {
  const registry = createDecisionRegistry();
  const events = [];
  const ch = await startDecisionChannel(
    (token, verdict) => registry.settle(token, verdict),
    (e) => events.push(e),
  );
  channels.push(ch);
  return { registry, ch, events };
};

const post = async (ch, body, secret) => {
  const res = await fetch(`http://127.0.0.1:${ch.port}/decide`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-dsh-notify-secret": secret } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

test("E2E: the channel writes an endpoint file with a matching port and a secret", async () => {
  const { ch } = await boot();
  assert.equal(ch.enabled, true);
  const ep = JSON.parse(readFileSync(join(tmpdir(), "dsh-notify", "endpoint.json"), "utf8"));
  assert.equal(ep.port, ch.port);
  assert.ok(typeof ep.secret === "string" && ep.secret.length >= 32, "secret must be substantial");
});

test("E2E: requests without the secret are rejected", async () => {
  const { ch } = await boot();
  const r = await post(ch, { token: "t", verdict: "allow" }, null);
  assert.equal(r.status, 401);
});

test("E2E: requests with a wrong secret are rejected", async () => {
  const { ch } = await boot();
  const r = await post(ch, { token: "t", verdict: "allow" }, "definitely-not-the-secret");
  assert.equal(r.status, 401);
});

test("E2E: an unknown verdict is a bad request, not a silent drop", async () => {
  const { registry, ch } = await boot();
  const ep = JSON.parse(readFileSync(join(tmpdir(), "dsh-notify", "endpoint.json"), "utf8"));
  const { token } = registry.park({ sessionId: "s1" });
  const r = await post(ch, { token, verdict: "maybe" }, ep.secret);
  assert.equal(r.status, 400);
});

test("E2E: a valid allow settles the parked request exactly once", async () => {
  const { registry, ch } = await boot();
  const ep = JSON.parse(readFileSync(join(tmpdir(), "dsh-notify", "endpoint.json"), "utf8"));
  const { token, settled } = registry.park({ sessionId: "s1" });
  const first = await post(ch, { token, verdict: "allow" }, ep.secret);
  assert.equal(first.status, 200);
  assert.equal(first.json.ok, true);
  assert.equal(await settled, VERDICTS.allow);
  // Replaying the same token must not settle anything twice.
  const second = await post(ch, { token, verdict: "allow" }, ep.secret);
  assert.equal(second.status, 200);
  assert.equal(second.json.ok, false, "a spent token must not be applied again");
});
