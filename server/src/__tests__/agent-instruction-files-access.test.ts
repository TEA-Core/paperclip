import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsGroup, assignableAgentsGid, withAgentsGid, withAgentsGidOverride } from "./helpers/agents-gid.js";

vi.mock("node:child_process", async (importOriginal) =>
  (await import("./helpers/agents-gid.js")).mockAgentsGroupLookup(await importOriginal()));

const { createInstructionDirectory, materializeInstructionBytes, resolveAgentsGid } = await import("../services/agent-instruction-files.js");

// Any assignable supplementary group stands in for the named agents group.
const agentsGid = assignableAgentsGid();
const primaryGid = process.getegid!();
const modeOf = async (filename: string) => (await fs.stat(filename)).mode & 0o7777;
const unsafe = (reason: string) => ({ status: 422, details: { code: "INSTRUCTION_STORAGE_UNSAFE", reason } });

/** Make every handle opened on `target` report another owner uid. */
function foreignOwner(target: string) {
  const open = fs.open.bind(fs);
  return vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[0] === target) {
      const stat = handle.stat.bind(handle);
      handle.stat = (async (...options: Parameters<typeof handle.stat>) => {
        const result = await stat(...options);
        return Object.assign(result, { uid: Number(result.uid) + 1 });
      }) as typeof handle.stat;
    }
    return handle;
  });
}

