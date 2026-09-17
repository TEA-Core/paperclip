import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BASELINE_RELATIVE_PATH,
  compareAgainstBaseline,
  extractTypeErrors,
  parseBaseline,
  renderBaseline,
  runCheck,
} from "./check-server-test-typecheck.mjs";

const TSC_OUTPUT = [
  "server/src/__tests__/alpha.test.ts(10,5): error TS2345: Argument of type 'string' is not assignable.",
  "  Type 'string' is not assignable to type 'number'.",
  "server/src/__tests__/alpha.test.ts(10,5): error TS2345: Argument of type 'string' is not assignable.",
  "server/src/__tests__/beta.test.ts(2,11): error TS2741: Property 'envVars' is missing.",
  "",
  "Found 2 errors in 2 files.",
].join("\n");

function withTempRepo(fn) {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "server-test-typecheck-"));
  try {
    return fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function writeBaseline(repoRoot, entries) {
  const file = path.join(repoRoot, BASELINE_RELATIVE_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, renderBaseline(entries), "utf8");
  return file;
}

function fakeSpawn({ status = 1, stdout = "", stderr = "" } = {}) {
  return () => ({ status, stdout, stderr });
}

test("extractTypeErrors keeps location and code, drops messages and duplicates", () => {
  assert.deepEqual(extractTypeErrors(TSC_OUTPUT), [
    "server/src/__tests__/alpha.test.ts(10,5): TS2345",
    "server/src/__tests__/beta.test.ts(2,11): TS2741",
  ]);
});

test("extractTypeErrors captures config-level diagnostics on non-.ts files", () => {
  const output = "server/src/__tests__/tsconfig.json(5,5): error TS5096: Option needs noEmit.";
  assert.deepEqual(extractTypeErrors(output), [
    "server/src/__tests__/tsconfig.json(5,5): TS5096",
  ]);
});

test("parseBaseline ignores comments and blank lines", () => {
  const parsed = parseBaseline("# comment\n\nserver/src/__tests__/a.test.ts(1,1): TS1\n  \n");
  assert.deepEqual([...parsed], ["server/src/__tests__/a.test.ts(1,1): TS1"]);
});

test("compareAgainstBaseline classifies new and stale entries", () => {
  const baseline = new Set(["a(1,1): TS1", "b(2,2): TS2"]);
  const { newErrors, staleEntries } = compareAgainstBaseline(["a(1,1): TS1", "c(3,3): TS3"], baseline);
  assert.deepEqual(newErrors, ["c(3,3): TS3"]);
  assert.deepEqual(staleEntries, ["b(2,2): TS2"]);
});

test("renderBaseline writes a comment header and every entry", () => {
  const rendered = renderBaseline(["a(1,1): TS1"]);
  assert.match(rendered, /^# Recorded type errors/);
  assert.ok(rendered.endsWith("a(1,1): TS1\n"));
});

test("runCheck passes when every diagnostic is in the baseline", () => {
  withTempRepo((repoRoot) => {
    writeBaseline(repoRoot, extractTypeErrors(TSC_OUTPUT));
    const logs = [];
    const code = runCheck({
      repoRoot,
      spawn: fakeSpawn({ stdout: TSC_OUTPUT }),
      log: (line) => logs.push(line),
      error: () => {},
    });
    assert.equal(code, 0);
    assert.ok(logs.some((line) => line.includes("No new server-test type errors")));
  });
});

test("runCheck fails and names an unbaselined diagnostic", () => {
  withTempRepo((repoRoot) => {
    writeBaseline(repoRoot, ["server/src/__tests__/alpha.test.ts(10,5): TS2345"]);
    const errors = [];
    const code = runCheck({
      repoRoot,
      spawn: fakeSpawn({ stdout: TSC_OUTPUT }),
      log: () => {},
      error: (line) => errors.push(line),
    });
    assert.equal(code, 1);
    assert.ok(errors.some((line) => line.includes("1 new server-test type error")));
    assert.ok(errors.some((line) => line.includes("beta.test.ts(2,11): TS2741")));
  });
});

test("runCheck fails on a tsc configuration failure with no located errors", () => {
  withTempRepo((repoRoot) => {
    writeBaseline(repoRoot, []);
    const errors = [];
    const code = runCheck({
      repoRoot,
      spawn: fakeSpawn({ status: 2, stderr: "error TS5096: Option 'allowImportingTsExtensions' requires noEmit." }),
      log: () => {},
      error: (line) => errors.push(line),
    });
    assert.equal(code, 1);
    assert.ok(errors.some((line) => line.includes("without reporting a located type error")));
  });
});

test("runCheck fails when the baseline file is missing", () => {
  withTempRepo((repoRoot) => {
    const errors = [];
    const code = runCheck({
      repoRoot,
      spawn: fakeSpawn({ stdout: TSC_OUTPUT }),
      log: () => {},
      error: (line) => errors.push(line),
    });
    assert.equal(code, 1);
    assert.ok(errors.some((line) => line.includes("baseline file not found")));
  });
});

test("runCheck --update records the current diagnostics", () => {
  withTempRepo((repoRoot) => {
    const code = runCheck({
      repoRoot,
      update: true,
      spawn: fakeSpawn({ stdout: TSC_OUTPUT }),
      log: () => {},
      error: () => {},
    });
    assert.equal(code, 0);
    const written = readFileSync(path.join(repoRoot, BASELINE_RELATIVE_PATH), "utf8");
    assert.deepEqual(parseBaseline(written), new Set(extractTypeErrors(TSC_OUTPUT)));
  });
});
