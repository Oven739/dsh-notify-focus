// Parked-decision registry: the heart of button-driven approval.
//
// Why this module exists: only `approval/request` and `user-questions/request`
// are waterfalls (see CONTEXT.md). A listener that holds the waterfall without
// calling next() prevents the browser from ever seeing the prompt, so parking is
// reserved for the case where the host is NOT focused (the user is away).
//
// The registry owns the token <-> pending-request mapping. Tokens are generated
// here because the Remote Event frame carries no correlation id the browser and
// this plugin can share, so the toast producer must be the one that remembers.

import { randomUUID } from "node:crypto";

/** Verdicts a toast button can carry. */
export const VERDICTS = Object.freeze({ allow: "allow", reject: "reject" });

const isVerdict = (value) => value === VERDICTS.allow || value === VERDICTS.reject;

/**
 * Create a registry of parked decisions.
 *
 * @param options.generateToken - token factory (injectable for tests).
 * @param options.now - clock (injectable for tests).
 * @param options.ttlMs - how long a parked decision stays answerable.
 * @param options.onExpire - called with the token when an entry expires, so
 *   the caller can hand the waterfall back downstream.
 */
export const createDecisionRegistry = ({
  generateToken = () => randomUUID(),
  now = () => Date.now(),
  ttlMs = 10 * 60 * 1000,
  onExpire = () => {},
} = {}) => {
  /** token -> { resolve, reject, createdAt, meta } */
  const parked = new Map();

  const sweep = () => {
    const at = now();
    for (const [token, entry] of parked) {
      if (at - entry.createdAt < ttlMs) continue;
      parked.delete(token);
      onExpire(token, entry.meta);
    }
  };

  /**
   * Park one pending decision and return the token plus its settlement promise.
   * @returns {{ token: string, settled: Promise<string> }}
   */
  const park = (meta = {}) => {
    sweep();
    const token = generateToken();
    let resolve;
    let reject;
    const settled = new Promise((res, rej) => { resolve = res; reject = rej; });
    parked.set(token, { resolve, reject, createdAt: now(), meta });
    return { token, settled };
  };

  /**
   * Apply one verdict from a toast button.
   * A miss is a normal race (answered in the browser, or expired) and returns
   * false rather than throwing: the caller's HTTP layer reports it to the
   * launcher, which degrades to opening the GUI.
   *
   * @returns true when a live entry consumed the verdict.
   */
  const settle = (token, verdict) => {
    if (!isVerdict(verdict)) return false;
    const entry = parked.get(token);
    if (entry === undefined) return false;
    if (now() - entry.createdAt >= ttlMs) {
      parked.delete(token);
      onExpire(token, entry.meta);
      return false;
    }
    parked.delete(token);
    entry.resolve(verdict);
    return true;
  };

  /**
   * Drop a parked decision without resolving it as a verdict: the request was
   * answered elsewhere or cancelled, so the promise settles through `next()`.
   * @returns true when an entry was present.
   */
  const abandon = (token) => {
    const entry = parked.get(token);
    if (entry === undefined) return false;
    parked.delete(token);
    entry.abandoned = true;
    if (typeof entry.onAbandon === "function") entry.onAbandon();
    return true;
  };

  /** Attach a callback that runs when a live entry is abandoned. */
  const onAbandoned = (token, callback) => {
    const entry = parked.get(token);
    if (entry !== undefined) entry.onAbandon = callback;
  };

  /**
   * Which tool names have already produced a buttoned toast.
   *
   * The waterfall listener parks + toasts an approval, and the log-only
   * `approval/asked` audit event fires for the same approval a moment later and
   * would toast it again without buttons. This short-lived set is what lets the
   * audit handler recognise "already announced" without coupling the two paths.
   */
  const toasted = new Map(); // toolName -> timestamp
  const TOAST_DEDUPE_MS = 15_000;

  const markToasted = (toolName) => {
    toasted.set(String(toolName ?? ""), now());
    const at = now();
    for (const [key, stamp] of toasted) {
      if (at - stamp > TOAST_DEDUPE_MS) toasted.delete(key);
    }
  };

  /** True when this tool name was parked+toasted moments ago. */
  const wasToasted = (toolName) => {
    const key = String(toolName ?? "");
    const stamp = toasted.get(key);
    if (stamp === undefined) return false;
    if (now() - stamp > TOAST_DEDUPE_MS) {
      toasted.delete(key);
      return false;
    }
    return true;
  };

  return {
    park,
    settle,
    abandon,
    onAbandoned,
    sweep,
    markToasted,
    wasToasted,
    get size() { return parked.size; },
    has: (token) => parked.has(token),
  };
};
