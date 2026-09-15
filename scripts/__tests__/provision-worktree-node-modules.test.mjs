import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// SUP-16336: the fleet runtime re-seeded the worktree node_modules bin targets as
// the server uid, so every agent-side `pnpm install` EPERM'd and forced a full
// re-materialization. The provision script must (1) run the worktree install as
// the consuming agent uid via the setuid shim when one is present, and (2) stop
// re-materializing a populated, fingerprint-matched tree just because the base
// checkout has a node_modules path the branch's own lockfile no longer carries.
//
// These tests drive the real scripts/provision-worktree.sh against a disposable
// worktree. A stub `pnpm` on PATH records every invocation so the tests can tell
// a first materialization (an `install` call) from a reuse (no `install` call).
// No second uid is required: when the process uid equals the shim's drop uid (or
// no shim is present), the script falls back to a current-uid install, which is
// the same code path the fleet takes for the tree it already owns.

const script = new URL("../provision-worktree.sh", import.meta.url).pathname;

const cleanupDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

// Expose node through an otherwise-empty directory so a globally installed
// `paperclipai` cannot shadow the stub pnpm under test.
const nodeOnlyBin = makeTempDir("paperclip-nm-nodebin-");
fs.symlinkSync(process.execPath, path.join(nodeOnlyBin, "node"));

