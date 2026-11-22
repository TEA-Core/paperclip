import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootEnvOrigin,
  bootEnvReport,
  captureOperatorEnv,
  currentBootEnvPlan,
  loadBootEnv,
  noteOperatorFlag,
  operatorEnvValue,
  readEnvFileVetted,
  operatorEnvForChild,
  refuseBootEnv,
  resetBootEnvForTests,
  resolveBootEnvPlan,
  setBootDerivedEnv,
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
  it("requires capture before planning or deriving boot values (L1/L4)", () => {
    expect(() => resolveBootEnvPlan({ cwd: process.cwd() })).toThrow("boot env was not captured");
    expect(() => loadBootEnv({ cwd: process.cwd() })).toThrow("boot env was not captured");
    expect(() => noteOperatorFlag("PAPERCLIP_INSTANCE_ID", "fixture")).toThrow("boot env was not captured");
    expect(() => setBootDerivedEnv("ZZ_DERIVED", "fixture")).toThrow("boot env was not captured");
  });

  it("restores a committed instance DATABASE_URL on refusal (L2)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-restore-db-"));
    const own = path.join(root, ".paperclip");
    fs.mkdirSync(own);
    fs.writeFileSync(path.join(own, "config.json"), "{}");
    fs.writeFileSync(path.join(own, ".env"), "DATABASE_URL=postgresql://fixture.invalid/db\n");
    process.env.PAPERCLIP_CONFIG = path.join(own, "config.json");
    captureOperatorEnv();
    const { plan } = loadBootEnv({ cwd: root });
    expect(process.env.DATABASE_URL !== undefined).toBe(true);
    refuseBootEnv({ kind: "content", path: plan.sources[0].path, message: "fixture refusal" });
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(bootEnvOrigin("DATABASE_URL")).toBeNull();
  });

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

    const absent = readEnvFileVetted(path.join(root, "missing.env"));
    expect(absent.status).toBe("absent");

    const asDirectory = path.join(root, "dir.env");
    fs.mkdirSync(asDirectory, { recursive: true });
    const refusedDirectory = readEnvFileVetted(asDirectory);
    expect(refusedDirectory.status).toBe("refused");
    expect(refusedDirectory.refusal?.kind).toBe("not-a-file");

    const noAccess = path.join(root, "locked.env");
    fs.writeFileSync(noAccess, "KEY=value\n", "utf8");
    fs.chmodSync(noAccess, 0o000);
    try {
      if (process.getuid?.() === 0) return; // mode 000 stays readable for root
      const refusedUnreadable = readEnvFileVetted(noAccess);
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

    const { refusals } = loadBootEnv({ cwd: worktreeRoot });
    expect(refusals[0]?.kind).toBe("content");
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

    loadBootEnv({ cwd: worktreeRoot });
    expect(process.env.BETTER_AUTH_SECRET).toBe("file-auth");

    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe("operator-jwt");
    expect(bootEnvOrigin("PAPERCLIP_AGENT_JWT_SECRET")).toBe("operator");
    expect(process.env.PAPERCLIP_ZZ_UNLISTED).toBeUndefined();
    expect(bootEnvOrigin("PAPERCLIP_ZZ_UNLISTED")).toBeNull();
    expect(process.env.DATABASE_URL).toBeUndefined();
    expect(process.env.DATABASE_MIGRATION_URL).toBeUndefined();
  });

  it("restores all committed own and cwd keys without promoting file origins (I-5)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-boot-env-restore-"));
    const keys = Array.from({ length: 24 }, (_, index) => `ZZ_${index}`);
    const wt = makeWorktree(root, "wt", keys.map((key) => `${key}=fixture`).join("\n") + "\n", true);
    fs.writeFileSync(path.join(wt, ".env"), "CWD_ZZ_KEY=cwd\n");
    process.env.PAPERCLIP_CONFIG = path.join(wt, ".paperclip", "config.json");
    process.env.PAPERCLIP_OPERATOR_MARKER = "operator";
    captureOperatorEnv();
    const { plan } = loadBootEnv({ cwd: wt });
    for (const key of keys) expect(bootEnvOrigin(key), key).toBe("own");
    expect(bootEnvOrigin("CWD_ZZ_KEY")).toBe("cwd");
    refuseBootEnv({ kind: "content", path: plan.sources[0].path, message: "fixture refusal" });
    for (const key of [...keys, "CWD_ZZ_KEY"]) {
      expect(process.env[key], key).toBeUndefined();
      expect(bootEnvOrigin(key), key).toBeNull();
      expect(operatorEnvValue(key), key).toBeUndefined();
    }
    expect(process.env.PAPERCLIP_OPERATOR_MARKER).toBe("operator");
    loadBootEnv({ cwd: wt });
    expect(process.env.CWD_ZZ_KEY).toBeUndefined();
  });

  it("strips every file-origin key for a child process but keeps operator and boot keys (I-12)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-boot-env-child-"));
    const worktreeRoot = makeWorktree(
      root,
      "wt",
      [
        "PAPERCLIP_IN_WORKTREE=true",
        "ZZ_CHILD_FILE=file-value",
        "PAPERCLIP_AGENT_JWT_SECRET=file-jwt",
      ].join("\n") + "\n",
      true,
    );
    process.env.PAPERCLIP_ZZ_CHILD_OPERATOR = "operator-value";
    const plan = planWorktree(worktreeRoot);
    loadBootEnv({ cwd: worktreeRoot });
    setBootDerivedEnv("PAPERCLIP_ZZ_BOOT", "boot-value");

    expect(process.env.ZZ_CHILD_FILE).toBe("file-value");
    const child = operatorEnvForChild();
    expect(child.ZZ_CHILD_FILE).toBeUndefined();
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
      "PAPERCLIP_ZZ_INSTANCE_OWN=own-value\nPAPERCLIP_WORKTREES_DIR=/file-steered/worktrees\n",
      "utf8",
    );
    fs.writeFileSync(path.join(instanceState, "config.json"), "{}\n", "utf8");
    const workdir = path.join(root, "instance", "work");
    fs.mkdirSync(path.join(root, "instance", ".git"), { recursive: true });
    fs.mkdirSync(workdir, { recursive: true });
    fs.writeFileSync(path.join(workdir, ".env"), "PAPERCLIP_ZZ_CWD=cwd-value\n", "utf8");

    process.chdir(workdir);
    captureOperatorEnv({ ...process.env });
    const plan = resolveBootEnvPlan({ cwd: workdir });
    expect(plan.mode).toBe("instance");
    expect(plan.sources.map((source) => source.kind)).toEqual(["own", "cwd"]);

    loadBootEnv({ cwd: workdir });
    expect(process.env.PAPERCLIP_ZZ_INSTANCE_OWN).toBe("own-value");
    expect(process.env.PAPERCLIP_ZZ_CWD).toBe("cwd-value");
    expect(bootEnvOrigin("PAPERCLIP_ZZ_CWD")).toBe("cwd");
    expect(process.env.PAPERCLIP_WORKTREES_DIR).toBeUndefined();
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
    loadBootEnv({ cwd: worktreeRoot });

    const report = bootEnvReport();
    expect(report.mode).toBe("worktree");
    expect(report.origins.PAPERCLIP_AGENT_JWT_SECRET).toBe("own");
    expect(JSON.stringify(report)).not.toContain("secret-value");
    expect(currentBootEnvPlan()?.mode).toBe("worktree");
  });

  it("captures once and rejects flags after the frozen plan", () => {
    captureOperatorEnv();
    process.env.ZZ_LATE = "fixture";
    captureOperatorEnv();
    expect(operatorEnvValue("ZZ_LATE")).toBeUndefined();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-capture-"));
    const { plan } = loadBootEnv({ cwd: root });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.sources)).toBe(true);
    expect(() => noteOperatorFlag("ZZ_LATE", "promoted")).toThrow("operator flags must precede");
    expect(operatorEnvValue("ZZ_LATE")).toBeUndefined();
  });

  it("does not re-read or re-apply a loaded source", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-idempotent-"));
    const wt = makeWorktree(root, "wt", "PAPERCLIP_IN_WORKTREE=true\nZZ_PLAIN=fixture\n");
    planWorktree(wt);
    const { plan } = loadBootEnv({ cwd: wt });
    fs.writeFileSync(plan.sources[0].path, "ZZ_PLAIN=changed\n");
    delete process.env.ZZ_PLAIN;
    expect(loadBootEnv({ cwd: root }).plan).toBe(plan);
    expect(process.env.ZZ_PLAIN).toBeUndefined();
  });

  it("pure vetted reads do not add a boot source or modify the process", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-pure-read-"));
    const file = path.join(root, ".env");
    fs.writeFileSync(file, "ZZ_PLAIN=fixture\n");
    const before = bootEnvReport();
    expect(readEnvFileVetted(file).entries.ZZ_PLAIN).toBe("fixture");
    expect(bootEnvReport()).toEqual(before);
    expect(process.env.ZZ_PLAIN).toBeUndefined();
  });
});
