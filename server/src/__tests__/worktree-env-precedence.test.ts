import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { sanitizeInheritedPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";
import { applyWorktreeEnvPrecedence } from "../worktree-env-precedence.js";
import { maybeRepairLegacyWorktreeConfigAndEnvFiles } from "../worktree-config.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

// Spelled out (not imported) so dropping a key from the allowlist fails here.
const SECRET_KEYS = [
  "PAPERCLIP_AGENT_JWT_SECRET",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
  "PAPERCLIP_DECISION_SIGNING_SECRET",
  "PAPERCLIP_SECRETS_MASTER_KEY",
  "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
];
const IDENTITY_KEYS = [
  "PAPERCLIP_HOME",
  "PAPERCLIP_INSTANCE_ID",
  "PAPERCLIP_CONTEXT",
  "PAPERCLIP_WORKTREE_NAME",
];
const ALLOWLIST = [...SECRET_KEYS, ...IDENTITY_KEYS, "PAPERCLIP_CONFIG"];

let warnSpy: MockInstance<typeof console.warn>;

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PAPERCLIP_") || key === "BETTER_AUTH_SECRET") delete process.env[key];
  }
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

function warnings(): string {
  return warnSpy.mock.calls.map((call) => call.join(" ")).join("\n");
}

/**
 * Creates `<root>/<stateDirSegments>/{config.json,.env}` and sets the process
 * env the dotenv loads would leave for a worktree boot targeting it.
 */
async function makeInstance(stateDirSegments: string[], envLines: (configPath: string) => string[]) {
  const tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-env-precedence-")));
  const worktreeRoot = path.join(tempRoot, "SUP-24365-worktree");
  const stateDir = path.join(worktreeRoot, ...stateDirSegments);
  const configPath = path.join(stateDir, "config.json");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, "{}\n", "utf8");
  await fs.writeFile(path.join(stateDir, ".env"), [...envLines(configPath), ""].join("\n"), "utf8");
  process.chdir(worktreeRoot);
  process.env.PAPERCLIP_IN_WORKTREE = "true";
  process.env.PAPERCLIP_CONFIG = configPath;
  return { stateDir, configPath };
}

