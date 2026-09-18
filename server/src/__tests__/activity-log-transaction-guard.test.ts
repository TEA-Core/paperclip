import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * SUP-9856 / SUP-16540 guard.
 *
 * `logActivity` is best-effort by design: it swallows every failure so that an
 * audit outage can never decide a mutation. Inside a transaction that is wrong.
 * Postgres aborts the whole transaction the moment the audit insert fails, so a
 * caller that keeps going either commits the mutation without its audit row or
 * reports success on a silent rollback. Transaction-scoped audits must use
 * `logActivityInTransaction`, which rethrows and therefore shares the mutation's
 * fate.
 *
 * This is a static scan, not a runtime test: it walks `server/src` (tests and
 * the `activity-log` definitions excluded) and fails on any `logActivity(...)`
 * whose first argument is a transaction handle. It can only go green once every
 * in-transaction site has been converted — and it keeps them converted.
 *
 * `dbOrTx` is included: it is a propagated handle that is a transaction whenever
 * it is not the service's own pool (`dbOrTx !== db`), so a direct
 * `logActivity(dbOrTx, ...)` is a violation. The sanctioned form dispatches on
 * `dbOrTx === db` (see `issues.addComment`'s expiry audit), which the scanner
 * does not flag because `logActivity` is not directly called there.
 */
const SERVER_SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const TRANSACTION_HANDLE_NAMES = new Set(["tx", "txDb", "transactionDb", "dbOrTx"]);
// `logActivityInTransaction(` does not match: the `(` must follow `logActivity`.
const CALL_RE = /\blogActivity\s*\(/g;
const FIRST_ARG_RE = /^\s*([A-Za-z_$][\w$]*)/;

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      collectSourceFiles(full, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    if (entry.name === "activity-log.ts") continue;
    acc.push(full);
  }
  return acc;
}

function findInTransactionAudits(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const violations: string[] = [];
  for (const match of source.matchAll(CALL_RE)) {
    const after = source.slice((match.index ?? 0) + match[0].length);
    const firstArg = FIRST_ARG_RE.exec(after)?.[1];
    if (!firstArg || !TRANSACTION_HANDLE_NAMES.has(firstArg)) continue;
    const line = source.slice(0, match.index).split("\n").length;
    violations.push(`${relative(SERVER_SRC, file)}:${line} passes \`${firstArg}\``);
  }
  return violations;
}

describe("logActivity transaction guard", () => {
  it("has no best-effort logActivity call on a transaction handle", () => {
    const violations = collectSourceFiles(SERVER_SRC).flatMap(findInTransactionAudits);
    expect(violations).toEqual([]);
  });
});
