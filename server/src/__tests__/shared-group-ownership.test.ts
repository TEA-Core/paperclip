import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// --- Mock infrastructure ---
// The new implementation opens the target by fd and mutates via handle methods.
// We mock fs.open (returns a handle) and fs.realpath (for /proc/self/fd/N).
const mockOpen = vi.fn();
const mockRealpath = vi.fn();

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    default: {
      ...actual,
      open: mockOpen,
      realpath: mockRealpath,
    },
  };
});

vi.mock("../home-paths.js", () => ({
  resolveSecretsKeyDir: vi.fn(() => "/tmp/nonexistent-secrets"),
  resolveSecretsMasterKeyFilePath: vi.fn(() => "/tmp/nonexistent-secrets/master.key"),
  resolveDefaultSecretsKeyFilePath: vi.fn(() => "/tmp/nonexistent-secrets/master.key"),
  resolveDefaultEmbeddedPostgresDir: vi.fn(() => "/tmp/nonexistent-db"),
  resolveDefaultBackupDir: vi.fn(() => "/tmp/nonexistent-backups"),
}));

const REAL_GID = 1002;

interface MockHandle {
  fd: number;
  stat: ReturnType<typeof vi.fn>;
  chown: ReturnType<typeof vi.fn>;
  chmod: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function createMockHandle(overrides: Partial<Record<string, any>> = {}): MockHandle {
  const statResult = { uid: 1000, mode: 0o755, isDirectory: () => true };
  const handle: MockHandle = {
    fd: 100,
    stat: vi.fn().mockResolvedValue(statResult),
    chown: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return handle;
}

/**
 * Set up mockOpen to succeed with a given handle, and mockRealpath to
 * resolve /proc/self/fd/100 to the specified verified path.
 */
function setupOpenSuccess(verifiedPath: string, handleOverrides: Partial<Record<string, any>> = {}): MockHandle {
  const handle = createMockHandle(handleOverrides);
  mockOpen.mockResolvedValue(handle);
  mockRealpath.mockImplementation(async (p: string) => {
    if (p.startsWith("/proc/self/fd/")) return verifiedPath;
    // For containmentRoot resolution, return the path as-is
    return p;
  });
  return handle;
}

async function loadFreshModule() {
  vi.resetModules();
  const mod = await import("../services/shared-group-ownership.js");
  return mod;
}

describe("shared-group-ownership", () => {
  beforeEach(() => {
    mockOpen.mockReset();
    mockRealpath.mockReset();
  });

  describe("ensureSharedGroupOwnership", () => {
    it("sets the setgid bit on the directory when the group exists", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const dir = path.join(os.tmpdir(), "paperclip-shared-group-test-setgid");
      const handle = setupOpenSuccess(dir);

      await ensureSharedGroupOwnership(dir, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
      });

      expect(handle.chmod).toHaveBeenCalledTimes(1);
      expect(handle.chmod).toHaveBeenCalledWith(0o755 | 0o2070);
      expect(handle.close).toHaveBeenCalled();
    });

    it("adds group rwx and the setgid bit to a 0700 dir (the mkdtemp case)", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const dir = path.join(os.tmpdir(), "paperclip-shared-group-test-mkdtemp");
      const handle = setupOpenSuccess(dir, {
        stat: vi.fn().mockResolvedValue({ uid: 1000, mode: 0o700, isDirectory: () => true }),
      });

      await ensureSharedGroupOwnership(dir, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
      });

      expect(handle.chmod).toHaveBeenCalledTimes(1);
      const chmodMode = handle.chmod.mock.calls[0]?.[0] as number;
      expect(chmodMode & 0o2000).toBe(0o2000);
      expect(chmodMode & 0o0070).toBe(0o0070);
    });

    it("chgrps to the resolved group when the group exists", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const dir = path.join(os.tmpdir(), "paperclip-shared-group-test-chgrp");
      const handle = setupOpenSuccess(dir);

      await ensureSharedGroupOwnership(dir, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
      });

      expect(handle.chown).toHaveBeenCalledTimes(1);
      expect(handle.chown).toHaveBeenCalledWith(1000, REAL_GID);
    });

    it("does not throw when the directory does not exist (open fails ENOENT)", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const dir = path.join(os.tmpdir(), "paperclip-nonexistent-dir-" + Date.now());
      const warnSpy = vi.fn();
      mockOpen.mockRejectedValue(Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }));

      await expect(
        ensureSharedGroupOwnership(dir, {
          resolveGid: async () => REAL_GID,
          resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
          warn: warnSpy,
        }),
      ).resolves.not.toThrow();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("cannot open"));
    });

    it("warns exactly once when the group is missing across multiple calls", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const warnSpy = vi.fn();
      const dir1 = path.join(os.tmpdir(), "paperclip-shared-group-test-missing-1");
      const dir2 = path.join(os.tmpdir(), "paperclip-shared-group-test-missing-2");

      setupOpenSuccess(dir1);
      await ensureSharedGroupOwnership(dir1, {
        resolveGid: async () => null,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
        warn: warnSpy,
      });

      mockOpen.mockReset();
      setupOpenSuccess(dir2);
      await ensureSharedGroupOwnership(dir2, {
        resolveGid: async () => null,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
        warn: warnSpy,
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not found"));
    });

    it("warns when open fails with ELOOP (symlink leaf)", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const warnSpy = vi.fn();
      const dir = path.join(os.tmpdir(), "paperclip-shared-group-test-eLOOP");
      mockOpen.mockRejectedValue(Object.assign(new Error("ELOOP: too many levels of symbolic links"), { code: "ELOOP" }));

      await ensureSharedGroupOwnership(dir, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
        warn: warnSpy,
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("cannot open"));
    });
  });

  describe("containment root verification", () => {
    it("refuses mutation when the verified path is outside containmentRoot", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const warnSpy = vi.fn();
      const lexicalPath = path.join(os.tmpdir(), "worktree", "subdir", "target");
      const externalTarget = path.join(os.tmpdir(), "outside", "secret");
      const containmentRoot = path.join(os.tmpdir(), "worktree");

      const handle = setupOpenSuccess(externalTarget);

      await ensureSharedGroupOwnership(lexicalPath, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
        containmentRoot,
        warn: warnSpy,
      });

      expect(handle.chown).not.toHaveBeenCalled();
      expect(handle.chmod).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("outside the containment root"));
    });

    it("allows mutation when the verified path is within containmentRoot", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const warnSpy = vi.fn();
      const lexicalPath = path.join(os.tmpdir(), "worktree", "subdir", "target");
      const verifiedPath = path.join(os.tmpdir(), "worktree", "subdir", "target");
      const containmentRoot = path.join(os.tmpdir(), "worktree");

      const handle = setupOpenSuccess(verifiedPath);

      await ensureSharedGroupOwnership(lexicalPath, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
        containmentRoot,
        warn: warnSpy,
      });

      expect(handle.chown).toHaveBeenCalledTimes(1);
      expect(handle.chmod).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("allows mutation when the verified path IS the containmentRoot", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const warnSpy = vi.fn();
      const containmentRoot = path.join(os.tmpdir(), "worktree");

      const handle = setupOpenSuccess(containmentRoot);

      await ensureSharedGroupOwnership(containmentRoot, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
        containmentRoot,
        warn: warnSpy,
      });

      expect(handle.chown).toHaveBeenCalledTimes(1);
      expect(handle.chmod).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("does not require containmentRoot (backward compat for non-self-repair call sites)", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const dir = path.join(os.tmpdir(), "paperclip-no-containment");
      const handle = setupOpenSuccess(dir);

      await ensureSharedGroupOwnership(dir, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
      });

      expect(handle.chown).toHaveBeenCalledTimes(1);
      expect(handle.chmod).toHaveBeenCalledTimes(1);
    });
  });

  describe("master-key isolation guard", () => {
    beforeEach(() => {
      mockOpen.mockReset();
      mockRealpath.mockReset();
    });

    it("refuses to chgrp the master-key directory itself", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const keyDir = path.join(os.tmpdir(), "paperclip-shared-group-test-keydir-1");
      const warnSpy = vi.fn();

      const handle = setupOpenSuccess(keyDir);

      await ensureSharedGroupOwnership(keyDir, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => keyDir,
        warn: warnSpy,
      });

      expect(handle.chown).not.toHaveBeenCalled();
      expect(handle.chmod).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("refusing shared-group ownership"));
    });

    it("refuses to chgrp an ancestor of the master-key directory", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const instanceRoot = path.join(os.tmpdir(), "paperclip-shared-group-test-ancestor");
      const secretsDir = path.join(instanceRoot, "secrets");
      const warnSpy = vi.fn();

      // The verified path IS the instanceRoot (an ancestor of secretsDir)
      const handle = setupOpenSuccess(instanceRoot);

      await ensureSharedGroupOwnership(instanceRoot, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => secretsDir,
        warn: warnSpy,
      });

      expect(handle.chown).not.toHaveBeenCalled();
      expect(handle.chmod).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("refusing shared-group ownership"));
    });

    it("refuses to chgrp a DESCENDANT of the master-key directory (both directions)", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const keyDir = path.join(os.tmpdir(), "paperclip-shared-group-test-keydir-desc");
      const subdir = path.join(keyDir, "subdir");
      const warnSpy = vi.fn();

      // The verified path is a descendant of the denied keyDir
      const handle = setupOpenSuccess(subdir);

      await ensureSharedGroupOwnership(subdir, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => keyDir,
        warn: warnSpy,
      });

      expect(handle.chown).not.toHaveBeenCalled();
      expect(handle.chmod).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("refusing shared-group ownership"));
    });

    it("still applies chgrp to a directory that is not the master-key dir or related", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const keyDir = path.join(os.tmpdir(), "paperclip-shared-group-test-keydir-3");
      const otherDir = path.join(os.tmpdir(), "paperclip-shared-group-test-other-1");

      const handle = setupOpenSuccess(otherDir);

      await ensureSharedGroupOwnership(otherDir, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => keyDir,
      });

      expect(handle.chown).toHaveBeenCalledTimes(1);
      expect(handle.chown).toHaveBeenCalledWith(1000, REAL_GID);
      expect(handle.chmod).toHaveBeenCalledTimes(1);
      expect(handle.chmod).toHaveBeenCalledWith(0o755 | 0o2070);
    });
  });

  describe("server-owned directory guard", () => {
    beforeEach(() => {
      mockOpen.mockReset();
      mockRealpath.mockReset();
    });

    it("refuses to chgrp the resolved embedded-Postgres data directory", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const pgData = path.join(os.tmpdir(), "paperclip-shared-group-test-pgdata");
      const warnSpy = vi.fn();

      const handle = setupOpenSuccess(pgData);

      await ensureSharedGroupOwnership(pgData, {
        resolveGid: async () => REAL_GID,
        resolvePostgresDataDir: () => pgData,
        warn: warnSpy,
      });

      expect(handle.chown).not.toHaveBeenCalled();
      expect(handle.chmod).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("refusing shared-group ownership"));
    });

    it("refuses to chgrp an ancestor of the resolved embedded-Postgres data directory", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const instanceRoot = path.join(os.tmpdir(), "paperclip-shared-group-test-pgdata-ancestor");
      const pgData = path.join(instanceRoot, "db");
      const warnSpy = vi.fn();

      const handle = setupOpenSuccess(instanceRoot);

      await ensureSharedGroupOwnership(instanceRoot, {
        resolveGid: async () => REAL_GID,
        resolvePostgresDataDir: () => pgData,
        warn: warnSpy,
      });

      expect(handle.chown).not.toHaveBeenCalled();
      expect(handle.chmod).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("refusing shared-group ownership"));
    });

    it("refuses to chgrp the resolved database backup directory", async () => {
      const { ensureSharedGroupOwnership } = await loadFreshModule();
      const backupDir = path.join(os.tmpdir(), "paperclip-shared-group-test-backup");
      const warnSpy = vi.fn();

      const handle = setupOpenSuccess(backupDir);

      await ensureSharedGroupOwnership(backupDir, {
        resolveGid: async () => REAL_GID,
        resolveDatabaseBackupDir: () => backupDir,
        warn: warnSpy,
      });

      expect(handle.chown).not.toHaveBeenCalled();
      expect(handle.chmod).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("refusing shared-group ownership"));
    });
  });

  describe("ensureSharedGroupTraversalPath", () => {
    beforeEach(() => {
      mockOpen.mockReset();
      mockRealpath.mockReset();
    });

    it("repairs every ancestor from the leaf up to and including stopAt", async () => {
      const { ensureSharedGroupTraversalPath } = await loadFreshModule();
      const repoRoot = path.join(os.tmpdir(), "paperclip-traversal-repo");
      const dotPaperclip = path.join(repoRoot, ".paperclip");
      const worktrees = path.join(repoRoot, ".paperclip", "worktrees");

      const handles: MockHandle[] = [];
      mockOpen.mockImplementation(async () => {
        const h = createMockHandle({
          stat: vi.fn().mockResolvedValue({ uid: 1000, mode: 0o2700, isDirectory: () => true }),
        });
        handles.push(h);
        return h;
      });
      mockRealpath.mockImplementation(async (p: string) => {
        if (p.startsWith("/proc/self/fd/")) return p.replace("/proc/self/fd/100", "");
        return p;
      });

      await ensureSharedGroupTraversalPath(worktrees, repoRoot, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
      });

      // 3 directories: repoRoot, .paperclip, worktrees
      expect(handles).toHaveLength(3);
      for (const h of handles) {
        expect(h.chmod).toHaveBeenCalledWith(0o2700 | 0o2070);
      }
    });

    it("repairs top-down, stopAt before the leaf", async () => {
      const { ensureSharedGroupTraversalPath } = await loadFreshModule();
      const repoRoot = path.join(os.tmpdir(), "paperclip-traversal-order");
      const worktrees = path.join(repoRoot, ".paperclip", "worktrees");

      const openedPaths: string[] = [];
      mockOpen.mockImplementation(async (p: string) => {
        openedPaths.push(p);
        return createMockHandle({
          stat: vi.fn().mockResolvedValue({ uid: 1000, mode: 0o2700, isDirectory: () => true }),
        });
      });
      mockRealpath.mockImplementation(async (p: string) => p);

      await ensureSharedGroupTraversalPath(worktrees, repoRoot, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
      });

      expect(openedPaths[0]).toBe(repoRoot);
      expect(openedPaths[openedPaths.length - 1]).toBe(worktrees);
    });

    it("repairs only the leaf when it does not sit under stopAt", async () => {
      const { ensureSharedGroupTraversalPath } = await loadFreshModule();
      const repoRoot = path.join(os.tmpdir(), "paperclip-traversal-repo");
      const outside = path.join(os.tmpdir(), "paperclip-traversal-elsewhere", "worktrees");

      const handle = createMockHandle({
        stat: vi.fn().mockResolvedValue({ uid: 1000, mode: 0o2700, isDirectory: () => true }),
      });
      mockOpen.mockResolvedValue(handle);
      mockRealpath.mockImplementation(async (p: string) => p);

      await ensureSharedGroupTraversalPath(outside, repoRoot, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
      });

      expect(mockOpen).toHaveBeenCalledTimes(1);
      expect(handle.chmod).toHaveBeenCalledWith(0o2700 | 0o2070);
    });

    it("repairs exactly once when the leaf is stopAt", async () => {
      const { ensureSharedGroupTraversalPath } = await loadFreshModule();
      const repoRoot = path.join(os.tmpdir(), "paperclip-traversal-same");

      const handle = createMockHandle({
        stat: vi.fn().mockResolvedValue({ uid: 1000, mode: 0o2700, isDirectory: () => true }),
      });
      mockOpen.mockResolvedValue(handle);
      mockRealpath.mockImplementation(async (p: string) => p);

      await ensureSharedGroupTraversalPath(repoRoot, repoRoot, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(os.tmpdir(), "nonexistent-secrets"),
      });

      expect(mockOpen).toHaveBeenCalledTimes(1);
      expect(handle.chmod).toHaveBeenCalledWith(0o2700 | 0o2070);
    });

    it("still refuses a server-owned directory encountered while walking the chain", async () => {
      const { ensureSharedGroupTraversalPath } = await loadFreshModule();
      const repoRoot = path.join(os.tmpdir(), "paperclip-traversal-denied");
      const worktrees = path.join(repoRoot, ".paperclip", "worktrees");
      const warnSpy = vi.fn();

      const fdToPath = new Map<number, string>();
      const handles: MockHandle[] = [];
      let nextFd = 200;
      mockOpen.mockImplementation(async (p: string) => {
        const fd = nextFd++;
        fdToPath.set(fd, p);
        const h = createMockHandle({
          fd,
          stat: vi.fn().mockResolvedValue({ uid: 1000, mode: 0o2700, isDirectory: () => true }),
        });
        handles.push(h);
        return h;
      });
      mockRealpath.mockImplementation(async (p: string) => {
        if (p.startsWith("/proc/self/fd/")) {
          const fd = parseInt(p.replace("/proc/self/fd/", ""), 10);
          return fdToPath.get(fd) ?? p;
        }
        return p;
      });

      await ensureSharedGroupTraversalPath(worktrees, repoRoot, {
        resolveGid: async () => REAL_GID,
        resolveMasterKeyDir: () => path.join(repoRoot, "secrets"),
        warn: warnSpy,
      });

      // repoRoot is an ancestor of the secrets dir, so it must be refused
      const repoRootHandle = handles.find(
        (h) => fdToPath.get(h.fd) === repoRoot,
      );
      expect(repoRootHandle).toBeDefined();
      expect(repoRootHandle!.chown).not.toHaveBeenCalled();
      expect(repoRootHandle!.chmod).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("refusing shared-group ownership"));
    });
  });
});