test.after(() => {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makePnpmStub(auditDir) {
  const stubDir = makeTempDir("paperclip-nm-pnpm-");
  const stub = path.join(stubDir, "pnpm");
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bash\n` +
      `echo "PNPM $*" >> "\${PNPMAUDIT:-/tmp}/calls.log"\n` +
      `exit 0\n`,
    { mode: 0o755 },
  );
  return stubDir;
}

function makeInstanceHome() {
  const home = makeTempDir("paperclip-nm-home-");
  fs.mkdirSync(path.join(home, "instances", "default"), { recursive: true });
  fs.writeFileSync(path.join(home, "instances", "default", "config.json"), "{}\n");
  return home;
}

// A base checkout that carries a node_modules path the worktree's own lockfile
// does not. Under the pre-SUP-16336 base-path enumeration this missing path was
// enough to force a full reinstall on every dispatch.
function makeBaseWithStrayNodeModules() {
  const baseCwd = makeTempDir("paperclip-nm-base-");
  fs.mkdirSync(path.join(baseCwd, "packages", "only-in-base", "node_modules", "stray-pkg"), {
    recursive: true,
  });
  return baseCwd;
}

// A seeded worktree whose node_modules is already populated and agent-owned.
// Pre-seeding .paperclip lets provision reach the install-decision block without
// depending on a real CLI, while the populated tree + matching fingerprint is the
// steady state the fix must preserve.
function makePopulatedWorktree({ withFingerprint }) {
  const worktreeCwd = makeTempDir("paperclip-nm-wt-");
  fs.mkdirSync(path.join(worktreeCwd, ".paperclip"), { recursive: true });
  fs.writeFileSync(
    path.join(worktreeCwd, "package.json"),
    JSON.stringify({ name: "wt-nm-test", version: "0.0.0", private: true, devDependencies: {} }) + "\n",
  );
  fs.writeFileSync(path.join(worktreeCwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

  const nodeModules = path.join(worktreeCwd, "node_modules");
  fs.mkdirSync(nodeModules, { recursive: true });
  fs.writeFileSync(path.join(nodeModules, ".modules.yaml"), "# populated\n");
  fs.writeFileSync(path.join(nodeModules, "SUP16336-SURVIVE-MARKER"), "sentinel\n");

  fs.writeFileSync(
    path.join(worktreeCwd, ".paperclip", "config.json"),
    JSON.stringify({ $meta: { source: "preseeded" } }) + "\n",
  );
  fs.writeFileSync(path.join(worktreeCwd, ".paperclip", ".env"), "PAPERCLIP_IN_WORKTREE=true\n");
  fs.writeFileSync(path.join(worktreeCwd, ".paperclip", "seed-complete"), "{}\n");
  if (withFingerprint) {
    fs.writeFileSync(path.join(worktreeCwd, ".paperclip", "pnpm-install-fingerprint"), "seeded\n");
  }
  return worktreeCwd;
}

function runProvision({ baseCwd, worktreeCwd, pnpmStubDir, auditDir }) {
  const instanceHome = makeInstanceHome();
  return spawnSync("bash", [script], {
    cwd: worktreeCwd,
    encoding: "utf8",
    env: {
      PATH: [pnpmStubDir, nodeOnlyBin, "/usr/bin", "/bin"].join(":"),
      HOME: os.homedir(),
      PAPERCLIP_WORKSPACE_BASE_CWD: baseCwd,
      PAPERCLIP_WORKSPACE_CWD: worktreeCwd,
      PAPERCLIP_WORKSPACE_BRANCH: "feature/nm-test",
      PAPERCLIP_WORKTREES_DIR: makeTempDir("paperclip-nm-worktrees-"),
      PAPERCLIP_HOME: instanceHome,
      PAPERCLIP_PROJECT_WORKSPACE_ID: "project-nm-1",
      PAPERCLIP_SEED_EXPECTED_COMPANY_ID: "company-nm-1",
      PNPMAUDIT: auditDir,
    },
  });
}

function countInstallCalls(auditDir) {
  const log = path.join(auditDir, "calls.log");
  if (!fs.existsSync(log)) return 0;
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("PNPM install")).length;
}

test("first dispatch materializes the worktree tree; second dispatch reuses it", () => {
  const baseCwd = makeBaseWithStrayNodeModules();
  const worktreeCwd = makePopulatedWorktree({ withFingerprint: false });
  const pnpmStubDir = makePnpmStub();
  const auditDir = makeTempDir("paperclip-nm-audit-");
  const marker = path.join(worktreeCwd, "node_modules", "SUP16336-SURVIVE-MARKER");

  const first = runProvision({ baseCwd, worktreeCwd, pnpmStubDir, auditDir });
  assert.equal(first.status, 0, `first dispatch should succeed:\n${first.stdout}\n${first.stderr}`);
  // A populated-but-fingerprint-mismatched tree is (re)materialized once.
  assert.equal(countInstallCalls(auditDir), 1, "first dispatch must run pnpm install exactly once");
  assert.ok(fs.existsSync(marker), "the pre-seeded tree marker must survive the first materialization");

  fs.rmSync(path.join(auditDir, "calls.log"), { force: true });
  const second = runProvision({ baseCwd, worktreeCwd, pnpmStubDir, auditDir });
  assert.equal(second.status, 0, `second dispatch should succeed:\n${second.stdout}\n${second.stderr}`);
  // The core SUP-16336 regression: the base's stray node_modules path must NOT
  // force a second materialization of a populated, fingerprint-matched tree.
  assert.equal(
    countInstallCalls(auditDir),
    0,
    "second dispatch must not re-run pnpm install on a populated, fingerprint-matched tree",
  );
  assert.ok(fs.existsSync(marker), "the tree must not be re-materialized on the second dispatch");
});

test("an absent tree still triggers an install", () => {
  const baseCwd = makeBaseWithStrayNodeModules();
  const worktreeCwd = makePopulatedWorktree({ withFingerprint: false });
  // Remove the populated tree so the worktree genuinely has nothing to reuse.
  fs.rmSync(path.join(worktreeCwd, "node_modules"), { recursive: true, force: true });
  const pnpmStubDir = makePnpmStub();
  const auditDir = makeTempDir("paperclip-nm-audit-");

  const result = runProvision({ baseCwd, worktreeCwd, pnpmStubDir, auditDir });
  assert.equal(result.status, 0, `dispatch should succeed:\n${result.stdout}\n${result.stderr}`);
  assert.equal(countInstallCalls(auditDir), 1, "an absent tree must still trigger pnpm install");
});
