import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Build census for the stale-restore hole closed by the board-only
 * restore-participant operation.
 *
 * Restore row-locks live runs, then the issue, then reads live runs again
 * before changing the assignee. That second read is not a predicate lock.
 * A later application insert of a live `heartbeat_runs` row, or a later grant
 * of the pending participant, must already hold the issue row in the same
 * transaction. Hand-run operator SQL remains the named residual: this scanner
 * cannot see a session that never enters the application source.
 *
 * The census is the same inventory release assurance ran over production
 * `insert(heartbeatRuns)` sites: each insert is lock-covered, delegated to a
 * function whose every production caller locks, or the one self-declared
 * status/assignee compare-and-set (which excludes an eligible restore in
 * either order and does not hold the row through the insert). A new insert
 * that does none of those fails this test. Dropping `.for("update")` from an
 * existing writer fails it too, because the lock has to be lexically inside
 * the insert's transaction, not in a transaction that already committed.
 *
 * Comment-aware, text-based. A commented-out insert is not a writer. A
 * comment that mentions `for update` is not a lock. Strings and template
 * SQL stay visible, so `sql\`select id from issues ... for update\`` counts.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCAN_ROOTS = ["server/src", "cli/src", "packages"];
const SELF_DECLARED_RUN = "server/src/services/self-declared-run.ts";

