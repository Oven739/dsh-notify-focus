// Guards for the shared protocol registration (stage 2).
//
// THE DEFECT THIS FILE EXISTS FOR
// The dshnotify:// registration lived inline in notify.ps1 only. Approval
// toasts are sent by notify-actions.ps1, which had no copy of it, and on a
// machine that has never seen a plain notification those are the FIRST toasts
// to arrive - buttons are enabled by default. The registry key was therefore
// never written, so clicking Allow did nothing and left no trace.
//
// The fix moves registration into lib/register-protocol.ps1 and has all three
// call sites use it: notify.ps1, notify-actions.ps1, and a startup warmup in
// index.js (the sender paths can each be skipped, the warmup cannot).
//
// NO PROCESS IS SPAWNED. These read text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");
const read = (name) => readFileSync(join(LIB, name), "utf8");

const REGISTER = read("register-protocol.ps1");
const NOTIFY = read("notify.ps1");
const ACTIONS = read("notify-actions.ps1");
const INDEX = read("index.js");

test("REG: the shared registration script exists and writes the command key", () => {
  assert.ok(existsSync(join(LIB, "register-protocol.ps1")));
  assert.ok(REGISTER.includes("Software\\Classes\\dshnotify"), "must target the dshnotify ProgID");
  assert.ok(REGISTER.includes("Set-Item -Path \u0024cmdKey"), "must actually write the command value");
});

test("REG: both toast senders call the shared script", () => {
  assert.ok(NOTIFY.includes("register-protocol.ps1"), "notify.ps1 must call register-protocol.ps1");
  assert.ok(ACTIONS.includes("register-protocol.ps1"), "notify-actions.ps1 must call register-protocol.ps1");
});

test("REGRESSION: notify-actions.ps1 must own a registration call, not inherit one", () => {
  const branchAt = ACTIONS.indexOf("$LaunchProtocol -eq 1");
  const callAt = ACTIONS.indexOf("register-protocol.ps1");
  assert.ok(branchAt >= 0, "approval sender must have a protocol branch");
  assert.ok(callAt > branchAt, "registration must be inside the protocol branch");
  assert.ok(callAt - branchAt < 1200, "registration must be reachable on that branch, not far below");
});

test("REG: startup warmup exists so a fresh install never depends on toast order", () => {
  assert.ok(INDEX.includes("REGISTER_PROTOCOL_SCRIPT"), "index.js must know the registration script");
  assert.ok(INDEX.includes("protocol-warmup"), "warmup must log its outcome");
  assert.ok(INDEX.includes("cfg.enabled && cfg.openOnClick"), "warmup must respect openOnClick");
});

test("REG: wscript.exe is registered by absolute path, not by bare name", () => {
  assert.ok(REGISTER.includes("SystemRoot"), "must resolve wscript via SystemRoot");
  assert.ok(REGISTER.includes("System32\\wscript.exe"), "must name the absolute wscript path");
  const offending = REGISTER.split("\n").filter((l) =>
    /^\s*\$command\s*=/.test(l) && l.includes('"wscript.exe" //'));
  assert.deepEqual(offending, [], "the command must not start with a bare wscript.exe");
});

test("REG: no registration script may contain a machine-specific path", () => {
  // "C:\Windows\System32\wscript.exe" is a SYSTEM path and fine anywhere.
  // What must not appear is a path into a user profile, a drive of this
  // machine, or the plugin's own install location.
  const code = REGISTER.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.equal(/[A-Za-z]:\\Users\\/.test(code), false, "user-profile path in code");
  assert.equal(/[A-Za-z]:\\DSH\\/.test(code), false, "this machine's drive-per-1 path in code");
  assert.equal(/[A-Za-z]:\\Program/.test(code), false, "install-location path in code");
});