// What should the plugin do with an incoming approval request?
//
// The waterfall is SERIAL: a listener that holds without calling next() stops
// every later listener, including the one that turns the request into a
// browser-visible card. So "park" (hold the promise, toast with buttons) also
// means "the user will not see the approval card".
//
// The bug this encodes the fix for: when DSH was focused but a DIFFERENT
// conversation was on screen, the plugin parked. The user - sitting right
// there - got a toast and no card, which is worse than no plugin at all.
//
// Rule: park ONLY when nobody is at the computer.

export const ACTION = {
  /** Hand straight to the browser, silently: the card is already in front. */
  SILENT: "hand-over-silently",
  /** Notify, then hand over: a card the user can actually click still appears. */
  NOTIFY: "notify-and-hand-over",
  /** Hold the waterfall: the toast carries the buttons because no card will. */
  PARK: "park",
};

/**
 * @param {object} input
 * @param {boolean} input.hostFocused  is the DSH app in the foreground?
 * @param {boolean} input.onScreen     is THIS request's conversation on screen?
 */
export const decideApprovalAction = ({ hostFocused, onScreen }) => {
  // Nobody at the computer: parking is safe and is the only way to get buttons.
  if (!hostFocused) return ACTION.PARK;
  // In front of the user already: do not even notify.
  if (onScreen) return ACTION.SILENT;
  // User is present but looking elsewhere: notify, yet let the card through.
  // Parking here would delete the card from the screen they will return to.
  return ACTION.NOTIFY;
};
