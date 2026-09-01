import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OPENCODE_STORAGE_DIR,
  openCodeLogArchivePath,
  resolveOpenCodeLogPath,
  resolveOpenCodeStorageDir,
  rotateOpenCodeLog,
} from "./opencode-log-rotation.js";

const storageRoots = new Set<string>();

async function makeStorageRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-log-rotation-test-"));
  storageRoots.add(root);
  return root;
}

async function makeLog(root: string, content: string): Promise<string> {
  await fs.mkdir(path.join(root, "log"), { recursive: true });
  const logPath = path.join(root, "log", "opencode.log");
  await fs.writeFile(logPath, content);
  return logPath;
}

afterEach(async () => {
  await Promise.all(
    Array.from(storageRoots, (root) =>
      fs.rm(root, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
  storageRoots.clear();
  vi.unstubAllEnvs();
});

describe("opencode log path resolution (SUP-13970)", () => {
  it("resolves through PAPERCLIP_OPENCODE_STORAGE_DIR with home expansion", () => {
    vi.stubEnv("PAPERCLIP_OPENCODE_STORAGE_DIR", "~/share/opencode");
    expect(resolveOpenCodeLogPath()).toBe(
      path.join(os.homedir(), "share", "opencode", "log", "opencode.log"),
    );
    // An explicit override wins over the env var.
    expect(resolveOpenCodeLogPath("/override/root")).toBe("/override/root/log/opencode.log");
  });

  it("falls back to the shared default when the env var is empty", () => {
    vi.stubEnv("PAPERCLIP_OPENCODE_STORAGE_DIR", "");
    // An empty value must not resolve the log to `log/opencode.log` under the
    // server's cwd; it falls back to the default the feedback bundle uses.
    expect(resolveOpenCodeStorageDir()).toBe(
      path.join(os.homedir(), ".local", "share", "opencode"),
    );
    expect(DEFAULT_OPENCODE_STORAGE_DIR).toBe("~/.local/share/opencode");
  });
});

describe("opencode log rotation (SUP-13970)", () => {
  const smallThreshold = { maxSizeBytes: 1024, retainedTailBytes: 128, retainedArchives: 3 };

  it("is a safe no-op when the log directory does not exist", async () => {
    const root = await makeStorageRoot();
    const result = await rotateOpenCodeLog({ ...smallThreshold, storageDir: root });
    expect(result).toEqual({
      rotated: false,
      logPath: path.join(root, "log", "opencode.log"),
      reason: "missing",
    });
  });

  it("is a safe no-op when the log path is a directory", async () => {
    const root = await makeStorageRoot();
    await fs.mkdir(path.join(root, "log", "opencode.log"), { recursive: true });
    const result = await rotateOpenCodeLog({ ...smallThreshold, storageDir: root });
    expect(result).toMatchObject({ rotated: false, reason: "not_a_file" });
    await expect(fs.stat(path.join(root, "log", "opencode.log"))).resolves.toBeTruthy();
  });

  it("does nothing while the log is below the threshold", async () => {
    const root = await makeStorageRoot();
    const logPath = await makeLog(root, "x".repeat(512));

    const result = await rotateOpenCodeLog({ ...smallThreshold, storageDir: root });

    expect(result).toMatchObject({ rotated: false, reason: "below_threshold", sizeBeforeBytes: 512 });
    expect(await fs.readFile(logPath, "utf8")).toBe("x".repeat(512));
    await expect(fs.stat(openCodeLogArchivePath(logPath, 1))).rejects.toThrow();
  });

  it("truncates an oversized log in place and retains its tail as .1", async () => {
    const root = await makeStorageRoot();
    const head = "A".repeat(1000);
    const tail = "B".repeat(300);
    const logPath = await makeLog(root, head + tail);
    const inodeBefore = (await fs.stat(logPath)).ino;

    const result = await rotateOpenCodeLog({ ...smallThreshold, storageDir: root });

    expect(result).toMatchObject({
      rotated: true,
      sizeBeforeBytes: 1300,
      sizeAfterBytes: 0,
      archivedBytes: 128,
      prunedArchives: 0,
    });
    expect(await fs.readFile(openCodeLogArchivePath(logPath, 1), "utf8")).toBe("B".repeat(128));
    // Copy-truncate, not unlink: the live path must be the same inode, because
    // a writer that holds an append descriptor would otherwise be orphaned.
    expect((await fs.stat(logPath)).ino).toBe(inodeBefore);
  });

  it("keeps a writer that holds the log open on the live path", async () => {
    const root = await makeStorageRoot();
    const logPath = await makeLog(root, "line\n".repeat(2000));
    const writer = await fs.open(logPath, "a");
    try {
      await rotateOpenCodeLog({ ...smallThreshold, storageDir: root });
      await fs.appendFile(writer, "after-rotation\n");
    } finally {
      await writer.close();
    }

    const live = await fs.readFile(logPath, "utf8");
    const archive = await fs.readFile(openCodeLogArchivePath(logPath, 1), "utf8");
    expect(live).toBe("after-rotation\n");
    expect(archive).not.toContain("after-rotation");
  });

  it("shifts existing archives and prunes the oldest beyond retention", async () => {
    const root = await makeStorageRoot();
    const logPath = await makeLog(root, "C".repeat(2048));
    await fs.writeFile(openCodeLogArchivePath(logPath, 1), "archive-one");
    await fs.writeFile(openCodeLogArchivePath(logPath, 2), "archive-two");

    const result = await rotateOpenCodeLog({ ...smallThreshold, retainedArchives: 2, storageDir: root });

    expect(result).toMatchObject({ rotated: true, prunedArchives: 1 });
    expect(await fs.readFile(openCodeLogArchivePath(logPath, 1), "utf8")).toBe("C".repeat(128));
    expect(await fs.readFile(openCodeLogArchivePath(logPath, 2), "utf8")).toBe("archive-one");
    await expect(fs.stat(openCodeLogArchivePath(logPath, 3))).rejects.toThrow();
  });

  it("truncates without keeping an archive when retention is zero", async () => {
    const root = await makeStorageRoot();
    const logPath = await makeLog(root, "D".repeat(4096));

    const result = await rotateOpenCodeLog({
      ...smallThreshold,
      retainedArchives: 0,
      storageDir: root,
    });

    expect(result).toMatchObject({ rotated: true, archivedBytes: 0, prunedArchives: 0 });
    expect(await fs.readFile(logPath, "utf8")).toBe("");
    await expect(fs.stat(openCodeLogArchivePath(logPath, 1))).rejects.toThrow();
  });

  it("prunes every archive above a lowered retention, not just the boundary slot", async () => {
    const root = await makeStorageRoot();
    const logPath = await makeLog(root, "F".repeat(4096));
    // Five archives on disk from a previous, higher retention. A shift-only
    // sweep would touch slot 2 and strand 3, 4 and 5 forever.
    for (const index of [1, 2, 3, 4, 5]) {
      await fs.writeFile(openCodeLogArchivePath(logPath, index), `archive-${index}`);
    }

    const result = await rotateOpenCodeLog({ ...smallThreshold, retainedArchives: 2, storageDir: root });

    expect(result).toMatchObject({ rotated: true, prunedArchives: 4 });
    expect(await fs.readFile(openCodeLogArchivePath(logPath, 1), "utf8")).toBe("F".repeat(128));
    expect(await fs.readFile(openCodeLogArchivePath(logPath, 2), "utf8")).toBe("archive-1");
    for (const index of [3, 4, 5]) {
      await expect(fs.stat(openCodeLogArchivePath(logPath, index))).rejects.toThrow();
    }
  });

  it("removes every existing archive when retention drops to zero", async () => {
    const root = await makeStorageRoot();
    const logPath = await makeLog(root, "G".repeat(4096));
    for (const index of [1, 2, 3]) {
      await fs.writeFile(openCodeLogArchivePath(logPath, index), `archive-${index}`);
    }

    const result = await rotateOpenCodeLog({ ...smallThreshold, retainedArchives: 0, storageDir: root });

    expect(result).toMatchObject({ rotated: true, archivedBytes: 0, prunedArchives: 3 });
    expect(await fs.readFile(logPath, "utf8")).toBe("");
    for (const index of [1, 2, 3]) {
      await expect(fs.stat(openCodeLogArchivePath(logPath, index))).rejects.toThrow();
    }
  });

  it("clears a stale .1.tmp left behind by an interrupted sweep", async () => {
    const root = await makeStorageRoot();
    const logPath = await makeLog(root, "E".repeat(4096));
    await fs.writeFile(`${openCodeLogArchivePath(logPath, 1)}.tmp`, "interrupted-copy");

    const result = await rotateOpenCodeLog({ ...smallThreshold, storageDir: root });

    expect(result).toMatchObject({ rotated: true });
    await expect(fs.stat(`${openCodeLogArchivePath(logPath, 1)}.tmp`)).rejects.toThrow();
    expect(await fs.readFile(openCodeLogArchivePath(logPath, 1), "utf8")).toBe("E".repeat(128));
  });
});
