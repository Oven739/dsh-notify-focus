// dsh-notify-focus — local fork of dsh-notify-windows: a Windows toast
// notification plugin for DeepSeek Harness that stays silent while the host
// window is focused (see skipWhenHostFocused below).
//
// Upstream behaviour: send a Windows toast notification
// whenever the agent needs the user's attention:
//   - turn/end          — a task completed, failed, or was cut off (with an
//                         optional excerpt of the agent's final reply);
//   - approval/asked    — a permission approval is waiting (only when the
//                         session's effective approval policy is "ask");
//   - tool/call         — the agent called the ask_user_question tool (directly
//                         or inside a run_code program) and is waiting.
//
// Click-to-open: when enabled (default) and a session is available, the toast
// becomes clickable and opens the DSH web GUI (preferring an already-open
// browser/App window) deep-linked to that conversation. Disable with
// openOnClick:false or omit the session to keep the legacy non-clickable toast.
//
// Goal rounds (/goal auto-continuation) are quiet by default: only the final
// round that completes or blocks the goal produces a toast.
//
// Wording is localizable: `locale` selects a built-in message pack (MESSAGES —
// "zh" by default, "en" and "ru" also ship) and `messages` overrides individual
// strings on top of it. The default pack keeps the original text, so an install
// that sets neither key behaves exactly as before.
//
// Zero runtime dependencies: notifications go through the toast sender
// script (./notify.ps1) executed by Windows PowerShell 5.1, whose .NET
// Framework runtime supports the WinRT toast API.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecisionRegistry, VERDICTS } from "./decision-registry.mjs";
import { startDecisionChannel } from "./decision-channel.mjs";
import { createFocusGate } from "./focus-gate.mjs";
import { fileURLToPath } from "node:url";

const NOTIFY_SCRIPT = fileURLToPath(new URL("./notify.ps1", import.meta.url));
// Button-capable sender. Kept separate from notify.ps1 so the plain path keeps
// its exact upstream behaviour and can be diffed against it.
const NOTIFY_ACTIONS_SCRIPT = fileURLToPath(new URL("./notify-actions.ps1", import.meta.url));
// Synchronous "is the host in the foreground?" probe used to decide whether an
// approval may be parked (see CONTEXT.md constraint 1).
const FOREGROUND_PROBE_SCRIPT = fileURLToPath(new URL("./foreground-probe.ps1", import.meta.url));
const VERSION = "0.7.8";

// Foreground suppression, modelled on ZCode's desktop client
// (packages/desktop/src/main/desktopNotifications.ts): it refuses to notify at
// all when any app window is focused, because the user is already looking at
// the approval/question UI and a system toast would only cover it.
//
// ZCode can call BrowserWindow.isFocused(); a DSH plugin cannot, so the same
// decision is made in notify.ps1 from the host's own pid and image name
// (GetForegroundWindow + GetWindowThreadProcessId). This process IS the host,
// so getpid() identifies it exactly, and the image name adds robustness when
// the foreground window belongs to a sibling process of the same app.
const HOST_PID = process.pid;
const HOST_IMAGE = (() => {
  try {
    const base = process.execPath.split(/[\\/]/).pop() ?? "";
    return base.replace(/\.exe$/i, "");
  } catch {
    return "";
  }
})();

// Convert a script path so powershell.exe can read it.
//   - On WSL: powershell.exe is a Windows process and can't read Linux paths
//     (e.g. /home/.../notify.ps1). wslpath -w rewrites it to a UNC path
//     (\\wsl.localhost\...) that Windows can access.
//   - On native Windows: wslpath does not exist, spawnSync fails with a
//     non-zero status, and we fall back to the original path unchanged, so
//     the native-Windows behaviour is preserved exactly.
const winPath = (p) => {
  const r = spawnSync("wslpath", ["-w", p], { encoding: "utf8" });
  return r.status === 0 && r.stdout ? r.stdout.trim() : p;
};

// NOTIFY_SCRIPT never changes, so the (synchronous) wslpath conversion is
// done once and cached instead of on every toast.
const NOTIFY_SCRIPT_WIN = winPath(NOTIFY_SCRIPT);
const NOTIFY_ACTIONS_SCRIPT_WIN = winPath(NOTIFY_ACTIONS_SCRIPT);
const FOREGROUND_PROBE_WIN = winPath(FOREGROUND_PROBE_SCRIPT);

// Resolve powershell.exe without relying on PATH alone.
//   - WSL: the standard Windows location is always readable via /mnt/c, even
//     when DSH runs under systemd/cron/ssh with a minimal PATH that lacks the
//     Windows directories (spawn("powershell.exe") would then fail with ENOENT
//     and every notification would be lost).
//   - Native Windows: /mnt/c does not exist, so we fall back to PATH lookup
//     ("powershell.exe"), which is the standard behaviour.
const WSL_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const resolvePowerShell = () => (existsSync(WSL_POWERSHELL) ? WSL_POWERSHELL : "powershell.exe");
const POWERSHELL = resolvePowerShell();

/**
 * Built-in toast message packs.
 *
 * The keys serve two purposes at once. The turn/end reason kinds (`completed`,
 * `error`, `max-tokens`, `aborted`, `interrupted`, `blocked`) are looked up
 * directly by `reason.kind`, so every pack must carry one entry per reason;
 * the remaining keys hold the surrounding toast and log wording.
 *
 * `zh` is the original wording and stays the default, so an existing install
 * sees no change after upgrading. `en` and `ru` are complete packs. Any pack
 * can be partially overridden per install through the `messages` config.
 * `{placeholder}` tokens are substituted by `format()`.
 */
