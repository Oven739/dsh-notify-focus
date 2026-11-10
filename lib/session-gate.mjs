// Session-scoped suppression: is the user looking at THIS conversation?
//
// Why this exists: suppression used to be app-level ("is DSH focused"), so
// reading conversation A silently dropped nothing but also let a request from
// the very conversation you were reading toast over the panel in use.
//
// Extracted from index.js so the decision can be tested directly rather than
// mirrored in a test that can drift away from the implementation.

/** A report older than this is not trusted; the caller falls back to notifying. */
export const ACTIVE_SESSION_STALE_MS = 10_000;

export const createSessionGate = ({ now = () => Date.now(), staleMs = ACTIVE_SESSION_STALE_MS } = {}) => {
  // The browser reports an empty id whenever no session is retained by the main
  // view. That happens for a moment on every panel switch and re-render
  // (measured: alternating id/empty every second), so an empty report is
  // remembered as "unknown", not as "nothing is open".
  let reported = "";
  let lastKnown = "";
  let reportedAt = 0;

  /** Record what the browser says the main view is showing. */
  const report = (sessionId) => {
    reported = typeof sessionId === "string" ? sessionId : "";
    if (reported !== "") lastKnown = reported;
    reportedAt = now();
  };

  /** The session we believe is on screen, or "" when we cannot tell. */
  const onScreen = () => (reported !== "" ? reported : lastKnown);

  /**
   * True only when this exact session is on screen right now.
   * Anything uncertain answers false, so the caller notifies.
   */
  const isOnScreen = (sessionId) => {
    if (typeof sessionId !== "string" || sessionId === "") return false;
    if (reportedAt === 0) return false;                       // never reported
    if (now() - reportedAt > staleMs) return false;            // stale report
    return onScreen() === sessionId;
  };

  /** Diagnostics: the value decisions are based on. */
  const state = () => ({ reported, lastKnown, effective: onScreen(), reportedAt });

  return { report, isOnScreen, onScreen, state };
};
