import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const script = new URL("../provision-worktree.sh", import.meta.url).pathname;
const runtimeScript = new URL("../provision-worktree-runtime.sh", import.meta.url).pathname;

const cleanupDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

// Keep the PATH minimal so the fallback ladder is deterministic: node must be
// reachable, but a globally installed `paperclipai` must not shadow the rung
// under test.
//
// Reaching that by putting `path.dirname(process.execPath)` on the PATH does the
// opposite of what it reads as. It hands the tests everything else the installer
// dropped next to node, and on an nvm or Volta layout that is `pnpm`, `corepack`
// AND `paperclipai`. The ladder then reached a real global CLI instead of the
// rung being exercised: "falls back to an isolated config" passed for the wrong
// reason wherever those binaries were absent, and failed with an empty stderr
// wherever they were present. Symlink the node binary alone so the isolation
// holds no matter how node was installed — and resolve it through
// `process.execPath`, which is the real binary rather than a version-manager
// shim that would need env vars this minimal environment does not pass.
const nodeOnlyBin = makeTempDir("paperclip-provision-nodebin-");
fs.symlinkSync(process.execPath, path.join(nodeOnlyBin, "node"));
const testPath = [nodeOnlyBin, "/usr/bin", "/bin"].join(":");

test.after(() => {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Writes a fake base workspace whose "tsx runner" is a plain node script, so
 * the provision script's health check and init call can be steered per test.
 *
 * helpExit: exit code for `... index.ts --help` (the health check boot).
 * initExit: exit code for `... index.ts worktree init ...`; on 0 the fake CLI
 *           writes a marker config so tests can tell CLI init from fallback.
 */
function makeBaseWorkspace({ helpExit, initExit, ensureExit = 0 }) {
  const baseCwd = makeTempDir("paperclip-provision-base-");
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
  if (${initExit} !== 0) {
    console.error("fake worktree init failure");
    process.exit(${initExit});
  }
  fs.mkdirSync(".paperclip", { recursive: true });
  fs.writeFileSync(".paperclip/config.json", JSON.stringify({ $meta: { source: "fake-cli" } }));
  fs.writeFileSync(".paperclip/.env", "PAPERCLIP_IN_WORKTREE=true\\n");
  process.exit(0);
}
if (cliArgs[0] === "worktree" && cliArgs[1] === "ensure-seeded") {
  if (${ensureExit} !== 0) {
    console.error("fake worktree ensure-seeded failure");
    process.exit(${ensureExit});
  }
  fs.rmSync(".paperclip/seed-pending", { force: true });
  fs.writeFileSync(".paperclip/seed-complete", "{}\\n");
  process.exit(0);
}
process.exit(0);
`,
  );
  return baseCwd;
}

function runProvision(baseCwd, { pathPrefix, worktreeCwd } = {}) {
  const worktreeDir = worktreeCwd ?? makeTempDir("paperclip-provision-worktree-");
  const worktreesHome = makeTempDir("paperclip-provision-home-");
  const result = spawnSync("bash", [script], {
    cwd: worktreeDir,
    encoding: "utf8",
    env: {
      PATH: pathPrefix ? `${pathPrefix}:${testPath}` : testPath,
      HOME: os.homedir(),
      PAPERCLIP_WORKSPACE_BASE_CWD: baseCwd,
      PAPERCLIP_WORKSPACE_CWD: worktreeDir,
      PAPERCLIP_WORKSPACE_BRANCH: "feature/provision-test",
      PAPERCLIP_WORKTREES_DIR: worktreesHome,
      PAPERCLIP_HOME: path.join(worktreesHome, "no-such-instance-home"),
    },
  });
  return { result, worktreeCwd: worktreeDir, worktreesHome };
}

// Creates a worktree directory whose basename is EXACTLY `baseName` under a
// fresh parent. mkdtemp randomises the name, which keeps every existing test
// far away from the 48-char slice boundary; these tests need the boundary
// itself, so the name is chosen by the test instead.
function makeNamedWorktreeDir(prefix, baseName) {
  const parent = makeTempDir(prefix);
  const dir = path.join(parent, baseName);
  fs.mkdirSync(dir);
  return dir;
}

// Independent oracle of the SUP-14150 slug spec, not a copy of the script:
// trim, lowercase, non-slug runs -> "-", collapse "-", trim boundary
// separators, slice(0, 48), strip trailing separators AFTER the slice, then
// "-" + first 12 hex of sha256(resolved path). `postSliceTrim: false` yields
// the legacy pre-fix spelling (separator at the slice boundary survives).
function deriveWorktreeInstanceId(worktreePath, { postSliceTrim = true } = {}) {
  const resolvedWorkspacePath = path.resolve(worktreePath);
  const normalized = path.basename(resolvedWorkspacePath)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  let prefix = (normalized || "worktree").slice(0, 48);
  if (postSliceTrim) prefix = prefix.replace(/[-_]+$/, "");
  const pathHash = createHash("sha256").update(resolvedWorkspacePath).digest("hex").slice(0, 12);
  return `${prefix}-${pathHash}`;
}

function readPersistedInstanceId(worktreeCwd) {
  const env = fs.readFileSync(path.join(worktreeCwd, ".paperclip", ".env"), "utf8");
  const line = env.split("\n").find((value) => value.startsWith("PAPERCLIP_INSTANCE_ID="));
  assert.ok(line, `expected PAPERCLIP_INSTANCE_ID in ${worktreeCwd}/.paperclip/.env, got:\n${env}`);
  return JSON.parse(line.slice("PAPERCLIP_INSTANCE_ID=".length));
}

function runRuntimeProvision(baseCwd, worktreeCwd) {
  const worktreesHome = makeTempDir("paperclip-provision-runtime-home-");
  return spawnSync("bash", [runtimeScript], {
    cwd: worktreeCwd,
    encoding: "utf8",
    env: {
      PATH: testPath,
      HOME: os.homedir(),
      PAPERCLIP_WORKSPACE_BASE_CWD: baseCwd,
      PAPERCLIP_WORKSPACE_CWD: worktreeCwd,
      PAPERCLIP_WORKSPACE_BRANCH: "feature/provision-runtime-test",
      PAPERCLIP_WORKTREES_DIR: worktreesHome,
      PAPERCLIP_HOME: path.join(worktreesHome, "no-such-instance-home"),
    },
  });
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

function readWorktreeConfig(worktreeCwd) {
  const configPath = path.join(worktreeCwd, ".paperclip", "config.json");
  assert.ok(fs.existsSync(configPath), `expected ${configPath} to exist`);
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

// The isolation above is load-bearing and silent when it breaks: every rung of the
// fallback ladder is "run some CLI", so a leaked binary does not error, it just
// answers, and the test goes on passing while measuring nothing. Assert the PATH
// directly. `bash -c`, not `-lc`: a login shell sources profile scripts that
// re-add the very directories being excluded.
//
// `paperclipai` is the binary the ladder actually dispatches on and the one no
// test injects, so it must be absent. A real `pnpm` may still come from /usr/bin
// on some hosts and cannot be excluded without losing git, flock and stat with
// it — that one is neutralised per test instead, by a fake earlier on the PATH
// via `pathPrefix`.
test("the test PATH exposes our node and no paperclipai shadow", () => {
  const resolve = (binary) =>
    spawnSync("bash", ["-c", `command -v ${binary}`], { env: { PATH: testPath }, encoding: "utf8" });

  const node = resolve("node");
  assert.equal(node.status, 0, "node must be reachable on the test PATH");
  assert.equal(
    node.stdout.trim(),
    path.join(nodeOnlyBin, "node"),
    "node must resolve to the isolated symlink, so nothing else from its install directory is on the PATH",
  );

  assert.notEqual(
    resolve("paperclipai").status,
    0,
    "a globally installed paperclipai must not be reachable — it shadows the fallback rung under test",
  );
});

test("uses the base CLI when its import graph boots", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
  const { result, worktreeCwd } = runProvision(baseCwd);

  assert.equal(result.status, 0, result.stderr);
  const config = readWorktreeConfig(worktreeCwd);
  assert.equal(config.$meta.source, "fake-cli");
  assert.ok(fs.existsSync(path.join(worktreeCwd, ".paperclip", "seed-pending")));
  const initInvocation = readCliInvocations(baseCwd).find(
    (args) => args[0] === "worktree" && args[1] === "init",
  );
  assert.ok(
    initInvocation?.includes("--no-seed"),
    `expected --no-seed in ${JSON.stringify(initInvocation)}`,
  );
});

test("falls back to an isolated config when the base CLI cannot boot", () => {
  // Simulates the dangling pnpm symlink incident: the runner and entry files
  // exist, but booting the CLI fails ESM resolution. The base has no
  // package.json/pnpm-lock.yaml, so the repair install is not possible and the
  // script must degrade to the no-CLI fallback config instead of failing.
  const baseCwd = makeBaseWorkspace({ helpExit: 1, initExit: 0 });
  const { result, worktreeCwd, worktreesHome } = runProvision(baseCwd);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /writing isolated fallback config/);
  const config = readWorktreeConfig(worktreeCwd);
  assert.equal(config.$meta.source, "configure");
  const dataDir = config.database.embeddedPostgresDataDir;
  assert.ok(
    !path.relative(worktreesHome, dataDir).startsWith(".."),
    `expected ${dataDir} to live under ${worktreesHome}`,
  );
  const env = fs.readFileSync(path.join(worktreeCwd, ".paperclip", ".env"), "utf8");
  assert.match(env, /PAPERCLIP_IN_WORKTREE=true/);
  assert.ok(fs.existsSync(path.join(worktreeCwd, ".paperclip", "seed-pending")));
});

test("repairs an unhealthy base install under the lock and then uses the CLI", (t) => {
  const hasTools = ["flock", "git"].every(
    (tool) => spawnSync("bash", ["-lc", `command -v ${tool}`], { env: { PATH: testPath } }).status === 0,
  );
  if (!hasTools) {
    t.skip("flock or git not available on this host");
    return;
  }

  // The CLI's health is controlled by a flag file, and a fake `pnpm install`
  // creates that flag — modeling a forced reinstall that relinks the store.
  const baseCwd = makeTempDir("paperclip-provision-repair-base-");
  const healthFlag = path.join(baseCwd, "cli-healthy.flag");
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
if (cliArgs.includes("--help")) {
  process.exit(fs.existsSync(${JSON.stringify(healthFlag)}) ? 0 : 1);
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
  fs.writeFileSync(path.join(baseCwd, "package.json"), "{}\n");
  fs.writeFileSync(path.join(baseCwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  spawnSync("git", ["init", "-q", baseCwd], { env: { PATH: testPath } });

  const fakeBin = makeTempDir("paperclip-provision-fakebin-");
  const installLog = path.join(baseCwd, "pnpm-invocations.log");
  fs.writeFileSync(
    path.join(fakeBin, "pnpm"),
    `#!/usr/bin/env bash
if [[ "$1" == "install" ]]; then
  echo "$@" >> ${JSON.stringify(installLog)}
  touch ${JSON.stringify(healthFlag)}
  exit 0
fi
exit 1
`,
    { mode: 0o755 },
  );

  const { result, worktreeCwd } = runProvision(baseCwd, { pathPrefix: fakeBin });

  assert.equal(result.status, 0, result.stderr);
  const config = readWorktreeConfig(worktreeCwd);
  assert.equal(config.$meta.source, "fake-cli");
  const installs = fs.readFileSync(installLog, "utf8").trim().split("\n");
  assert.equal(installs.length, 1, `expected exactly one repair install, got: ${installs.join(" | ")}`);
  assert.match(installs[0], /--force/);
  assert.match(installs[0], /--frozen-lockfile/);
  assert.ok(
    fs.existsSync(path.join(baseCwd, ".git", "paperclip-provision-repair.lock")),
    "expected the repair lock file inside the resolved git dir",
  );
});

test("a failed CLI init fails provisioning instead of being masked as success", () => {
  // Regression test for the masked `return 0` after the init subshell: a CLI
  // that passes the health check but fails `worktree init` signals a real
  // problem, so the script must propagate the failure rather than report
  // success or write an unseeded fallback config over it.
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 3 });
  const { result, worktreeCwd } = runProvision(baseCwd);

  assert.equal(result.status, 3, result.stderr);
  assert.match(result.stderr, /fake worktree init failure/);
  assert.ok(!fs.existsSync(path.join(worktreeCwd, ".paperclip", "config.json")));
});

test("runtime provisioning invokes ensure-seeded once and fast-exits after success", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
  const worktreeCwd = makeTempDir("paperclip-provision-runtime-worktree-");
  fs.mkdirSync(path.join(worktreeCwd, ".paperclip"), { recursive: true });
  fs.writeFileSync(path.join(worktreeCwd, ".paperclip", "config.json"), "{}\n");
  fs.writeFileSync(path.join(worktreeCwd, ".paperclip", "seed-pending"), "{}\n");

  const first = runRuntimeProvision(baseCwd, worktreeCwd);
  assert.equal(first.status, 0, first.stderr);
  assert.ok(fs.existsSync(path.join(worktreeCwd, ".paperclip", "seed-complete")));
  assert.ok(!fs.existsSync(path.join(worktreeCwd, ".paperclip", "seed-pending")));

  const ensureCallsAfterFirst = readCliInvocations(baseCwd)
    .filter((args) => args[0] === "worktree" && args[1] === "ensure-seeded");
  assert.equal(ensureCallsAfterFirst.length, 1);
  assert.ok(ensureCallsAfterFirst[0].includes("--config"));
  assert.ok(ensureCallsAfterFirst[0].includes("--from-config"));

  const second = runRuntimeProvision(baseCwd, worktreeCwd);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /already seeded; skipping/);
  const ensureCallsAfterSecond = readCliInvocations(baseCwd)
    .filter((args) => args[0] === "worktree" && args[1] === "ensure-seeded");
  assert.equal(ensureCallsAfterSecond.length, 1);
});

test("runtime provisioning leaves seed-pending in place when ensure-seeded fails", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0, ensureExit: 4 });
  const worktreeCwd = makeTempDir("paperclip-provision-runtime-failure-");
  fs.mkdirSync(path.join(worktreeCwd, ".paperclip"), { recursive: true });
  fs.writeFileSync(path.join(worktreeCwd, ".paperclip", "config.json"), "{}\n");
  fs.writeFileSync(path.join(worktreeCwd, ".paperclip", "seed-pending"), "{}\n");

  const result = runRuntimeProvision(baseCwd, worktreeCwd);
  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stderr, /fake worktree ensure-seeded failure/);
  assert.ok(fs.existsSync(path.join(worktreeCwd, ".paperclip", "seed-pending")));
  assert.ok(!fs.existsSync(path.join(worktreeCwd, ".paperclip", "seed-complete")));
});

// SUP-14150: the 48-char slice can land on a separator. 47 non-separator
// chars, then the separator at index 47, then filler so the name exceeds 48.
const sliceBoundaryHyphenName = `a${"b".repeat(46)}-${"c".repeat(50)}`;
const sliceBoundaryUnderscoreName = `a${"b".repeat(46)}_${"c".repeat(50)}`;

test("slice(0, 48) can no longer leave a trailing separator in the instance id", () => {
  // The base CLI cannot boot, so the script takes the fallback path, which is
  // the one that persists PAPERCLIP_INSTANCE_ID into .paperclip/.env where
  // these assertions can observe it.
  const baseCwd = makeBaseWorkspace({ helpExit: 1, initExit: 0 });

  for (const baseName of [sliceBoundaryHyphenName, sliceBoundaryUnderscoreName]) {
    const worktreeCwd = makeNamedWorktreeDir("paperclip-provision-slice-boundary-", baseName);
    const { result } = runProvision(baseCwd, { worktreeCwd });
    assert.equal(result.status, 0, result.stderr);

    const instanceId = readPersistedInstanceId(worktreeCwd);
    assert.equal(instanceId, deriveWorktreeInstanceId(worktreeCwd));
    const prefix = instanceId.slice(0, -13); // drop "-<12 hex>"
    assert.ok(
      !/[-_]$/.test(prefix),
      `prefix ${JSON.stringify(prefix)} still ends on a separator`,
    );
    assert.ok(
      !instanceId.includes("--"),
      `slug ${instanceId} contains a double hyphen`,
    );
    // Pin the fixture to the defect boundary: the legacy spelling for this
    // basename really does carry the trailing separator, so a test that
    // passed pre-fix would have been measuring nothing.
    const legacy = deriveWorktreeInstanceId(worktreeCwd, { postSliceTrim: false });
    assert.notEqual(legacy, instanceId);
  }
});

test("the SUP-14139 worktree basename no longer mints a double-hyphen instance id", () => {
  const baseName =
    "SUP-14139-execution-workspace-allocation-has-no-path-exclusivity-two-active-rows-over-one-worktree-and-an-issue-bound-to";
  const baseCwd = makeBaseWorkspace({ helpExit: 1, initExit: 0 });
  const worktreeCwd = makeNamedWorktreeDir("paperclip-provision-sup14139-", baseName);
  const { result } = runProvision(baseCwd, { worktreeCwd });
  assert.equal(result.status, 0, result.stderr);

  const instanceId = readPersistedInstanceId(worktreeCwd);
  assert.ok(
    !instanceId.includes("--"),
    `slug ${instanceId} contains a double hyphen`,
  );
  assert.ok(
    instanceId.startsWith("sup-14139-execution-workspace-allocation-has-no-"),
    `slug ${instanceId} lost the expected prefix`,
  );
  assert.equal(instanceId, deriveWorktreeInstanceId(worktreeCwd));
});

// A .paperclip/ pair persisted by a pre-fix provisioning carries the legacy
// spelling (separator at the slice boundary). The guard must accept it and
// reuse the config instead of forcing a re-init on every run.
function writePersistedWorktreeConfig(worktreeCwd, homeDir, instanceId) {
  const paperclipDir = path.join(worktreeCwd, ".paperclip");
  const instanceRoot = path.join(homeDir, "instances", instanceId);
  const configPath = path.join(paperclipDir, "config.json");
  fs.mkdirSync(paperclipDir, { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      $meta: { version: 1, source: "pre-fix-provisioning" },
      database: {
        embeddedPostgresDataDir: path.join(instanceRoot, "db"),
        backup: { dir: path.join(instanceRoot, "data", "backups") },
      },
      logging: { logDir: path.join(instanceRoot, "logs") },
      storage: { localDisk: { baseDir: path.join(instanceRoot, "data", "storage") } },
      secrets: { localEncrypted: { keyFilePath: path.join(instanceRoot, "secrets", "master.key") } },
    }),
  );
  fs.writeFileSync(
    path.join(paperclipDir, ".env"),
    [
      `PAPERCLIP_HOME=${JSON.stringify(homeDir)}`,
      `PAPERCLIP_INSTANCE_ID=${JSON.stringify(instanceId)}`,
      `PAPERCLIP_CONFIG=${JSON.stringify(configPath)}`,
      "PAPERCLIP_IN_WORKTREE=true",
    ].join("\n") + "\n",
  );
}

test("reuses a worktree env persisted with the legacy double-hyphen spelling", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
  const worktreeCwd = makeNamedWorktreeDir("paperclip-provision-legacy-env-", sliceBoundaryHyphenName);
  const homeDir = makeTempDir("paperclip-provision-legacy-instance-home-");
  const legacyId = deriveWorktreeInstanceId(worktreeCwd, { postSliceTrim: false });
  const expectedId = deriveWorktreeInstanceId(worktreeCwd);
  assert.match(legacyId, /--[0-9a-f]{12}$/, "fixture must exercise the divergent boundary");
  assert.notEqual(legacyId, expectedId);
  writePersistedWorktreeConfig(worktreeCwd, homeDir, legacyId);

  const { result } = runProvision(baseCwd, { worktreeCwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Reusing existing isolated Paperclip worktree config/);
  // No on-read migration: the persisted id is left in its legacy spelling, and
  // no init ran over it.
  assert.equal(readPersistedInstanceId(worktreeCwd), legacyId);
  const initCalls = readCliInvocations(baseCwd).filter(
    (args) => args[0] === "worktree" && args[1] === "init",
  );
  assert.equal(initCalls.length, 0, `expected no re-init, got ${JSON.stringify(initCalls)}`);
});

test("reuses a worktree env persisted with the slice-stable spelling", () => {
  const baseCwd = makeBaseWorkspace({ helpExit: 0, initExit: 0 });
  const worktreeCwd = makeNamedWorktreeDir("paperclip-provision-stable-env-", sliceBoundaryHyphenName);
  const homeDir = makeTempDir("paperclip-provision-stable-instance-home-");
  const expectedId = deriveWorktreeInstanceId(worktreeCwd);
  writePersistedWorktreeConfig(worktreeCwd, homeDir, expectedId);

  const { result } = runProvision(baseCwd, { worktreeCwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Reusing existing isolated Paperclip worktree config/);
  assert.equal(readPersistedInstanceId(worktreeCwd), expectedId);
});

test("still regenerates a worktree env that names an unrelated instance id", () => {
  // Accepting both spellings must not widen into accepting any id: a .env that
  // belongs to neither the stable nor the legacy spelling of THIS worktree is
  // still stale and gets regenerated.
  const baseCwd = makeBaseWorkspace({ helpExit: 1, initExit: 0 });
  const worktreeCwd = makeNamedWorktreeDir("paperclip-provision-foreign-env-", sliceBoundaryHyphenName);
  const homeDir = makeTempDir("paperclip-provision-foreign-instance-home-");
  writePersistedWorktreeConfig(worktreeCwd, homeDir, "foreign-instance-abc");

  const { result } = runProvision(baseCwd, { worktreeCwd });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /stale for this host; regenerating/);
  // The mismatch message keeps naming both the found and the expected slug.
  const expectedId = deriveWorktreeInstanceId(worktreeCwd);
  assert.match(result.stderr, new RegExp(`mismatched instance foreign-instance-abc, expected ${expectedId}`));
  assert.equal(readPersistedInstanceId(worktreeCwd), expectedId);
});