const INSERT_RE = /\.insert\(\s*heartbeatRuns\s*\)/g;
const ISSUE_LOCK_RE =
  /(?:from\(\s*issues\s*\)|from\(\s*issueRows\s*\)|from\s+issues\b)(?:(?!;|\.insert\s*\(|\bawait\b)[\s\S]){0,4000}?(?:\.for\(\s*["']update["']|for\s+update\b)/i;
const GRANT_ROUTE_RE = /router\.post\(\s*["'`][^"'`]*restore-participant["'`]/g;
const GRANT_ACTIVITY_RE = /action:\s*["']issue\.participant_restored["']/g;
const GRANT_WRITE_RE = /\.set\(\s*\{(?:(?!\}\))[\s\S]){0,240}?assigneeAgentId\s*:/g;
const SELF_DECLARED_CAS_RE =
  /\.update\(\s*issues\s*\)(?:(?!\.insert\(\s*heartbeatRuns\s*\))[\s\S]){0,1200}?status:\s*["']in_progress["'](?:(?!\.insert\(\s*heartbeatRuns\s*\))[\s\S]){0,800}?assigneeAgentId/;

export type InsertCoverage = "issue-lock" | "caller-issue-lock" | "status-cas" | "uncovered";

export type InsertSite = {
  file: string;
  line: number;
  coverage: InsertCoverage;
};

export type GrantSite = {
  file: string;
  line: number;
  kind: "route" | "activity";
  locked: boolean;
};

type SourceFile = { file: string; code: string };

function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        state = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "'") state = "single";
      else if (c === '"') state = "double";
      else if (c === "`") state = "template";
      out += c;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      } else out += " ";
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") {
        state = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }
    if (c === "\\" && state !== "template") {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "\\" && state === "template" && (next === "`" || next === "\\")) {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (
      (state === "single" && c === "'")
      || (state === "double" && c === '"')
      || (state === "template" && c === "`")
    ) {
      state = "code";
    }
    out += c;
    i += 1;
  }
  return out;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}


function skipLiteral(source: string, index: number): number {
  const quote = source[index];
  if (quote !== "'" && quote !== '"' && quote !== "`") return index;
  let i = index + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`" && source[i] === "$" && source[i + 1] === "{") {
      const end = matchBrace(source, i + 1);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

function matchBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const c = source[i];
    if (c === "'" || c === '"' || c === "`") {
      i = skipLiteral(source, i) - 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function callbackBody(source: string, from: number): { start: number; end: number } | null {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const c = source[i];
    if (c === "'" || c === '"' || c === "`") {
      i = skipLiteral(source, i) - 1;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      if (depth === 0) return null;
      depth -= 1;
    } else if (c === "{" && depth === 1) {
      const end = matchBrace(source, i);
      return end < 0 ? null : { start: i, end };
    }
  }
  return null;
}

function transactionBodies(source: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of source.matchAll(/\.transaction\s*\(/g)) {
    const body = callbackBody(source, match.index! + match[0].length - 1);
    if (body) ranges.push(body);
  }
  return ranges;
}

function innermostRange(
  ranges: Array<{ start: number; end: number }>,
  index: number,
): { start: number; end: number } | null {
  let best: { start: number; end: number } | null = null;
  for (const range of ranges) {
    if (index <= range.start || index >= range.end) continue;
    if (!best || range.end - range.start < best.end - best.start) best = range;
  }
  return best;
}

function hasIssueLock(source: string, start: number, end: number): boolean {
  return ISSUE_LOCK_RE.test(source.slice(start, end));
}

type FunctionRange = { name: string; start: number; end: number; header: number };

function functionRanges(source: string): FunctionRange[] {
  const ranges: FunctionRange[] = [];
  const re = /(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{)/g;
  for (const match of source.matchAll(re)) {
    const name = match[1] ?? match[2];
    if (!name) continue;
    const open = source.indexOf("{", match.index!);
    if (open < 0) continue;
    const end = matchBrace(source, open);
    if (end < 0) continue;
    ranges.push({ name, start: open, end, header: match.index! });
  }
  return ranges;
}

function enclosingFunctions(ranges: FunctionRange[], index: number): FunctionRange[] {
  return ranges
    .filter((range) => index > range.start && index < range.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start));
}

function callSites(files: SourceFile[], name: string): Array<{ file: string; code: string; index: number }> {
  const re = new RegExp(`\\b${name}\\s*\\(`, "g");
  const sites: Array<{ file: string; code: string; index: number }> = [];
  for (const source of files) {
    for (const match of source.code.matchAll(re)) {
      sites.push({ file: source.file, code: source.code, index: match.index! });
    }
  }
  return sites;
}

function callIsLocked(call: { code: string; index: number }): boolean {
  const tx = innermostRange(transactionBodies(call.code), call.index);
  return Boolean(tx && hasIssueLock(call.code, tx.start, call.index));
}

function coverInsert(files: SourceFile[], file: string, code: string, index: number): InsertCoverage {
  const tx = innermostRange(transactionBodies(code), index);
  if (tx && hasIssueLock(code, tx.start, index)) return "issue-lock";

  const owners = enclosingFunctions(functionRanges(code), index);
  for (const owner of owners) {
    const exported = /export\s+$/.test(code.slice(Math.max(0, owner.header - 40), owner.header));
    const sites = callSites(files, owner.name).filter((site) => {
      if (!exported && site.file !== file) return false;
      if (site.file === file && site.index >= owner.header && site.index <= owner.end) return false;
      const before = site.code.slice(Math.max(0, site.index - 16), site.index);
      if (/function\s+$/.test(before)) return false;
      const line = site.code.slice(site.index, site.index + 180).split("\n")[0] ?? "";
      if (/\)\s*:/.test(line) && !line.includes("{")) return false;
      return true;
    });
    if (sites.length === 0) continue;
    if (sites.every((site) => callIsLocked(site))) return "caller-issue-lock";
  }

  if (
    file === SELF_DECLARED_RUN
    && SELF_DECLARED_CAS_RE.test(code.slice(Math.max(0, index - 2500), index))
  ) return "status-cas";
  return "uncovered";
}

function isScannedFile(file: string): boolean {
  if (!file.endsWith(".ts") && !file.endsWith(".tsx")) return false;
  if (file.endsWith(".d.ts")) return false;
  if (file.includes(`${path.sep}__tests__${path.sep}`)) return false;
  if (file.includes(`${path.sep}node_modules${path.sep}`)) return false;
  if (file.includes(`${path.sep}dist${path.sep}`)) return false;
  if (file.endsWith(".test.ts") || file.endsWith(".integration.test.ts")) return false;
  return true;
}

function listProductionFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__tests__") continue;
        walk(full);
      } else if (isScannedFile(full)) out.push(full);
    }
  };
  for (const root of SCAN_ROOTS) walk(path.join(repoRoot, root));
  return out.sort();
}

