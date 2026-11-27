import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assignableAgentsGid, withAgentsGid } from "./helpers/agents-gid.js";

// The named-group lookup is the only host dependency; each test sets it.
const getent = vi.hoisted(() => ({ stdout: null as string | null }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const fake = ((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout?: string, stderr?: string) => void;
    if (getent.stdout === null) callback(Object.assign(new Error("not found"), { code: 2 }));
    else callback(null, getent.stdout, "");
  }) as unknown as typeof actual.execFile;
  Object.defineProperty(fake, promisify.custom, {
    value: async () => {
      if (getent.stdout === null) throw Object.assign(new Error("not found"), { code: 2 });
      return { stdout: getent.stdout, stderr: "" };
    },
  });
  return { ...actual, execFile: fake };
});

const { createInstructionDirectory, materializeInstructionBytes, resolveAgentsGid } = await import("../services/agent-instruction-files.js");

// Any supplementary group stands in for the named agents group.
const agentsGid = assignableAgentsGid();
const primaryGid = process.getegid!();
const modeOf = async (filename: string) => (await fs.stat(filename)).mode & 0o7777;

describe("instruction file access", () => {
  let parent: string;
  let root: string;
  const previousUmask = process.umask();

  beforeEach(async () => {
    getent.stdout = null;
    delete process.env.PAPERCLIP_AGENTS_GID;
    parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "instruction-access-")));
    root = path.join(parent, "instructions");
  });

  afterEach(async () => {
    process.umask(previousUmask);
    delete process.env.PAPERCLIP_AGENTS_GID;
    vi.restoreAllMocks();
    await fs.chmod(parent, 0o700).catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  });

  describe("agents group resolution", () => {
    it("refuses an override of gid 0", async () => {
      expect(await withAgentsGid(0, resolveAgentsGid)).toBeNull();
    });

    it("refuses an override naming the server's primary group", async () => {
      expect(await withAgentsGid(primaryGid, resolveAgentsGid)).toBeNull();
    });

    it("refuses a non-numeric override", async () => {
      expect(await withAgentsGid("agents", resolveAgentsGid)).toBeNull();
    });

    it("refuses when the agents group is missing and no override is set", async () => {
      expect(await resolveAgentsGid()).toBeNull();
    });

    it.skipIf(agentsGid === undefined)("resolves the agents group by name", async () => {
      getent.stdout = `agents:x:${agentsGid}:paperclip\n`;
      expect(await resolveAgentsGid()).toBe(agentsGid);
    });

    it.skipIf(agentsGid === undefined)("refuses an override that differs from the named agents group", async () => {
      getent.stdout = `agents:x:${agentsGid}:paperclip\n`;
      const other = agentsGid! + 1;
      expect(await withAgentsGid(other, resolveAgentsGid)).toBeNull();
    });

    it("refuses a named agents group that this process may not assign", async () => {
      let foreign = 60000;
      while (foreign === primaryGid || process.getgroups!().includes(foreign)) foreign++;
      getent.stdout = `agents:x:${foreign}:\n`;
      expect(await resolveAgentsGid()).toBe(process.getuid?.() === 0 ? foreign : null);
    });
  });

  describe.each([0o000, 0o002, 0o022, 0o077])("writes under umask %s", (umask) => {
    it.skipIf(agentsGid === undefined)("puts written files and created directories in the agents group", async () => {
      getent.stdout = `agents:x:${agentsGid}:paperclip\n`;
      process.umask(umask);
      await materializeInstructionBytes(root, "doctrine/nested/mission.md", Buffer.from("mission"));
      const file = await fs.stat(path.join(root, "doctrine/nested/mission.md"));
      expect(file.mode & 0o7777).toBe(0o640);
      expect(file.gid).toBe(agentsGid);
      for (const directory of [root, path.join(root, "doctrine"), path.join(root, "doctrine/nested")]) {
        const stat = await fs.stat(directory);
        expect(stat.mode & 0o7777).toBe(0o750);
        expect(stat.gid).toBe(agentsGid);
      }
    });

    it.each([["gid 0", () => "0"], ["the primary gid", () => String(primaryGid)]])("keeps files owner-only when the override is %s", async (_label, override) => {
      process.umask(umask);
      await withAgentsGid(override(), () => materializeInstructionBytes(root, "doctrine/mission.md", Buffer.from("mission")));
      const file = await fs.stat(path.join(root, "doctrine/mission.md"));
      expect(file.mode & 0o7777).toBe(0o600);
      expect(file.gid).not.toBe(0);
      expect(await modeOf(root)).toBe(0o700);
      expect(await modeOf(path.join(root, "doctrine"))).toBe(0o700);
    });

    it("keeps files owner-only when the agents group is missing", async () => {
      process.umask(umask);
      await materializeInstructionBytes(root, "doctrine/mission.md", Buffer.from("mission"));
      expect(await modeOf(path.join(root, "doctrine/mission.md"))).toBe(0o600);
      expect(await modeOf(root)).toBe(0o700);
      expect(await modeOf(path.join(root, "doctrine"))).toBe(0o700);
    });
  });

  describe("pre-existing storage", () => {
    async function looseTree() {
      await fs.mkdir(path.join(root, "doctrine"), { recursive: true });
      await fs.writeFile(path.join(root, "doctrine/mission.md"), "old");
      await fs.chmod(path.join(root, "doctrine/mission.md"), 0o666);
      await fs.chmod(path.join(root, "doctrine"), 0o777);
      await fs.chmod(root, 0o777);
      await fs.chmod(parent, 0o777);
    }

    it.skipIf(agentsGid === undefined)("tightens loose directories and replaces a loose file in the agents group", async () => {
      getent.stdout = `agents:x:${agentsGid}:paperclip\n`;
      await looseTree();
      await materializeInstructionBytes(root, "doctrine/mission.md", Buffer.from("new"));
      for (const directory of [root, path.join(root, "doctrine")]) {
        const stat = await fs.stat(directory);
        expect(stat.mode & 0o7777).toBe(0o750);
        expect(stat.gid).toBe(agentsGid);
      }
      const file = await fs.stat(path.join(root, "doctrine/mission.md"));
      expect(file.mode & 0o7777).toBe(0o640);
      expect(file.gid).toBe(agentsGid);
      expect(await fs.readFile(path.join(root, "doctrine/mission.md"), "utf8")).toBe("new");
      // Directories above the instruction root are not managed storage.
      expect(await modeOf(parent)).toBe(0o777);
    });

    it("tightens loose directories to owner-only when the agents group is missing", async () => {
      await looseTree();
      await materializeInstructionBytes(root, "doctrine/mission.md", Buffer.from("new"));
      expect(await modeOf(root)).toBe(0o700);
      expect(await modeOf(path.join(root, "doctrine"))).toBe(0o700);
      expect(await modeOf(path.join(root, "doctrine/mission.md"))).toBe(0o600);
      expect(await modeOf(parent)).toBe(0o777);
    });

    it("tightens an existing loose root on directory creation", async () => {
      await fs.mkdir(root, { mode: 0o700 });
      await fs.chmod(root, 0o777);
      await createInstructionDirectory(root);
      expect(await modeOf(root)).toBe(0o700);
    });

    it("refuses the write when a loose directory cannot be tightened", async () => {
      await looseTree();
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (args[0] === path.join(root, "doctrine")) {
          handle.chmod = async () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); };
        }
        return handle;
      });
      await expect(materializeInstructionBytes(root, "doctrine/mission.md", Buffer.from("new")))
        .rejects.toMatchObject({ status: 422, details: { code: "INSTRUCTION_STORAGE_UNSAFE" } });
      expect(await fs.readFile(path.join(root, "doctrine/mission.md"), "utf8")).toBe("old");
      expect(await fs.readdir(path.join(root, "doctrine"))).toEqual(["mission.md"]);
    });

    it("keeps a private file owner-only while its directories follow the shared layout", async () => {
      await materializeInstructionBytes(root, "marker.json", Buffer.from("{}"), { privateFile: true });
      expect(await modeOf(path.join(root, "marker.json"))).toBe(0o600);
    });

    it.skipIf(agentsGid === undefined)("keeps a private tree owner-only even when the agents group resolves", async () => {
      getent.stdout = `agents:x:${agentsGid}:paperclip\n`;
      await fs.mkdir(root, { mode: 0o700 });
      await fs.chmod(root, 0o750);
      await materializeInstructionBytes(root, "copy/AGENTS.md", Buffer.from("copy"), { privateTree: true });
      expect(await modeOf(root)).toBe(0o700);
      expect(await modeOf(path.join(root, "copy"))).toBe(0o700);
      expect(await modeOf(path.join(root, "copy/AGENTS.md"))).toBe(0o600);
    });
  });
});
