import { describe, expect, it, vi, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";

const mockChown = vi.fn();
const mockChmod = vi.fn();
const mockStat = vi.fn();

vi.mock("node:fs/promises", () => ({
  default: {
    chown: mockChown,
    chmod: mockChmod,
    stat: mockStat,
  },
}));

vi.mock("../home-paths.js", () => ({
  // The master-key directory is resolved through resolveSecretsKeyDir now, so
  // that the PAPERCLIP_SECRETS_MASTER_KEY_FILE override reaches every key file
  // the server persists rather than only the master key itself.
  resolveSecretsKeyDir: vi.fn(() => "/tmp/nonexistent-secrets"),
  resolveSecretsMasterKeyFilePath: vi.fn(() => "/tmp/nonexistent-secrets/master.key"),
  resolveDefaultSecretsKeyFilePath: vi.fn(() => "/tmp/nonexistent-secrets/master.key"),
  resolveDefaultEmbeddedPostgresDir: vi.fn(() => "/tmp/nonexistent-db"),
  resolveDefaultBackupDir: vi.fn(() => "/tmp/nonexistent-backups"),
}));

const REAL_GID = 1002;

async function loadFreshModule() {
  vi.resetModules();
  const mod = await import("../services/shared-group-ownership.js");
  return mod;
}

describe("shared-group-ownership", () => {
  describe("ensureSharedGroupOwnership", () => {
    beforeEach(() => {
      mockChown.mockReset();
      mockChmod.mockReset();
      mockStat.mockReset();
    });

    it("sets the setgid bit on the directory when the group exists", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const dir = path.join(os.tmpdir(), "paperclip-shared-group-test-setgid");

      mockStat.mockResolvedValue({ uid: 1000, mode: 0o755 });

      await ensureSharedGroupOwnership(dir, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
      });

      expect(mockChmod).toHaveBeenCalledTimes(1);
      expect(mockChmod).toHaveBeenCalledWith(dir, 0o755 | 0o2070);
    });

    it("adds group rwx and the setgid bit to a 0700 dir (the mkdtemp case)", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const dir = path.join(os.tmpdir(), "paperclip-shared-group-test-mkdtemp");

      mockStat.mockResolvedValue({ uid: 1000, mode: 0o700 });

      await ensureSharedGroupOwnership(dir, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
      });

      expect(mockChmod).toHaveBeenCalledTimes(1);
      const chmodMode = mockChmod.mock.calls[0]?.[1] as number;
      expect(chmodMode & 0o2000).toBe(0o2000);
      expect(chmodMode & 0o0070).toBe(0o0070); // group rwx — the fix under test
    });

    it("chgrps to the resolved group when the group exists", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const dir = path.join(os.tmpdir(), "paperclip-shared-group-test-chgrp");

      mockStat.mockResolvedValue({ uid: 1000, mode: 0o755 });

      await ensureSharedGroupOwnership(dir, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
      });

      expect(mockChown).toHaveBeenCalledTimes(1);
      expect(mockChown).toHaveBeenCalledWith(dir, 1000, REAL_GID);
    });

    it("does not throw when the directory does not exist", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const dir = path.join(os.tmpdir(), "paperclip-nonexistent-dir-" + Date.now());

      mockStat.mockRejectedValue(new Error("ENOENT: no such file or directory"));

      await expect(
        ensureSharedGroupOwnership(dir, {
          resolveGid: async () => REAL_GID,
          resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
        }),
      ).resolves.not.toThrow();
    });

    it("warns exactly once when the group is missing across multiple calls", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const warnSpy = vi.fn();
      const dir1 = path.join(os.tmpdir(), "paperclip-shared-group-test-missing-1");
      const dir2 = path.join(os.tmpdir(), "paperclip-shared-group-test-missing-2");

      await ensureSharedGroupOwnership(dir1, {
        resolveGid: async () => null,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
        warn: warnSpy,
      });
      await ensureSharedGroupOwnership(dir2, {
        resolveGid: async () => null,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
        warn: warnSpy,
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(mockChown).not.toHaveBeenCalled();
      expect(mockChmod).not.toHaveBeenCalled();
    });

    it("warns when chgrp/chmod fails, independent of the missing-group warning", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const warnSpy = vi.fn();
      const dir = path.join(os.tmpdir(), "paperclip-shared-group-test-fail");

      mockStat.mockRejectedValue(new Error("ENOENT: no such file or directory"));

      await ensureSharedGroupOwnership(dir, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
        warn: warnSpy,
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(mockChown).not.toHaveBeenCalled();
      expect(mockChmod).not.toHaveBeenCalled();
    });
  });

  describe("master-key isolation guard", () => {
    beforeEach(() => {
      mockChown.mockReset();
      mockChmod.mockReset();
      mockStat.mockReset();
    });

    it("refuses to chgrp the master-key directory itself", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const keyDir = path.join(os.tmpdir(), "paperclip-shared-group-test-keydir-1");
      const warnSpy = vi.fn();

      mockStat.mockResolvedValue({ uid: 1000, mode: 0o755 });

      await ensureSharedGroupOwnership(keyDir, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => keyDir,
        warn: warnSpy,
      });

      expect(mockChown).not.toHaveBeenCalled();
      expect(mockChmod).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("refusing shared-group ownership"));
    });

    it("refuses to chgrp an ancestor of the master-key directory", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const instanceRoot = path.join(os.tmpdir(), "paperclip-shared-group-test-ancestor");
      const secretsDir = path.join(instanceRoot, "secrets");
      const warnSpy = vi.fn();

      mockStat.mockResolvedValue({ uid: 1000, mode: 0o755 });

      await ensureSharedGroupOwnership(instanceRoot, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => secretsDir,
        warn: warnSpy,
      });

      expect(mockChown).not.toHaveBeenCalled();
      expect(mockChmod).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("refusing shared-group ownership"));
    });

    it("does not set the setgid bit on the master-key directory", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const keyDir = path.join(os.tmpdir(), "paperclip-shared-group-test-keydir-2");
      const warnSpy = vi.fn();

      mockStat.mockResolvedValue({ uid: 1000, mode: 0o755 });

      await ensureSharedGroupOwnership(keyDir, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => keyDir,
        warn: warnSpy,
      });

      expect(mockChown).not.toHaveBeenCalled();
      expect(mockChmod).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("refusing shared-group ownership"));
    });

    it("still applies chgrp to a directory that is not the master-key dir or its ancestor", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const keyDir = path.join(os.tmpdir(), "paperclip-shared-group-test-keydir-3");
      const otherDir = path.join(os.tmpdir(), "paperclip-shared-group-test-other-1");

      mockStat.mockResolvedValue({ uid: 1000, mode: 0o755 });

      await ensureSharedGroupOwnership(otherDir, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => keyDir,
      });

      expect(mockChown).toHaveBeenCalledTimes(1);
      expect(mockChown).toHaveBeenCalledWith(otherDir, 1000, REAL_GID);
      expect(mockChmod).toHaveBeenCalledTimes(1);
      expect(mockChmod).toHaveBeenCalledWith(otherDir, 0o755 | 0o2070);
    });
  });

  describe("server-owned directory guard", () => {
    beforeEach(() => {
      mockChown.mockReset();
      mockChmod.mockReset();
      mockStat.mockReset();
    });

    it("refuses to chgrp the resolved embedded-Postgres data directory", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const pgData = path.join(os.tmpdir(), "paperclip-shared-group-test-pgdata");
      const warnSpy = vi.fn();

      mockStat.mockResolvedValue({ uid: 1000, mode: 0o755 });

      await ensureSharedGroupOwnership(pgData, {
        resolveGid: async () => REAL_GID,
        resolvePostgresDataDir: () => pgData,
        warn: warnSpy,
      });

      expect(mockChown).not.toHaveBeenCalled();
      expect(mockChmod).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("refusing shared-group ownership"));
    });

    it("refuses to chgrp an ancestor of the resolved embedded-Postgres data directory", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const instanceRoot = path.join(os.tmpdir(), "paperclip-shared-group-test-pgdata-ancestor");
      const pgData = path.join(instanceRoot, "db");
      const warnSpy = vi.fn();

      mockStat.mockResolvedValue({ uid: 1000, mode: 0o755 });

      await ensureSharedGroupOwnership(instanceRoot, {
        resolveGid: async () => REAL_GID,
        resolvePostgresDataDir: () => pgData,
        warn: warnSpy,
      });

      expect(mockChown).not.toHaveBeenCalled();
      expect(mockChmod).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("refusing shared-group ownership"));
    });

    it("refuses to chgrp the resolved database backup directory", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const backupDir = path.join(os.tmpdir(), "paperclip-shared-group-test-backup");
      const warnSpy = vi.fn();

      mockStat.mockResolvedValue({ uid: 1000, mode: 0o755 });

      await ensureSharedGroupOwnership(backupDir, {
        resolveGid: async () => REAL_GID,
        resolveDatabaseBackupDir: () => backupDir,
        warn: warnSpy,
      });

      expect(mockChown).not.toHaveBeenCalled();
      expect(mockChmod).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("refusing shared-group ownership"));
    });
  });

  describe("ensureSharedGroupTraversalPath", () => {
    beforeEach(() => {
      mockChown.mockReset();
      mockChmod.mockReset();
      mockStat.mockReset();
    });

    // Traversal is an all-or-nothing property of the whole ancestor chain:
    // uid 1001 needs the x bit on EVERY directory between the repo root and
    // the worktree. Repairing only the leaf leaves the chain broken while
    // looking fixed, which is exactly how the production EACCES happened.
    it("repairs every ancestor from the leaf up to and including stopAt", async () => {
      const { ensureSharedGroupTraversalPath } = await loadFreshModule();
      const repoRoot = path.join(os.tmpdir(), "paperclip-traversal-repo");
      const dotPaperclip = path.join(repoRoot, ".paperclip");
      const worktrees = path.join(dotPaperclip, "worktrees");

      mockStat.mockResolvedValue({ uid: 1000, mode: 0o2700 });

      await ensureSharedGroupTraversalPath(worktrees, repoRoot, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
      });

      expect(mockChmod).toHaveBeenCalledTimes(3);
      expect(mockChmod.mock.calls.map((c) => c[0])).toEqual([repoRoot, dotPaperclip, worktrees]);
      // 0o2700 -> 0o2770: the group x bit is what makes the path traversable.
      for (const call of mockChmod.mock.calls) {
        expect(call[1]).toBe(0o2700 | 0o2070);
      }
    });

    // Top-down, so an interrupted walk never leaves a traversable leaf sitting
    // behind an untraversable ancestor — a state that reads as repaired but
    // still returns EACCES.
    it("repairs top-down, stopAt before the leaf", async () => {
      const { ensureSharedGroupTraversalPath } = await loadFreshModule();
      const repoRoot = path.join(os.tmpdir(), "paperclip-traversal-order");
      const worktrees = path.join(repoRoot, ".paperclip", "worktrees");

      mockStat.mockResolvedValue({ uid: 1000, mode: 0o2700 });

      await ensureSharedGroupTraversalPath(worktrees, repoRoot, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
      });

      const order = mockChmod.mock.calls.map((c) => c[0] as string);
      expect(order[0]).toBe(repoRoot);
      expect(order[order.length - 1]).toBe(worktrees);
    });

    it("repairs only the leaf when it does not sit under stopAt", async () => {
      const { ensureSharedGroupTraversalPath } = await loadFreshModule();
      const repoRoot = path.join(os.tmpdir(), "paperclip-traversal-repo");
      // A configured worktreeParentDir may point outside the repo entirely.
      // Walking "up to" an unrelated stopAt would climb to the filesystem root.
      const outside = path.join(os.tmpdir(), "paperclip-traversal-elsewhere", "worktrees");

      mockStat.mockResolvedValue({ uid: 1000, mode: 0o2700 });

      await ensureSharedGroupTraversalPath(outside, repoRoot, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
      });

      expect(mockChmod).toHaveBeenCalledTimes(1);
      expect(mockChmod).toHaveBeenCalledWith(outside, 0o2700 | 0o2070);
    });

    it("repairs exactly once when the leaf is stopAt", async () => {
      const { ensureSharedGroupTraversalPath } = await loadFreshModule();
      const repoRoot = path.join(os.tmpdir(), "paperclip-traversal-same");

      mockStat.mockResolvedValue({ uid: 1000, mode: 0o2700 });

      await ensureSharedGroupTraversalPath(repoRoot, repoRoot, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
      });

      expect(mockChmod).toHaveBeenCalledTimes(1);
      expect(mockChmod).toHaveBeenCalledWith(repoRoot, 0o2700 | 0o2070);
    });

    it("still refuses a server-owned directory encountered while walking the chain", async () => {
      const { ensureSharedGroupTraversalPath } = await loadFreshModule();
      const repoRoot = path.join(os.tmpdir(), "paperclip-traversal-denied");
      const worktrees = path.join(repoRoot, ".paperclip", "worktrees");
      const warnSpy = vi.fn();

      mockStat.mockResolvedValue({ uid: 1000, mode: 0o2700 });

      // The repo root is an ancestor of the secrets key dir here, so the
      // denial must survive the walk rather than be bypassed by it.
      await ensureSharedGroupTraversalPath(worktrees, repoRoot, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(repoRoot, "secrets"),
        warn: warnSpy,
      });

      expect(mockChmod.mock.calls.map((c) => c[0])).not.toContain(repoRoot);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("refusing shared-group ownership"));
    });
  });
});
