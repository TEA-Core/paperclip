import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateOverridesGuard,
  extractPnpmOverrides,
} from "./check-overrides-lockfile.mjs";

test("extractPnpmOverrides reads the pnpm.overrides section", () => {
  const pkg = JSON.stringify({ pnpm: { overrides: { undici: "^7.29.0" } } });
  assert.equal(extractPnpmOverrides(pkg), JSON.stringify({ undici: "^7.29.0" }));
});

test("extractPnpmOverrides is null when pnpm.overrides is absent", () => {
  assert.equal(extractPnpmOverrides(JSON.stringify({ name: "x" })), "null");
});

test("guard passes when pnpm-lock.yaml changed", () => {
  const result = evaluateOverridesGuard({
    changedFiles: ["package.json", "pnpm-lock.yaml"],
    baseOverrides: "{}",
    headOverrides: "{}",
  });
  assert.equal(result.ok, true);
});

test("guard passes when root package.json is unchanged", () => {
  const result = evaluateOverridesGuard({
    changedFiles: ["server/src/index.ts"],
    baseOverrides: null,
    headOverrides: null,
  });
  assert.equal(result.ok, true);
});

test("guard passes when overrides are unchanged", () => {
  const result = evaluateOverridesGuard({
    changedFiles: ["package.json"],
    baseOverrides: '{"undici":"^7.29.0"}',
    headOverrides: '{"undici":"^7.29.0"}',
  });
  assert.equal(result.ok, true);
});

test("guard fails when overrides changed without a lockfile update", () => {
  const result = evaluateOverridesGuard({
    changedFiles: ["package.json"],
    baseOverrides: '{"undici":"^7.0.0"}',
    headOverrides: '{"undici":"^7.29.0"}',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /pnpm\.overrides changed/);
});