function loadProduction(): SourceFile[] {
  return listProductionFiles().map((full) => ({
    file: path.relative(repoRoot, full),
    code: stripComments(readFileSync(full, "utf8")),
  }));
}

export function censusInserts(files: SourceFile[]): InsertSite[] {
  const sites: InsertSite[] = [];
  for (const source of files) {
    for (const match of source.code.matchAll(INSERT_RE)) {
      sites.push({
        file: source.file,
        line: lineOf(source.code, match.index!),
        coverage: coverInsert(files, source.file, source.code, match.index!),
      });
    }
  }
  return sites;
}

function grantLocked(code: string, writeIndex: number): boolean {
  const tx = innermostRange(transactionBodies(code), writeIndex);
  return Boolean(tx && hasIssueLock(code, tx.start, writeIndex));
}

export function censusGrants(files: SourceFile[]): GrantSite[] {
  const sites: GrantSite[] = [];
  for (const source of files) {
    for (const match of source.code.matchAll(GRANT_ROUTE_RE)) {
      const open = source.code.lastIndexOf("(", match.index! + match[0].length);
      const body = open < 0 ? null : callbackBody(source.code, open);
      const writes = body ? [...source.code.slice(body.start, body.end).matchAll(GRANT_WRITE_RE)] : [];
      if (!body || writes.length === 0) {
        sites.push({ file: source.file, line: lineOf(source.code, match.index!), kind: "route", locked: false });
        continue;
      }
      for (const write of writes) {
        const index = body.start + write.index!;
        sites.push({
          file: source.file,
          line: lineOf(source.code, index),
          kind: "route",
          locked: grantLocked(source.code, index),
        });
      }
    }
    for (const match of source.code.matchAll(GRANT_ACTIVITY_RE)) {
      sites.push({
        file: source.file,
        line: lineOf(source.code, match.index!),
        kind: "activity",
        locked: grantLocked(source.code, match.index!),
      });
    }
  }
  return sites;
}

function singleFile(name: string, code: string): SourceFile[] {
  return [{ file: name, code: stripComments(code) }];
}