describe("instruction file access", () => {
  let parent: string;
  let root: string;
  const previousUmask = process.umask();
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;

  beforeEach(async () => {
    agentsGroup.gid = null;
    delete process.env.PAPERCLIP_AGENTS_GID;
    parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "instruction-access-")));
    // The instance root lives elsewhere, so these roots have no managed ancestors.
    process.env.PAPERCLIP_HOME = path.join(parent, "unused-home");
    process.env.PAPERCLIP_INSTANCE_ID = "access-test";
    root = path.join(parent, "instructions");
  });

  afterEach(async () => {
    process.umask(previousUmask);
    agentsGroup.gid = undefined;
    delete process.env.PAPERCLIP_AGENTS_GID;
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
    vi.restoreAllMocks();
    await fs.chmod(parent, 0o700).catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
  });

  describe("agents group resolution", () => {
    it("refuses when the agents group is missing and no override is set", async () => {
      expect(await resolveAgentsGid()).toBeNull();
    });

    it("ignores a numeric override when the agents group name does not resolve", async () => {
      expect(await withAgentsGidOverride(100, resolveAgentsGid)).toBeNull();
      expect(await withAgentsGidOverride(agentsGid ?? 100, resolveAgentsGid)).toBeNull();
    });

    it.skipIf(agentsGid === undefined)("resolves the agents group by name", async () => {
      expect(await withAgentsGid(agentsGid!, resolveAgentsGid)).toBe(agentsGid);
    });

    it.skipIf(agentsGid === undefined)("accepts an override equal to the named agents gid", async () => {
      expect(await withAgentsGid(agentsGid!, () => withAgentsGidOverride(agentsGid!, resolveAgentsGid))).toBe(agentsGid);
    });

    it.skipIf(agentsGid === undefined)("refuses an override that differs from the named agents gid", async () => {
      expect(await withAgentsGid(agentsGid!, () => withAgentsGidOverride(agentsGid! + 1, resolveAgentsGid))).toBeNull();
      expect(await withAgentsGid(agentsGid!, () => withAgentsGidOverride(0, resolveAgentsGid))).toBeNull();
      expect(await withAgentsGid(agentsGid!, () => withAgentsGidOverride(primaryGid, resolveAgentsGid))).toBeNull();
      expect(await withAgentsGid(agentsGid!, () => withAgentsGidOverride("agents", resolveAgentsGid))).toBeNull();
    });

    it("refuses an override of gid 0 or the primary gid even when it names the agents group", async () => {
      expect(await withAgentsGid(0, () => withAgentsGidOverride(0, resolveAgentsGid))).toBeNull();
      expect(await withAgentsGid(primaryGid, () => withAgentsGidOverride(primaryGid, resolveAgentsGid))).toBeNull();
    });

    it("refuses a named agents group of gid 0", async () => {
      expect(await withAgentsGid(0, resolveAgentsGid)).toBeNull();
    });

    it("refuses a named agents group that this process may not assign", async () => {
      let foreign = 60000;
      while (foreign === primaryGid || process.getgroups!().includes(foreign)) foreign++;
      expect(await withAgentsGid(foreign, resolveAgentsGid)).toBe(process.getuid?.() === 0 ? foreign : null);
    });
  });

  describe.each([0o000, 0o002, 0o022, 0o077])("writes under umask %s", (umask) => {
    it.skipIf(agentsGid === undefined)("puts written files and created directories in the agents group", async () => {
      agentsGroup.gid = agentsGid!;
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

    it("keeps files owner-only, not in the override group, when the name is missing and the override is 100", async () => {
      process.umask(umask);
      await withAgentsGidOverride(100, () => materializeInstructionBytes(root, "doctrine/mission.md", Buffer.from("mission")));
      const file = await fs.stat(path.join(root, "doctrine/mission.md"));
      expect(file.mode & 0o7777).toBe(0o600);
      expect(file.gid).not.toBe(100);
      expect(await modeOf(root)).toBe(0o700);
      expect(await modeOf(path.join(root, "doctrine"))).toBe(0o700);
    });

    it.skipIf(agentsGid === undefined)("keeps files owner-only when the override differs from the named group", async () => {
      agentsGroup.gid = agentsGid!;
      process.umask(umask);
      await withAgentsGidOverride(primaryGid, () => materializeInstructionBytes(root, "doctrine/mission.md", Buffer.from("mission")));
      const file = await fs.stat(path.join(root, "doctrine/mission.md"));
      expect(file.mode & 0o7777).toBe(0o600);
      expect(file.gid).not.toBe(agentsGid);
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

  describe("pre-existing storage below the instruction root", () => {
    async function looseTree() {
      await fs.mkdir(path.join(root, "doctrine"), { recursive: true });
      await fs.writeFile(path.join(root, "doctrine/mission.md"), "old");
      await fs.chmod(path.join(root, "doctrine/mission.md"), 0o666);
      await fs.chmod(path.join(root, "doctrine"), 0o777);
      await fs.chmod(root, 0o777);
      await fs.chmod(parent, 0o777);
    }

    it.skipIf(agentsGid === undefined)("tightens loose directories and replaces a loose file in the agents group", async () => {
      agentsGroup.gid = agentsGid!;
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
      // Outside the instance root nothing above the instruction root is managed.
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
        .rejects.toMatchObject(unsafe("cannot-tighten"));
      expect(await fs.readFile(path.join(root, "doctrine/mission.md"), "utf8")).toBe("old");
      expect(await fs.readdir(path.join(root, "doctrine"))).toEqual(["mission.md"]);
    });

    it.skipIf(agentsGid === undefined)("refuses an instruction directory owned by another uid even with the expected mode and group", async () => {
      agentsGroup.gid = agentsGid!;
      await materializeInstructionBytes(root, "AGENTS.md", Buffer.from("old"));
      expect(await modeOf(root)).toBe(0o750);
      foreignOwner(root);
      await expect(materializeInstructionBytes(root, "AGENTS.md", Buffer.from("new"))).rejects.toMatchObject(unsafe("foreign-owner"));
      expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("old");
    });

    it("keeps a private file owner-only while its directories follow the shared layout", async () => {
      await materializeInstructionBytes(root, "marker.json", Buffer.from("{}"), { privateFile: true });
      expect(await modeOf(path.join(root, "marker.json"))).toBe(0o600);
    });

    it.skipIf(agentsGid === undefined)("keeps a private tree owner-only even when the agents group resolves", async () => {
      agentsGroup.gid = agentsGid!;
      await fs.mkdir(root, { mode: 0o700 });
      await fs.chmod(root, 0o750);
      await materializeInstructionBytes(root, "copy/AGENTS.md", Buffer.from("copy"), { privateTree: true });
      expect(await modeOf(root)).toBe(0o700);
      expect(await modeOf(path.join(root, "copy"))).toBe(0o700);
      expect(await modeOf(path.join(root, "copy/AGENTS.md"))).toBe(0o600);
    });
  });

  describe("managed ancestors inside the instance root", () => {
    let instance: string;
    let agentDir: string;
    let managedRoot: string;

    beforeEach(async () => {
      process.env.PAPERCLIP_HOME = path.join(parent, "home");
      instance = path.join(parent, "home", "instances", "access-test");
      agentDir = path.join(instance, "companies", "company-1", "agents", "agent-1");
      managedRoot = path.join(agentDir, "instructions");
      await fs.mkdir(managedRoot, { recursive: true, mode: 0o700 });
      for (let current = managedRoot; current !== parent; current = path.dirname(current)) await fs.chmod(current, 0o755);
    });

    it("tightens a group-writable server-owned agent directory in place and saves", async () => {
      await fs.chmod(agentDir, 0o775);
      await materializeInstructionBytes(managedRoot, "AGENTS.md", Buffer.from("saved"));
      expect(await fs.readFile(path.join(managedRoot, "AGENTS.md"), "utf8")).toBe("saved");
      expect(await modeOf(agentDir)).toBe(0o755);
    });

    it("tightens a group-writable instance root in place and leaves directories above it unchanged", async () => {
      await fs.chmod(instance, 0o770);
      await fs.chmod(path.dirname(instance), 0o777);
      await materializeInstructionBytes(managedRoot, "AGENTS.md", Buffer.from("saved"));
      expect(await modeOf(instance)).toBe(0o750);
      expect(await modeOf(path.dirname(instance))).toBe(0o777);
    });

    it("refuses a world-writable agent directory without changing it", async () => {
      await fs.chmod(agentDir, 0o777);
      await expect(materializeInstructionBytes(managedRoot, "AGENTS.md", Buffer.from("saved")))
        .rejects.toMatchObject(unsafe("world-writable-ancestor"));
      expect(await modeOf(agentDir)).toBe(0o777);
      await expect(fs.stat(path.join(managedRoot, "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses an agent directory owned by another uid", async () => {
      foreignOwner(agentDir);
      await expect(materializeInstructionBytes(managedRoot, "AGENTS.md", Buffer.from("saved")))
        .rejects.toMatchObject(unsafe("foreign-owner"));
      await expect(fs.stat(path.join(managedRoot, "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses a group-writable agent directory whose group write cannot be removed", async () => {
      await fs.chmod(agentDir, 0o775);
      const open = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args);
        if (args[0] === agentDir) handle.chmod = async () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); };
        return handle;
      });
      await expect(materializeInstructionBytes(managedRoot, "AGENTS.md", Buffer.from("saved")))
        .rejects.toMatchObject(unsafe("cannot-tighten"));
      expect(await modeOf(agentDir)).toBe(0o775);
    });

    it("checks the agent directory for the adoption marker beside the instruction root", async () => {
      await fs.chmod(agentDir, 0o777);
      await expect(materializeInstructionBytes(path.join(agentDir, "file-sync"), "adopted.json", Buffer.from("{}"), { privateFile: true }))
        .rejects.toMatchObject(unsafe("world-writable-ancestor"));
    });
  });
});
