// Portability guards for lib/forward.vbs (the toast-click forwarder).
//
// THE BUG THIS FILE EXISTS FOR
// forward.vbs used to hard-code the launcher's absolute path:
//
//   cmd = "... -File ""G:\DSH\dsh-notify-focus\lib\launcher.ps1"" """ & url
//
// On another machine, or after the repo moves, wscript starts the VBS, the VBS
// starts powershell with a -File path that does not exist, powershell exits 1
// without ever running launcher.ps1, //B swallows the error dialog, and the
// only thing the user can observe is that clicking the toast does nothing.
//
// The fix derives the directory from WScript.ScriptFullName. Every assertion
// below goes red if the literal comes back, if the mechanism is swapped for
// something CWD-dependent, or if the file is re-encoded into a shape that
// Windows Script Host cannot run.
//
// NO PROCESS IS EVER SPAWNED. The subject under test is the *text* of the
// forwarder, not this machine's registry or window state. Reading bytes is both
// the honest and the portable way to check it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");
const VBS_PATH = join(LIB, "forward.vbs");
const PS1_PATH = join(LIB, "launcher.ps1");

// --- VBScript lexical helpers ---------------------------------------------

// Strip VBScript comments from one physical line, keeping string contents.
//
//   * an apostrophe starts a comment ONLY outside a string literal;
//   * inside a string, "" is an escaped quote and stays part of the string;
//   * quote characters are copied through, so a hard-coded path inside a
//     string literal is still visible to the caller.
// Not handled: the Rem statement. The calibration test fails loudly if one
// ever appears in the file.
function stripComment(line) {
  let out = "";
  let inString = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inString) {
      out += ch;
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "'") break; // rest of the line is prose
    out += ch;
  }
  return out;
}

// Comment-free view of a source file: CRLF tolerated, output joined with LF.
function codeOf(source) {
  return source
    .split("\n")
    .map((l) => stripComment(l.replace(/\r$/, "")))
    .join("\n");
}

// What counts as "hard-coded to this machine". Broader than one drive letter:
// C:\Users\... and %LOCALAPPDATA%\... are the same defect wearing a different coat.
function leaksAbsolutePath(vbsCode) {
  if (/[A-Za-z]:\\/.test(vbsCode)) return true;
  if (/%(USERPROFILE|USERNAME|LOCALAPPDATA|APPDATA|TEMP|TMP)%/i.test(vbsCode)) return true;
  if (/\\\\[A-Za-z0-9._$-]+\\/.test(vbsCode)) return true; // \\server\share
  return false;
}

// Every *.ps1 path the source mentions, without surrounding quotes.
function ps1Literals(vbsCode) {
  return [...vbsCode.matchAll(/["']([^"'\r\n]*\.ps1)["']/gi)].map((m) => m[1]);
}

// The exact regression, kept as a fixture so the detector can prove itself.
const ORIGINAL_BROKEN = String.raw`cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""G:\DSH\dsh-notify-focus\lib\launcher.ps1"" """ & url & """"`;

const raw = readFileSync(VBS_PATH); // Buffer: byte-level assertions
const text = raw.toString("latin1"); // 1 byte === 1 char, lossless
const lines = text.split("\r\n");
const code = codeOf(text); // comments removed, strings kept

// --- 1. no absolute path in executable code -------------------------------

test("FORWARDER: no absolute path outside a comment (regression: click does nothing)", () => {
  const at = code.split("\n").findIndex((l) => leaksAbsolutePath(l));
  const where = at < 0 ? "" : " (line " + (at + 1) + ": " + lines[at].trim() + ")";
  assert.equal(
    leaksAbsolutePath(code),
    false,
    "forward.vbs hard-codes a machine-specific path again" + where,
  );
});

// --- 2. the detector is calibrated in both directions ---------------------

test("FORWARDER: the comment stripper is calibrated in both directions", () => {
  // False negative check: the exact regression MUST be detected.
  assert.equal(
    leaksAbsolutePath(codeOf(ORIGINAL_BROKEN)),
    true,
    "detector missed the original bug - the guard above is worthless",
  );

  // False positive check: prose is not code.
  const prose = "' history: this used to be G:\\DSH\\x\\launcher.ps1\r\nOption Explicit";
  assert.equal(
    leaksAbsolutePath(codeOf(prose)),
    false,
    "a comment that mentions the old path must not fail the suite",
  );

  // A comment at the end of a code line is still a comment.
  assert.equal(leaksAbsolutePath(codeOf("x = 1 ' old: G:\\DSH\\x")), false);

  // An apostrophe inside a string must not be mistaken for a comment start.
  assert.equal(
    leaksAbsolutePath(codeOf('cmd = "powershell.exe -File ""G:\\DSH\\x\\launcher.ps1"""')),
    true,
    "apostrophes inside string literals must not truncate the line",
  );

  // This helper does not parse the Rem statement; fail loudly if one appears.
  assert.doesNotMatch(text, /^[ \t]*Rem[ \t]/im, "forward.vbs uses Rem; stripComment needs a Rem branch");
});

// --- 3. the path is derived, not typed -----------------------------------

test("FORWARDER: the launcher path is derived from the script's own location", () => {
  assert.match(
    code,
    /WScript\.ScriptFullName/i,
    "the fix must derive the directory from WScript.ScriptFullName",
  );
  assert.doesNotMatch(code, /\.CurrentDirectory/i, "CurrentDirectory is explorer.exe's CWD, never lib/");
  assert.doesNotMatch(code, /\.\.[ \t]*[\\/]/, "no relative traversal from an assumed CWD");
});