describe("applyWorktreeEnvPrecedence", () => {
  it("lets the worktree env beat inherited values for every allowlisted secret and identity key", async () => {
    const { stateDir, configPath } = await makeInstance([".paperclip"], (configPath) => [
      "PAPERCLIP_IN_WORKTREE=true",
      `PAPERCLIP_CONFIG=${configPath}`,
      ...[...SECRET_KEYS, ...IDENTITY_KEYS].map((key) => `${key}=CANARY_WORKTREE_${key}`),
    ]);
    // Same resolved config, different text: the inherited value is still replaced.
    process.env.PAPERCLIP_CONFIG = `${stateDir}/./config.json`;
    for (const key of [...SECRET_KEYS, ...IDENTITY_KEYS]) process.env[key] = `CANARY_PARENT_${key}`;
    const keysBefore = Object.keys(process.env).sort();

    const result = applyWorktreeEnvPrecedence();

    expect(result.applied).toBe(true);
    expect([...result.overridden].sort()).toEqual([...ALLOWLIST].sort());
    expect(result.keptInherited).toEqual([]);
    for (const key of [...SECRET_KEYS, ...IDENTITY_KEYS]) {
      expect(process.env[key]).toBe(`CANARY_WORKTREE_${key}`);
    }
    expect(process.env.PAPERCLIP_CONFIG).toBe(configPath);
    // Values change; the key set (what an agent sanitizer filters) does not.
    expect(Object.keys(process.env).sort()).toEqual(keysBefore);
    for (const key of ALLOWLIST) expect(warnings()).toContain(key);
    expect(warnings()).not.toContain("CANARY");
  });

  it("applies the same precedence in a uid-scoped worktree layout", async () => {
    await makeInstance([".paperclip", "uid-1001"], (configPath) => [
      "PAPERCLIP_IN_WORKTREE=true",
      `PAPERCLIP_CONFIG=${configPath}`,
      "PAPERCLIP_DECISION_SIGNING_SECRET=CANARY_WORKTREE_DECISION",
    ]);
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "CANARY_PARENT_DECISION";

    const result = applyWorktreeEnvPrecedence();

    expect(result.overridden).toEqual(["PAPERCLIP_DECISION_SIGNING_SECRET"]);
    expect(process.env.PAPERCLIP_DECISION_SIGNING_SECRET).toBe("CANARY_WORKTREE_DECISION");
  });

  it("keeps an inherited allowlisted value the worktree env does not set, and warns by key name only", async () => {
    await makeInstance([".paperclip"], (configPath) => [
      "PAPERCLIP_IN_WORKTREE=true",
      `PAPERCLIP_CONFIG=${configPath}`,
      "BETTER_AUTH_SECRET=",
    ]);
    process.env.BETTER_AUTH_SECRET = "CANARY_PARENT_AUTH";
    process.env.PAPERCLIP_DECISION_SIGNING_SECRET = "CANARY_PARENT_DECISION";
    process.env.PAPERCLIP_INSTANCE_ID = "CANARY_PARENT_INSTANCE";

    const result = applyWorktreeEnvPrecedence();

    expect(result.overridden).toEqual([]);
    expect([...result.keptInherited].sort()).toEqual(
      ["BETTER_AUTH_SECRET", "PAPERCLIP_DECISION_SIGNING_SECRET", "PAPERCLIP_INSTANCE_ID"].sort(),
    );
    expect(process.env.BETTER_AUTH_SECRET).toBe("CANARY_PARENT_AUTH");
    expect(process.env.PAPERCLIP_DECISION_SIGNING_SECRET).toBe("CANARY_PARENT_DECISION");
    expect(process.env.PAPERCLIP_INSTANCE_ID).toBe("CANARY_PARENT_INSTANCE");
    expect(warnings()).toContain("BETTER_AUTH_SECRET");
    expect(warnings()).toContain("PAPERCLIP_DECISION_SIGNING_SECRET");
    expect(warnings()).toContain("PAPERCLIP_INSTANCE_ID");
    expect(warnings()).not.toContain("CANARY");
  });

  it("does not report a key whose inherited value already matches the worktree env", async () => {
    await makeInstance([".paperclip"], (configPath) => [
      "PAPERCLIP_IN_WORKTREE=true",
      `PAPERCLIP_CONFIG=${configPath}`,
      "BETTER_AUTH_SECRET=CANARY_SAME",
    ]);
    process.env.BETTER_AUTH_SECRET = "CANARY_SAME";

    const result = applyWorktreeEnvPrecedence();

    expect(result).toEqual({ applied: true, overridden: [], keptInherited: [] });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("keeps inherited values for keys outside the allowlist even inside a worktree", async () => {
    await makeInstance([".paperclip"], (configPath) => [
      "PAPERCLIP_IN_WORKTREE=true",
      `PAPERCLIP_CONFIG=${configPath}`,
      "OPENAI_API_KEY=CANARY_WORKTREE_OPENAI",
      "DATABASE_URL=CANARY_WORKTREE_DATABASE",
    ]);
    process.env.OPENAI_API_KEY = "CANARY_PARENT_OPENAI";
    process.env.DATABASE_URL = "CANARY_PARENT_DATABASE";

    const result = applyWorktreeEnvPrecedence();

    expect(result.applied).toBe(true);
    expect(process.env.OPENAI_API_KEY).toBe("CANARY_PARENT_OPENAI");
    expect(process.env.DATABASE_URL).toBe("CANARY_PARENT_DATABASE");
  });

  it.each([
    {
      name: "the instance env does not declare PAPERCLIP_IN_WORKTREE",
      stateDir: [".paperclip"],
      inWorktreeLine: [] as string[],
    },
    {
      name: "the config is not in a .paperclip layout",
      stateDir: ["instances", "default"],
      inWorktreeLine: ["PAPERCLIP_IN_WORKTREE=true"],
    },
    {
      name: "a uid-named dir is not under .paperclip",
      stateDir: ["instances", "uid-1001"],
      inWorktreeLine: ["PAPERCLIP_IN_WORKTREE=true"],
    },
  ])("leaves process env byte-identical when $name", async ({ stateDir, inWorktreeLine }) => {
    await makeInstance(stateDir, (configPath) => [
      ...inWorktreeLine,
      `PAPERCLIP_CONFIG=${configPath}`,
      "BETTER_AUTH_SECRET=CANARY_FILE_AUTH",
      "PAPERCLIP_HOME=CANARY_FILE_HOME",
    ]);
    process.env.BETTER_AUTH_SECRET = "CANARY_PARENT_AUTH";
    process.env.PAPERCLIP_HOME = "CANARY_PARENT_HOME";
    const before = { ...process.env };

    const result = applyWorktreeEnvPrecedence();

    expect(result).toEqual({ applied: false, overridden: [], keptInherited: [] });
    expect({ ...process.env }).toEqual(before);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("leaves process env untouched when the inherited flag says this is not a worktree", async () => {
    await makeInstance([".paperclip"], (configPath) => [
      "PAPERCLIP_IN_WORKTREE=true",
      `PAPERCLIP_CONFIG=${configPath}`,
      "BETTER_AUTH_SECRET=CANARY_FILE_AUTH",
    ]);
    process.env.PAPERCLIP_IN_WORKTREE = "false";
    process.env.BETTER_AUTH_SECRET = "CANARY_PARENT_AUTH";

    expect(applyWorktreeEnvPrecedence().applied).toBe(false);
    expect(process.env.BETTER_AUTH_SECRET).toBe("CANARY_PARENT_AUTH");
  });

  it.each([
    { name: "a ~-prefixed nonexistent path", declared: () => "~/paperclip-canary-nonexistent/config.json" },
    { name: "a stale absolute path", declared: () => "/elsewhere/.paperclip/config.json" },
  ])("secrets still win and identity keys stay inherited when the worktree env holds $name", async ({ declared }) => {
    await makeInstance([".paperclip"], () => [
      "PAPERCLIP_IN_WORKTREE=true",
      `PAPERCLIP_CONFIG=${declared()}`,
      ...[...SECRET_KEYS, ...IDENTITY_KEYS].map((key) => `${key}=CANARY_WORKTREE_${key}`),
    ]);
    const inheritedConfig = process.env.PAPERCLIP_CONFIG;
    for (const key of [...SECRET_KEYS, ...IDENTITY_KEYS]) process.env[key] = `CANARY_PARENT_${key}`;

    const result = applyWorktreeEnvPrecedence();

    expect(result.applied).toBe(true);
    expect([...result.overridden].sort()).toEqual([...SECRET_KEYS].sort());
    for (const key of SECRET_KEYS) expect(process.env[key]).toBe(`CANARY_WORKTREE_${key}`);
    for (const key of IDENTITY_KEYS) expect(process.env[key]).toBe(`CANARY_PARENT_${key}`);
    expect(process.env.PAPERCLIP_CONFIG).toBe(inheritedConfig);
    expect([...result.keptInherited].sort()).toEqual([...IDENTITY_KEYS].sort());
    for (const key of IDENTITY_KEYS) expect(warnings()).toContain(key);
    expect(warnings()).not.toContain("CANARY");
    expect(warnings()).not.toContain("elsewhere");
  });

  it("overrides identity keys when the worktree env PAPERCLIP_CONFIG is ~-prefixed and expands to the resolved config", async () => {
    const { configPath } = await makeInstance([".paperclip"], () => []);
    process.env.HOME = path.dirname(path.dirname(path.dirname(configPath)));
    const tilde = `~/${path.relative(process.env.HOME, configPath)}`;
    await fs.writeFile(
      path.join(path.dirname(configPath), ".env"),
      ["PAPERCLIP_IN_WORKTREE=true", `PAPERCLIP_CONFIG=${tilde}`, "PAPERCLIP_INSTANCE_ID=CANARY_WORKTREE_INSTANCE", ""].join("\n"),
      "utf8",
    );
    process.env.PAPERCLIP_INSTANCE_ID = "CANARY_PARENT_INSTANCE";

    const result = applyWorktreeEnvPrecedence();

    expect(result.overridden).toContain("PAPERCLIP_INSTANCE_ID");
    expect(process.env.PAPERCLIP_INSTANCE_ID).toBe("CANARY_WORKTREE_INSTANCE");
    expect(process.env.PAPERCLIP_CONFIG).toBe(configPath);
    expect(maybeRepairLegacyWorktreeConfigAndEnvFiles().repairedEnv).toBe(true);
    expect(process.env.PAPERCLIP_CONFIG).toBe(configPath);
  });

  it("leaves a moved worktree to the repair path, which adopts the moved config and derived instance id", async () => {
    const { configPath, stateDir } = await makeInstance([".paperclip"], () => [
      "PAPERCLIP_IN_WORKTREE=true",
      "PAPERCLIP_CONFIG=/old/home/paperclip/.paperclip/worktrees/SUP-24365-worktree/.paperclip/config.json",
      "PAPERCLIP_INSTANCE_ID=wt-old",
      "PAPERCLIP_WORKTREE_NAME=SUP-24365-worktree",
    ]);
    process.env.PAPERCLIP_WORKTREES_DIR = path.join(path.dirname(path.dirname(stateDir)), ".paperclip-worktrees");
    delete process.env.PAPERCLIP_INSTANCE_ID;

    applyWorktreeEnvPrecedence();
    const result = maybeRepairLegacyWorktreeConfigAndEnvFiles();

    expect(result).toEqual({ repairedConfig: true, repairedEnv: true });
    expect(process.env.PAPERCLIP_CONFIG).toBe(configPath);
    expect(process.env.PAPERCLIP_INSTANCE_ID).toBe("sup-24365-worktree");
    const persisted = await fs.readFile(path.join(stateDir, ".env"), "utf8");
    expect(persisted).toContain(`PAPERCLIP_CONFIG=${JSON.stringify(configPath)}`);
    expect(persisted).not.toContain("wt-old");
  });

  it("only covers keys that agent child processes never inherit", () => {
    const sanitized = sanitizeInheritedPaperclipEnv(
      Object.fromEntries(ALLOWLIST.map((key) => [key, "CANARY_VALUE"])),
    );
    expect(Object.keys(sanitized)).toEqual([]);
  });
});
