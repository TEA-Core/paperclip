import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootEnvOrigin,
  bootEnvReport,
  captureOperatorEnv,
  commitBootEnv,
  currentBootEnvPlan,
  operatorEnvForChild,
  refuseBootEnv,
  resetBootEnvForTests,
  resolveBootEnvPlan,
  setBootDerivedEnv,
  stageEnvSource,
} from "./boot-env.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

beforeEach(() => {
  resetBootEnvForTests();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("PAPERCLIP_") || key.startsWith("DATABASE_") || key === "DOTENV_KEY") {
      delete process.env[key];
    }
  }
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
  vi.restoreAllMocks();
});

function makeWorktree(root: string, name: string, envContents: string, withConfig = false): string {
  const worktreeRoot = path.join(root, name);
  const stateDir = path.join(worktreeRoot, ".paperclip");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, ".env"), envContents, "utf8");
  if (withConfig) {
    fs.writeFileSync(path.join(stateDir, "config.json"), "{}\n", "utf8");
  }
  return worktreeRoot;
}

function planWorktree(worktreeRoot: string) {
  process.chdir(worktreeRoot);
  captureOperatorEnv({ ...process.env, PAPERCLIP_IN_WORKTREE: "true" });
  process.env.PAPERCLIP_IN_WORKTREE = "true";
  return resolveBootEnvPlan({ cwd: worktreeRoot });
}

