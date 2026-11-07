// dsh-notify-focus -- browser half.
//
// Two jobs:
//   1. Poll the Host for a session to reveal and hand it to uiWorkspace
//      (DSH's frontend never reads ?session=, so this is the only way in).
//   2. Report which session the main view is currently showing.
//
// (2) exists because the Host cannot see the UI. Without it, "is the user
// looking?" can only be answered per-app: DSH in the foreground meant every
// session's notifications were suppressed, so a question raised in session B
// was silently dropped while you were reading session A.
//
// Written as a hand-rolled __ModuleLoader__ module: no build step, no
// dependencies. The loader only registers a factory and materialises it
// lazily, which is why apply() must be exported from the factory body.
window.__ModuleLoader__.load({
  id: "dsh-notify-focus",
  factory: () => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // Latency budget: the Host posts a jump, then this loop has to notice it.
    // At 1000ms the worst case added a full second before openSession ran, which
    // is what made a click feel slow. 350ms cuts the expected wait to ~175ms;
    // the request itself is a tiny loopback JSON ping.
    const POLL_MS = 350;
    // No leading slash: the page runs under the dsh-app:// scheme and the
    // shipped plugins poll with a bare relative path (task-board uses
    // fetch("api/task-board/verification")). A leading slash resolved to a
    // host-absolute URL the shell rejected with 400 before any handler ran.
    const PENDING = "api/dsh-notify/jump/pending";
    const ACTIVE = "api/dsh-notify/active-session";

    /**
     * Session currently shown in the main view, or "" when none is.
     *
     * `retainedBy.mainView > 0` is how the shipped UI decides "this row is
     * the one on screen" (dsh-client-ui-session's isMainView uses the same
     * test), so this follows the product's own definition rather than
     * inventing one.
     */
    const activeSessionId = (ctx) => {
      try {
        const byId = ctx.sessions?.list?.getSnapshot?.()?.byId;
        if (!byId) return "";
        for (const [id, row] of Object.entries(byId)) {
          if ((row?.retainedBy?.mainView ?? 0) > 0) return id;
        }
      } catch {
        // Snapshot unavailable during startup or teardown: report nothing.
      }
      return "";
    };

    /**
     * @param ctx - client context; uiWorkspace and sessions are injected.
     */
    function apply(ctx) {
      let stopped = false;
      let inFlight = false;

      const reportOutcome = (payload) => {
        try {
          fetch("api/dsh-notify/jump/outcome", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            cache: "no-store",
          }).catch(() => {});
        } catch {}
      };

      const reportActive = (sessionId) => {
        try {
          fetch(ACTIVE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId }),
            cache: "no-store",
          }).catch(() => {});
        } catch {}
      };

      const poll = async () => {
        // Overlapping polls would double-consume the take-once slot and make
        // a slow host look like two jump requests.
        if (stopped || inFlight) return;
        inFlight = true;
        try {
          // Report first: the Host needs the current session to decide whether
          // an incoming request is already on screen.
          reportActive(activeSessionId(ctx));

          const response = await fetch(PENDING, { cache: "no-store" });
          if (!response.ok) return;
          const body = await response.json();
          const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
          if (sessionId === "") return;
          // Unknown ids throw synchronously (the session may have been
          // archived between the notification and the click). A failed jump
          // must never break the poll loop, so it is contained here.
          // uiWorkspace is reachable only while this plugin's context is active;
          // the service is torn down during navigation. Asking for it then throws
          // "cannot get required service uiWorkspace in inactive context", which
          // is transient and self-heals on the next tick — so a jump that lands
          // in that window is retried by simply leaving the slot unconsumed is
          // not possible (the Host hands it out once), which is why this is
          // reported rather than silently swallowed.
          const workspace = ctx.uiWorkspace ?? (typeof ctx.get === "function" ? ctx.get("uiWorkspace") : undefined);
          if (!workspace || typeof workspace.openSession !== "function") {
            reportOutcome({
              sessionId,
              result: "threw",
              error: "uiWorkspace unavailable (inactive context); jump dropped",
            });
            return;
          }
          try {
            workspace.openSession(sessionId);
            // Report success too: "the page switched" and "openSession threw"
            // look identical from the Host, and a minimized window is exactly
            // the case where the user cannot see which one happened.
            reportOutcome({ sessionId, result: "ok" });
          } catch (error) {
            console.warn("[dsh-notify-focus] openSession failed:", sessionId, error);
            reportOutcome({ sessionId, result: "threw", error: String(error?.message ?? error) });
          }
        } catch {
          // Host gone, page navigating, or route not mounted yet: retry next tick.
        } finally {
          inFlight = false;
        }
      };

      const timer = setInterval(poll, POLL_MS);
      poll();

      // A restored window should react at once instead of waiting for the next
      // tick: clicking a toast is exactly the moment the page regains focus.
      const onVisible = () => {
        if (document.visibilityState === "visible") poll();
      };
      document.addEventListener("visibilitychange", onVisible);
      window.addEventListener("focus", poll);

      return () => {
        stopped = true;
        clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("focus", poll);
      };
    }

    exports.name = "dsh-notify-focus";
    exports.inject = ["uiWorkspace", "sessions"];
    exports.apply = apply;
    return module.exports;
  },
});