// --- 4. the derived path actually lands on lib/launcher.ps1 ---------------

test("FORWARDER: the path the VBS builds resolves to lib/launcher.ps1", () => {
  const literals = ps1Literals(code);
  assert.ok(literals.length > 0, "forward.vbs no longer names launcher.ps1 at all");

  for (const lit of literals) {
    assert.doesNotMatch(lit, /[A-Za-z]:\\/, "absolute PS1 path again: " + lit);
  }

  // A bare "launcher.ps1" is fine only if something joins it onto a derived
  // directory. With no join it resolves against the process CWD, and wscript's
  // CWD is inherited from explorer.exe (usually C:\Windows\System32), never lib\.
  const bare = literals.filter((lit) => !/[\\/]/.test(lit));
  if (bare.length > 0) {
    assert.match(code, /BuildPath|JoinPath|GetParentFolderName/i,
      "a bare 'launcher.ps1' must be joined onto the script's own directory");
  }

  assert.ok(
    literals.some((lit) => existsSync(join(LIB, lit))),
    "no candidate resolves to a real file: " + literals.join(" | "),
  );
});

// --- 5. the fix assumes one directory ------------------------------------

test("FORWARDER: forward.vbs and launcher.ps1 are siblings", () => {
  const vbs = statSync(VBS_PATH);
  const ps1 = statSync(PS1_PATH);
  assert.equal(vbs.isFile(), true, "forward.vbs must exist");
  assert.equal(ps1.isFile(), true, "launcher.ps1 must exist");
  assert.equal(
    dirname(VBS_PATH).toLowerCase(),
    dirname(PS1_PATH).toLowerCase(),
    "the ScriptFullName-based fix assumes both live in the same directory",
  );
});

// --- 6. encoding: ASCII, no BOM ------------------------------------------

test("FORWARDER: pure ASCII, no BOM (WSH decodes ANSI, a UTF-8 BOM is a syntax error)", () => {
  assert.ok(raw.length > 100, "forward.vbs is truncated");

  const head = [...raw.subarray(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  assert.notEqual(head, "ef bb bf", "UTF-8 BOM: WSH decodes ANSI -> 800A0408 invalid character on line 1, and //B hides it");
  assert.notEqual(head.slice(0, 5), "ff fe", "UTF-16LE BOM: not the shipped form");
  assert.notEqual(head.slice(0, 5), "fe ff", "UTF-16BE BOM: not the shipped form");

  assert.equal(raw[0], 0x27, "byte 0 must be the header comment apostrophe, got 0x" + raw[0].toString(16));

  const nonAscii = [];
  for (let i = 0; i < raw.length; i += 1) if (raw[i] > 0x7f) nonAscii.push(i);
  assert.equal(nonAscii.length, 0, "non-ASCII byte offsets: " + nonAscii.slice(0, 8).join(","));

  assert.equal(Buffer.from(text, "latin1").equals(raw), true, "latin1 round-trip must be lossless");
});

// --- 7. line endings: CRLF by repository convention ---------------------

test("FORWARDER: CRLF only (the shape .gitattributes promises for *.vbs)", () => {
  let bareLf = 0;
  let bareCr = 0;
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === 0x0a && raw[i - 1] !== 0x0d) bareLf += 1;
    if (raw[i] === 0x0d && raw[i + 1] !== 0x0a) bareCr += 1;
  }
  // WSH accepts CR, LF and CRLF alike (measured 2026-11-14), so this pins the
  // repository convention rather than a runtime requirement. A bare LF here
  // means an editor or a git filter rewrote the file, not that wscript breaks.
  assert.equal(bareLf, 0, "bare LF found: an editor or a git filter rewrote the file");
  assert.equal(bareCr, 0, "bare CR found: a partial conversion (mixed line endings)");

  const crlf = text.split("\r\n").length - 1;
  assert.ok(crlf >= 20, "expected the whole file on CRLF, found " + crlf);

  assert.equal(raw[raw.length - 2], 0x0d, "file must end CRLF");
  assert.equal(raw[raw.length - 1], 0x0a, "file must end CRLF");
});

// --- 8. the attribute that keeps 7 true ----------------------------------

function vbsAttributes(source) {
  const rules = source
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  let attrs = null;
  for (const rule of rules) {
    const [pattern, ...rest] = rule.split(/\s+/);
    if (pattern !== "*.vbs") continue; // this helper only understands the literal form
    attrs = rest;
  }
  return attrs;
}

test("FORWARDER: .gitattributes still forces CRLF for *.vbs on checkout", () => {
  const attrs = vbsAttributes(readFileSync(join(LIB, "..", ".gitattributes"), "utf8"));
  assert.ok(attrs, "no *.vbs rule: a checkout can hand the forwarder LF");
  assert.ok(attrs.includes("text"), "*.vbs must be marked text for eol to apply");
  assert.ok(attrs.includes("eol=crlf"), "*.vbs must force eol=crlf");

  // calibration: the helper must actually be able to say "no"
  assert.equal(vbsAttributes("*.ps1 -text"), null);
  assert.deepEqual(vbsAttributes("*.vbs text eol=crlf"), ["text", "eol=crlf"]);
});