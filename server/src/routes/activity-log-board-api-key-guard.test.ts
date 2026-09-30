/**
 * Regression guard: every board-authenticable `logActivity` /
 * `persistActivity` / `logActivityInTransaction` call site under
 * `server/src/{routes,services,modules,middleware}` must pass `boardApiKeyId`
 * in the same call.
 *
 * This is a source check — omitting the property produces no type error and no
 * runtime error, just a NULL column, so only a source scan can catch it.
 *
 * Scope (PR 1 of SUP-17958): the guard was historically routes/-only
 * (`readdirSync` on the top level of `routes/`, a scope limit that also never
 * scanned `routes/` subdirectories and did not exclude `*.spec.ts`). It now
 * walks those four subtrees recursively and treats `logActivityInTransaction`
 * as a first-class call shape. Test files (`__tests__/`, `*.test.ts`,
 * `*.spec.ts`) are excluded.
 *
 * Landing mode (SUP-17958, Shape 1 "quarantine warn-first" ruling, 2026-09-30):
 * this PR (PR 1) lands the widened guard NON-BLOCKING — the main scan computes
 * and names every reportable site but warns instead of failing the build.
 * SUP-18015 (PR 2) remediates the reported sites and restores hard-fail in the
 * same change. The site names emitted by the warning are the quarantine record
 * PR 2 consumes; do not delete the scan or the message to make the test green.
 *
 * The guard parses the COMPLETE second argument of each call (a comment- and
 * string-aware, balanced-brace parse — not a fixed line window) and requires a
 * TOP-LEVEL `boardApiKeyId`. A `boardApiKeyId` nested inside `details` does not
 * satisfy the requirement.
 *
 * Actor classification drives which calls are board-authenticable:
 *  - a literal `actorType` of "agent" / "system" / "plugin" can never carry a
 *    board key, so those sites are exempt by classification;
 *  - a literal "user", or an expression (`actor.actorType`, a ternary, a
 *    spread that may resolve to a user, or a missing actorType) is treated as
 *    potentially user and must carry a top-level `boardApiKeyId`.
 *
 * Exception mechanism is keyed by file + action string, and — where a
 * file/action pair is shared by multiple calls — by the exempted call's exact
 * `actorType` expression, so an entry covers a single occurrence, not a
 * file/action class. Markers are stable across line shifts and never pin a
 * line number; if the matched call is reformatted, renamed, or gains the key,
 * the marker stops matching and the guard falls back to requiring a top-level
 * boardApiKeyId.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(__dirname, "..");

/**
 * The guard's scope: these four subtrees of `server/src`, walked recursively.
 * `routes/` is included so the historical routes/ fence is a strict subset of
 * the widened walk (no previously-covered site is dropped by the widening).
 */
const SCAN_DIRS = ["routes", "services", "modules", "middleware"];

/**
 * A directory is recursed into unless it is a test-fixture directory
 * (`__tests__`). A file is scanned only when it is a `.ts` source file that is
 * not a test file (`*.test.ts`, `*.spec.ts`). Kept as a pure predicate so the
 * recursive-scan and test-file-exclusion behavior can be asserted directly.
 */
function isScannable(name: string, isDirectory: boolean): boolean {
  if (isDirectory) return name !== "__tests__";
  if (!name.endsWith(".ts")) return false;
  if (name.endsWith(".test.ts")) return false;
  if (name.endsWith(".spec.ts")) return false;
  return true;
}

/** Recursively collect the scannable source files across the guard's scope. */
function collectSourceFiles(root: string = SRC_ROOT): string[] {
  const out: string[] = [];
  for (const dir of SCAN_DIRS) {
    walkScannable(join(root, dir), out);
  }
  return out;
}

function walkScannable(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // a scope directory that does not exist yet contributes no files
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (isScannable(entry.name, true)) walkScannable(join(dir, entry.name), out);
    } else if (entry.isFile() && isScannable(entry.name, false)) {
      out.push(join(dir, entry.name));
    }
  }
}

