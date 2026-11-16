// Approval/answer decision loopback.
//
// A toast button is a protocol activation: Windows runs
//   powershell.exe -File launcher.ps1 "dshnotify://answer?t=<token>&v=allow"
// in a NEW process, entirely outside this plugin. The decision has to travel
// back into the running host, so this module runs a tiny loopback-only HTTP
// server that the launcher posts to.
//
// Why a server instead of a file mailbox: the launcher gets an immediate
// accept/reject verdict it can trace, and there is no polling latency on the
// decision path (approvals are often answered while an agent is blocked).
//
// Security posture:
//   - binds 127.0.0.1 with port 0 (OS-assigned) and never 0.0.0.0
//   - a 32-byte random secret gates every request (constant-time compare)
//   - endpoint + secret are written to a 0600-ish JSON file in the OS temp dir
//     so the launcher can find them; the file is removed on shutdown
//   - tokens are single-use and expire with the pending request
//   - every failure is silent: a broken loopback must never block an approval
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Fixed filename so the launcher can locate the endpoint without arguments. */
export const ENDPOINT_FILE = "endpoint.json";

export const endpointDir = (tmp = tmpdir()) => join(tmp, "dsh-notify");

const sameSecret = (a, b) => {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  // timingSafeEqual throws on length mismatch, so compare lengths first; the
  // secret is fixed-length random, so a mismatch is never a valid request.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

const readBody = (req, limit = 4096) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

/**
 * Start the decision receiver.
 *
 * @param handler - (token, verdict) => boolean; true when the token was known
 *   and the decision was applied, false for an expired/unknown token.
 * @param log - diagnostic sink (may be a no-op).
 * @returns the bound port and a stop() that removes the endpoint file.
 */
export const startDecisionChannel = (handler, log = () => {}, options = {}) => {
  const secret = randomBytes(32).toString("base64url");
  const dir = endpointDir();
  // Optional: a second sink on the SAME authenticated port, so the launcher
  // never needs browser credentials. DSH's same-origin fetch routes require the
  // page's auth cookie, which an external process does not have.
  const onJump = typeof options.onJump === "function" ? options.onJump : null;

  // The endpoint file is the ONLY way the external launcher can find this port,
  // and it is written exactly once, when the listener comes up. Anything that
  // removes it afterwards -- an antivirus sweep, a temp cleaner, a stray
  // cleanup, a profile export -- silently disables both toast buttons and
  // session jumping until the host is restarted, because the launcher then logs
  // "no usable endpoint file" and falls back to just opening the GUI.
  //
  // Measured 2026-11-15: the file disappeared while port 4337 was still
  // listening and the plugin had not reloaded, so a click could not jump.
  //
  // Re-writing it is cheap and idempotent, so the file is re-asserted whenever a
  // launcher request arrives and finds it missing. The write is atomic-rename so
  // a launcher never reads a half-written JSON document.
  const endpointPath = () => join(dir, ENDPOINT_FILE);
  const writeEndpointFile = () => {
    try {
      mkdirSync(dir, { recursive: true });
      const file = endpointPath();
      const body = JSON.stringify({ port: server.address()?.port ?? 0, secret });
      const tmp = file + ".tmp";
      writeFileSync(tmp, body, "utf8");
      // chmod before the rename so the published file is never briefly readable
      // by other accounts. Windows ACLs ignore the mode bits; the file lives
      // under the user's own profile temp dir, already user-scoped.
      try { chmodSync(tmp, 0o600); } catch {}
      renameSync(tmp, file);
      return true;
    } catch (error) {
      log({ event: "decision-endpoint-file-error", message: String(error?.message ?? error) });
      return false;
    }
  };
  /** Re-publish the endpoint file if something removed it. */
  const ensureEndpointFile = () => {
    try {
      if (!existsSync(endpointPath())) {
        log({ event: "decision-endpoint-file-restored" });
        return writeEndpointFile();
      }
    } catch {}
    return true;
  };

  const server = createServer(async (req, res) => {
    // A request proves the launcher is running and expects this file to exist.
    // If it is gone, put it back before doing anything else so the NEXT click
    // works even when this one could not be authenticated.
    ensureEndpointFile();
    // Only the launcher on this machine should ever reach this port.
    const remote = req.socket.remoteAddress ?? "";
    if (!(remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1")) {
      res.writeHead(403).end();
      return;
    }
    const isJump = onJump !== null && req.method === "POST" && req.url === "/jump";
    if (!isJump && (req.method !== "POST" || req.url !== "/decide")) {
      res.writeHead(404).end();
      return;
    }
    if (!sameSecret(req.headers["x-dsh-notify-secret"], secret)) {
      res.writeHead(401).end();
      return;
    }
    if (isJump) {
      try {
        const payload = JSON.parse(await readBody(req));
        const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
        if (sessionId === "") {
          res.writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({ ok: false, error: "sessionId required" }));
          return;
        }
        onJump(sessionId);
        res.writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: true, queued: sessionId }));
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
      }
      return;
    }
    try {
      const payload = JSON.parse(await readBody(req));
      const token = typeof payload?.token === "string" ? payload.token : "";
      const verdict = payload?.verdict;
      if (token === "" || (verdict !== "allow" && verdict !== "reject")) {
        res.writeHead(400, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: false, error: "bad request" }));
        return;
      }
      const applied = handler(token, verdict);
      // A stale token is a normal race: the request may have been cancelled or
      // answered in the browser first. Report it, but do not treat it as an
      // error the launcher needs to surface loudly.
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: applied, reason: applied ? "applied" : "unknown-or-expired-token" }));
      log({ event: "decision", applied, verdict });
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
      log({ event: "decision-error", message: String(error?.message ?? error) });
    }
  });

  return new Promise((resolve) => {
    server.once("error", (error) => {
      log({ event: "decision-channel-error", message: String(error?.message ?? error) });
      resolve({ port: 0, enabled: false, stop: () => {} });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      let published = false;
      try {
        published = writeEndpointFile();
      } catch (error) {
        log({ event: "decision-endpoint-file-error", message: String(error?.message ?? error) });
      }
      log({ event: "decision-channel", port, endpointFile: published });
      resolve({
        port,
        enabled: true,
        stop: () => {
          try { server.close(); } catch {}
          try { rmSync(join(dir, ENDPOINT_FILE), { force: true }); } catch {}
        },
      });
    });
  });
};
