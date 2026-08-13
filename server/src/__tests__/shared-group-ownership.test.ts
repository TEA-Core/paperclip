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

      await ensureSharedGroupOwnership(keyDir, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => keyDir,
      });

      expect(mockChown).not.toHaveBeenCalled();
      expect(mockChmod).not.toHaveBeenCalled();
    });

    it("refuses to chgrp an ancestor of the master-key directory", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const instanceRoot = path.join(os.tmpdir(), "paperclip-shared-group-test-ancestor");
      const secretsDir = path.join(instanceRoot, "secrets");

      await ensureSharedGroupOwnership(instanceRoot, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => secretsDir,
      });

      expect(mockChown).not.toHaveBeenCalled();
      expect(mockChmod).not.toHaveBeenCalled();
    });

    it("does not set the setgid bit on the master-key directory", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const keyDir = path.join(os.tmpdir(), "paperclip-shared-group-test-keydir-2");

      await ensureSharedGroupOwnership(keyDir, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => keyDir,
      });

      expect(mockChmod).not.toHaveBeenCalled();
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

      await ensureSharedGroupOwnership(pgData, {
        resolveGid: async () => REAL_GID,
        resolvePostgresDataDir: () => pgData,
      });

      expect(mockChown).not.toHaveBeenCalled();
      expect(mockChmod).not.toHaveBeenCalled();
    });

    it("refuses to chgrp an ancestor of the resolved embedded-Postgres data directory", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const instanceRoot = path.join(os.tmpdir(), "paperclip-shared-group-test-pgdata-ancestor");
      const pgData = path.join(instanceRoot, "db");

      await ensureSharedGroupOwnership(instanceRoot, {
        resolveGid: async () => REAL_GID,
        resolvePostgresDataDir: () => pgData,
      });

      expect(mockChown).not.toHaveBeenCalled();
      expect(mockChmod).not.toHaveBeenCalled();
    });

    it("refuses to chgrp the resolved database backup directory", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const backupDir = path.join(os.tmpdir(), "paperclip-shared-group-test-backup");

      await ensureSharedGroupOwnership(backupDir, {
        resolveGid: async () => REAL_GID,
        resolveDatabaseBackupDir: () => backupDir,
      });

      expect(mockChown).not.toHaveBeenCalled();
      expect(mockChmod).not.toHaveBeenCalled();
    });
  });
});