/** Resolve a guard-scoped file by basename (the first match in walk order). */
function pathByBasename(files: string[], base: string): string {
  const hit = files.find((f) => f.endsWith(`/${base}`));
  return hit ?? join(files[0], base);
}

/**
 * Explicit route/action exceptions for board-authenticable sites that are
 * genuinely request-less (or owned by a sibling fence, not this residual
 * guard's scope). Keyed by file + action, and where a file/action pair is
 * shared by multiple calls, by the exact `actorType` expression of the
 * exempted call (occurrence-specific, stable across line shifts — never a
 * line number). An entry with no `actorType` marker exempts every call with
 * that file + action; an entry with a marker exempts only the call whose
 * trimmed `actorType` value matches the marker exactly.
 */
interface AllowlistEntry {
  file: string;
  action: string;
  /** Exact trimmed source text of the exempted call's actorType property value. */
  actorType?: string;
  reason: string;
}

const ALLOWLIST: AllowlistEntry[] = [
  // agent actor: a board key can never be an agent
  { file: "secrets.ts", action: "secret.access.listed", reason: "agent actor" },
  // system actor: background/system join-claim event
  { file: "access.ts", action: "agent_api_key.claimed", reason: "system actor" },
];

function isAllowlisted(allowlist: AllowlistEntry[], file: string, action: string, actorTypeExpr: string | undefined): boolean {
  return allowlist.some(
    (entry) =>
      entry.file === file &&
      entry.action === action &&
      (entry.actorType === undefined || entry.actorType === (actorTypeExpr ?? "")),
  );
}

// ---------------------------------------------------------------------------
// Structural scanning. `toCodeOnly` blanks comments and string interiors
// (keeping the same length so index arithmetic stays valid), leaving braces,
// commas, colons, and identifiers intact. All structural work runs on that
// code-only view; values are read back from the original text at the same
// indices so string literals (actorType/action values) are preserved.
// ---------------------------------------------------------------------------

function toCodeOnly(text: string): string {
  const out = text.split("");
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      let j = i;
      while (j < n && text[j] !== "\n") {
        out[j] = " ";
        j++;
      }
      i = j;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      let j = i;
      while (j < n && !(text[j] === "*" && text[j + 1] === "/")) {
        out[j] = " ";
        j++;
      }
      if (j < n) {
        out[j] = " ";
        out[j + 1] = " ";
        j += 2;
      }
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out[i] = " ";
      i++;
      while (i < n) {
        if (text[i] === "\\") {
          out[i] = " ";
          i++;
          if (i < n) {
            out[i] = " ";
            i++;
          }
          continue;
        }
        if (text[i] === q) {
          out[i] = " ";
          i++;
          break;
        }
        out[i] = " ";
        i++;
      }
      continue;
    }
    i++;
  }
  return out.join("");
}

