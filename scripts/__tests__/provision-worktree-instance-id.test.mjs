import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = new URL("../provision-worktree.sh", import.meta.url).pathname;

// Keep the PATH minimal so the fallback ladder is deterministic: node must be
// reachable, but a globally installed `paperclipai` must not shadow the paths
// under test.
const testPath = [path.dirname(process.execPath), "/usr/bin", "/bin"].join(":");

const cleanupDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The execution-instance id is canonicalized by
 * `sanitizeWorktreeInstanceId` (cli/src/commands/worktree-lib.ts) whenever the
 * CLI consumes it: lowercase [a-z0-9-], leading/trailing hyphens trimmed,
 * consecutive hyphens collapsed. The provisioner's joiner must emit a value
 * that is already at that fixed point; otherwise the CLI silently rewrites it
 * when it persists `.paperclip/.env`, and the provisioner's next run sees a
 * mismatch between its own raw computation and the persisted value and
 * regenerates the worktree config on every provisioning (SUP-14156).
 */
function assertCanonicalInstanceId(id, label) {
  assert.ok(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id),
    `${label} instance id must be canonical (no leading/trailing/consecutive hyphens): ${id}`,
  );
}

/** Mirrors the provisioner's derivation for a canonical (sanitized) id. */
function expectedInstanceId(worktreeCwd) {
  const resolved = path.resolve(worktreeCwd);
  const normalized = path
    .basename(resolved)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  const prefix = (normalized || "worktree").slice(0, 48).replace(/-+$/, "");
  const pathHash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return `${prefix}-${pathHash}`;
}

function normalizeBasename(name) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

/**
 * Fake base workspace whose "tsx runner" is a plain node script, so the
 * provision script's health check and init call can be steered per test.
 * helpExit=0: healthy CLI, `worktree init` succeeds and writes a marker.
 * helpExit=1: unhealthy CLI, provisioner must take the no-CLI fallback and
 *             write `.paperclip/.env` itself.
 */
function makeBaseWorkspace({ helpExit }) {
  const baseCwd = makeTempDir("paperclip-instance-id-base-");
  const runnerPath = path.join(baseCwd, "cli", "node_modules", "tsx", "dist", "cli.mjs");
  const entryPath = path.join(baseCwd, "cli", "src", "index.ts");
  fs.mkdirSync(path.dirname(runnerPath), { recursive: true });
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(entryPath, "// fake CLI entry\n");
  fs.writeFileSync(
    runnerPath,
    `
import fs from "node:fs";
const cliArgs = process.argv.slice(3);
fs.appendFileSync(${JSON.stringify(path.join(baseCwd, "cli-invocations.log"))}, JSON.stringify(cliArgs) + "\\n");
if (cliArgs.includes("--help")) {
  if (${helpExit} !== 0) console.error("ERR_MODULE_NOT_FOUND: drizzle-orm");
  process.exit(${helpExit});
}
if (cliArgs[0] === "worktree" && cliArgs[1] === "init") {
  fs.mkdirSync(".paperclip", { recursive: true });
  fs.writeFileSync(".paperclip/config.json", JSON.stringify({ $meta: { source: "fake-cli" } }));
  fs.writeFileSync(".paperclip/.env", "PAPERCLIP_IN_WORKTREE=true\\n");
  process.exit(0);
}
process.exit(0);
`,
  );
  return baseCwd;
}

