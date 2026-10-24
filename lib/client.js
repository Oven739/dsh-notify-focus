// dsh-notify-focus -- browser half.
//
// Why this file exists: the Host half can focus the DSH window but cannot
// change which conversation it shows. DSH's frontend never reads the
// ?session= query parameter, so the only way to land on the exact session is
// to call the client-side navigation service from inside the page.
//
// The Host half exposes two same-origin routes; this half polls the pending
// one and hands the id to uiWorkspace. Same-origin (a relative path) keeps it
// free of CORS and of any assumption about the GUI port.
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

    const POLL_MS = 1000;
    // No leading slash: the page runs under the dsh-app:// scheme and the
    // shipped plugins poll with a bare relative path (task-board uses
    // fetch("api/task-board/verification")). A leading slash resolved to a
    // host-absolute URL that the shell rejected with 400 before any handler ran.
    const PENDING = "api/dsh-notify/jump/pending";

    /**
     * @param ctx - client context; uiWorkspace is injected by name.
     */
    function apply(ctx) {
      let stopped = false;
      let inFlight = false;

      const poll = async () => {
        // Overlapping polls would double-consume the take-once slot and make
        // a slow host look like two jump requests.
        if (stopped || inFlight) return;
        inFlight = true;
        try {
          const response = await fetch(PENDING, { cache: "no-store" });
          if (!response.ok) return;
          const body = await response.json();
          const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
          if (sessionId === "") return;
          // Unknown ids throw synchronously (the session may have been
          // archived between the notification and the click). A failed jump
          // must never break the poll loop, so it is contained here — and
          // reported, because otherwise a swallowed error looks exactly like a
          // jump that never arrived.
          try {
            ctx.uiWorkspace.openSession(sessionId);
          } catch (error) {
            // A stale id (archived between the notification and the click) is
            // expected; console-only so it never breaks the poll loop.
            console.warn("[dsh-notify-focus] openSession failed:", sessionId, error);
          }
        } catch {
          // Host gone, page navigating, or route not mounted yet: retry next tick.
        } finally {
          inFlight = false;
        }
      };

      const timer = setInterval(poll, POLL_MS);
      poll();

      return () => {
        stopped = true;
        clearInterval(timer);
      };
    }

    exports.name = "dsh-notify-focus";
    exports.inject = ["uiWorkspace"];
    exports.apply = apply;
    return module.exports;
  },
});
