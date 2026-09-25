import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Ratchet guard (SUP-17465): no service module may decide "am I already inside
 * a transaction?" by comparing a db-or-tx handle against the pool `db`
 * constructor with `===` / `!==`.
 *
 * `db.transaction(cb)` hands `cb` a `PgTransaction` that is *never* `=== db`,
 * and a pool-less caller (or a test stub) is not the pool handle either, so
 * every such identity check mis-classifies at least one of the two real
 * callers. The supported predicate is `isTransactionHandle()` from
 * `server/src/services/db-handle.ts`; the constructor check is a latent bug
 * that only fires when a caller starts passing a real transaction handle.
 *
 * Scope: every `*.ts` under `server/src/services/` (recursive). The scanner is
 * comment-aware — a commented-out offender or prose mentioning the shape is
 * NOT a violation (AC1 is a code-level census) — but it is deliberately
 * text-based rather than AST-aware, so it matches the shape wherever it
 * appears in live code, including inside a string it cannot tell apart from
 * code.
 *
 * The allowlist is empty and MUST stay empty: this card's premise is that the
 * three SUP-16541 consumer children plus SUP-17462 already migrated every
 * pre-existing discriminator, so a fresh offender is a regression. Never add
 * an entry — migrate the site to `isTransactionHandle()` instead.
 *
 * Documented exception (stated per the card): the one non-transaction identity
 * check in `agents.ts` is intentional memoization — `syncAgentSecretBindings`
 * compares its injected `dbClient` against the pool `db` to choose a cached
 * secrets service, not to ask "am I in a transaction?". It is matched by idiom
 * so it survives line drift; it is not a general exemption for that file.
 */
const servicesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "services",
);

const TX_IDENTITY_CHECK = /(?:===|!==)[ \t]*db\b/g;

/** The agents.ts memoization idiom, exempted by content rather than line. */
const AGENTS_MEMOIZATION_EXCEPTION = /dbClient === db \? secretsSvc : secretService\(dbClient\)/;

/**
 * Blanks out `//`, `/* ... *\/` and string/template literals while preserving
 * line breaks, so reported line numbers still map to the original file.
 */
export function stripCommentsAndStrings(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") { state = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && next === "*") { state = "block"; out += "  "; i += 2; continue; }
      if (c === "'") { state = "single"; out += c; i += 1; continue; }
      if (c === '"') { state = "double"; out += c; i += 1; continue; }
      if (c === "`") { state = "template"; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += c; i += 1; continue; }
      out += " "; i += 1; continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") { state = "code"; out += "  "; i += 2; continue; }
      out += c === "\n" ? "\n" : " "; i += 1; continue;
    }
    if (c === "\\") { out += "  "; i += 2; continue; }
    if (
      (state === "single" && c === "'")
      || (state === "double" && c === '"')
      || (state === "template" && c === "`")
    ) { state = "code"; out += c; i += 1; continue; }
    out += c === "\n" ? "\n" : " "; i += 1; continue;
  }
  return out;
}

/** 1-based line numbers of every live tx-identity check in `source`. */
export function findTxIdentityChecks(source: string): number[] {
  const code = stripCommentsAndStrings(source);
  const lines: number[] = [];
  for (const match of code.matchAll(TX_IDENTITY_CHECK)) {
    lines.push(code.slice(0, match.index!).split("\n").length);
  }
  return lines;
}

function listServiceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listServiceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

describe("no service module discriminates a transaction by `=== db`", () => {
  it("matches every live tx-identity shape and ignores comments", () => {
    expect(findTxIdentityChecks("if (dbOrTx === db) { open(); }")).toEqual([1]);
    expect(findTxIdentityChecks("return dbOrTx !== db ? publish() : null;")).toEqual([1]);
    expect(findTxIdentityChecks("const t = executor === db ? null : executor;")).toEqual([1]);
    expect(findTxIdentityChecks("a\nb\n  if (dbOrTx !== db) throw new Error('x');")).toEqual([3]);
    expect(
      findTxIdentityChecks("if (dbOrTx === db) {}\nif (executor !== db) {}"),
    ).toEqual([1, 2]);

    // Not violations: comments, string content, and a different identifier.
    expect(findTxIdentityChecks("// dbOrTx === db was the old check")).toEqual([]);
    expect(findTxIdentityChecks("/* dbOrTx !== db */ const x = 1;")).toEqual([]);
    expect(findTxIdentityChecks("const msg = 'dbOrTx === db';")).toEqual([]);
    expect(findTxIdentityChecks("if (dbOrTx === dbase) {}")).toEqual([]);
    expect(findTxIdentityChecks("if (dbOrTx === pool) {}")).toEqual([]);
  });

  it("treats the agents.ts memoization check as a documented exception", () => {
    expect(
      findTxIdentityChecks(
        "const scopedSecretsSvc = dbClient === db ? secretsSvc : secretService(dbClient);",
      ),
    ).toEqual([1]);
    expect(
      AGENTS_MEMOIZATION_EXCEPTION.test(
        "const scopedSecretsSvc = dbClient === db ? secretsSvc : secretService(dbClient);",
      ),
    ).toBe(true);
  });

  it("has no service module discriminating a transaction by identity", () => {
    const offenders: string[] = [];
    for (const full of listServiceFiles(servicesDir)) {
      const repoPath = path.relative(path.join(servicesDir, "..", "..", ".."), full);
      const source = readFileSync(full, "utf-8");
      for (const line of findTxIdentityChecks(source)) {
        const text = source.split("\n")[line - 1] ?? "";
        if (AGENTS_MEMOIZATION_EXCEPTION.test(text)) continue;
        offenders.push(`${repoPath}:${line}`);
      }
    }
    expect(
      offenders,
      "These service modules classify a db-or-tx handle with `=== db` / "
        + "`!== db`. That check is wrong for a real `db.transaction()` handle "
        + "(and for a pool-less caller), so it is a latent bug. Use "
        + "`isTransactionHandle()` from `server/src/services/db-handle.ts`. "
        + "The allowlist is empty by design and may never grow.",
    ).toEqual([]);
  });
});