function readCliInvocations(baseCwd) {
  const logPath = path.join(baseCwd, "cli-invocations.log");
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Runs the provision script against a worktree dir whose name is controlled. */
function runProvision(worktreeName, { helpExit = 0 } = {}) {
  const baseCwd = makeBaseWorkspace({ helpExit });
  const parent = makeTempDir("paperclip-instance-id-root-");
  const worktreeCwd = path.join(parent, worktreeName);
  fs.mkdirSync(worktreeCwd);
  const worktreesHome = makeTempDir("paperclip-instance-id-home-");
  // provision-worktree.sh now refuses unless the registered seed source config
  // exists as a canonical file. The base workspace here is a plain checkout, so
  // that source is the control plane's own instance config; seed it so the run
  // reaches the instance-id derivation this test is about.
  const instanceHome = path.join(worktreesHome, "instance-home");
  fs.mkdirSync(path.join(instanceHome, "instances", "default"), { recursive: true });
  fs.writeFileSync(path.join(instanceHome, "instances", "default", "config.json"), "{}\n");
  const result = spawnSync("bash", [script], {
    cwd: worktreeCwd,
    encoding: "utf8",
    env: {
      PATH: testPath,
      HOME: os.homedir(),
      PAPERCLIP_WORKSPACE_BASE_CWD: baseCwd,
      PAPERCLIP_WORKSPACE_CWD: worktreeCwd,
      PAPERCLIP_WORKSPACE_BRANCH: "feature/instance-id-test",
      PAPERCLIP_WORKTREES_DIR: worktreesHome,
      PAPERCLIP_HOME: instanceHome,
    },
  });
  return { result, worktreeCwd, baseCwd, worktreesHome };
}

function initInstanceIdArg(baseCwd) {
  const initInvocation = readCliInvocations(baseCwd).find(
    (args) => args[0] === "worktree" && args[1] === "init",
  );
  assert.ok(initInvocation, "expected a `worktree init` CLI invocation");
  const idx = initInvocation.indexOf("--instance");
  assert.ok(idx !== -1, `expected --instance in ${JSON.stringify(initInvocation)}`);
  return initInvocation[idx + 1];
}

// The real-world trigger: the SUP-14139 execution-workspace branch basename,
// whose normalized 48-char slice ends on a hyphen.
const BOUNDARY_NAME =
  "SUP-14139-execution-workspace-allocation-has-no-path-exclusivity-two-active-rows-over-one-worktree-and-an-issue-bound-to";
assert.ok(normalizeBasename(BOUNDARY_NAME).slice(0, 48).endsWith("-"));

// Control: a basename whose 48-char slice ends on an alphanumeric, so the
// joiner is unchanged by the trailing-hyphen strip.
const CONTROL_NAME = "a123456789-a123456789-a123456789-a123456789-a123456789-a123456789";
assert.ok(!normalizeBasename(CONTROL_NAME).slice(0, 48).endsWith("-"));

test("instance id is canonical when the 48-char slice ends on a hyphen", () => {
  const { result, worktreeCwd, baseCwd } = runProvision(BOUNDARY_NAME);
  assert.equal(result.status, 0, result.stderr);

  const instanceId = initInstanceIdArg(baseCwd);
  const expected = expectedInstanceId(worktreeCwd);
  assertCanonicalInstanceId(instanceId, "cli-path");
  assert.equal(instanceId, expected);
  assert.ok(!instanceId.includes("--"), `instance id must not contain consecutive hyphens: ${instanceId}`);
  assert.equal(instanceId.length, 47 + 1 + 12);
});

test("instance id is unchanged when the 48-char slice does not end on a hyphen", () => {
  const { result, worktreeCwd, baseCwd } = runProvision(CONTROL_NAME);
  assert.equal(result.status, 0, result.stderr);

  const instanceId = initInstanceIdArg(baseCwd);
  const expected = expectedInstanceId(worktreeCwd);
  assertCanonicalInstanceId(instanceId, "cli-path control");
  assert.equal(instanceId, expected);
  assert.equal(instanceId.length, 48 + 1 + 12);
});

test("fallback .env carries the same canonical instance id", () => {
  const { result, worktreeCwd } = runProvision(BOUNDARY_NAME, { helpExit: 1 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /writing isolated fallback config/);

  const env = fs.readFileSync(path.join(worktreeCwd, ".paperclip", ".env"), "utf8");
  const line = env.split("\n").find((l) => l.startsWith("PAPERCLIP_INSTANCE_ID="));
  assert.ok(line, "expected PAPERCLIP_INSTANCE_ID in .env");
  const instanceId = JSON.parse(line.slice("PAPERCLIP_INSTANCE_ID=".length));
  const expected = expectedInstanceId(worktreeCwd);
  assertCanonicalInstanceId(instanceId, "fallback-path");
  assert.equal(instanceId, expected);
  assert.ok(!instanceId.includes("--"), `instance id must not contain consecutive hyphens: ${instanceId}`);
});