describe("boot env ledger", () => {
  it("freezes the worktree plan to the nearest state dir and its single own file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-boot-env-plan-"));
    fs.mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
    const ancestorState = path.join(root, "repo", ".paperclip");
    fs.mkdirSync(ancestorState, { recursive: true });
    fs.writeFileSync(path.join(ancestorState, ".env"), "PAPERCLIP_IN_WORKTREE=true\n", "utf8");
    const worktreeRoot = makeWorktree(
      path.join(root, "repo"),
      "wt",
      "PAPERCLIP_IN_WORKTREE=true\n",
      true,
    );
    fs.writeFileSync(path.join(worktreeRoot, ".env"), "DATABASE_URL=postgresql://cwd.invalid/db\n", "utf8");

    const plan = planWorktree(worktreeRoot);

    expect(plan.mode).toBe("worktree");
    expect(plan.stateDir).toBe(path.join(worktreeRoot, ".paperclip"));
    expect(plan.sources).toHaveLength(1);
    expect(plan.sources[0]).toEqual({
      kind: "own",
      path: path.join(worktreeRoot, ".paperclip", ".env"),
    });

    // A file-supplied PAPERCLIP_CONFIG never re-selects the frozen plan.
    const redirect = path.join(root, "elsewhere", "config.json");
    process.env.PAPERCLIP_CONFIG = redirect;
    expect(resolveBootEnvPlan({ cwd: worktreeRoot })).toBe(plan);
    expect(plan.configPath).not.toBe(redirect);
  });

  it("stages absent, refuses a directory and an unreadable file as not-a-file/unreadable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-boot-env-stage-"));
    const worktreeRoot = makeWorktree(root, "wt", "PAPERCLIP_IN_WORKTREE=true\n", true);
    planWorktree(worktreeRoot);

    const absent = stageEnvSource({ kind: "own", path: path.join(root, "missing.env") });
    expect(absent.status).toBe("absent");

    const asDirectory = path.join(root, "dir.env");
    fs.mkdirSync(asDirectory, { recursive: true });
    const refusedDirectory = stageEnvSource({ kind: "own", path: asDirectory });
    expect(refusedDirectory.status).toBe("refused");
    expect(refusedDirectory.refusal?.kind).toBe("not-a-file");

    const noAccess = path.join(root, "locked.env");
    fs.writeFileSync(noAccess, "KEY=value\n", "utf8");
    fs.chmodSync(noAccess, 0o000);
    try {
      if (process.getuid?.() === 0) return; // mode 000 stays readable for root
      const refusedUnreadable = stageEnvSource({ kind: "own", path: noAccess });
      expect(refusedUnreadable.status).toBe("refused");
      expect(refusedUnreadable.refusal?.kind).toBe("unreadable");
    } finally {
      fs.chmodSync(noAccess, 0o600);
    }
  });

  it("refuses worktree content the writer cannot rewrite and never applies it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-boot-env-content-"));
    const poisoned = [
      "PAPERCLIP_IN_WORKTREE=true",
      "PAPERCLIP_SECRETS_MASTER_KEY=canary-master-key",
      'FOO="unterminated',
      "DATABASE_URL=postgresql://attacker.invalid/db",
      "",
    ].join("\n");
    const worktreeRoot = makeWorktree(root, "wt", poisoned, true);
    planWorktree(worktreeRoot);

    const staged = stageEnvSource({
      kind: "own",
      path: path.join(worktreeRoot, ".paperclip", ".env"),
    });
    expect(staged.status).toBe("refused");
    expect(staged.refusal?.kind).toBe("content");

    refuseBootEnv(staged.refusal!);
    const committed = commitBootEnv();
    expect(committed.applied).toEqual([]);
    expect(process.env.PAPERCLIP_SECRETS_MASTER_KEY).toBeUndefined();
    expect(process.env.DATABASE_URL).toBeUndefined();
  });

  it("keeps the operator value, lets own beat cwd, and blocks file database URLs in worktree mode", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-boot-env-commit-"));
    const worktreeRoot = makeWorktree(
      root,
      "wt",
      [
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_AGENT_JWT_SECRET=file-jwt",
        "PAPERCLIP_ZZ_UNLISTED=file-unlisted",
        "DATABASE_URL=postgresql://file.invalid/db",
        "DATABASE_MIGRATION_URL=postgresql://file.invalid/migrations",
        "BETTER_AUTH_SECRET=file-auth",
      ].join("\n") + "\n",
      true,
    );
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "operator-jwt";
    const plan = planWorktree(worktreeRoot);
    expect(plan.mode).toBe("worktree");

    const staged = stageEnvSource(plan.sources[0]);
    expect(staged.status).toBe("staged");
    const committed = commitBootEnv();

    expect(committed.applied).toContain("PAPERCLIP_ZZ_UNLISTED");
    expect(committed.applied).toContain("BETTER_AUTH_SECRET");
    expect(committed.shadowed).toContain("DATABASE_URL");
    expect(committed.shadowed).toContain("DATABASE_MIGRATION_URL");
    expect(committed.shadowed).toContain("PAPERCLIP_AGENT_JWT_SECRET");

    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe("operator-jwt");
    expect(bootEnvOrigin("PAPERCLIP_AGENT_JWT_SECRET")).toBe("operator");
    expect(process.env.PAPERCLIP_ZZ_UNLISTED).toBe("file-unlisted");
    expect(bootEnvOrigin("PAPERCLIP_ZZ_UNLISTED")).toBe("own");
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.DATABASE_MIGRATION_URL).toBeUndefined();
  });

  it("restores every file-supplied key and the full snapshot on any refusal (I-5)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-boot-env-restore-"));
    const randomKeys = Array.from({ length: 24 }, (_, index) => {
      const prefix = index % 2 === 0 ? "PAPERCLIP_" : "";
      return `${prefix}ZZ_${randomBytes(6).toString("hex").toUpperCase()}`;
    });
    const ownEntries = randomKeys.map((key) => `${key}=file-${key}`);
    const ownFile = path.join(root, "own.env");
    fs.writeFileSync(ownFile, [...ownEntries, 'POISON="unterminated'].join("\n") + "\n", "utf8");
    const cwdFile = path.join(root, "cwd.env");
    fs.writeFileSync(
      cwdFile,
      ["CWD_ZZ_KEY=cwd-value", "PAPERCLIP_SECRETS_MASTER_KEY=cwd-master-key"].join("\n") + "\n",
      "utf8",
    );

    resetBootEnvForTests();
    process.env.PAPERCLIP_OPERATOR_MARKER = "snapshot-marker";
    captureOperatorEnv({ ...process.env });

    // The clean cwd file is applied first; the poisoned own file is staged
    // after it, so the refusal must undo an already-applied source too.
    const cleanCwd = stageEnvSource({ kind: "cwd", path: cwdFile });
    expect(cleanCwd.status).toBe("staged");
    const committed = commitBootEnv();
    expect(committed.applied).toContain("CWD_ZZ_KEY");
    expect(process.env.CWD_ZZ_KEY).toBe("cwd-value");

    const refusedOwn = stageEnvSource({ kind: "own", path: ownFile });
    expect(refusedOwn.status).toBe("staged");
    expect(refusedOwn.keys).toContain(randomKeys[0]);
    commitBootEnv();
    expect(process.env[randomKeys[0]]).toBe(`file-${randomKeys[0]}`);

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    refuseBootEnv({ kind: "content", path: ownFile, message: "poisoned for test" });

    for (const key of randomKeys) {
      expect(process.env[key]).toBeUndefined();
    }
    expect(process.env.CWD_ZZ_KEY).toBeUndefined();
    expect(process.env.PAPERCLIP_SECRETS_MASTER_KEY).toBeUndefined();
    expect(process.env.PAPERCLIP_OPERATOR_MARKER).toBe("snapshot-marker");

    const afterRefusal = commitBootEnv();
    expect(afterRefusal.applied).toEqual([]);
  });

  it("strips every file-origin key for a child process but keeps operator and boot keys (I-12)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-boot-env-child-"));
    const worktreeRoot = makeWorktree(
      root,
      "wt",
      [
        "PAPERCLIP_IN_WORKTREE=true",
        "PAPERCLIP_ZZ_CHILD_FILE=file-value",
        "PAPERCLIP_AGENT_JWT_SECRET=file-jwt",
      ].join("\n") + "\n",
      true,
    );
    process.env.PAPERCLIP_ZZ_CHILD_OPERATOR = "operator-value";
    const plan = planWorktree(worktreeRoot);
    stageEnvSource(plan.sources[0]);
    commitBootEnv();
    setBootDerivedEnv("PAPERCLIP_ZZ_BOOT", "boot-value");

    expect(process.env.PAPERCLIP_ZZ_CHILD_FILE).toBe("file-value");
    const child = operatorEnvForChild();
    expect(child.PAPERCLIP_ZZ_CHILD_FILE).toBeUndefined();
    expect(child.PAPERCLIP_AGENT_JWT_SECRET).toBeUndefined();
    expect(child.PAPERCLIP_ZZ_CHILD_OPERATOR).toBe("operator-value");
    expect(child.PAPERCLIP_ZZ_BOOT).toBe("boot-value");
  });

  it("reads instance mode from the own file and the cwd file, keeping today's behaviour", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-boot-env-instance-"));
    const instanceState = path.join(root, "instance", ".paperclip");
    fs.mkdirSync(instanceState, { recursive: true });
    fs.writeFileSync(
      path.join(instanceState, ".env"),
      "PAPERCLIP_ZZ_INSTANCE_OWN=own-value\n",
      "utf8",
    );
    fs.writeFileSync(path.join(instanceState, "config.json"), "{}\n", "utf8");
    const workdir = path.join(root, "instance", "work");
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(path.join(workdir, ".env"), "PAPERCLIP_ZZ_CWD=cwd-value\n", "utf8");

    process.chdir(workdir);
    captureOperatorEnv({ ...process.env });
    const plan = resolveBootEnvPlan({ cwd: workdir });
    expect(plan.mode).toBe("instance");
    expect(plan.sources.map((source) => source.kind)).toEqual(["own", "cwd"]);

    for (const source of plan.sources) stageEnvSource(source);
    commitBootEnv();
    expect(process.env.PAPERCLIP_ZZ_INSTANCE_OWN).toBe("own-value");
    expect(process.env.PAPERCLIP_ZZ_CWD).toBe("cwd-value");
    expect(bootEnvOrigin("PAPERCLIP_ZZ_CWD")).toBe("cwd");
  });

  it("reports names and origins only, never values", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-boot-env-report-"));
    const worktreeRoot = makeWorktree(
      root,
      "wt",
      "PAPERCLIP_IN_WORKTREE=true\nPAPERCLIP_AGENT_JWT_SECRET=secret-value\n",
      true,
    );
    const plan = planWorktree(worktreeRoot);
    stageEnvSource(plan.sources[0]);
    commitBootEnv();

    const report = bootEnvReport();
    expect(report.mode).toBe("worktree");
    expect(report.origins.PAPERCLIP_AGENT_JWT_SECRET).toBe("own");
    expect(JSON.stringify(report)).not.toContain("secret-value");
    expect(currentBootEnvPlan()?.mode).toBe("worktree");
  });
});
