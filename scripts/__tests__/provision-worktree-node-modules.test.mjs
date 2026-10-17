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

function provisionEnv({ baseCwd, worktreeCwd, pnpmStubDir, auditDir }) {
  return {
    PATH: [pnpmStubDir, nodeOnlyBin, "/usr/bin", "/bin"].join(":"),
    HOME: os.homedir(),
    PAPERCLIP_WORKSPACE_BASE_CWD: baseCwd,
    PAPERCLIP_WORKSPACE_CWD: worktreeCwd,
    PAPERCLIP_WORKSPACE_BRANCH: "feature/nm-test",
    PAPERCLIP_WORKTREES_DIR: makeTempDir("paperclip-nm-worktrees-"),
    PAPERCLIP_HOME: makeInstanceHome(),
    PAPERCLIP_PROJECT_WORKSPACE_ID: "project-nm-1",
    PAPERCLIP_SEED_EXPECTED_COMPANY_ID: "company-nm-1",
    PNPMAUDIT: auditDir,
  };
}

function runProvision({ baseCwd, worktreeCwd, pnpmStubDir, auditDir, scriptPath = script, env }) {
  return spawnSync("bash", [scriptPath], {
    cwd: worktreeCwd,
    encoding: "utf8",
    env: env ?? provisionEnv({ baseCwd, worktreeCwd, pnpmStubDir, auditDir }),
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

// SUP-19074: the shim drops the install to the agent uid, and every process of
// that uid can read the install's environment (/proc/<pid>/environ needs only
// the same uid). The provision environment is a copy of the server's, which
// carries the secrets master key. So the shim calls (the drop-uid probe and the
// install) must start from an allowlist, while the no-shim install, which runs
// as the caller's own uid, keeps the inherited environment exactly as before.
//
// The shim path is a fixed absolute path that CI hosts do not have, so these
// tests run a copy of the script whose shim path points at a recording fake.

const serverUtilsSource = new URL("../../packages/adapter-utils/src/server-utils.ts", import.meta.url)
  .pathname;
const SHIM_PATH_ASSIGNMENT = 'agent_spawn_shim="/usr/local/sbin/paperclip-spawn-agent"';

// What sanitizeInheritedPaperclipEnv strips from every agent run, read from its
// source rather than copied, so a name added there is covered here too.
function readAgentRunStrippedNames() {
  const source = fs.readFileSync(serverUtilsSource, "utf8");
  const setLiteral = (name) => {
    const match = source.match(new RegExp(`export const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
    assert.ok(match, `${name} must stay a Set literal in server-utils.ts`);
    return [...match[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map((entry) => entry[1]);
  };
  const start = source.indexOf("export function sanitizeInheritedPaperclipEnv(");
  assert.ok(start >= 0, "sanitizeInheritedPaperclipEnv must exist in server-utils.ts");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  const deleted = [...body.matchAll(/delete env\.([A-Za-z0-9_]+);/g)].map((entry) => entry[1]);
  const names = [...setLiteral("SECRET_ENV_KEYS"), ...setLiteral("MANAGED_GITHUB_TOKEN_KEYS"), ...deleted];
  // A refactor that moves these lists must fail here, not pass with nothing to check.
  for (const anchor of ["PAPERCLIP_SECRETS_MASTER_KEY", "BETTER_AUTH_SECRET", "GH_TOKEN", "DATABASE_URL"]) {
    assert.ok(names.includes(anchor), `the agent-run strip list must contain ${anchor}`);
  }
  return [...new Set(names)];
}

function makeScriptWithShim(shimPath) {
  const source = fs.readFileSync(script, "utf8");
  assert.equal(
    source.split(SHIM_PATH_ASSIGNMENT).length - 1,
    1,
    "provision-worktree.sh must assign the shim path exactly once",
  );
  const copy = path.join(makeTempDir("paperclip-nm-script-"), "provision-worktree.sh");
  fs.writeFileSync(copy, source.replace(SHIM_PATH_ASSIGNMENT, `agent_spawn_shim="${shimPath}"`));
  return copy;
}

// Stands in for the setuid shim: reports a drop uid other than ours, so the
// script takes the shim branch; records the environment it was handed; and
// execs the command unchanged, as the real shim does.
function makeRecordingShim(auditDir) {
  const shim = path.join(makeTempDir("paperclip-nm-shim-"), "paperclip-spawn-agent");
  const dropUid = process.getuid() + 1;
  fs.writeFileSync(
    shim,
    `#!/bin/bash\n` +
      `/usr/bin/env -0 > "${auditDir}/shim-$$.env"\n` +
      `printf '%s\\n' "$*" > "${auditDir}/shim-$$.argv"\n` +
      `if [[ "$1" == "id" ]]; then echo ${dropUid}; exit 0; fi\n` +
      `exec "$@"\n`,
    { mode: 0o755 },
  );
  return shim;
}

// A pnpm that records its arguments and the environment it actually received.
// Paths are baked in because the shim branch must not depend on inherited env.
function makeRecordingPnpm(auditDir) {
  const stubDir = makeTempDir("paperclip-nm-pnpm-");
  fs.writeFileSync(
    path.join(stubDir, "pnpm"),
    `#!/bin/bash\n` +
      `echo "PNPM $*" >> "${auditDir}/calls.log"\n` +
      `/usr/bin/env -0 > "${auditDir}/pnpm-$$.env"\n` +
      `printf '%s\\n' "$*" > "${auditDir}/pnpm-$$.argv"\n` +
      `exit 0\n`,
    { mode: 0o755 },
  );
  return stubDir;
}

// The script also runs `pnpm paperclipai ...` as its own uid; pick the install.
function readInstallCall(auditDir) {
  const installs = readRecordedCalls(auditDir, "pnpm-").filter((call) => call.argv?.startsWith("install "));
  assert.equal(installs.length, 1, "exactly one pnpm install must have been recorded");
  return installs[0];
}

function readRecordedCalls(auditDir, prefix) {
  return fs
    .readdirSync(auditDir)
    .filter((file) => file.startsWith(prefix) && file.endsWith(".env"))
    .map((file) => {
      const env = new Map();
      for (const entry of fs.readFileSync(path.join(auditDir, file), "utf8").split("\0")) {
        if (!entry) continue;
        const separator = entry.indexOf("=");
        env.set(entry.slice(0, separator), entry.slice(separator + 1));
      }
      const argvFile = path.join(auditDir, file.replace(/\.env$/, ".argv"));
      const argv = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, "utf8").trim() : null;
      return { env, argv };
    });
}

// What a legitimate agent-uid install needs (justified in the script).
const INSTALL_ENV_ALLOWED = {
  NODE_ENV: "production",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  CI: "1",
  npm_config_store_dir: "/srv/sup19074/pnpm-store",
  npm_config_registry: "https://registry.example.invalid/",
  NPM_CONFIG_FETCH_RETRIES: "5",
  COREPACK_HOME: "/srv/sup19074/corepack",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  PNPM_HOME: "/srv/sup19074/pnpm-home",
  XDG_DATA_HOME: "/srv/sup19074/xdg-data",
  XDG_CACHE_HOME: "/srv/sup19074/xdg-cache",
  XDG_CONFIG_HOME: "/srv/sup19074/xdg-config",
  XDG_STATE_HOME: "/srv/sup19074/xdg-state",
  HTTP_PROXY: "http://proxy.example.invalid:3128",
  HTTPS_PROXY: "http://proxy.example.invalid:3128",
  NO_PROXY: "localhost",
  ALL_PROXY: "http://proxy.example.invalid:3128",
  http_proxy: "http://proxy.example.invalid:3128",
  https_proxy: "http://proxy.example.invalid:3128",
  no_proxy: "localhost",
  all_proxy: "http://proxy.example.invalid:3128",
  NODE_EXTRA_CA_CERTS: "/srv/sup19074/extra-ca.pem",
  SSL_CERT_FILE: "/srv/sup19074/ca-bundle.pem",
  SSL_CERT_DIR: "/srv/sup19074/certs",
};

// Server-side names the agent-uid install must never see, beyond the
// agent-run strip list read from server-utils.ts. Each gets a unique sentinel
// value, so the test can also catch a value smuggled under another name.
const INSTALL_ENV_DENIED_EXTRA = [
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_RUNTIME_API_URL",
  "PAPERCLIP_AGENT_JWT_SECRET",
  "npm_config_tailscale_auth",
  "npm_config_authenticated_private",
  "ANTHROPIC_API_KEY",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TZ",
  "SUP19074_UNLISTED_SERVER_VAR",
];

// Denied names whose values must stay realistic, because the script itself
// (still the caller's uid) uses them: checked by name only.
function realisticDeniedEnv() {
  return {
    TMPDIR: makeTempDir("paperclip-nm-tmpdir-"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
  };
}

const SHELL_BOOKKEEPING = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);

test("shim install: the agent-uid pnpm gets only the allowlisted environment", () => {
  const strippedNames = readAgentRunStrippedNames();
  const baseCwd = makeBaseWithStrayNodeModules();
  const worktreeCwd = makePopulatedWorktree({ withFingerprint: false });
  fs.rmSync(path.join(worktreeCwd, "node_modules"), { recursive: true, force: true });
  const auditDir = makeTempDir("paperclip-nm-audit-");
  const pnpmStubDir = makeRecordingPnpm(auditDir);
  const scriptPath = makeScriptWithShim(makeRecordingShim(auditDir));

  const denied = {};
  for (const name of [...strippedNames, ...INSTALL_ENV_DENIED_EXTRA]) {
    denied[name] = `sup19074-must-not-reach-agent-${name}`;
  }
  const realisticDenied = realisticDeniedEnv();
  const env = {
    ...provisionEnv({ baseCwd, worktreeCwd, pnpmStubDir, auditDir }),
    ...INSTALL_ENV_ALLOWED,
    ...denied,
    ...realisticDenied,
    NODE_OPTIONS: "--max-old-space-size=123",
  };

  const result = runProvision({ worktreeCwd, scriptPath, env });
  assert.equal(result.status, 0, `dispatch should succeed:\n${result.stdout}\n${result.stderr}`);

  const shimCalls = readRecordedCalls(auditDir, "shim-");
  assert.deepEqual(
    shimCalls.map((call) => call.argv).sort(),
    ["id -u", "pnpm install --prod=false --frozen-lockfile"],
    "the script must probe the shim once and run the install through it once",
  );
  const installCall = readInstallCall(auditDir);

  // Nothing server-side reaches either shim call or the install: no denied name,
  // and no denied value under any other name.
  const deniedValues = new Set(Object.values(denied));
  for (const call of [...shimCalls, installCall]) {
    for (const name of [...Object.keys(denied), ...Object.keys(realisticDenied)]) {
      assert.ok(!call.env.has(name), `${name} reached the agent uid (${call.argv})`);
    }
    for (const [name, value] of call.env) {
      assert.ok(!deniedValues.has(value), `a denied value reached the agent uid as ${name}`);
    }
  }

  // Positive control: the install still has everything it legitimately needs.
  const installEnv = installCall.env;
  const expected = {
    ...INSTALL_ENV_ALLOWED,
    PATH: env.PATH,
    HOME: env.HOME,
    PAPERCLIP_WORKSPACE_BASE_CWD: baseCwd,
    PAPERCLIP_WORKSPACE_CWD: worktreeCwd,
    PAPERCLIP_WORKSPACE_BRANCH: "feature/nm-test",
    NODE_OPTIONS: "--max-old-space-size=123 --disable-warning=DEP0169",
  };
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(installEnv.get(name), value, `the agent-uid install must receive ${name}`);
  }
  for (const name of installEnv.keys()) {
    assert.ok(
      name in expected || SHELL_BOOKKEEPING.has(name),
      `${name} reached the agent-uid install but is not on the allowlist`,
    );
  }

  // The drop-uid probe needs nothing but PATH to find `id`.
  const probe = shimCalls.find((call) => call.argv === "id -u");
  for (const name of probe.env.keys()) {
    assert.ok(name === "PATH" || SHELL_BOOKKEEPING.has(name), `${name} reached the drop-uid probe`);
  }
});

test("no-shim install: pnpm keeps the inherited environment unchanged", () => {
  const baseCwd = makeBaseWithStrayNodeModules();
  const worktreeCwd = makePopulatedWorktree({ withFingerprint: false });
  fs.rmSync(path.join(worktreeCwd, "node_modules"), { recursive: true, force: true });
  const auditDir = makeTempDir("paperclip-nm-audit-");
  const pnpmStubDir = makeRecordingPnpm(auditDir);
  // A shim path that does not exist: the install runs as the caller's own uid,
  // which can already read its parent's environment, so nothing is filtered.
  const scriptPath = makeScriptWithShim(path.join(makeTempDir("paperclip-nm-noshim-"), "absent"));
  const env = {
    ...provisionEnv({ baseCwd, worktreeCwd, pnpmStubDir, auditDir }),
    ...INSTALL_ENV_ALLOWED,
    SUP19074_UNLISTED_SERVER_VAR: "inherited-unchanged",
    PAPERCLIP_SECRETS_MASTER_KEY: "same-uid-sentinel",
    NODE_OPTIONS: "--max-old-space-size=123",
  };

  const result = runProvision({ worktreeCwd, scriptPath, env });
  assert.equal(result.status, 0, `dispatch should succeed:\n${result.stdout}\n${result.stderr}`);
  assert.equal(countInstallCalls(auditDir), 1, "the no-shim install must still run once");
  const installCall = readInstallCall(auditDir);
  assert.equal(installCall.argv, "install --prod=false --frozen-lockfile");

  for (const [name, value] of Object.entries(env)) {
    if (name === "NODE_OPTIONS") continue;
    assert.equal(installCall.env.get(name), value, `the no-shim install must inherit ${name} unchanged`);
  }
  assert.equal(installCall.env.get("NODE_OPTIONS"), "--max-old-space-size=123 --disable-warning=DEP0169");
  for (const name of installCall.env.keys()) {
    assert.ok(name in env || SHELL_BOOKKEEPING.has(name), `${name} was added to the no-shim install`);
  }
});

test("the agent-run strip list is read from sanitizeInheritedPaperclipEnv", () => {
  const names = readAgentRunStrippedNames();
  for (const name of ["PAPERCLIP_SECRETS_MASTER_KEY_FILE", "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET", "DATABASE_MIGRATION_URL"]) {
    assert.ok(names.includes(name), `expected ${name} in the strip list`);
  }
});