export const MESSAGES = {
  zh: {
    // turn/end reason kinds
    completed: "任务已完成",
    error: "任务出错",
    "max-tokens": "输出达到 token 上限",
    aborted: "任务已取消",
    interrupted: "任务中断",
    blocked: "任务未开始",
    // turn/end wording
    turnEnded: "任务已结束",
    turnSuffix: "（第 {turn} 轮）",
    // approval/asked wording
    approvalTitle: " · 需要审批",
  allowButton: "允许一次",
  denyButton: "拒绝",
    approvalToolWithReason: "工具 {tool}：{reason}",
    approvalTool: "工具 {tool}",
    approvalGeneric: "有一项操作等待你的批准",
    // ask_user_question wording
    askTitle: " · 需要回答",
    askFallback: "Agent 正在等待你的确认",
    // activation toast
    activated: "任务完成提醒已激活（v{version}）",
    // logger messages (the "dsh-notify:" tag stays untranslated, so logs
    // remain greppable across locales)
    warnSpawnFailed: "启动通知进程失败",
    warnToastFailed: "通知进程未成功显示 toast",
    warnExitCode: "（退出码 {code}）",
    warnChannelUnavailable: "通知通道不可用（powershell.exe 或 notify.ps1 缺失），桌面通知将不会发送",
  },
  en: {
    completed: "Task completed",
    error: "Task errored",
    "max-tokens": "Output reached the token cap",
    aborted: "Task cancelled",
    interrupted: "Task interrupted",
    blocked: "Task not started",
    turnEnded: "Task ended",
    turnSuffix: " (turn {turn})",
    approvalTitle: " · Needs approval",
  allowButton: "Allow once",
  denyButton: "Deny",
    approvalToolWithReason: "tool {tool}: {reason}",
    approvalTool: "tool {tool}",
    approvalGeneric: "An operation is waiting for your approval",
    askTitle: " · Needs your answer",
    askFallback: "The agent is waiting for your confirmation",
    activated: "Task-completion reminders activated (v{version})",
    warnSpawnFailed: "failed to start the notification process",
    warnToastFailed: "the notification process did not show a toast",
    warnExitCode: " (exit code {code})",
    warnChannelUnavailable: "notification channel unavailable (powershell.exe or notify.ps1 missing); desktop toasts will not be sent",
  },
  ru: {
    completed: "Задача завершена",
    error: "Ошибка в задаче",
    "max-tokens": "Достигнут лимит токенов",
    aborted: "Задача отменена",
    interrupted: "Задача прервана",
    blocked: "Задача не начата",
    turnEnded: "Задача завершена",
    turnSuffix: " (раунд {turn})",
    approvalTitle: " · Требуется одобрение",
  allowButton: "Разрешить",
  denyButton: "Отклонить",
    approvalToolWithReason: "Инструмент {tool}: {reason}",
    approvalTool: "Инструмент {tool}",
    approvalGeneric: "Одна операция ожидает вашего одобрения",
    askTitle: " · Требуется ответ",
    askFallback: "Агент ждёт вашего подтверждения",
    activated: "Напоминания о задачах активированы (v{version})",
    warnSpawnFailed: "не удалось запустить процесс уведомления",
    warnToastFailed: "не удалось показать тост",
    warnExitCode: " (код выхода {code})",
    warnChannelUnavailable: "канал уведомлений недоступен (нет powershell.exe или notify.ps1); тосты отправляться не будут",
  },
};

/**
 * Substitute `{name}` tokens with `params.name`. An unknown token is left
 * verbatim rather than blanked, so a typo in an override stays visible in the
 * toast instead of silently dropping text.
 */
function format(template, params) {
  if (typeof template !== "string") return "";
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match,
  );
}

/**
 * Resolve the effective message pack: the selected locale (an unknown locale
 * falls back to the default pack rather than leaving the toast empty), then
 * the install's own `messages` overrides on top.
 *
 * A non-string override is ignored: it could only ever produce "[object
 * Object]" in a toast, and silently dropping it is better than leaking it.
 */
export function resolveMessages(config = {}) {
  // An unknown locale falls back to the default pack. `Object.hasOwn` (not a
  // bare index) is required: a locale naming an Object.prototype member
  // ("constructor", "toString", "__proto__", …) would otherwise resolve to a
  // function, spread into an empty pack, and render a literal "undefined" body.
  const base = Object.hasOwn(MESSAGES, config.locale) ? MESSAGES[config.locale] : MESSAGES.zh;
  const resolved = { ...base };
  const overrides = config.messages;
  if (overrides && typeof overrides === "object") {
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === "string") resolved[key] = value;
    }
  }
  return resolved;
}

export const name = "dsh-notify-focus";

// NOTE: no top-level `inject`.
//
// A top-level `export const inject = [...]` was added for the session-jump
// routes and it broke the approval waterfall: after that change the plugin kept
// receiving `session/event` (the audit line still appeared) but never received
// `approval/request` again, so approvals stopped being parked and the Allow /
// Deny buttons disappeared. Verified against the log: the last
// `waterfall-seen` is 10-24 07:50, and `jump-routes-unavailable (cannot get
// property connection without inject)` is 10-24 08:52.
//
// The jump routes now take `webServer` through a scoped ctx.inject inside
// apply(), so the listener registrations are not gated on any service.

