import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listOpenCodeSkills,
  syncOpenCodeSkills,
} from "@paperclipai/adapter-opencode-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("opencode local skill sync", () => {
  const paperclipKey = "paperclipai/paperclip/paperclip";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("defaults and installs the operational Paperclip skill in the shared Claude/OpenCode skills home", async () => {
    const home = await makeTempDir("paperclip-opencode-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "opencode_local",
      config: {
        env: {
          HOME: home,
        },
      },
    } as const;

    const before = await listOpenCodeSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.warnings).toContain("OpenCode currently uses the shared Claude skills home (~/.claude/skills).");
    expect(before.desiredSkills).toContain(paperclipKey);
    expect(before.entries.find((entry) => entry.key === paperclipKey)?.state).toBe("missing");

    const after = await syncOpenCodeSkills(ctx, [paperclipKey]);
    expect(after.entries.find((entry) => entry.key === paperclipKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".claude", "skills", "paperclip"))).isSymbolicLink()).toBe(true);
  });
});

// PR-6 (b): a skill sync never prunes the shared skills home.

const SHARED_REMOVE_WARNING =
  "Removing a skill updates this agent's desired skills only. Its link stays in the shared skills home, where other agents can still load it, until an operator cleans the home.";

async function createSkillDir(root: string, name: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `# ${name}\n`, "utf8");
  return dir;
}

/** Every entry of a skills home as [name, readlink target or null], sorted by name. */
async function listSkillsHome(skillsHome: string): Promise<Array<[string, string | null]>> {
  const names = (await fs.readdir(skillsHome).catch((): string[] => [])).sort();
  return Promise.all(
    names.map(async (name): Promise<[string, string | null]> => [
      name,
      await fs.readlink(path.join(skillsHome, name)).catch(() => null),
    ]),
  );
}

async function makePruneFixture(cleanupDirs: Set<string>) {
  const root = await makeTempDir("paperclip-opencode-prune-");
  cleanupDirs.add(root);
  const home = path.join(root, "home");
  await fs.mkdir(home, { recursive: true });
  const sources = path.join(root, "src");
  const runtimeSkills = [
    { key: "pc/alpha", runtimeName: "alpha", source: await createSkillDir(sources, "alpha") },
    { key: "pc/beta", runtimeName: "beta", source: await createSkillDir(sources, "beta") },
    { key: "pc/gamma", runtimeName: "gamma", source: await createSkillDir(sources, "gamma") },
  ];
  const ctxFor = (agentId: string, desiredSkills: string[], extra: Record<string, unknown> = {}) => ({
    agentId,
    companyId: "company-1",
    adapterType: "opencode_local",
    config: {
      env: { HOME: home },
      paperclipRuntimeSkills: runtimeSkills,
      paperclipSkillSync: { desiredSkills },
      ...extra,
    },
  });
  return { home, skillsHome: path.join(home, ".claude", "skills"), runtimeSkills, ctxFor };
}

describe("opencode local skill sync: shared callers link only (PR-6 b)", () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("(1) keeps peers' links when a shared caller adds a skill", async () => {
    const { skillsHome, runtimeSkills, ctxFor } = await makePruneFixture(cleanupDirs);
    await syncOpenCodeSkills(ctxFor("peer", ["pc/alpha", "pc/beta"]), ["pc/alpha", "pc/beta"]);
    const peersBefore = await listSkillsHome(skillsHome);
    expect(peersBefore.map(([name]) => name)).toEqual(["alpha", "beta"]);

    await syncOpenCodeSkills(ctxFor("caller", ["pc/gamma"]), ["pc/gamma"]);

    expect(await listSkillsHome(skillsHome)).toEqual([
      ...peersBefore,
      ["gamma", runtimeSkills[2]!.source],
    ]);
  });

  it("(3) keeps the link when a shared caller removes a skill only it desires", async () => {
    const { skillsHome, runtimeSkills, ctxFor } = await makePruneFixture(cleanupDirs);
    await syncOpenCodeSkills(ctxFor("caller", ["pc/gamma"]), ["pc/gamma"]);

    const snapshot = await syncOpenCodeSkills(ctxFor("caller", []), []);

    expect(await listSkillsHome(skillsHome)).toEqual([["gamma", runtimeSkills[2]!.source]]);
    const gamma = snapshot.entries.find((entry) => entry.key === "pc/gamma");
    expect(gamma?.desired).toBe(false);
    expect(gamma?.state).toBe("stale");
    expect(snapshot.warnings).toContain(SHARED_REMOVE_WARNING);
  });
});
