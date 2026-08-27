#!/usr/bin/env node
// Per-uid half of the two-real-uid worktree state-partition regression probe
// (SUP-14127, SUP-14126 ruling item 4).
//
// This child is launched as root by the harness and drops itself to ONE real
// target uid via process.setuid() (the harness verifies the drop by reading
// back process.getuid()). It then performs the partition assertions for that
// uid: the other uid's 0o600 canonical/scoped config+env must yield a genuine
// EACCES from a real open(), the current uid's worktree state-dir resolution
// must land on the current uid's OWN scoped state dir, and the run must never
// mutate the other uid's files (stat uid + mtime before/after). The root
// orchestrator (scripts/probe-worktree-uid-partition.sh) runs this child once
// per real uid, so both directions are exercised in one probe run.
//
// The resolution under test is the tree's real consumer code
// (server/src/dev-runner-worktree.ts), imported through tsx's loader BEFORE the
// privilege drop (so it is read from the live tree) and CALLED after the drop
// (so every process.getuid()-derived decision is made as the real target uid).
// This works against both the fold head (canonical-only resolution) and the
// uid-scoped resolution (SUP-14087/14118). A hardcoded `uid-<n>` directory name
// never stands in for a real uid here: every scoped path is derived from the
// real process uid and the other real uid passed in the environment.
//
// Required environment:
//   PAPERCLIP_PROBE_ROOT                 fixture worktree root
//   PAPERCLIP_PROBE_TARGET_UID           the real uid to drop to for this run
//   PAPERCLIP_PROBE_OTHER_UID            the other real uid (numeric)
//   PAPERCLIP_PROBE_REPO_ROOT            repo root whose resolution code is probed
//   PAPERCLIP_PROBE_CANONICAL_OWNER_UID  the uid that owns the canonical .paperclip/ state
//   PAPERCLIP_PROBE_TSX_LOADER           (optional) absolute tsx loader path; discovered otherwise
//
// Usage: probe-worktree-uid-partition-child.mjs <provision|resolve>

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROLE = process.argv[2];
if (ROLE !== "provision" && ROLE !== "resolve") {
  console.error(`probe child: unknown role "${ROLE}" (expected provision|resolve)`);
  process.exit(2);
}

const root = path.resolve(requireEnv("PAPERCLIP_PROBE_ROOT"));
const targetUid = Number(requireEnv("PAPERCLIP_PROBE_TARGET_UID"));
const otherUid = Number(requireEnv("PAPERCLIP_PROBE_OTHER_UID"));
const repoRoot = path.resolve(requireEnv("PAPERCLIP_PROBE_REPO_ROOT"));
const canonicalOwnerUid = Number(requireEnv("PAPERCLIP_PROBE_CANONICAL_OWNER_UID"));

if (!Number.isInteger(targetUid) || !Number.isInteger(otherUid) || !Number.isInteger(canonicalOwnerUid)) {
  console.error("probe child: PAPERCLIP_PROBE_TARGET_UID/OTHER_UID/CANONICAL_OWNER_UID must be numeric uids");
  process.exit(2);
}
if (targetUid === 0 || otherUid === 0 || canonicalOwnerUid === 0) {
  console.error(
    "probe child: refusing to run any phase as uid 0 — root bypasses the 0o600 permission " +
      "boundary, so an EACCES assertion under root would be meaningless",
  );
  process.exit(2);
}
if (targetUid === otherUid) {
  console.error(
    `probe child: refusing to run — target uid ${targetUid} equals the other real uid; ` +
      "a probe run needs two DISTINCT real uids",
  );
  process.exit(2);
}

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    console.error(`probe child: missing required environment variable ${name}`);
    process.exit(2);
  }
  return value;
}

function fail(reason) {
  console.error(`FAIL - ${reason}`);
  process.exitCode = 1;
}