// --- Regression tests with real filesystem ---
// These verify the TOCTOU fix against real symlink races.
describe("shared-group-ownership regression (real fs)", () => {
  let tmpRoot: string;
  let realFs: typeof import("node:fs/promises");

  beforeAll(async () => {
    realFs = await vi.importActual("node:fs/promises");
    tmpRoot = await realFs.mkdtemp(path.join(os.tmpdir(), "sgo-regression-"));
    // Use real fs for open/realpath in these tests
    mockOpen.mockImplementation((...args) => realFs.open(...args));
    mockRealpath.mockImplementation((...args) => realFs.realpath(...args));
  });

  afterAll(async () => {
    await realFs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("regression: ancestor-swap race — external target unchanged", async () => {
    const { ensureSharedGroupOwnership } = await loadFreshModule();

    // Create: tmpRoot/worktree/realdir/file.txt
    const worktree = path.join(tmpRoot, "worktree");
    const realdir = path.join(worktree, "realdir");
    const externalTarget = path.join(tmpRoot, "outside", "target.txt");
    await realFs.mkdir(realdir, { recursive: true });
    await realFs.mkdir(path.dirname(externalTarget), { recursive: true });
    await realFs.writeFile(externalTarget, "secret-data", "utf8");
    const beforeStat = await realFs.stat(externalTarget);

    // Create: tmpRoot/worktree/linkeddir -> tmpRoot/outside (ancestor symlink)
    // Then "target" resolves to tmpRoot/outside/target.txt via the ancestor symlink
    const linkedDir = path.join(worktree, "linkeddir");
    await realFs.symlink(path.join(tmpRoot, "outside"), linkedDir, "dir");

    // The lexical path is inside the worktree, but resolves outside
    const lexicalPath = path.join(linkedDir, "target.txt");

    await ensureSharedGroupOwnership(lexicalPath, {
      resolveGid: async () => REAL_GID,
      resolveMasterKeyDir: () => path.join(tmpRoot, "nonexistent-secrets"),
      containmentRoot: worktree,
      warn: () => {},
    });

    // The external target must be UNCHANGED
    const afterStat = await realFs.stat(externalTarget);
    expect(afterStat.uid).toBe(beforeStat.uid);
    expect(afterStat.mode).toBe(beforeStat.mode);
    const content = await realFs.readFile(externalTarget, "utf8");
    expect(content).toBe("secret-data");
  });

  it("regression: symlinked leaf is skipped (ELOOP via O_NOFOLLOW)", async () => {
    const { ensureSharedGroupOwnership } = await loadFreshModule();
    const warnSpy = vi.fn();

    const worktree = path.join(tmpRoot, "worktree2");
    const externalFile = path.join(tmpRoot, "outside2", "secret.txt");
    await realFs.mkdir(worktree, { recursive: true });
    await realFs.mkdir(path.dirname(externalFile), { recursive: true });
    await realFs.writeFile(externalFile, "do-not-touch", "utf8");

    // Create a symlink INSIDE the worktree that points outside
    const leafSymlink = path.join(worktree, "leaf-link");
    await realFs.symlink(externalFile, leafSymlink);

    const beforeStat = await realFs.stat(externalFile);

    await ensureSharedGroupOwnership(leafSymlink, {
      resolveGid: async () => REAL_GID,
      resolveMasterKeyDir: () => path.join(tmpRoot, "nonexistent-secrets"),
      containmentRoot: worktree,
      warn: warnSpy,
    });

    // The leaf symlink was rejected by O_NOFOLLOW; no mutation on the target
    const afterStat = await realFs.stat(externalFile);
    expect(afterStat.uid).toBe(beforeStat.uid);
    expect(afterStat.mode).toBe(beforeStat.mode);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("cannot open"));
  });

  it("regression: denied descendant is refused even via real fs", async () => {
    const { ensureSharedGroupOwnership } = await loadFreshModule();
    const warnSpy = vi.fn();

    const worktree = path.join(tmpRoot, "worktree3");
    const secretsDir = path.join(worktree, "secrets");
    const secretSubdir = path.join(secretsDir, "keys");
    await realFs.mkdir(secretSubdir, { recursive: true });
    await realFs.writeFile(path.join(secretSubdir, "key.bin"), "x", "utf8");

    const beforeStat = await realFs.stat(secretSubdir);

    await ensureSharedGroupOwnership(secretSubdir, {
      resolveGid: async () => REAL_GID,
      resolveMasterKeyDir: () => secretsDir,
      containmentRoot: worktree,
      warn: warnSpy,
    });

    // The secret subdir (descendant of the denied secrets dir) must be unchanged
    const afterStat = await realFs.stat(secretSubdir);
    expect(afterStat.mode).toBe(beforeStat.mode);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("refusing shared-group ownership"));
  });
});