function truncate(text, max) {
  if (typeof text !== "string") return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/** First question text of an ask_user_question tool call, if parseable. */
function extractAskQuestion(argumentsJson) {
  try {
    const parsed = JSON.parse(argumentsJson);
    const first = Array.isArray(parsed?.questions) ? parsed.questions[0] : undefined;
    return typeof first?.question === "string" ? first.question : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This deployment invokes every tool through run_code programs, so a real
 * question never appears as a model-level ask_user_question tool call.
 * Detect the nested call inside a run_code program's code and pull out the
 * first question text.
 */
function extractQuestionFromCode(argumentsJson) {
  try {
    const parsed = JSON.parse(argumentsJson);
    const code = typeof parsed?.code === "string" ? parsed.code : "";
    const callIndex = code.search(/tools\.ask_user_question\s*\(/);
    if (callIndex < 0) return undefined;
    const region = code.slice(callIndex, callIndex + 8000);
    const matches = [...region.matchAll(/question\s*:\s*["']([^"']{2,200})["']/g)];
    return matches.length > 0 ? matches[0][1] : undefined;
  } catch {
    return undefined;
  }
}

/** First non-empty text block of a message, trimmed. */
function textOfMessage(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return undefined;
  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) return block.text.trim();
  }
  return undefined;
}

/**
 * Read a session's event log across DSH generations.
 *
 * DSH stopped exposing the public `session.events` property in 0.1.2-alpha.4
 * (0.1.2-alpha.3 and earlier still had `get events()`); from there on history
 * is read on demand through `snapshotEvents()`, which returns
 * `readonly SessionEvent[]`. Prefer the legacy property so those older DSH
 * builds stay supported, then fall back to the new accessor.
 *
 * A host-side read failure must degrade to "no history" rather than throw:
 * losing the excerpt or the goal-round check is acceptable, but breaking the
 * notification path is not. The degradation is reported through
 * `onUnavailable` so it never disappears without a trace again.
 *
 * DSH 0.1.6+ deprecation deferral: `Session.snapshotEvents()` (with `eventAt()`
 * and `ownEvents()`) is marked `@deprecated` from 0.1.6-alpha.1 and restated in
 * the 0.1.7-rc.1 release notes — "new production calls are prohibited", while
 * "existing logic may remain unmigrated for now". This reader is existing
 * logic and keeps the deprecated accessor deliberately: the notification
 * excerpt / `/goal` round check only need the current turn's tail, and DSH
 * still retains the complete event sequence in memory, so no rewrite is
 * required to keep working on 0.1.7-rc.1. Revisit only when DSH ships the
 * async paged-read replacement. See the official Agent Note
 * `.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`.
 */
export function sessionEvents(session, onUnavailable) {
  // Reporting must never break the notification path either: a throwing
  // `onUnavailable` would otherwise escape into the turn/end handler.
  const report = (reason) => {
    try {
      onUnavailable?.(reason, session);
    } catch {
      // diagnostics must never break the notify path
    }
  };
  const legacy = session?.events;
  if (Array.isArray(legacy)) return legacy;
  try {
    const snapshot = session?.snapshotEvents?.();
    if (Array.isArray(snapshot)) return snapshot;
  } catch (error) {
    report("snapshotEvents() threw: " + String(error?.message ?? error));
    return [];
  }
  report("session exposes neither events nor snapshotEvents()");
  return [];
}

/**
 * Scan the session log from the turn/end event back to its turn/start and
 * collect what the notification needs: the driving user message's source,
 * every goal/change operation in the window, and the last assistant reply
 * text (for the excerpt).
 */
function turnWindow(session, turnEnd, onUnavailable) {
  const events = sessionEvents(session, onUnavailable);
  const turn = turnEnd?.data?.turn;
  let endIndex = events.length - 1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.seq === turnEnd?.seq) { endIndex = i; break; }
  }
  let userSource;
  const goalOps = [];
  let lastAssistantText;
  for (let i = endIndex; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) continue;
    if (event.type === "turn/start" && event.data?.turn === turn) break;
    // Every user/message in the window overwrites: walking backwards, the
    // final value is the FIRST message of the turn — the driving input.
    if (event.type === "user/message" && event.data?.source) userSource = event.data.source;
    if (event.type === "goal/change" && event.data?.operation) goalOps.push(event.data.operation);
    if (event.type === "assistant/message" && event.data?.turn === turn && lastAssistantText === undefined) {
      const text = textOfMessage(event.data.message);
      if (text) lastAssistantText = text;
    }
  }
  return { userSource, goalOps, lastAssistantText };
}