async function loadResolutionModule() {
  const candidates = [
    process.env.PAPERCLIP_PROBE_TSX_LOADER,
    path.join(repoRoot, "cli", "node_modules", "tsx", "dist", "loader.mjs"),
    path.join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs"),
  ].filter(Boolean);
  const loader = candidates.find((candidate) => fs.existsSync(candidate));
  if (!loader) {
    fail(
      `cannot load the tree's resolution module: no tsx loader found under ${repoRoot} ` +
        "(expected cli/node_modules/tsx/dist/loader.mjs or node_modules/tsx/dist/loader.mjs; " +
        "run `pnpm install --frozen-lockfile` first)",
    );
    return null;
  }
  await import(pathToFileURL(loader).href);
  const modulePath = path.join(repoRoot, "server", "src", "dev-runner-worktree.ts");
  if (!fs.existsSync(modulePath)) {
    fail(`resolution module not found at ${modulePath}`);
    return null;
  }
  return import(pathToFileURL(modulePath).href);
}

// The module is imported while still root so the live tree is readable even
// under a non-traversable checkout path; every assertion below runs after the
// drop, with the process's real uid equal to the target.
const module = ROLE === "resolve" ? await loadResolutionModule() : null;
if (ROLE === "resolve" && !module) process.exit(1);

if (typeof process.setuid !== "function" || typeof process.getuid !== "function") {
  console.error("probe child: this platform cannot setuid/getuid — cannot run a real-uid probe");
  process.exit(2);
}

// Drop: setgid before setuid (after setuid the gid can no longer be changed),
// then verify the drop actually took rather than assuming it.
try {
  if (typeof process.setgid === "function") process.setgid(targetUid);
  process.setuid(targetUid);
} catch (error) {
  console.error(
    `probe child: cannot drop to real uid ${targetUid}: ${error.message} — ` +
      "the two-real-uid contract cannot be met; the harness must run as root",
  );
  process.exit(2);
}

const uid = process.getuid();
if (uid !== targetUid) {
  console.error(
    `probe child: privilege drop failed — after setuid(${targetUid}) the real uid reads ${uid}; ` +
      "the two-real-uid contract cannot be met",
  );
  process.exit(2);
}
console.log(`probe child dropped to real uid ${uid} (other uid ${otherUid})`);

const canonicalDir = path.resolve(root, ".paperclip");
const scopedDir = path.resolve(canonicalDir, `uid-${uid}`);
const otherScopedDir = path.resolve(canonicalDir, `uid-${otherUid}`);

const canonicalFiles = ["config.json", ".env"].map((name) => path.join(canonicalDir, name));
// The owning uid's provisioned state lives in the canonical dir for the
// canonical owner and in the uid-scoped dir for every other uid, so the
// cross-uid EACCES target is selected per direction.
const crossTargets =
  uid === canonicalOwnerUid
    ? ["config.json", ".env"].map((name) => path.join(otherScopedDir, name))
    : canonicalFiles;

function snapshot(paths) {
  return Object.fromEntries(
    paths.map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return [
          filePath,
          { uid: stat.uid, mode: stat.mode, mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino },
        ];
      } catch (error) {
        return [filePath, { error: error.code ?? error.message }];
      }
    }),
  );
}

function assertUnchanged(before, after, label) {
  for (const [filePath, beforeStat] of Object.entries(before)) {
    const afterStat = after[filePath];
    if (afterStat?.error) {
      fail(`${label}: ${filePath} became unreadable (${afterStat.error}) — the resolution mutated the owning uid's state`);
      continue;
    }
    if (
      beforeStat?.error ||
      beforeStat.uid !== afterStat.uid ||
      beforeStat.mtimeMs !== afterStat.mtimeMs ||
      beforeStat.size !== afterStat.size ||
      beforeStat.mode !== afterStat.mode ||
      beforeStat.ino !== afterStat.ino
    ) {
      fail(
        `${label}: ${filePath} changed across the run ` +
          `(before uid=${beforeStat?.uid} mode=${beforeStat?.mode} mtime=${beforeStat?.mtimeMs}; ` +
          `after uid=${afterStat.uid} mode=${afterStat.mode} mtime=${afterStat.mtimeMs}) — ` +
          "the non-owning uid mutated the owning uid's state",
      );
    } else if (afterStat.uid !== otherUid) {
      fail(
        `${label}: ${filePath} is owned by uid ${afterStat.uid}, not the other real uid ${otherUid} — ` +
          "the EACCES assertion would not be testing a real cross-uid boundary",
      );
    }
  }
}

