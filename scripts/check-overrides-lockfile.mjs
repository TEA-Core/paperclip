#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A PR that edits `pnpm.overrides` in the root package.json without also
// updating pnpm-lock.yaml merges a base whose committed lockfile no longer
// matches its manifests. Every later `pnpm install --frozen-lockfile` on the
// deployed line — and every merge-queue entry — then fails with
// ERR_PNPM_LOCKFILE_CONFIG_MISMATCH. pr.yml's policy job would paper over that
// for the PR's own checks by regenerating a throwaway `pr-lockfile` artifact,
// so the PR stays green while the base it merges is broken. This guard fails
// the PR instead, so the author updates the lockfile before merge.

export function extractPnpmOverrides(packageJsonText) {
  const pkg = JSON.parse(packageJsonText);
  return JSON.stringify(pkg.pnpm?.overrides ?? null);
}

export const OVERRIDES_WITHOUT_LOCKFILE_MESSAGE = [
  "pnpm.overrides changed in package.json but pnpm-lock.yaml was not updated.",
  "",
  "An overrides change that merges without a matching lockfile update breaks every",
  "later `pnpm install --frozen-lockfile` on the deployed line — and every merge-queue",
  "entry — with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH. CI regenerates a throwaway lockfile",
  "to keep this PR's own checks green, but the merged base stays broken.",
  "",
  "Fix: regenerate the lockfile and include it in this PR, then re-run CI:",
  "  pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile",
  "  git add pnpm-lock.yaml",
  "(Commit the lockfile through a chore/refresh-lockfile or fold-sync branch — the flows",
  "exempt from the manual-lockfile-edit guard.)",
].join("\n");

export function evaluateOverridesGuard({ changedFiles, baseOverrides, headOverrides }) {
  if (changedFiles.includes("pnpm-lock.yaml")) {
    return { ok: true, reason: "pnpm-lock.yaml changed in this diff; overrides guard satisfied." };
  }

  if (!changedFiles.includes("package.json")) {
    return { ok: true, reason: "root package.json unchanged in this diff; overrides guard satisfied." };
  }

  if (baseOverrides !== headOverrides) {
    return { ok: false, reason: OVERRIDES_WITHOUT_LOCKFILE_MESSAGE };
  }

  return { ok: true, reason: "pnpm.overrides unchanged; ok." };
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function main() {
  const base = process.env.BASE_SHA;
  const head = process.env.HEAD_SHA;
  if (!base || !head) {
    console.error("check-overrides-lockfile: BASE_SHA and HEAD_SHA must be set.");
    process.exit(2);
  }

  const changedFiles = git(["diff", "--name-only", `${base}...${head}`])
    .split("\n")
    .filter(Boolean);

  let baseOverrides = null;
  let headOverrides = null;
  if (changedFiles.includes("package.json")) {
    baseOverrides = extractPnpmOverrides(git(["show", `${base}:package.json`]));
    headOverrides = extractPnpmOverrides(git(["show", `${head}:package.json`]));
  }

  const result = evaluateOverridesGuard({ changedFiles, baseOverrides, headOverrides });
  if (!result.ok) {
    console.error(result.reason);
    process.exit(1);
  }

  console.log(result.reason);
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  main();
}
