// The authoritative regression probe for the uid-scoped worktree state
// partition is scripts/probe-worktree-uid-partition.sh (SUP-14127, SUP-14126
// ruling item 4): it runs the resolution under two DISTINCT REAL uids and
// asserts a genuine EACCES on the other uid's 0o600 state plus own-scoped-dir
// resolution. A test that names a directory `uid-<n>` asserts a string
// convention, not a permission boundary — it must never substitute for that
// probe, and the probe's CI check is the gate for the SUP-14087/14118 cluster.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapDevRunnerWorktreeEnv,
  isWorktreeSeedPending,
  isLinkedGitWorktreeCheckout,
  resolveWorktreeEnvFilePath,
  resolveWorktreeStateDir,
} from "../dev-runner-worktree.ts";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

function createTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.add(root);
  return root;
}

describe("dev-runner worktree env bootstrap", () => {
  it("guards seed-pending worktrees until a seed-complete marker exists", () => {
    const root = createTempRoot("paperclip-dev-runner-seed-pending-");
    fs.mkdirSync(path.join(root, ".paperclip"), { recursive: true });
    fs.writeFileSync(path.join(root, ".paperclip", "seed-pending"), "{}\n", "utf8");

    expect(isWorktreeSeedPending(root)).toBe(true);

    fs.writeFileSync(path.join(root, ".paperclip", "seed-complete"), "{}\n", "utf8");
    expect(isWorktreeSeedPending(root)).toBe(false);
  });

  it("guards every manifest state except a complete verified manifest", () => {
    const root = createTempRoot("paperclip-dev-runner-seed-manifest-");
    const manifestPath = path.join(root, ".paperclip", "seed-manifest.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 2, state: "failed" }), "utf8");
    expect(isWorktreeSeedPending(root)).toBe(true);

    fs.writeFileSync(manifestPath, JSON.stringify({ version: 2, state: "verified" }), "utf8");
    expect(isWorktreeSeedPending(root)).toBe(true);

    fs.writeFileSync(manifestPath, JSON.stringify({
      version: 2,
      source: { instanceId: "source", configPath: "/source/config.json" },
      snapshotAt: "2026-08-18T00:00:00.000Z",
      seedMode: "minimal",
      migrationRevision: "0001",
      targetInstanceId: "target",
      phase: "complete",
      state: "verified",
      attemptId: "attempt",
      startedAt: "2026-08-18T00:00:00.000Z",
      finishedAt: "2026-08-18T00:01:00.000Z",
      diagnostics: [{ phase: "complete", status: "succeeded", at: "2026-08-18T00:01:00.000Z" }],
    }), "utf8");
    expect(isWorktreeSeedPending(root)).toBe(false);

    fs.writeFileSync(manifestPath, "not-json", "utf8");
    expect(isWorktreeSeedPending(root)).toBe(true);
  });

  it("resolves the uid-scoped state dir when it exists for the running uid, else the canonical dir", () => {
    const root = createTempRoot("paperclip-dev-runner-scoped-state-");
    const uid = process.getuid ? process.getuid() : -1;
    const canonicalDir = path.join(root, ".paperclip");
    const scopedDir = path.join(canonicalDir, `uid-${uid}`);
    fs.mkdirSync(canonicalDir, { recursive: true });

    // No scoped state yet: canonical resolution, as before.
    expect(resolveWorktreeStateDir(root)).toBe(canonicalDir);
    expect(resolveWorktreeEnvFilePath(root)).toBe(path.join(canonicalDir, ".env"));
    expect(isWorktreeSeedPending(root)).toBe(false);

    fs.mkdirSync(scopedDir, { recursive: true });
    fs.writeFileSync(path.join(scopedDir, ".env"), "PAPERCLIP_IN_WORKTREE=true\n", "utf8");

    expect(resolveWorktreeStateDir(root)).toBe(scopedDir);
    expect(resolveWorktreeEnvFilePath(root)).toBe(path.join(scopedDir, ".env"));

    fs.writeFileSync(path.join(scopedDir, "seed-pending"), "{}\n", "utf8");
    expect(isWorktreeSeedPending(root)).toBe(true);
    fs.writeFileSync(path.join(scopedDir, "seed-complete"), "{}\n", "utf8");
    expect(isWorktreeSeedPending(root)).toBe(false);

    // Once the scoped state dir is active, canonical markers no longer gate
    // this run — the other uid's pending seed must not block it.
    fs.writeFileSync(path.join(canonicalDir, "seed-pending"), "{}\n", "utf8");
    expect(isWorktreeSeedPending(root)).toBe(false);
  });

  it("keeps canonical seed markers authoritative for a different uid's scoped dir", () => {
    const root = createTempRoot("paperclip-dev-runner-scoped-other-uid-");
    const canonicalDir = path.join(root, ".paperclip");
    fs.mkdirSync(canonicalDir, { recursive: true });
    fs.writeFileSync(path.join(canonicalDir, "seed-pending"), "{}\n", "utf8");

    const otherUidDir = path.join(canonicalDir, "uid-4242");
    fs.mkdirSync(otherUidDir, { recursive: true });
    fs.writeFileSync(path.join(otherUidDir, ".env"), "PAPERCLIP_IN_WORKTREE=true\n", "utf8");

    // The running uid is not 4242, so the other uid's scoped dir is ignored
    // and the canonical marker still gates.
    const uid = process.getuid ? process.getuid() : -1;
    expect(uid).not.toBe(4242);
    expect(resolveWorktreeStateDir(root)).toBe(canonicalDir);
    expect(isWorktreeSeedPending(root)).toBe(true);
  });

  it("detects linked git worktrees from .git files", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-");
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/paperclip/.git/worktrees/feature\n", "utf8");

    expect(isLinkedGitWorktreeCheckout(root)).toBe(true);
  });

  it("loads repo-local Paperclip env for initialized worktrees without overriding explicit env", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-env-");
    fs.mkdirSync(path.join(root, ".paperclip"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/paperclip/.git/worktrees/feature\n", "utf8");
    fs.writeFileSync(
      resolveWorktreeEnvFilePath(root),
      [
        "PAPERCLIP_HOME=/tmp/paperclip-worktrees",
        "PAPERCLIP_INSTANCE_ID=feature-worktree",
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_WORKTREE_NAME=feature-worktree",
        "PAPERCLIP_OPTIONAL= # comment-only value",
        "",
      ].join("\n"),
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_INSTANCE_ID: "already-set",
    };
    const result = bootstrapDevRunnerWorktreeEnv(root, env);

    expect(result).toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      missingEnv: false,
    });
    expect(env.PAPERCLIP_HOME).toBe("/tmp/paperclip-worktrees");
    expect(env.PAPERCLIP_INSTANCE_ID).toBe("already-set");
    expect(env.PAPERCLIP_IN_WORKTREE).toBe("true");
    expect(env.PAPERCLIP_OPTIONAL).toBe("");
  });

  it("repairs stale migrated config paths before loading worktree env", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-migrated-env-");
    const localConfigPath = path.join(root, ".paperclip", "config.json");
    const worktreesDir = path.join(root, ".paperclip-worktrees");
    fs.mkdirSync(path.dirname(localConfigPath), { recursive: true });
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/paperclip/.git/worktrees/feature\n", "utf8");
    fs.writeFileSync(localConfigPath, "{}\n", "utf8");
    fs.writeFileSync(
      resolveWorktreeEnvFilePath(root),
      [
        "PAPERCLIP_HOME=/old/home/.paperclip-worktrees",
        "PAPERCLIP_INSTANCE_ID=feature-worktree",
        "PAPERCLIP_CONFIG=/old/home/paperclip/.paperclip/worktrees/feature/.paperclip/config.json",
        "PAPERCLIP_CONTEXT=/old/home/.paperclip-worktrees/context.json",
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_WORKTREE_NAME=feature-worktree",
        "",
      ].join("\n"),
      "utf8",
    );

    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_WORKTREES_DIR: worktreesDir,
    };
    const result = bootstrapDevRunnerWorktreeEnv(root, env);

    expect(result).toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      missingEnv: false,
    });
    expect(env.PAPERCLIP_HOME).toBe(worktreesDir);
    expect(env.PAPERCLIP_CONFIG).toBe(localConfigPath);
    expect(env.PAPERCLIP_CONTEXT).toBe(path.join(worktreesDir, "context.json"));
    expect(env.PAPERCLIP_INSTANCE_ID).toBe("feature-worktree");
  });

  it("reports uninitialized linked worktrees so dev runner can fail fast", () => {
    const root = createTempRoot("paperclip-dev-runner-worktree-missing-");
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /tmp/paperclip/.git/worktrees/feature\n", "utf8");

    expect(bootstrapDevRunnerWorktreeEnv(root, {})).toEqual({
      envPath: resolveWorktreeEnvFilePath(root),
      missingEnv: true,
    });
  });
});