export const apply = (ctx, config = {}) => {
  const cfg = {
    enabled: true,
    reasons: ["completed", "error", "max-tokens"],
    locale: "zh", // built-in pack: "zh" (default) | "en" | "ru"
    messages: {}, // per-key overrides applied on top of the locale pack
    includeSubagents: false,
    notifyOnStart: false,
    notifyOnApproval: true,
    notifyOnAskUser: true,
    notifyOnGoalRounds: false,
    excerpt: true,
    excerptMaxChars: 80,
    appName: "DeepSeek Harness",
    aumid: "DeepSeekHarness.Notify",
    log: true,
    debug: false,
    // Click-to-open feature (v0.7.0):
    openOnClick: true, // when false: never make toasts clickable (never pass -Url)
    preferExisting: true, // true -> -LaunchProtocol 1 (launcher, prefer existing window); false -> 0 (plain open)
    webUrl: "", // manual override of the web GUI base; empty = auto-discover
    // Foreground suppression (v0.8.2-focus). Mirrors ZCode's desktop client,
    // which sends no notification at all while the app window is focused:
    // the user is already looking at the approval/question UI and a toast
    // would cover it. Set false to restore unconditional toasts.
    skipWhenHostFocused: true,
    // Also match by image name, covering a foreground window owned by a
    // sibling process of the same app (Electron main vs. renderer hosts).
    skipWhenHostFocusedByName: true,
    // Decision buttons (v0.9). When enabled, an approval (or a live question)
    // that arrives while the host is NOT in the foreground is parked and sent
    // as a toast carrying Allow/Deny. While the host IS focused the request is
    // handed straight to the browser, because parking would hide the prompt.
    buttonsEnabled: true,
    // How long a parked decision stays answerable before the waterfall is
    // handed back downstream. Must stay well under the host's own approval
    // patience; a stale toast simply falls back to opening the GUI.
    decisionTtlMs: 10 * 60 * 1000,
    // How long the approval audit event waits before deciding whether the
    // waterfall already announced this request (see the handler for why).
    approvalDedupeDelayMs: 400,
    // "Form two": let a toast click land on the exact conversation rather than
    // only bringing the window forward. Requires the browser half (client.js);
    // with it off the plugin behaves as "form one".
    jumpEnabled: true,
    ...config,
  };
  const reasons = new Set(cfg.reasons);
  const t = resolveMessages(cfg);
  const logPath = join(tmpdir(), "dsh-notify", "notify.log");

  const log = (entry) => {
    if (!cfg.log) return;
    try {
      mkdirSync(join(tmpdir(), "dsh-notify"), { recursive: true });
      appendFileSync(logPath, JSON.stringify({ time: Date.now(), ...entry }) + "\n");
    } catch {
      // diagnostics must never break the agent loop
    }
  };

  /** Report a history-read degradation instead of silently losing the excerpt. */
  const historyUnavailable = (reason, session) =>
    log({ event: "history-unavailable", reason, sessionId: session?.id });

  // Authoritative base URL discovery (verified against rc.8).
  // Always loopback: ctx.webServer.host may be 0.0.0.0, which is not a valid
  // browser target. Use the actual bound port (correct even when config port=0).
  const webBaseUrl = () => {
    if (cfg.webUrl) return cfg.webUrl.replace(/\/+$/, "");
    try {
      const port = ctx.get?.("webServer")?.port; // actual bound port
      if (Number.isInteger(port) && port > 0) return "http://127.0.0.1:" + port;
    } catch {
      // fall through to documented default
    }
    return "http://127.0.0.1:3080"; // documented default (dsh-web-app patch.yml)
  };

  // Per-session deep link. rc.8 ignores the ?session= query but it is harmless
  // and future-proof for frontends that want to jump straight to a conversation.
  const conversationUrl = (sessionId) => {
    const base = webBaseUrl();
    if (!sessionId) return base + "/";
    return base + "/?session=" + encodeURIComponent(sessionId);
  };

  // ---------------------------------------------------------------------
  // Decision buttons (v0.9). See CONTEXT.md: the waterfall is serial, so
  // parking hides the prompt from the browser. Park ONLY when the host is not
  // in the foreground, i.e. when the user is demonstrably away.
  // ---------------------------------------------------------------------
  const registry = createDecisionRegistry({
    ttlMs: cfg.decisionTtlMs,
    onExpire: (token, meta) => {
      log({ event: "decision-expired", token, sessionId: meta?.sessionId ?? null });
      meta?.handBack?.();
    },
  });

  // The WinRT/USER32 probe costs ~1.1 s (PowerShell 5.1 startup dominates),
  // which is far too slow to run inline on the approval waterfall. A background
  // sampler keeps a recent reading and the waterfall reads that cached value.
  //
  // The gate itself lives in ./focus-gate.mjs because it is the exact logic a
  // bug turned into "approvals never park": a failed or empty probe used to be
  // recorded as a background sample. That module has regression tests; this
  // call site only supplies the probe and the log sink.
  let lastFocusFingerprint = "";
  const focusGate = createFocusGate({
    enabled: cfg.buttonsEnabled,
    skipWhenFocused: cfg.skipWhenHostFocused,
    probe: () => {
      const probeArgs = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", FOREGROUND_PROBE_WIN, "-HostPid", String(HOST_PID)];
      if (HOST_IMAGE) probeArgs.push("-Name", HOST_IMAGE);
      const r = spawnSync(POWERSHELL, probeArgs, { encoding: "utf8", windowsHide: true, timeout: 8000 });
      // Only record a probe that produced an UNUSABLE answer. The sampler runs
      // every five seconds, so logging every success would grow notify.log by
      // thousands of lines a day while saying nothing new.
      const stdout = (r.stdout ?? "").trim();
      if (r.error || stdout === "") {
        log({
          event: "focus-probe-unusable",
          pid: HOST_PID,
          image: HOST_IMAGE || null,
          status: r.status,
          signal: r.signal ?? null,
          error: r.error ? String(r.error.code ?? r.error.message) : null,
          stdout: stdout.slice(0, 40),
          stderr: (r.stderr ?? "").trim().slice(0, 160),
        });
        return null;                       // spawn denied, timed out, or silent
      }
      return /(^|\s)fg(\s|$)/.test(stdout) ? "fg" : "bg";
    },
    onSample: (sample) => {
      // Log transitions only. A steady "focused" every five seconds is noise;
      // what matters for diagnosis is when the answer changes.
      const fingerprint = sample.kind === "sampled" ? "sampled:" + sample.focused : sample.kind;
      if (fingerprint === lastFocusFingerprint) return;
      lastFocusFingerprint = fingerprint;
      log({ event: "focus-" + sample.kind, ...sample });
    },
  });

  /** True when the prompt must go to the browser instead of being parked. */
  const hostFocused = () => focusGate.shouldHandToBrowser();

  const channel = { stop: () => {}, port: 0, secret: "" };
  const startChannel = async () => {
    const started = await startDecisionChannel(
      (token, verdict) => registry.settle(token, verdict),
      log,
      {
        // The launcher posts a session id here after focusing the window. It
        // shares the decision endpoint's secret because an external process has
        // no browser cookie, and DSH's own fetch routes require one (401).
        onJump: (sessionId) => {
          pendingJump = sessionId;
          log({ event: "jump-offered", sessionId });
        },
      },
    );
    channel.port = started.port;
    channel.secret = started.secret;
    channel.stop = started.stop;
  };
  // ---------------------------------------------------------------------
  // Session jump queue (v0.9 "form two").
  //
  // The launcher can only bring the window forward: DSH's frontend ignores the
  // ?session= query parameter entirely, so nothing in the URL changes which
  // conversation is shown. The browser half of this plugin polls these
  // same-origin routes and calls ctx.uiWorkspace.openSession() instead.
  //
  // One slot, latest wins: two rapid notifications should land on the newest
  // request, not replay a queue.
  // ---------------------------------------------------------------------
  let pendingJump = null;

  // Which session the UI is currently showing, reported by the browser half.
  //
  // The Host cannot see the page, so "is the user looking at this?" was only
  // answerable per-app: any request raised while DSH was in the foreground was
  // suppressed, even when the user was reading a DIFFERENT conversation. This
  // value closes that gap. Empty means "unknown" and falls back to the old
  // app-level answer.
  let mainViewSessionId = "";
  let mainViewReportedAt = 0;
  const ACTIVE_SESSION_STALE_MS = 10_000;
  // The client reports an empty id whenever no session is retained by the main
  // view — which happens for a moment on every panel switch and re-render
  // (measured: alternating id/empty every second). Treating those blips as
  // "the user is looking at nothing" made every request look un-seen and let
  // notifications through while the very session was on screen. A blank report
  // is therefore remembered as "unknown", not as "nothing is open".
  let lastKnownSessionId = "";

  /** True when the UI is showing this exact session right now. */
  const isOnScreen = (sessionId) => {
    if (typeof sessionId !== "string" || sessionId === "") return false;
    if (Date.now() - mainViewReportedAt > ACTIVE_SESSION_STALE_MS) return false;
    const current = mainViewSessionId !== "" ? mainViewSessionId : lastKnownSessionId;
    if (current === "") return false;
    return current === sessionId;
  };

  const sendJson = (res, status, body) => {
    const text = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    // The page runs under the dsh-app:// scheme and polls once a second; a
    // cached reply would strand the jump, so it must never be stored.
    res.setHeader("cache-control", "no-store");
    res.end(text);
  };

  // Jump routes need `webServer`, but that dependency must not leak onto the
  // waterfall listener. A scoped ctx.inject keeps the wait local to this setup
  // callback: if the service never arrives, jumping is unavailable while
  // approvals keep working.
  const registerJumpRoute = () => {
    if (typeof ctx.inject !== "function") {
      log({ event: "jump-routes-unavailable", message: "ctx.inject unavailable" });
      return;
    }
    ctx.inject(["webServer"], (webCtx) => registerJumpRoutesOn(webCtx));
  };

  const registerJumpRoutesOn = (webCtx) => {
    try {
      // webServer.register is the route surface the shipped plugins use
      // (open-in-app, client-hmr, client-modules). connection.fetch.register is
      // a different, page-facing API: the browser's request under dsh-app:// was
      // rejected with 400 before it ever reached a handler.
      webCtx.webServer.register({
        kind: "exact",
        path: "/api/dsh-notify/jump/pending",
        handler: async (req, res) => {
          if (req.method !== "GET") {
            sendJson(res, 405, { ok: false, error: "method-not-allowed" });
            return;
          }
          const sessionId = pendingJump;
          pendingJump = null; // take-once: a lost response just means no jump
          if (sessionId) log({ event: "jump-consumed", sessionId });
          sendJson(res, 200, { sessionId });
        },
      });

      // The browser half reports whether openSession actually ran. From the
      // Host, "the page switched" and "openSession threw" look identical, and a
      // minimized window hides the difference from the user too.
      webCtx.webServer.register({
        kind: "exact",
        path: "/api/dsh-notify/jump/outcome",
        handler: async (req, res) => {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: "method-not-allowed" });
            return;
          }
          try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            log({
              event: "jump-outcome",
              sessionId: typeof body?.sessionId === "string" ? body.sessionId : null,
              result: typeof body?.result === "string" ? body.result : null,
              error: typeof body?.error === "string" ? body.error.slice(0, 200) : null,
            });
          } catch {}
          sendJson(res, 204, {});
        },
      });

      // The browser half reports what the main view is showing, once a second.
      webCtx.webServer.register({
        kind: "exact",
        path: "/api/dsh-notify/active-session",
        handler: async (req, res) => {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: "method-not-allowed" });
            return;
          }
          try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const raw = Buffer.concat(chunks).toString("utf8");
            const body = raw === "" ? {} : JSON.parse(raw);
            const next = typeof body?.sessionId === "string" ? body.sessionId : "";
            // Log transitions only: this arrives every second and a steady
            // value would drown the log.
            // Log only real conversation switches. The id<->blank flicker is a
            // rendering artefact and used to write two lines every second.
            const prevEffective = mainViewSessionId !== "" ? mainViewSessionId : lastKnownSessionId;
            const nextEffective = next !== "" ? next : lastKnownSessionId;
            if (nextEffective !== prevEffective) {
              log({ event: "main-view", from: prevEffective || null, to: nextEffective || null });
            }
            mainViewSessionId = next;
            // Remember the last non-blank answer: the blank reports are
            // re-render blips, not the user closing everything.
            if (next !== "") lastKnownSessionId = next;
            mainViewReportedAt = Date.now();
          } catch {
            // A malformed report must never break the poll loop on the other side.
          }
          sendJson(res, 204, {});
        },
      });
    } catch (error) {
      // Older hosts without this API simply do not get session jumping.
      log({ event: "jump-routes-unavailable", message: String(error?.message ?? error) });
    }
  };
  if (cfg.jumpEnabled) registerJumpRoute();

  if (cfg.buttonsEnabled) {
    focusGate.sampleOnce();
    const focusTimer = setInterval(() => focusGate.sampleOnce(), 5_000);
    focusTimer.unref?.();
    void startChannel();
    // The endpoint file holds a live secret; remove it when the plugin unloads
    // so a launcher that fires later fails closed instead of posting to a port
    // that no longer belongs to this host.
    try {
      ctx.effect?.(() => () => channel.stop(), "dsh-notify: decision channel");
    } catch {
      // Older hosts without ctx.effect simply leak the file until temp cleanup.
    }
  }

  const sendToast = (title, body, opts = {}) => {
    // Every toast is recorded at origin. Without this, a toast that is skipped
    // for foreground suppression leaves ONLY the "skipped-foreground" line, and
    // the caller that produced it is indistinguishable from a caller that never
    // ran — which is exactly how a missing approval button looked.
    log({
      event: "toast-sent",
      sessionId: opts?.sessionId ?? null,
      actionable: typeof opts?.token === "string" && opts.token !== "",
      onScreen: opts?.onScreen ?? null,
      title: String(title ?? "").slice(0, 80),
    });
    // A decision toast uses the action-capable sender; every other toast keeps
    // the upstream script verbatim.
    const actionable = typeof opts?.token === "string" && opts.token !== "";
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      actionable ? NOTIFY_ACTIONS_SCRIPT_WIN : NOTIFY_SCRIPT_WIN,
      "-Title",
      title,
      "-Body",
      body,
      "-Aumid",
      cfg.aumid,
      "-AppName",
      cfg.appName,
    ];
    if (actionable) {
      args.push(
        "-Token", opts.token,
        "-AllowLabel", t.allowButton,
        "-DenyLabel", t.denyButton,
      );
    }
    const sessionId = opts?.sessionId;
    if (cfg.openOnClick && sessionId) {
      const url = conversationUrl(sessionId);
      args.push("-Url", url, "-LaunchProtocol", cfg.preferExisting ? 1 : 0);
    }
    // Foreground suppression, now scoped to the session instead of the app.
    //
    // notify.ps1 skips the toast when the given pid owns the foreground window,
    // which protected the approval/question panel from being covered. That test
    // is app-level, so it also suppressed a notification for conversation B
    // while conversation A was on screen.
    //
    // Passing the pid only when THIS session is the one being read keeps the
    // original protection and drops the collateral silencing. opts.onScreen
    // is the caller's per-session answer; absent means "assume on screen" so an
    // unknown state never springs a surprise toast over the panel in use.
    const suppressForFocus = cfg.skipWhenHostFocused && (opts?.onScreen ?? true);
    if (suppressForFocus) {
      args.push("-ForegroundPid", String(HOST_PID));
      if (cfg.skipWhenHostFocusedByName && HOST_IMAGE) {
        args.push("-ForegroundName", HOST_IMAGE);
      }
    }
    // Capture output: PowerShell 5.1 exits 0 even when -File cannot load the
    // script (e.g. a Linux path that was never converted), so the exit code
    // alone cannot tell success from failure. notify.ps1 prints "toast shown"
    // only after the WinRT Show() call returns, which is our success marker.
    const child = spawn(POWERSHELL, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      log({ event: "error", message: String(error?.message ?? error) });
      ctx.logger?.warn?.("dsh-notify: " + t.warnSpawnFailed, error);
    });
    child.on("exit", (code) => {
      if (/skipped foreground/.test(stdout)) {
        log({ event: "skipped-foreground", sessionId, token: opts?.token ?? null });
        return;
      }
      if (actionable) {
        log({ event: "toast-actionable", shown: /toast shown/.test(stdout), code, token: opts.token });
      }
      const shown = /toast shown/.test(stdout);
      if (code !== 0 || !shown) {
        log({
          event: "error",
          code,
          shown,
          stdout: stdout.slice(0, 500),
          stderr: stderr.slice(0, 500),
        });
        ctx.logger?.warn?.("dsh-notify: " + t.warnToastFailed + (code !== null ? format(t.warnExitCode, { code }) : ""));
      }
    });
  };

  const titleFor = (session) => {
    try {
      return ctx.sessionTitle?.get?.(session)?.title;
    } catch {
      return undefined;
    }
  };

  /** Session id behind an approval request, for the toast deep link. */
  const sessionIdOf = (request) => {
    try {
      return request?.agent?.session?.id ?? request?.agent?.sessionId ?? undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * Cap how many approvals we park at once.
   *
   * Every parked request is one the browser cannot show, so an unbounded park
   * would leave prompts invisible if this plugin misbehaved. Above the limit a
   * request is handed downstream instead: a visible card beats a lost one.
   */
  const MAX_PARKED = 3;
  const pendingApprovalThrottled = () => registry.size >= MAX_PARKED;

  /**
   * True for subagent sessions when subagents are excluded.
   *
   * DSH stamps `delegationDepth` on the session header: main sessions carry 0
   * (and, after a restart, the RESTORED header always includes it because the
   * persistence layer writes `delegationDepth ?? 0`), while subagent sessions
   * carry >= 1. Testing `!== undefined` therefore misclassifies every restored
   * main session as a subagent and silently kills all notifications after a
   * dsh web restart. Only depths >= 1 are real subagents.
   */
  const isFilteredSession = (session) => {
    if (cfg.includeSubagents) return false;
    return session?.header?.origin === "subagent" || (session?.header?.delegationDepth ?? 0) > 0;
  };

  /** Last approval/policy event of the session, or undefined (defaults to ask). */
  const effectivePolicy = (session) => {
    const events = sessionEvents(session, historyUnavailable);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === "approval/policy") return event.data?.policy;
    }
    return undefined;
  };

  // ---------------------------------------------------------------------
  // Approval waterfall consumer.
  //
  // The waterfall is SERIAL: whichever listener returns a value wins, and a
  // listener that holds without calling next() stops every later one — which
  // includes api-remotes, the component that shows the prompt in the browser.
  // So this listener may only park when the user is away; otherwise it hands
  // the request straight downstream and the normal approval card appears.
  // ---------------------------------------------------------------------
  ctx.on("approval/request", (request, next) => {
    // Reaching this line at all is the fact worth logging: it proves the host
    // dispatches the waterfall to plugin listeners. The upstream plugin only
    // listened to the log-only audit event, so a miss here is silent otherwise.
    log({
      event: "waterfall-seen",
      toolName: request?.toolName ?? null,
      buttonsEnabled: cfg.buttonsEnabled,
    });
    if (!cfg.enabled || !cfg.buttonsEnabled) return next();

    // Parking hides the prompt from the browser, so it is only allowed when the
    // user genuinely is not looking at this request. Two separate conditions:
    //
    //   - DSH in the foreground AND this exact session on screen  -> hand over
    //   - DSH in the foreground but a DIFFERENT session on screen -> park
    //
    // The second case is the reason the active-session report exists: without
    // it, reading conversation A silently swallowed every notification raised
    // by conversation B.
    const requestSessionId = sessionIdOf(request);
    if (hostFocused()) {
      if (isOnScreen(requestSessionId)) {
        log({
          event: "waterfall-handed-to-browser",
          toolName: request?.toolName ?? null,
          reason: "same-session-on-screen",
        });
        return next(); // the card is already in front of the user
      }
      log({
        event: "waterfall-parked-despite-focus",
        toolName: request?.toolName ?? null,
        requestSession: requestSessionId ?? null,
        onScreen: mainViewSessionId || null,
      });
      // fall through: a different conversation is on screen, so a toast helps
    }
    // A session whose policy auto-rejects never waits for a human, so there is
    // nothing to park (the policy check already ran before the waterfall).
    if (pendingApprovalThrottled()) return next();

    const sessionId = requestSessionId;
    const title = cfg.appName + t.approvalTitle;
    const label = typeof request?.toolName === "string" ? request.toolName : "";
    const body = label !== ""
      ? (typeof request?.reason === "string" && request.reason !== ""
        ? format(t.approvalToolWithReason, { tool: label, reason: truncate(request.reason, 100) })
        : format(t.approvalTool, { tool: label }))
      : t.approvalGeneric;

    const { token, settled } = registry.park({ sessionId, toolName: label });
    registry.onAbandoned(token, () => log({ event: "approval-resolved-elsewhere", token }));
    request?.signal?.addEventListener?.("abort", () => {
      // Host withdrew the request (cancelled, or answered in the browser).
      registry.abandon(token);
    }, { once: true });

    sendToast(title, body, { sessionId, token, onScreen: isOnScreen(sessionId) });
    // Remember that this approval already got a buttoned toast, so the
    // approval/asked audit event that follows does not toast it again.
    registry.markToasted(label);
    log({ event: "approval-parked", token, toolName: label, sessionId });

    return settled.then(
      (verdict) => (verdict === VERDICTS.allow ? "allowed-once" : "rejected"),
      () => next(),
    );
  });

  ctx.on("session/event", (session, event) => {
    if (!cfg.enabled) return;
    if (cfg.debug) {
      log({ event: "debug", type: event.type, name: event.data?.name ?? null, sessionId: session?.id });
    }
    if (isFilteredSession(session)) return;

    if (event.type === "turn/end") {
      const reason = event.data?.reason;
      if (typeof reason?.kind !== "string" || !reasons.has(reason.kind)) return;
      const window = turnWindow(session, event, historyUnavailable);

      // /goal 自动推进回合默认静默：仅在目标完成/阻塞的最终回合提醒。
      if (!cfg.notifyOnGoalRounds) {
        const isGoalRound = window.userSource?.kind === "goal" && window.userSource.round > 0;
        const terminal = window.goalOps.some((op) => op === "complete" || op === "block");
        if (isGoalRound && !terminal) return;
      }

      const title = titleFor(session) || cfg.appName;
      let body = t[reason.kind] ?? t.turnEnded;
      if (Number.isInteger(event.data.turn)) body += format(t.turnSuffix, { turn: event.data.turn });
      if (cfg.excerpt && window.lastAssistantText) {
        body += "\n" + truncate(window.lastAssistantText, cfg.excerptMaxChars);
      }
      sendToast(title, body, { sessionId: session?.id, onScreen: isOnScreen(session?.id) });
      const url = cfg.openOnClick && session?.id ? conversationUrl(session?.id) : undefined;
      log({
        event: "notify",
        sessionId: session?.id,
        reason: reason.kind,
        turn: event.data?.turn,
        title,
        body,
        ...(url ? { url } : {}),
      });
      return;
    }

    if (event.type === "approval/asked" && cfg.notifyOnApproval) {
      // Never notify when the session policy auto-rejects: nothing waits for
      // the user, so a toast would be noise.
      if (effectivePolicy(session) === "never") return;
      const data = event.data ?? {};
      const body = typeof data.toolName === "string"
        ? (typeof data.reason === "string" && data.reason.length > 0
          ? format(t.approvalToolWithReason, { tool: data.toolName, reason: truncate(data.reason, 100) })
          : format(t.approvalTool, { tool: data.toolName }))
        : t.approvalGeneric;
      const title = cfg.appName + t.approvalTitle;
      const url = cfg.openOnClick && session?.id ? conversationUrl(session?.id) : undefined;
      const auditEntry = {
        sessionId: session?.id,
        id: data.id,
        toolName: data.toolName,
        reason: data.reason,
        title,
        body,
        ...(url ? { url } : {}),
      };

      // Ordering, not racing: this audit event is appended BEFORE the approval
      // waterfall runs (measured ~29 ms earlier), so checking "was it already
      // toasted" here always answers no. Defer the decision by a short delay so
      // the waterfall listener — which can send a toast WITH buttons — gets its
      // first shot, then re-check.
      const toolName = String(data.toolName ?? "");
      const timer = setTimeout(() => {
        if (registry.wasToasted(toolName)) {
          // The waterfall parked this approval and already toasted it with
          // Allow/Deny; a second, buttonless toast for the same request would
          // only confuse which one the user should click.
          log({ event: "approval-toast-deduped", ...auditEntry });
          return;
        }
        sendToast(title, body, { sessionId: session?.id, onScreen: isOnScreen(session?.id) });
        log({ event: "approval", ...auditEntry });
      }, cfg.approvalDedupeDelayMs);
      timer.unref?.();
      return;
    }

    if (event.type === "tool/call" && cfg.notifyOnAskUser) {
      const data = event.data ?? {};
      let question;
      if (data.name === "ask_user_question") {
        question = extractAskQuestion(data.arguments);
      } else if (data.name === "run_code" && typeof data.arguments === "string" && data.arguments.includes("ask_user_question")) {
        question = extractQuestionFromCode(data.arguments);
      }
      if (question !== undefined || data.name === "ask_user_question") {
        const body = question ? truncate(question, 100) : t.askFallback;
        const title = cfg.appName + t.askTitle;
        // The case that started this: a question raised in conversation B while
        // conversation A is on screen. Session-aware suppression lets it through.
        const onScreen = isOnScreen(session?.id);
        sendToast(title, body, { sessionId: session?.id, onScreen });
        if (!onScreen && hostFocused()) {
          log({ event: "ask-user-shown-despite-focus", sessionId: session?.id ?? null });
        }
        const url = cfg.openOnClick && session?.id ? conversationUrl(session?.id) : undefined;
        log({
          event: "ask-user",
          sessionId: session?.id,
          question: question ?? null,
          title,
          body,
          ...(url ? { url } : {}),
        });
      }
      return;
    }
  });

  // Startup self-check: if the notification channel is broken (powershell.exe
  // unreachable or notify.ps1 missing), say so immediately instead of letting
  // every toast fail silently later.
  const channelOk = existsSync(NOTIFY_SCRIPT) && (POWERSHELL === "powershell.exe" || existsSync(POWERSHELL));
  log({
    event: "start",
    version: VERSION,
    enabled: cfg.enabled,
    reasons: [...reasons],
    powershell: POWERSHELL,
    notifyScript: NOTIFY_SCRIPT_WIN,
    channelOk,
    sessionId: null,
  });
  if (cfg.enabled && !channelOk) {
    ctx.logger?.warn?.("dsh-notify: " + t.warnChannelUnavailable);
  }
  if (cfg.enabled && cfg.notifyOnStart) {
    // Activation toast has no session: leave non-clickable (legacy behavior).
    sendToast(cfg.appName, format(t.activated, { version: VERSION }));
  }
}