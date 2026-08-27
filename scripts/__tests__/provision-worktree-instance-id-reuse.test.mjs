import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = new URL("../provision-worktree.sh", import.meta.url).pathname;

// SUP-14156 made the derived instance id canonical. It did not make the reuse
// check accept the ids that were written before that, and those are still on
// disk: any worktree provisioned while the 48-character truncation left a
// trailing "-" carries the CLI-sanitised spelling in .paperclip/.env.
//
// The check compares that stored id against the freshly derived one and reports:
//
//   existing worktree env names legacy or mismatched instance
//     sup-14139-…-has-no-7fcc21a9cb33, expected sup-14139-…-has-no--7fcc21a9cb33
//
// The verdict is not a warning. It sends the script down the "stale for this
// host" branch, which runs `worktree init --force` and destroys that worktree's
// isolated database — on every dispatch, because both spellings name the same
// instance directory and neither side ever converges on the other.
//
// The two spellings are one instance. Compare them as one.

const WEDGING_BRANCH =
  "SUP-14139-execution-workspace-allocation-has-no-path-exclusivity-two-active-rows";

const cleanupDirs = [];
test.after(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

const nodeOnlyBin = makeTempDir("paperclip-instance-reuse-nodebin-");
fs.symlinkSync(process.execPath, path.join(nodeOnlyBin, "node"));
const testPath = [nodeOnlyBin, "/usr/bin", "/bin"].join(":");

/**
 * The pre-SUP-14156 spelling, as `write_fallback_worktree_config` stored it.
 *
 * The CLI path collapsed the doubled separator on its way into .env, so those
 * worktrees already read as canonical. The fallback path — taken whenever no
 * usable `paperclipai` CLI is found — writes WORKTREE_INSTANCE_ID through
 * unchanged, so it is the fallback-provisioned worktrees that still carry "--".
 */
function legacyStoredInstanceId(worktreeCwd) {
  const normalized = path.basename(worktreeCwd)
    .trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  const prefix = (normalized || "worktree").slice(0, 48);
  const pathHash = crypto.createHash("sha256").update(worktreeCwd).digest("hex").slice(0, 12);
  return `${prefix}-${pathHash}`;
}

/** A worktree provisioned before the derivation was made canonical. */
function makeLegacyWorktree(branch) {
  const parent = makeTempDir("paperclip-instance-reuse-parent-");
  const worktreeCwd = path.join(parent, branch);
  fs.mkdirSync(path.join(worktreeCwd, ".paperclip"), { recursive: true });

  const storedInstanceId = legacyStoredInstanceId(worktreeCwd);
  const worktreesHome = makeTempDir("paperclip-instance-reuse-home-");
  const instanceRoot = path.join(worktreesHome, "instances", storedInstanceId);
  fs.mkdirSync(path.join(instanceRoot, "data"), { recursive: true });

  const configPath = path.join(worktreeCwd, ".paperclip", "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      database: { embeddedPostgresDataDir: path.join(instanceRoot, "data") },
      logging: { logDir: path.join(instanceRoot, "logs") },
    }),
  );
  fs.writeFileSync(
    path.join(worktreeCwd, ".paperclip", ".env"),
    `PAPERCLIP_CONFIG=${configPath}\nPAPERCLIP_HOME=${worktreesHome}\nPAPERCLIP_INSTANCE_ID=${storedInstanceId}\n`,
  );

  return { worktreeCwd, worktreesHome, storedInstanceId };
}

function runProvision({ worktreeCwd, worktreesHome }, branch) {
  // No CLI anywhere on the PATH: the reuse decision is made before any CLI is
  // reached, so this keeps the run short and the signal specific to the check.
  const baseCwd = makeTempDir("paperclip-instance-reuse-base-");
  return spawnSync("bash", [script], {
    cwd: worktreeCwd,
    encoding: "utf8",
    env: {
      PATH: testPath,
      HOME: os.homedir(),
      PAPERCLIP_WORKSPACE_BASE_CWD: baseCwd,
      PAPERCLIP_WORKSPACE_CWD: worktreeCwd,
      PAPERCLIP_WORKSPACE_BRANCH: branch,
      PAPERCLIP_WORKTREES_DIR: worktreesHome,
      PAPERCLIP_HOME: worktreesHome,
    },
  });
}

/** The canonical spelling, as scripts/provision-worktree.sh derives it today. */
function canonicalInstanceId(worktreeCwd) {
  const normalized = path.basename(worktreeCwd)
    .trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  const prefix = (normalized || "worktree").slice(0, 48).replace(/-+$/, "");
  const pathHash = crypto.createHash("sha256").update(worktreeCwd).digest("hex").slice(0, 12);
  return `${prefix}-${pathHash}`;
}

test("the fixture really does predate the canonical derivation", () => {
  // Guard the guard. The whole point is a stored id the current derivation does
  // not reproduce; if the two ever agree, every assertion below passes whatever
  // the check does.
  const worktree = makeLegacyWorktree(WEDGING_BRANCH);
  assert.notEqual(worktree.storedInstanceId, canonicalInstanceId(worktree.worktreeCwd));
  assert.ok(worktree.storedInstanceId.includes("--"), worktree.storedInstanceId);
  assert.equal(
    worktree.storedInstanceId.replace(/-+/g, "-"),
    canonicalInstanceId(worktree.worktreeCwd).replace(/-+/g, "-"),
    "the two spellings must name one instance — otherwise this is a foreign id, not a legacy one",
  );
});

test("reuses a worktree whose stored id predates the canonical derivation", () => {
  const worktree = makeLegacyWorktree(WEDGING_BRANCH);
  const result = runProvision(worktree, WEDGING_BRANCH);

  assert.doesNotMatch(
    result.stderr,
    /legacy or mismatched instance/,
    `provisioning rejected an id naming its own instance:\n${result.stderr}`,
  );
  assert.match(result.stderr, /Reusing existing isolated Paperclip worktree config/);
  assert.doesNotMatch(result.stderr, /stale for this host/);
});

test("still refuses an instance id that belongs to a different worktree", () => {
  // Only the separator spelling may relax. The guard exists to catch an env
  // pointing at another workspace's instance, and it must keep catching it.
  const worktree = makeLegacyWorktree(WEDGING_BRANCH);
  const envPath = path.join(worktree.worktreeCwd, ".paperclip", ".env");
  fs.writeFileSync(
    envPath,
    fs.readFileSync(envPath, "utf8").replace(worktree.storedInstanceId, "some-other-worktree-0123456789ab"),
  );

  const result = runProvision(worktree, WEDGING_BRANCH);
  assert.match(result.stderr, /legacy or mismatched instance/);
});