function writePrivateFile(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function provision() {
  // Canonical state belongs to the first provisioner (the canonical owner).
  // Canonical `seed-pending` is intentionally left WITHOUT `seed-complete`:
  // the canonical owner's seeding is mid-flight, which is the state that must
  // never gate a different uid's resolution.
  if (uid === canonicalOwnerUid) {
    fs.mkdirSync(canonicalDir, { recursive: true });
    writePrivateFile(path.join(canonicalDir, "config.json"), JSON.stringify({ probe: true, uid }, null, 2) + "\n");
    writePrivateFile(
      path.join(canonicalDir, ".env"),
      [
        "# Paperclip environment variables",
        `PAPERCLIP_INSTANCE_ID=probe-canonical-${uid}`,
        "PAPERCLIP_IN_WORKTREE=true",
        "",
      ].join("\n"),
    );
    writePrivateFile(path.join(canonicalDir, "seed-pending"), "{}\n");
  }

  // Every uid provisions its own scoped state dir, complete with its own env,
  // config and seed markers. The scoped dir is traversable but not writable by
  // other uids (0o711), so the partition boundary under test is the 0o600
  // FILE mode exactly as in production — not the directory.
  fs.mkdirSync(scopedDir, { recursive: true });
  fs.chmodSync(scopedDir, 0o711);
  writePrivateFile(path.join(scopedDir, "config.json"), JSON.stringify({ probe: true, uid }, null, 2) + "\n");
  writePrivateFile(
    path.join(scopedDir, ".env"),
    [
      "# Paperclip environment variables",
      `PAPERCLIP_INSTANCE_ID=probe-instance-${uid}`,
      "PAPERCLIP_IN_WORKTREE=true",
      `PAPERCLIP_HOME=${path.resolve(root, `.paperclip-probe-home-${uid}`)}`,
      "",
    ].join("\n"),
  );
  writePrivateFile(path.join(scopedDir, "seed-pending"), "{}\n");
  writePrivateFile(path.join(scopedDir, "seed-complete"), "{}\n");

  console.log(`provisioned uid-scoped state dir ${scopedDir} for real uid ${uid}`);
}

async function resolve() {
  const resolveWorktreeEnvFilePath = module.resolveWorktreeEnvFilePath;
  const bootstrapDevRunnerWorktreeEnv = module.bootstrapDevRunnerWorktreeEnv;
  const isWorktreeSeedPending = module.isWorktreeSeedPending;
  const resolveWorktreeStateDir = module.resolveWorktreeStateDir;
  const isLinkedGitWorktreeCheckout = module.isLinkedGitWorktreeCheckout;

  if (!isLinkedGitWorktreeCheckout(root)) {
    fail(`resolution module did not recognize ${root} as a linked git worktree`);
  }

  // --- EACCES on the owning uid's 0o600 config/env + same-uid control ------
  const controlFiles =
    uid === canonicalOwnerUid ? canonicalFiles : ["config.json", ".env"].map((name) => path.join(scopedDir, name));
  for (const filePath of controlFiles) {
    try {
      fs.readFileSync(filePath, "utf8");
      console.log(`ok   - same-uid control: uid ${uid} can read its own ${path.basename(filePath)}`);
    } catch (error) {
      fail(`same-uid control failed: uid ${uid} could not read its own ${filePath}: ${error.code ?? error.message}`);
    }
  }

  for (const filePath of crossTargets) {
    try {
      const contents = fs.readFileSync(filePath, "utf8");
      fail(
        `cross-uid partition broken: uid ${uid} READ the other real uid ${otherUid}'s ${filePath} ` +
          `(contents: ${JSON.stringify(contents).slice(0, 80)})`,
      );
    } catch (error) {
      if (error.code === "EACCES") {
        let owner = "unreachable";
        let mode = "?";
        try {
          const stat = fs.statSync(filePath);
          owner = String(stat.uid);
          mode = (stat.mode & 0o777).toString(8);
        } catch {
          // Directory-level deny can make even the stat fail; the EACCES on
          // the open is what the assertion is about.
        }
        console.log(
          `ok   - cross-uid EACCES: uid ${uid} -> ${filePath} errno=EACCES ` +
            `(owner uid ${owner}, mode ${mode})`,
        );
      } else {
        fail(
          `cross-uid probe: uid ${uid} touching ${filePath} failed with ${error.code ?? error.message}, ` +
            "expected a genuine EACCES from the kernel",
        );
      }
    }
  }

  // --- the resolution must land on the current uid's OWN scoped dir ---------
  const expectedScopedDir = path.join(canonicalDir, `uid-${uid}`);
  let envPath;
  try {
    envPath = resolveWorktreeEnvFilePath(root);
  } catch (error) {
    fail(`resolveWorktreeEnvFilePath threw: ${error.code ?? error.message}`);
    return;
  }

  if (path.dirname(envPath) === expectedScopedDir) {
    console.log(`ok   - resolution lands on the running uid's scoped dir: ${path.dirname(envPath)}`);
  } else {
    fail(
      `uid-scoped partition missing: uid ${uid} resolved ${envPath} (dir ${path.dirname(envPath)}), ` +
        `expected the uid's own scoped dir ${expectedScopedDir} — the resolution is not uid-scoped`,
    );
  }

  if (typeof resolveWorktreeStateDir === "function") {
    const stateDir = resolveWorktreeStateDir(root);
    if (stateDir === expectedScopedDir) {
      console.log(`ok   - resolveWorktreeStateDir returns the running uid's scoped dir (${stateDir})`);
    } else {
      fail(`resolveWorktreeStateDir returned ${stateDir}, expected ${expectedScopedDir}`);
    }
    if (stateDir !== path.dirname(envPath)) {
      fail(
        `consumer divergence: resolveWorktreeStateDir (${stateDir}) disagrees with ` +
          `resolveWorktreeEnvFilePath (${path.dirname(envPath)})`,
      );
    }
  }

  // --- the resolved env must be readable and actually bootstrap the uid -----
  try {
    const contents = fs.readFileSync(envPath, "utf8");
    console.log(`ok   - resolved env is readable by uid ${uid}: ${envPath}`);
    const bootstrap = bootstrapDevRunnerWorktreeEnv(root, {});
    if (bootstrap.missingEnv) {
      fail(`bootstrapDevRunnerWorktreeEnv reported missingEnv despite a readable ${envPath}`);
    } else if (path.resolve(bootstrap.envPath ?? "") !== path.resolve(envPath)) {
      fail(`bootstrapDevRunnerWorktreeEnv resolved ${bootstrap.envPath}, expected ${envPath}`);
    } else if (!contents.includes(`PAPERCLIP_INSTANCE_ID=probe-instance-${uid}`)) {
      fail(`scoped env at ${envPath} is not the running uid's own env`);
    } else {
      console.log(`ok   - bootstrapDevRunnerWorktreeEnv returns ${envPath}, missingEnv=false`);
    }
  } catch (error) {
    fail(
      `the running uid cannot bootstrap from its resolved env ${envPath}: ` +
        `${error.code ?? error.message} — the resolution is not uid-scoped`,
    );
  }

  // --- the OTHER uid's pending canonical seed must not gate this uid --------
  try {
    const pending = isWorktreeSeedPending(root);
    if (pending === false) {
      console.log("ok   - the other uid's pending canonical seed does not gate this uid (isWorktreeSeedPending=false)");
    } else {
      fail(
        "isWorktreeSeedPending returned true for a uid whose own scoped state is seed-complete — " +
          "the resolution is not uid-scoped",
      );
    }
  } catch (error) {
    fail(`isWorktreeSeedPending threw: ${error.code ?? error.message}`);
  }
}

async function main() {
  if (ROLE === "provision") {
    provision();
    return;
  }
  const before = snapshot(crossTargets);
  await resolve();
  const after = snapshot(crossTargets);
  assertUnchanged(before, after, "non-mutation");
}

main().then(
  () => {
    if (process.exitCode) {
      console.error(`probe child (uid ${uid}, role ${ROLE}) FAILED`);
    } else {
      console.log(`probe child (uid ${uid}, role ${ROLE}) PASSED`);
    }
  },
  (error) => {
    console.error(`probe child crashed: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  },
);
