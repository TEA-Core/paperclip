import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-shared-group-test-"));
}

function getGidOfPath(p: string): number | null {
  try {
    const stat = fs.statSync(p);
    return stat.gid;
  } catch {
    return null;
  }
}

function getModeOfPath(p: string): number {
  return fs.statSync(p).mode & 0o7777;
}

const REAL_GID = 1002;

async function loadFreshModule() {
  vi.resetModules();
  const mod = await import("../services/shared-group-ownership.js");
  return mod;
}

describe("shared-group-ownership", () => {
  describe("ensureSharedGroupOwnership", () => {
    it("sets the setgid bit on the directory when the group exists", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const dir = createTempDir();
      try {
        await ensureSharedGroupOwnership(dir, {
          resolveGid: async () => REAL_GID,
          resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
        });
        const mode = getModeOfPath(dir);
        expect(mode & 0o2000).toBe(0o2000);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("chgrps to the resolved group when the group exists", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const dir = createTempDir();
      try {
        await ensureSharedGroupOwnership(dir, {
          resolveGid: async () => REAL_GID,
          resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
        });
        const gid = getGidOfPath(dir);
        expect(gid).toBe(REAL_GID);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not throw when the directory does not exist", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const dir = path.join(os.tmpdir(), "paperclip-nonexistent-dir-" + Date.now());
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
      const dir1 = createTempDir();
      const dir2 = createTempDir();
      try {
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
      } finally {
        fs.rmSync(dir1, { recursive: true, force: true });
        fs.rmSync(dir2, { recursive: true, force: true });
      }
    });

    it("warns when chgrp/chmod fails, independent of the missing-group warning", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const warnSpy = vi.fn();
      const dir = createTempDir();
      const nonexistentDir = path.join(dir, "does-not-exist");
      try {
        await ensureSharedGroupOwnership(nonexistentDir, {
          resolveGid: async () => REAL_GID,
          resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
          warn: warnSpy,
        });
        expect(warnSpy).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("master-key isolation guard", () => {
    it("refuses to chgrp the master-key directory itself", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const keyDir = createTempDir();
      try {
        const originalGid = getGidOfPath(keyDir);
        const originalMode = getModeOfPath(keyDir);

        await ensureSharedGroupOwnership(keyDir, {
          resolveGid: async () => REAL_GID,
          resolveMasterKeyDir: () => keyDir,
        });

        const newGid = getGidOfPath(keyDir);
        const newMode = getModeOfPath(keyDir);
        expect(newGid).toBe(originalGid);
        expect(newMode).toBe(originalMode);
      } finally {
        fs.rmSync(keyDir, { recursive: true, force: true });
      }
    });

    it("refuses to chgrp an ancestor of the master-key directory", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const instanceRoot = createTempDir();
      const secretsDir = path.join(instanceRoot, "secrets");
      const masterKeyPath = path.join(secretsDir, "master.key");
      try {
        fs.mkdirSync(secretsDir, { recursive: true });
        fs.writeFileSync(masterKeyPath, "test-key", { mode: 0o600 });

        const originalGid = getGidOfPath(secretsDir);
        const originalMode = getModeOfPath(secretsDir);

        await ensureSharedGroupOwnership(instanceRoot, {
          resolveGid: async () => REAL_GID,
          resolveMasterKeyDir: () => secretsDir,
        });

        const newGid = getGidOfPath(secretsDir);
        const newMode = getModeOfPath(secretsDir);
        expect(newGid).toBe(originalGid);
        expect(newMode).toBe(originalMode);

        const masterKeyMode = fs.statSync(masterKeyPath).mode & 0o7777;
        expect(masterKeyMode & 0o004).toBe(0);
        expect(masterKeyMode & 0o040).toBe(0);
      } finally {
        fs.rmSync(instanceRoot, { recursive: true, force: true });
      }
    });

    it("does not set the setgid bit on the master-key directory", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const keyDir = createTempDir();
      try {
        await ensureSharedGroupOwnership(keyDir, {
          resolveGid: async () => REAL_GID,
          resolveMasterKeyDir: () => keyDir,
        });

        const mode = getModeOfPath(keyDir);
        expect(mode & 0o2000).toBe(0);
      } finally {
        fs.rmSync(keyDir, { recursive: true, force: true });
      }
    });

    it("still applies chgrp to a directory that is not the master-key dir or its ancestor", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const keyDir = createTempDir();
      const otherDir = createTempDir();
      try {
        await ensureSharedGroupOwnership(otherDir, {
          resolveGid: async () => REAL_GID,
          resolveMasterKeyDir: () => keyDir,
        });

        const gid = getGidOfPath(otherDir);
        expect(gid).toBe(REAL_GID);
        const mode = getModeOfPath(otherDir);
        expect(mode & 0o2000).toBe(0o2000);
      } finally {
        fs.rmSync(keyDir, { recursive: true, force: true });
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });
  });
});
