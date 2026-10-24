// Focus gate: decides whether an approval may be PARKED (held away from the
// browser) or must be handed downstream.
//
// This module exists to be testable. The decision used to live inline in the
// waterfall listener, where it could only be exercised by a live DSH host plus
// a human switching windows — a loop far too slow to debug against.
//
// Safety direction (see CONTEXT.md): answering "focused" is always safe, it
// merely hands the prompt to the browser. Answering "background" parks the
// request, which HIDES the prompt, so every uncertain case must answer focused.

export const DEFAULT_STALE_MS = 15_000;

/**
 * @param options.probe - () => "fg" | "bg" | null; null means the probe failed.
 * @param options.now - clock.
 * @param options.staleMs - a sample older than this is not trusted.
 * @param options.enabled - when false the gate always answers focused.
 * @param options.skipWhenFocused - when false the gate never parks.
 */
export const createFocusGate = ({
  probe,
  now = () => Date.now(),
  staleMs = DEFAULT_STALE_MS,
  enabled = true,
  skipWhenFocused = true,
  onSample = () => {},
} = {}) => {
  // Starts focused: before any trustworthy sample exists the safe answer is
  // "the user is right here", so nothing is parked away from them.
  let sample = { focused: true, at: 0 };

  const sampleOnce = () => {
    if (!enabled) return sample;
    let raw;
    try {
      raw = probe();
    } catch (error) {
      onSample({ kind: "crashed", message: String(error?.message ?? error) });
      return sample;
    }
    // A failed probe is NOT evidence of absence: recording it as "background"
    // would park every approval while the user sits in front of the screen.
    if (raw !== "fg" && raw !== "bg") {
      onSample({ kind: "failed", raw: raw ?? null });
      return sample;
    }
    sample = { focused: raw === "fg", at: now() };
    onSample({ kind: "sampled", focused: sample.focused });
    return sample;
  };

  /** True when the prompt must go to the browser instead of being parked. */
  const shouldHandToBrowser = () => {
    if (!enabled) return true;
    if (!skipWhenFocused) return false;
    if (sample.at === 0) return true; // never sampled yet
    if (now() - sample.at > staleMs) return true; // stale -> safe
    return sample.focused;
  };

  return {
    sampleOnce,
    shouldHandToBrowser,
    /** Test/diagnostic view of the current sample. */
    get current() { return { ...sample }; },
  };
};
