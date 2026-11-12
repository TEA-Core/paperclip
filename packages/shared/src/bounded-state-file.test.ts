import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { once } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BoundedStateFileError,
  isSameFileIdentity,
  readBoundedStateFile,
  STATE_FILE_MAX_BYTES,
  writeStateFileAtomic,
} from "./bounded-state-file.js";

/** Local malformed inputs must fail within the startup budget. */
const STARTUP_BUDGET_MS = 2_000;
const moduleUrl = new URL("./bounded-state-file.ts", import.meta.url).href;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-bounded-state-")));
  temporaryRoots.push(root);
  return root;
}

function refusalCode(read: () => unknown): string {
  try {
    read();
  } catch (error) {
    expect(error).toBeInstanceOf(BoundedStateFileError);
    return (error as BoundedStateFileError).code;
  }
  throw new Error("expected the read to be refused");
}

/**
 * Runs a read in a separate Node process (loading the module through Node's
 * type stripping). A blocking open would hang this worker's event loop, so the
 * child is the only way for a regression to fail the test instead of wedging
 * the suite. The child must exit on its own, well inside the startup budget.
 */
function readInChild(body: string): { stdout: string; elapsedMs: number } {
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import * as m from ${JSON.stringify(moduleUrl)};\n${body}`],
    { encoding: "utf8", timeout: 20_000 },
  );
  const elapsedMs = performance.now() - started;
  expect(result.signal, "the read was killed instead of finishing").toBeNull();
  expect(result.status, result.stderr).toBe(0);
  return { stdout: result.stdout.trim(), elapsedMs };
}

describe("readBoundedStateFile", () => {
  it("reads a regular file and reports a missing one as absent", () => {
    const root = makeRoot();
    const filePath = path.join(root, "seed-manifest.json");
    expect(readBoundedStateFile(filePath)).toBeNull();
    expect(readBoundedStateFile(path.join(root, "missing-dir", "seed-manifest.json"))).toBeNull();

    const contents = randomBytes(32).toString("hex");
    fs.writeFileSync(filePath, contents);
    expect(readBoundedStateFile(filePath)?.toString("utf8")).toBe(contents);

    fs.writeFileSync(filePath, "");
    expect(readBoundedStateFile(filePath)?.length).toBe(0);
  });

  it("reads exactly the size limit and refuses one byte more", () => {
    const filePath = path.join(makeRoot(), "seed-manifest.json");
    fs.writeFileSync(filePath, Buffer.alloc(STATE_FILE_MAX_BYTES, 0x20));
    expect(readBoundedStateFile(filePath)?.length).toBe(STATE_FILE_MAX_BYTES);

    fs.writeFileSync(filePath, Buffer.alloc(STATE_FILE_MAX_BYTES + 1, 0x20));
    expect(refusalCode(() => readBoundedStateFile(filePath))).toBe("oversize");
  });

  it("refuses a FIFO with no writer without blocking", () => {
    const fifoPath = path.join(makeRoot(), "seed-manifest.json");
    expect(spawnSync("mkfifo", [fifoPath]).status).toBe(0);

    const { stdout, elapsedMs } = readInChild(`
try {
  m.readBoundedStateFile(${JSON.stringify(fifoPath)});
  console.log("read");
} catch (error) {
  console.log(error.code ?? "unexpected");
}`);
    expect(stdout).toBe("not_regular");
    expect(elapsedMs).toBeLessThan(STARTUP_BUDGET_MS);
  });

  it("refuses a directory, a symlink, a dangling symlink, a socket and a device", async () => {
    const root = makeRoot();
    const target = path.join(root, "target.json");
    fs.writeFileSync(target, "{}");

    const directory = path.join(root, "directory.json");
    fs.mkdirSync(directory);
    const symlink = path.join(root, "symlink.json");
    fs.symlinkSync(target, symlink);
    const dangling = path.join(root, "dangling.json");
    fs.symlinkSync(path.join(root, "nowhere.json"), dangling);

    const socketPath = path.join(root, "socket.json");
    const server = net.createServer().listen(socketPath);
    await once(server, "listening");
    try {
      for (const candidate of [directory, symlink, dangling, socketPath, "/dev/null"]) {
        const started = performance.now();
        expect(refusalCode(() => readBoundedStateFile(candidate))).toBe("not_regular");
        expect(performance.now() - started).toBeLessThan(STARTUP_BUDGET_MS);
      }
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("refuses a hard-linked alias and a relative path", () => {
    const root = makeRoot();
    const filePath = path.join(root, "seed-manifest.json");
    fs.writeFileSync(filePath, "{}");
    fs.linkSync(filePath, path.join(root, "alias.json"));
    expect(refusalCode(() => readBoundedStateFile(filePath))).toBe("hard_linked");
    expect(refusalCode(() => readBoundedStateFile("seed-manifest.json"))).toBe("not_absolute");
  });

  it("does not block when the file is swapped for a FIFO between the checks and the open", () => {
    const root = makeRoot();
    const filePath = path.join(root, "seed-manifest.json");
    const fifoPath = path.join(root, "staged-fifo");
    fs.writeFileSync(filePath, "{}");
    expect(spawnSync("mkfifo", [fifoPath]).status).toBe(0);

    // The hook runs between the lstat checks and the open.
    const body = `
import fs from "node:fs";
try {
  m.readBoundedStateFile(${JSON.stringify(filePath)}, {
    hooks: { afterPathCheck: () => fs.renameSync(${JSON.stringify(fifoPath)}, ${JSON.stringify(filePath)}) },
  });
  console.log("read");
} catch (error) {
  console.log(error.code ?? "unexpected");
}`;
    const { stdout, elapsedMs } = readInChild(body);
    expect(stdout).toBe("changed");
    expect(elapsedMs).toBeLessThan(STARTUP_BUDGET_MS);
    expect(fs.lstatSync(filePath).isFIFO()).toBe(true);
  });

  it("refuses a file swapped for a symlink, a directory or another file before the open", () => {
    const root = makeRoot();
    const filePath = path.join(root, "seed-manifest.json");
    const other = path.join(root, "other.json");

    const swapThenRead = (swap: () => void) => {
      fs.rmSync(filePath, { recursive: true, force: true });
      fs.writeFileSync(filePath, "{}");
      return refusalCode(() => readBoundedStateFile(filePath, { hooks: { afterPathCheck: swap } }));
    };

    expect(swapThenRead(() => {
      fs.writeFileSync(other, "{}");
      fs.rmSync(filePath);
      fs.symlinkSync(other, filePath);
    })).toBe("changed");
    expect(swapThenRead(() => {
      fs.rmSync(filePath);
      fs.mkdirSync(filePath);
    })).toBe("changed");
    expect(swapThenRead(() => {
      fs.writeFileSync(other, "{}");
      fs.renameSync(other, filePath);
    })).toBe("changed");
  });

  it("refuses growth, oversize growth and truncation while reading", () => {
    const root = makeRoot();
    const filePath = path.join(root, "seed-manifest.json");
    const readWith = (afterDescriptorCheck: () => void) => {
      fs.writeFileSync(filePath, "{\"version\":2}");
      return refusalCode(() => readBoundedStateFile(filePath, { hooks: { afterDescriptorCheck } }));
    };

    expect(readWith(() => fs.appendFileSync(filePath, " "))).toBe("grown");
    expect(readWith(() => fs.appendFileSync(filePath, Buffer.alloc(STATE_FILE_MAX_BYTES, 0x20)))).toBe("oversize");
    expect(readWith(() => fs.truncateSync(filePath, 3))).toBe("truncated");
  });

  it("names the path and reason but never the contents", () => {
    const filePath = path.join(makeRoot(), "seed-manifest.json");
    const canary = randomBytes(24).toString("hex");
    fs.writeFileSync(filePath, `${canary}${" ".repeat(STATE_FILE_MAX_BYTES)}`);
    try {
      readBoundedStateFile(filePath);
      throw new Error("expected an oversize refusal");
    } catch (error) {
      expect((error as Error).message).toContain(filePath);
      expect((error as Error).message).not.toContain(canary);
    }
  });

  it("compares file identities exactly beyond 2^53", () => {
    const base = 2n ** 53n;
    // As Numbers these two inodes are the same value, which would accept a
    // swapped file; as bigints they differ.
    expect(Number(base)).toBe(Number(base + 1n));
    expect(isSameFileIdentity({ dev: 1n, ino: base }, { dev: 1n, ino: base + 1n })).toBe(false);
    expect(isSameFileIdentity({ dev: base, ino: 7n }, { dev: base + 1n, ino: 7n })).toBe(false);
    expect(isSameFileIdentity({ dev: 1n, ino: base }, { dev: 1n, ino: base })).toBe(true);
  });
});

describe("writeStateFileAtomic", () => {
  it("replaces the file with owner-only permissions and leaves no temporary file", () => {
    const root = makeRoot();
    const filePath = path.join(root, "seed-manifest.json");
    const previousUmask = process.umask(0o000);
    try {
      fs.writeFileSync(filePath, "old", { mode: 0o644 });
      const previousInode = fs.statSync(filePath, { bigint: true }).ino;
      const contents = randomBytes(16).toString("hex");
      writeStateFileAtomic(filePath, contents);

      const stat = fs.statSync(filePath, { bigint: true });
      expect(stat.mode & 0o777n).toBe(0o600n);
      expect(stat.ino).not.toBe(previousInode);
      expect(readBoundedStateFile(filePath)?.toString("utf8")).toBe(contents);
      expect(fs.readdirSync(root)).toEqual(["seed-manifest.json"]);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("removes its temporary file and keeps the target when the rename fails", () => {
    const root = makeRoot();
    const directoryTarget = path.join(root, "seed-manifest.json");
    fs.mkdirSync(directoryTarget);
    fs.writeFileSync(path.join(directoryTarget, "keep"), "");

    expect(() => writeStateFileAtomic(directoryTarget, "{}")).toThrow();
    expect(fs.readdirSync(root)).toEqual(["seed-manifest.json"]);
    expect(fs.readdirSync(directoryTarget)).toEqual(["keep"]);
  });

  it("refuses relative paths and a missing private directory", () => {
    const root = makeRoot();
    expect(() => writeStateFileAtomic("seed-manifest.json", "{}")).toThrow(BoundedStateFileError);
    expect(() => writeStateFileAtomic(path.join(root, "missing", "seed-manifest.json"), "{}")).toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
