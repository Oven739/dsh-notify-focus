// Regression guard for the decision-channel endpoint file.
//
// THE BUG THIS FILE EXISTS FOR
//
// endpoint.json is the ONLY way the external launcher can learn the loopback
// port + secret. It used to be written exactly once, when the listener came up,
// and never again. Anything that removes it afterwards (temp cleaner, AV sweep,
// a stray cleanup) silently disables BOTH the approval buttons and the session
// jump until the host is restarted: the launcher logs
// "no usable endpoint file" and falls back to just opening the GUI.
//
// Measured 2026-11-15: the file was gone while port 4337 was still listening and
// the plugin had not reloaded, so a real toast click could not jump.
//
// These tests drive the real module against a throwaway temp dir. They do not
// touch the live endpoint file, spawn nothing, and only listen on 127.0.0.1:0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// endpointDir() reads tmpdir(); point it at a private dir so the live file is
// never involved. The module derives the dir from `tmpdir()` at call time, so a
// TMPDIR change is enough on POSIX -- on Windows `tmpdir()` honours TEMP/TMP, so
// all three are set.
const sandboxRoot = mkdtempSync(join(tmpdir(), "dsh-notify-endpoint-"));
const prev = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
process.env.TEMP = sandboxRoot;
process.env.TMP = sandboxRoot;
process.env.TMPDIR = sandboxRoot;

const { startDecisionChannel, ENDPOINT_FILE } = await import("../lib/decision-channel.mjs");
const endpointPath = join(sandboxRoot, "dsh-notify", ENDPOINT_FILE);

const readEndpoint = () => JSON.parse(readFileSync(endpointPath, "utf8"));

test.after(() => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { rmSync(sandboxRoot, { recursive: true, force: true }); } catch {}
});

test("writes the endpoint file on listen", async () => {
  const ch = await startDecisionChannel(() => true, () => {});
  try {
    assert.ok(existsSync(endpointPath), "endpoint.json must exist after start");
    const parsed = readEndpoint();
    assert.equal(parsed.port, ch.port);
    assert.equal(typeof parsed.secret, "string");
    assert.ok(parsed.secret.length >= 32, "secret must be a real random string");
  } finally {
    ch.stop();
  }
});

test("REGRESSION: a deleted endpoint file is re-published on the next request", async () => {
  const events = [];
  const ch = await startDecisionChannel(() => true, (e) => events.push(e));
  try {
    assert.ok(existsSync(endpointPath));
    // Simulate whatever external cleaner removed it in the wild.
    unlinkSync(endpointPath);
    assert.equal(existsSync(endpointPath), false);

    // A launcher request must restore it (any request, even an unauthenticated
    // one: the point is that the NEXT click finds a file).
    const res = await fetch(`http://127.0.0.1:${ch.port}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "x", verdict: "allow" }),
    });
    assert.equal(res.status, 401, "unauthenticated request is still rejected");

    assert.ok(
      existsSync(endpointPath),
      "endpoint.json must be restored by the request, otherwise every later " +
        "toast click logs 'no usable endpoint file' until the host restarts",
    );
    const parsed = readEndpoint();
    assert.equal(parsed.port, ch.port, "restored file must point at the live port");
    assert.ok(events.some((e) => e.event === "decision-endpoint-file-restored"));
  } finally {
    ch.stop();
  }
});

test("a restored endpoint file is valid JSON with no leftover temp file", async () => {
  const ch = await startDecisionChannel(() => true, () => {});
  try {
    unlinkSync(endpointPath);
    await fetch(`http://127.0.0.1:${ch.port}/decide`, { method: "POST", body: "{}" });
    assert.equal(existsSync(`${endpointPath}.tmp`), false, "no .tmp must be left behind");
    assert.doesNotThrow(() => readEndpoint(), "restored file must parse");
  } finally {
    ch.stop();
  }
});

test("an authenticated jump still works after the file was deleted", async () => {
  let jumped = "";
  const ch = await startDecisionChannel(
    () => true,
    () => {},
    { onJump: (id) => { jumped = id; } },
  );
  try {
    const secret = readEndpoint().secret;
    unlinkSync(endpointPath);
    const res = await fetch(`http://127.0.0.1:${ch.port}/jump`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-dsh-notify-secret": secret },
      body: JSON.stringify({ sessionId: "session-abc" }),
    });
    assert.equal(res.status, 200);
    assert.equal(jumped, "session-abc", "the jump must still be delivered");
    assert.ok(existsSync(endpointPath), "and the file must be back for the next click");
  } finally {
    ch.stop();
  }
});