function matchBrace(code: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface TopLevelProp {
  key: string;
  value: string;
}

interface ParsedObject {
  props: TopLevelProp[];
  spreadVars: string[];
}

/** Parse the top-level properties of the object literal whose `{` is at openIdx. */
function topLevelProps(code: string, text: string, openIdx: number): ParsedObject | null {
  const close = matchBrace(code, openIdx);
  if (close < 0) return null;
  const innerStart = openIdx + 1;
  const innerEnd = close;
  let depth = 0;
  let segStart = innerStart;
  const spans: Array<[number, number]> = [];
  for (let i = innerStart; i < innerEnd; i++) {
    const c = code[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "," && depth === 0) {
      spans.push([segStart, i]);
      segStart = i + 1;
    }
  }
  spans.push([segStart, innerEnd]);

  const props: TopLevelProp[] = [];
  const spreadVars: string[] = [];
  for (const [s, e] of spans) {
    let d = 0;
    let colon = -1;
    for (let i = s; i < e; i++) {
      const c = code[i];
      if (c === "{") d++;
      else if (c === "}") d--;
      else if (c === ":" && d === 0) {
        colon = i;
        break;
      }
    }
    const segCode = code.slice(s, e).trim();
    if (segCode.startsWith("...")) {
      const sm = segCode.match(/\.\.\.\s*([A-Za-z_$][\w$]*)/);
      if (sm) spreadVars.push(sm[1]);
      continue;
    }
    if (colon < 0) continue;
    const keyTok = code.slice(s, colon).trim();
    const keyMatch = keyTok.match(/^["']?([A-Za-z_$][\w$]*)["']?$/);
    if (!keyMatch) continue;
    const value = text.slice(colon + 1, e).trim();
    props.push({ key: keyMatch[1], value });
  }
  return { props, spreadVars };
}

/**
 * Resolve a spread variable to its in-file object-literal initializer and check
 * whether THAT object carries a top-level boardApiKeyId. Handles the
 * `logActivity(db, { ...baseLog, details: {...} })` pattern where the board key
 * lives on the spread source, not on the call literal.
 */
function spreadHasBoard(code: string, text: string, varName: string): boolean {
  const re = new RegExp(`(?:const|let|var)\\s+${varName}\\b\\s*=[^;{]*\\{`);
  const m = re.exec(code);
  if (!m) return false;
  const openIdx = m.index + m[0].length - 1;
  const parsed = topLevelProps(code, text, openIdx);
  return !!parsed && parsed.props.some((p) => p.key === "boardApiKeyId");
}

type ActorClass = "USER" | "AGENT" | "SYSTEM" | "PLUGIN" | "EXPR";

function classifyActor(value: string | null): ActorClass {
  if (!value) return "EXPR";
  const v = value.trim();
  if (/^["']user["']/.test(v)) return "USER";
  if (/^["']agent["']/.test(v)) return "AGENT";
  if (/^["']system["']/.test(v)) return "SYSTEM";
  if (/^["']plugin["']/.test(v)) return "PLUGIN";
  return "EXPR";
}

interface Violation {
  file: string;
  line: number;
  action: string;
  detail: string;
}

const CALL_RE = /(?<![\w$.])(logActivity|persistActivity|logActivityInTransaction)\s*\(/g;

/**
 * Scan one source file and return board-api-key violations.
 *
 * Scope limit (documented, matching the transaction guard): a call whose second
 * argument is not an inline object literal (i.e. a helper-built object such as
 * `logActivity(db, buildDependencyWakeWithheldActivity({...}))`, or a call
 * routed through a variable such as `const auditActivity = isTransactionHandle(db)
 * ? logActivityInTransaction : logActivity`) is not statically verifiable and
 * is skipped. Every current site of that shape in the scanned scope is a
 * `system`-actor event (the helpers return `actorType: "system"`), so this is
 * not masking a board-authenticable gap.
 */
function scanSource(content: string, fileName: string, allowlist: AllowlistEntry[] = ALLOWLIST): Violation[] {
  const code = toCodeOnly(content);
  const violations: Violation[] = [];
  const n = code.length;

  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(code)) !== null) {
    const callStart = m.index;
    // Locate the second argument: the top-level comma after the opening `(`.
    let p = callStart + m[0].length;
    let depth = 1;
    let commaIdx = -1;
    while (p < n) {
      const c = code[p];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) break;
      } else if (c === "," && depth === 1) {
        commaIdx = p;
        break;
      }
      p++;
    }
    if (commaIdx < 0) continue; // no second argument

    let argStart = commaIdx + 1;
    while (argStart < n && (code[argStart] === "\n" || /[ \t]/.test(code[argStart]))) argStart++;
    if (code[argStart] !== "{") continue; // helper-built object: out of static reach

    const parsed = topLevelProps(code, content, argStart);
    if (!parsed) continue;

    const actorProp = parsed.props.find((pr) => pr.key === "actorType");
    const cls = classifyActor(actorProp ? actorProp.value : null);
    // agent/system/plugin actors can never carry a board key.
    if (cls === "AGENT" || cls === "SYSTEM" || cls === "PLUGIN") continue;

    const hasBoard =
      parsed.props.some((pr) => pr.key === "boardApiKeyId") ||
      parsed.spreadVars.some((v) => spreadHasBoard(code, content, v));
    if (hasBoard) continue;

    const actionProp = parsed.props.find((pr) => pr.key === "action");
    const action = actionProp ? actionProp.value.replace(/^["']|["']$/g, "") : "(unknown)";
    if (isAllowlisted(allowlist, fileName, action, actorProp?.value)) continue;

    const line = content.slice(0, callStart).split("\n").length;
    violations.push({
      file: fileName,
      line,
      action,
      detail: `actorType=${actorProp?.value ?? "(none)"} — missing top-level boardApiKeyId`,
    });
  }

  return violations;
}

describe("board-api-key activity log guard", () => {
  it("warns on every board-authenticable logActivity/persistActivity/logActivityInTransaction call missing boardApiKeyId (non-blocking quarantine)", () => {
    const files = collectSourceFiles();
    const allViolations: Violation[] = [];

    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      const base = file.split("/").pop() as string;
      allViolations.push(...scanSource(content, base));
    }

    // WARN-FIRST QUARANTINE (SUP-17958 Shape 1 ruling, 2026-09-30): PR 1 lands
    // the widened guard non-blocking so it does not fail the build. The scan
    // still runs and names every reportable site — that warning is the record
    // SUP-18015 (PR 2) remediates against and then flips this guard back to
    // hard-fail. Do not "fix" redness by deleting the scan or the message.
    if (allViolations.length > 0) {
      const summary = allViolations
        .map((v) => `  ${v.file}:${v.line} — ${v.action} (${v.detail})`)
        .join("\n");
      console.warn(
        `board-api-key guard [WARN-FIRST, non-blocking]: boardApiKeyId missing from ${allViolations.length} board-authenticable logActivity call site(s). SUP-18015 (PR 2) remediates these and restores hard-fail.\n` +
          `Add "boardApiKeyId: getActorInfo(req).boardApiKeyId" (or the transaction/actor equivalent) to each call, or add an occurrence-specific entry to the ALLOWLIST (file + action +, when a file/action pair is shared, the exact actorType expression) if the site is genuinely request-less or fence-owned.\n` +
          `${summary}`,
      );
    }

    // The guard ran and produced a well-formed result; redness is reported as a
    // warning above, not a failure, in this PR.
    expect(files.length).toBeGreaterThan(200);
    expect(allViolations).toEqual(expect.any(Array));
  });

  it("allowlist entries reference valid files, actions, and actorType markers", () => {
    const files = collectSourceFiles();
    for (const entry of ALLOWLIST) {
      const content = readFileSync(pathByBasename(files, entry.file), "utf-8");
      const actionPattern = new RegExp(`action\\s*:\\s*["']${entry.action}["']`);
      expect(
        actionPattern.test(content),
        `Allowlist entry ${entry.file} (${entry.action}): action string not found in file`,
      ).toBe(true);
      if (entry.actorType !== undefined) {
        expect(
          content.includes(`actorType: ${entry.actorType}`),
          `Allowlist entry ${entry.file} (${entry.action}) marker: exact actorType expression no longer present in file — the occurrence-specific exception is stale, re-evaluate it deliberately`,
        ).toBe(true);
      }
    }
  });

  it("reports a same-file, same-action board-authenticable omission the exception must not cover", () => {
    // Same route file, same action string, board-authenticable actor
    // expression, top-level boardApiKeyId omitted: the broad {file, action}
    // key used to hide this; the occurrence-specific entry must not.
    const snippet = [
      'import { logActivity } from "../services/activity-log";',
      "export function handler(actor: any, db: any) {",
      "  return logActivity(db, {",
      "    companyId: actor.companyId,",
      "    actorType: actor.actorType,",
      "    actorId: actor.actorId,",
      '    action: "issue.recovery_action_resolved",',
      '    entityType: "issue",',
      '    entityId: "x",',
      "  });",
      "}",
    ].join("\n");
    const violations = scanSource(snippet, "issues.ts");
    expect(violations).toHaveLength(1);
    expect(violations[0].action).toBe("issue.recovery_action_resolved");
  });

  it("does not extend the occurrence-specific exception to another file", () => {
    // The exact same actorType expression in a different route file must
    // still be flagged: the entry is an occurrence carve-out, not a
    // file/action-class exemption.
    const snippet = [
      'import { logActivity } from "../services/activity-log";',
      "export function handler(actor: any, db: any) {",
      "  return logActivity(db, {",
      "    companyId: actor.companyId,",
      '    actorType: actor?.actorType ?? "system",',
      "    actorId: actor?.actorId,",
      '    action: "issue.recovery_action_resolved",',
      '    entityType: "issue",',
      '    entityId: "x",',
      "  });",
      "}",
    ].join("\n");
    const violations = scanSource(snippet, "other-routes.ts");
    expect(violations).toHaveLength(1);
    expect(violations[0].action).toBe("issue.recovery_action_resolved");
  });

  // --- Distinguishing tests: prove the guard actually detects the gap. ---

  it("flags a call that drops the top-level boardApiKeyId while keeping details.boardApiKeyId", () => {
    const snippet = [
      'import { logActivity } from "../services/activity-log";',
      "export function handler(req: any, db: any) {",
      "  return logActivity(db, {",
      "    companyId: req.companyId,",
      '    actorType: "user",',
      "    actorId: req.actor.userId,",
      '    action: "synthetic.missing_board",',
      '    entityType: "synthetic",',
      '    entityId: "x",',
      "    details: {",
      '      boardApiKeyId: "nested-must-not-count",',
      "    },",
      "  });",
      "}",
    ].join("\n");
    const violations = scanSource(snippet, "synthetic.ts");
    expect(violations).toHaveLength(1);
    expect(violations[0].action).toBe("synthetic.missing_board");
  });

  it("passes an actorType: actor.actorType call that carries a top-level boardApiKeyId", () => {
    const snippet = [
      'import { logActivity } from "../services/activity-log";',
      "export function handler(actor: any, db: any) {",
      "  return logActivity(db, {",
      "    companyId: actor.companyId,",
      "    actorType: actor.actorType,",
      "    boardApiKeyId: actor.boardApiKeyId,",
      "    actorId: actor.actorId,",
      '    action: "synthetic.expr_ok",',
      '    entityType: "synthetic",',
      '    entityId: "x",',
      "  });",
      "}",
    ].join("\n");
    expect(scanSource(snippet, "synthetic.ts")).toHaveLength(0);
  });

  it("flags an actorType: actor.actorType call that omits the top-level boardApiKeyId", () => {
    const snippet = [
      'import { logActivity } from "../services/activity-log";',
      "export function handler(actor: any, db: any) {",
      "  return logActivity(db, {",
      "    companyId: actor.companyId,",
      "    actorType: actor.actorType,",
      "    actorId: actor.actorId,",
      '    action: "synthetic.expr_missing",',
      '    entityType: "synthetic",',
      '    entityId: "x",',
      "  });",
      "}",
    ].join("\n");
    const violations = scanSource(snippet, "synthetic.ts");
    expect(violations).toHaveLength(1);
    expect(violations[0].action).toBe("synthetic.expr_missing");
  });

  it("exempts a literal system-actor call without boardApiKeyId", () => {
    const snippet = [
      'import { logActivity } from "../services/activity-log";',
      "export function handler(db: any) {",
      "  return logActivity(db, {",
      '    companyId: "c1",',
      '    actorType: "system",',
      '    actorId: "background",',
      '    action: "synthetic.system_ok",',
      '    entityType: "synthetic",',
      '    entityId: "x",',
      "  });",
      "}",
    ].join("\n");
    expect(scanSource(snippet, "synthetic.ts")).toHaveLength(0);
  });

  // --- Widened-scope behavior: transaction calls, recursion, test-file exclusion. ---

  it("flags a board-authenticable logActivityInTransaction call that omits the top-level boardApiKeyId", () => {
    const snippet = [
      'import { logActivityInTransaction } from "../services/activity-log";',
      "export function handler(tx: any, actor: any) {",
      "  return logActivityInTransaction(tx, {",
      "    companyId: actor.companyId,",
      "    actorType: actor.actorType,",
      "    actorId: actor.actorId,",
      '    action: "synthetic.tx_missing",',
      '    entityType: "synthetic",',
      '    entityId: "x",',
      "  });",
      "}",
    ].join("\n");
    const violations = scanSource(snippet, "synthetic.ts");
    expect(violations).toHaveLength(1);
    expect(violations[0].action).toBe("synthetic.tx_missing");
  });

  it("passes a logActivityInTransaction call that carries a top-level boardApiKeyId", () => {
    const snippet = [
      'import { logActivityInTransaction } from "../services/activity-log";',
      "export function handler(tx: any, actor: any) {",
      "  return logActivityInTransaction(tx, {",
      "    companyId: actor.companyId,",
      "    actorType: actor.actorType,",
      "    boardApiKeyId: actor.boardApiKeyId,",
      "    actorId: actor.actorId,",
      '    action: "synthetic.tx_ok",',
      '    entityType: "synthetic",',
      '    entityId: "x",',
      "  });",
      "}",
    ].join("\n");
    expect(scanSource(snippet, "synthetic.ts")).toHaveLength(0);
  });

  it("exempts a literal system-actor logActivityInTransaction call without boardApiKeyId", () => {
    const snippet = [
      'import { logActivityInTransaction } from "../services/activity-log";',
      "export function handler(tx: any) {",
      "  return logActivityInTransaction(tx, {",
      '    companyId: "c1",',
      '    actorType: "system",',
      '    actorId: "background",',
      '    action: "synthetic.tx_system_ok",',
      '    entityType: "synthetic",',
      '    entityId: "x",',
      "  });",
      "}",
    ].join("\n");
    expect(scanSource(snippet, "synthetic.ts")).toHaveLength(0);
  });

  it("recurses into subdirectories rather than only scanning each scope's top level", () => {
    // The historical routes/ guard used a non-recursive readdirSync, so any
    // file nested below the top level of a scope would be silently skipped.
    // Proving the walk reaches below the top level closes that hole.
    const files = collectSourceFiles();
    const nestedModuleFiles = files.filter((f) => {
      const rel = f.slice(SRC_ROOT.length).replace(/^\/+/, "").split("/");
      // rel e.g. ["modules", "active-run-watchdog", "adapters", "postgres.ts"]
      return rel[0] === "modules" && rel.length >= 4;
    });
    expect(
      nestedModuleFiles.length,
      "expected at least one modules/ source file nested below the top level",
    ).toBeGreaterThan(0);
  });

  it("excludes *.spec.ts, *.test.ts, *.tsx, and __tests__/ from the scan", () => {
    // Pure predicate: assert the exclusion rules directly.
    expect(isScannable("foo.spec.ts", false)).toBe(false);
    expect(isScannable("foo.test.ts", false)).toBe(false);
    expect(isScannable("foo.ts", false)).toBe(true);
    expect(isScannable("foo.tsx", false)).toBe(false);
    expect(isScannable("__tests__", true)).toBe(false);
    expect(isScannable("adapters", true)).toBe(true);

    // And the real walk honors the predicate over the live tree.
    const files = collectSourceFiles();
    const offenders = files.filter(
      (f) => f.endsWith(".spec.ts") || f.endsWith(".test.ts") || f.includes("/__tests__/"),
    );
    expect(offenders).toEqual([]);
  });
});
