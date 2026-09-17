#!/usr/bin/env node
/**
 * check-server-test-typecheck.mjs
 *
 * Baseline-aware type-check gate for the server test suite.
 *
 * `server/tsconfig.json` excludes `src/__tests__`, and the root `pnpm
 * typecheck` chain stops at the runner cargo build before it reaches the
 * server workspace, so the server test files were never type-checked by CI.
 * This check runs `tsc --noEmit -p server/src/__tests__/tsconfig.json`
 * directly (TypeScript only, no cargo) and compares the diagnostics against a
 * recorded baseline.
 *
 * The suite carries pre-existing upstream type errors (recorded in
 * `server/src/__tests__/typecheck-baseline.txt`, see SUP-16604). The gate
 * fails only on diagnostics that are NOT in that baseline, so it protects the
 * fork-owned tests from new type errors without freezing every merge on the
 * upstream debt. Diagnostics are compared as `file(line,column): TScode` with
 * the message text stripped, so a reworded message does not trip the gate.
 *
 * Re-record the baseline after intentionally changing the error set:
 *   node scripts/check-server-test-typecheck.mjs --update
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const TSCONFIG_RELATIVE_PATH = "server/src/__tests__/tsconfig.json";
export const BASELINE_RELATIVE_PATH = "server/src/__tests__/typecheck-baseline.txt";
export const TSC_RELATIVE_PATH = "node_modules/typescript/bin/tsc";

const ERROR_LINE_PATTERN = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/;
const MAX_LISTED = 40;

/**
 * Reduce raw tsc output to the sorted set of `file(line,column): TScode`
 * entries. The diagnostic message is dropped and continuation lines (which
 * are indented and carry no location) are ignored.
 */
export function extractTypeErrors(tscOutput) {
  const entries = new Set();
  for (const rawLine of tscOutput.split(/\r?\n/)) {
    const match = ERROR_LINE_PATTERN.exec(rawLine);
    if (!match) continue;
    const [, file, line, column, code] = match;
    entries.add(`${file}(${line},${column}): ${code}`);
  }
  return [...entries].sort();
}

/** Parse a baseline file: blank lines and `#` comments are ignored. */
export function parseBaseline(text) {
  const entries = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    entries.add(line);
  }
  return entries;
}

export function compareAgainstBaseline(actual, baseline) {
  const actualSet = new Set(actual);
  const baselineSet = baseline instanceof Set ? baseline : new Set(baseline);
  return {
    newErrors: actual.filter((entry) => !baselineSet.has(entry)),
    staleEntries: [...baselineSet].filter((entry) => !actualSet.has(entry)),
  };
}

export function renderBaseline(entries) {
  const header = [
    "# Recorded type errors for server/src/__tests__/tsconfig.json (baseline).",
    "#",
    "# Each line is `<file>(<line>,<column>): <TS code>` with the diagnostic",
    "# message stripped, so the baseline reacts to an error appearing, moving or",
    "# disappearing, not to a reworded message.",
    "#",
    "# These are pre-existing upstream test-type errors, not fork regressions;",
    "# see SUP-16604. Any error that is NOT listed here fails",
    "# `pnpm run check:server-test-typecheck`.",
    "#",
    "# Regenerate from the repository root:",
    "#   node scripts/check-server-test-typecheck.mjs --update",
  ].join("\n");
  return `${header}\n${entries.join("\n")}\n`;
}

export function runTsc({ repoRoot, spawn = spawnSync } = {}) {
  return spawn(
    process.execPath,
    [path.join(repoRoot, TSC_RELATIVE_PATH), "--noEmit", "-p", TSCONFIG_RELATIVE_PATH],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
}

export function runCheck({
  repoRoot = process.cwd(),
  update = false,
  log = console.log,
  error = console.error,
  spawn = spawnSync,
} = {}) {
  const baselinePath = path.join(repoRoot, BASELINE_RELATIVE_PATH);
  const tscResult = runTsc({ repoRoot, spawn });
  if (tscResult.error) {
    error(`ERROR: could not run tsc: ${tscResult.error.message}`);
    return 1;
  }

  const output = `${tscResult.stdout ?? ""}${tscResult.stderr ?? ""}`;
  const actual = extractTypeErrors(output);

  if (update) {
    mkdirSync(path.dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, renderBaseline(actual), "utf8");
    log(`  ✓  Recorded ${actual.length} server-test type error(s) to ${BASELINE_RELATIVE_PATH}.`);
    return 0;
  }

  if (tscResult.status !== 0 && actual.length === 0) {
    error("ERROR: tsc failed without reporting a located type error (configuration problem or crash):\n");
    error(output.trim() || "(no output)");
    return 1;
  }

  let baseline;
  try {
    baseline = parseBaseline(readFileSync(baselinePath, "utf8"));
  } catch {
    error(`ERROR: baseline file not found: ${BASELINE_RELATIVE_PATH}`);
    error("Record it from the repository root with: node scripts/check-server-test-typecheck.mjs --update");
    return 1;
  }

  const { newErrors, staleEntries } = compareAgainstBaseline(actual, baseline);

  if (newErrors.length > 0) {
    error(`ERROR: ${newErrors.length} new server-test type error(s) not in ${BASELINE_RELATIVE_PATH}:`);
    for (const entry of newErrors.slice(0, MAX_LISTED)) error(`  ${entry}`);
    if (newErrors.length > MAX_LISTED) error(`  ... and ${newErrors.length - MAX_LISTED} more.`);
    error("");
    error("Fix the new errors. If they are genuinely pre-existing upstream debt,");
    error("re-record the baseline with: node scripts/check-server-test-typecheck.mjs --update");
    return 1;
  }

  log(
    `  ✓  No new server-test type errors (${actual.length} known baseline error(s) recorded).`,
  );
  if (staleEntries.length > 0) {
    log(
      `  … ${staleEntries.length} baseline entr${staleEntries.length === 1 ? "y" : "ies"} no longer reported; refresh with --update when convenient.`,
    );
  }
  return 0;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  process.exit(runCheck({ repoRoot: process.cwd(), update: process.argv.includes("--update") }));
}