describe("live-run admission lock census", () => {
  it("rejects an insert that never locks the issue, including a lock that already committed", () => {
    const unlocked = censusInserts(singleFile("server/src/services/future-writer.ts", `
      export async function insertLive(tx: { insert: Function }) {
        await tx.insert(heartbeatRuns).values({ status: "queued" });
      }
    `));
    expect(unlocked.map((site) => site.coverage)).toEqual(["uncovered"]);

    const committed = censusInserts(singleFile("server/src/services/future-writer.ts", `
      export async function insertLive(db: { transaction: Function; insert: Function }) {
        await db.transaction(async (tx) => {
          await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
        });
        await db.transaction(async (tx) => {
          await tx.insert(heartbeatRuns).values({ status: "queued" });
        });
      }
    `));
    expect(committed.map((site) => site.coverage)).toEqual(["uncovered"]);
  });

  it("accepts an issue-row lock in the insert transaction, and not an agent-row lock", () => {
    const locked = censusInserts(singleFile("server/src/services/future-writer.ts", `
      export async function insertLive(db: { transaction: Function }) {
        await db.transaction(async (tx) => {
          await tx.execute(sql\`select id from issues where id = \${issueId} for update\`);
          await tx.insert(heartbeatRuns).values({ status: "queued" });
        });
      }
    `));
    expect(locked.map((site) => site.coverage)).toEqual(["issue-lock"]);

    const drizzle = censusInserts(singleFile("server/src/services/future-writer.ts", `
      export async function insertLive(db: { transaction: Function }) {
        await db.transaction(async (tx) => {
          await tx.select().from(issueRows).where(eq(issueRows.id, id)).for("update");
          await tx.insert(heartbeatRuns).values({ status: "queued" });
        });
      }
    `));
    expect(drizzle.map((site) => site.coverage)).toEqual(["issue-lock"]);

    const agentOnly = censusInserts(singleFile("server/src/services/future-writer.ts", `
      export async function insertLive(db: { transaction: Function }) {
        await db.transaction(async (tx) => {
          await tx.execute(sql\`select id from agents where id = \${agentId} for update\`);
          await tx.insert(heartbeatRuns).values({ status: "queued" });
        });
      }
    `));
    expect(agentOnly.map((site) => site.coverage)).toEqual(["uncovered"]);
  });

  it("accepts a delegated insert only when every production caller holds the issue lock", () => {
    const covered = censusInserts(singleFile("server/src/services/future-writer.ts", `
      function buildTransaction(tx) {
        return { async finalize() { await tx.insert(heartbeatRuns).values({ status: "queued" }); } };
      }
      export async function release(db) {
        await db.transaction(async (tx) => {
          await tx.execute(sql\`select id from issues where id = \${issueId} for update\`);
          buildTransaction(tx);
        });
      }
    `));
    expect(covered.map((site) => site.coverage)).toEqual(["caller-issue-lock"]);

    const mixed = censusInserts(singleFile("server/src/services/future-writer.ts", `
      function buildTransaction(tx) {
        return { async finalize() { await tx.insert(heartbeatRuns).values({ status: "queued" }); } };
      }
      export async function release(db) {
        await db.transaction(async (tx) => {
          await tx.execute(sql\`select id from issues where id = \${issueId} for update\`);
          buildTransaction(tx);
        });
      }
      export async function sneak(tx) {
        buildTransaction(tx);
      }
    `));
    expect(mixed.map((site) => site.coverage)).toEqual(["uncovered"]);
  });

  it("ignores a commented insert and a comment that only mentions the lock", () => {
    const commented = censusInserts(singleFile("server/src/services/future-writer.ts", `
      export async function insertLive(tx) {
        // await tx.insert(heartbeatRuns).values({ status: "queued" });
        /* from(issues).for("update") */
      }
    `));
    expect(commented).toEqual([]);
  });

  it("rejects a restore grant that updates the assignee without the issue lock", () => {
    const unlocked = censusGrants(singleFile("server/src/routes/issues.ts", `
      router.post("/issues/:id/restore-participant", async (req, res) => {
        await db.transaction(async (tx) => {
          await tx.update(issueRows).set({ assigneeAgentId: agent.id, updatedAt: new Date() });
          await log({ action: "issue.participant_restored" });
        });
      });
    `));
    expect(unlocked.map((site) => site.locked)).toEqual([false, false]);

    const locked = censusGrants(singleFile("server/src/routes/issues.ts", `
      router.post("/issues/:id/restore-participant", async (req, res) => {
        await db.transaction(async (tx) => {
          await tx.select().from(issueRows).where(eq(issueRows.id, id)).for("update");
          await tx.update(issueRows).set({ assigneeAgentId: agent.id, updatedAt: new Date() });
          await log({ action: "issue.participant_restored" });
        });
      });
    `));
    expect(locked.map((site) => site.locked)).toEqual([true, true]);
  });

  it("keeps every current application writer and the restore grant lock-covered", () => {
    const files = loadProduction();
    const inserts = censusInserts(files);
    const grants = censusGrants(files);
    const uncovered = inserts.filter((site) => site.coverage === "uncovered");
    const statusCas = inserts.filter((site) => site.coverage === "status-cas");
    const unlockedGrants = grants.filter((site) => !site.locked);

    expect(inserts.length).toBeGreaterThan(0);
    expect(uncovered, "an application live-run insert does not take the issue lock in its transaction").toEqual([]);
    expect(statusCas.map((site) => site.file)).toEqual([SELF_DECLARED_RUN]);
    expect(grants.length).toBeGreaterThan(0);
    expect(unlockedGrants, "a pending-participant restore grant does not take the issue lock before the write").toEqual([]);
    expect(grants.some((site) => site.kind === "route" && site.locked)).toBe(true);
    expect(grants.some((site) => site.kind === "activity" && site.locked)).toBe(true);
  });
});
