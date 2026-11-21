import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { vetEnvFileContents } from "./env-file.js";
import { expandHomePrefix } from "./home-paths.js";

export type EnvSourceKind = "own" | "cwd";
export type EnvOrigin = "operator" | "own" | "cwd" | "boot";
export type RefusalKind = "unreadable" | "not-a-file" | "content" | "persist";

export type BootEnvPlan = {
  mode: "instance" | "worktree";
  configPath: string;
  stateDir: string;
  sources: Array<{ kind: EnvSourceKind; path: string }>;
};

export type BootEnvRefusal = {
  kind: RefusalKind;
  path: string;
  message: string;
};

type StagedSource = {
  kind: EnvSourceKind;
  path: string;
  realPath: string;
  status: "staged" | "absent" | "refused";
  entries: Record<string, string>;
  refusal?: BootEnvRefusal;
};

type BootEnvState = {
  captured: boolean;
  snapshot: Record<string, string | undefined>;
  plan: BootEnvPlan | null;
  staged: Map<string, StagedSource>;
  origins: Record<string, EnvOrigin>;
  fileSuppliedKeys: Set<string>;
  refused: boolean;
  refusals: BootEnvRefusal[];
  committed: boolean;
  instanceDespiteWorktreeFlag: boolean;
  boundCwd: string;
  boundConfig: string;
};

const STATE_KEY = Symbol.for("paperclip.boot-env.v1");

function freshState(): BootEnvState {
  return {
    captured: false,
    snapshot: {},
    plan: null,
    staged: new Map(),
    origins: {},
    fileSuppliedKeys: new Set(),
    refused: false,
    refusals: [],
    committed: false,
    instanceDespiteWorktreeFlag: false,
    boundCwd: "",
    boundConfig: "",
  };
}

function state(): BootEnvState {
  const holder = globalThis as typeof globalThis & { [STATE_KEY]?: BootEnvState };
  holder[STATE_KEY] ??= freshState();
  return holder[STATE_KEY];
}

function copyEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) snapshot[key] = env[key];
  return snapshot;
}

export function captureOperatorEnv(env: NodeJS.ProcessEnv = process.env): void {
  const current = state();
  if (current.captured) return;
  current.snapshot = copyEnv(env);
  current.captured = true;
  for (const key of Object.keys(current.snapshot)) current.origins[key] = "operator";
}
export function adoptCurrentProcessEnv(cwd: string): void {
  const current = state();
  const resolved = path.resolve(cwd);
  const config = process.env.PAPERCLIP_CONFIG ?? "";
  if (current.captured && current.boundCwd === resolved && current.boundConfig === config) {
    current.staged = new Map();
    current.committed = false;
    current.refused = false;
    current.refusals = [];
    current.fileSuppliedKeys = new Set();
    return;
  }
  const holder = globalThis as typeof globalThis & { [STATE_KEY]?: BootEnvState };
  holder[STATE_KEY] = freshState();
  captureOperatorEnv();
  state().boundCwd = resolved;
  state().boundConfig = config;
}

export function noteOperatorEnv(key: string, value: string): void {
  captureOperatorEnv();
  const current = state();
  current.snapshot[key] = value;
  current.origins[key] = "operator";
  process.env[key] = value;
}

export function operatorEnvValue(key: string): string | undefined {
  const value = state().snapshot[key];
  return typeof value === "string" ? value : undefined;
}

export function bootEnvOrigin(key: string): EnvOrigin | null {
  return state().origins[key] ?? null;
}

export function currentBootEnvPlan(): BootEnvPlan | null {
  return state().plan;
}

export function stagedOwnValue(key: string): string | undefined {
  for (const staged of state().staged.values()) {
    if (staged.kind !== "own" || staged.status !== "staged") continue;
    if (Object.hasOwn(staged.entries, key)) return staged.entries[key];
  }
  return undefined;
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function sameFile(left: string, right: string): boolean {
  if (path.resolve(left) === path.resolve(right)) return true;
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function operatorHome(snapshot: Record<string, string | undefined>): string {
  const raw = snapshot.PAPERCLIP_HOME?.trim();
  if (raw) return path.resolve(expandHomePrefix(raw));
  return path.resolve(os.homedir(), ".paperclip");
}

function operatorInstanceId(snapshot: Record<string, string | undefined>): string {
  const raw = snapshot.PAPERCLIP_INSTANCE_ID?.trim();
  return raw && /^[a-zA-Z0-9_-]+$/.test(raw) ? raw : "default";
}

function defaultInstanceConfig(snapshot: Record<string, string | undefined>): string {
  return path.resolve(operatorHome(snapshot), "instances", operatorInstanceId(snapshot), "config.json");
}

function checkoutBound(start: string): string {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const next = path.resolve(current, "..");
    if (next === current) return path.resolve(start);
    current = next;
  }
}

function isCanonicalStateDir(stateDir: string): boolean {
  if (path.basename(stateDir) === ".paperclip") return true;
  return /^uid-\d+$/.test(path.basename(stateDir)) && path.basename(path.dirname(stateDir)) === ".paperclip";
}

function directoryHoldsState(dir: string, operatorInWorktree: boolean): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) return false;
  if (isRegularFile(path.join(dir, "config.json")) || isRegularFile(path.join(dir, ".env"))) return true;
  return operatorInWorktree;
}

function findStateDir(cwd: string, home: string, operatorInWorktree: boolean): string | null {
  const bound = checkoutBound(cwd);
  let current = path.resolve(cwd);
  while (true) {
    if (isInside(current, home)) return null;
    const paperclip = path.join(current, ".paperclip");
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    const scoped = path.join(paperclip, `uid-${uid}`);
    const chosen = fs.existsSync(path.join(scoped, ".env")) ? scoped : paperclip;
    if (directoryHoldsState(chosen, operatorInWorktree)) return chosen;
    if (current === bound) return null;
    const next = path.resolve(current, "..");
    if (next === current) return null;
    current = next;
  }
}

function findAncestorConfig(start: string): string | null {
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(current, ".paperclip", "config.json");
    if (isRegularFile(candidate)) return candidate;
    const next = path.resolve(current, "..");
    if (next === current) return null;
    current = next;
  }
}

function peekEntries(filePath: string): Record<string, string> | null {
  if (!isRegularFile(filePath)) return null;
  try {
    return parseDotenv(fs.readFileSync(filePath));
  } catch {
    return null;
  }
}

export function resolveBootEnvPlan(input: { cwd: string; configOverride?: string }): BootEnvPlan {
  const current = state();
  if (current.plan) return current.plan;
  captureOperatorEnv();
  const snapshot = current.snapshot;
  const cwd = path.resolve(input.cwd);
  const home = operatorHome(snapshot);
  const override = input.configOverride?.trim() || snapshot.PAPERCLIP_CONFIG?.trim() || "";
  const operatorInWorktree = snapshot.PAPERCLIP_IN_WORKTREE === "true";

  let stateDir = "";
  let configPath = "";
  let fromOverride = false;
  if (override) {
    configPath = path.resolve(expandHomePrefix(override));
    stateDir = path.dirname(configPath);
    fromOverride = true;
  } else {
    stateDir = findStateDir(cwd, home, operatorInWorktree) ?? "";
    configPath = stateDir ? path.join(stateDir, "config.json") : "";
  }

  const peeked = stateDir ? peekEntries(path.join(stateDir, ".env")) : null;
  const ownSaysWorktree = peeked?.PAPERCLIP_IN_WORKTREE === "true";
  const ownDisablesCwd = snapshot.PAPERCLIP_DISABLE_CWD_ENV_FILE === "true" || peeked?.PAPERCLIP_DISABLE_CWD_ENV_FILE === "true";
  const canonical = stateDir !== "" && isCanonicalStateDir(stateDir);
  const readableOwnDeclines = peeked !== null && !ownSaysWorktree;
  // A leaked operator flag must not adopt a readable .paperclip whose own
  // env does not declare a worktree. The flag still selects a directory
  // that has no readable declaration, which is the missing-config case.
  const mode: BootEnvPlan["mode"] =
    canonical && (ownSaysWorktree || (operatorInWorktree && !readableOwnDeclines))
      ? "worktree"
      : "instance";
  current.instanceDespiteWorktreeFlag = operatorInWorktree && mode === "instance";

  if (mode !== "worktree" && !fromOverride && !isRegularFile(configPath)) {
    configPath = findAncestorConfig(cwd) ?? defaultInstanceConfig(snapshot);
    stateDir = path.dirname(configPath);
  } else if (!configPath) {
    configPath = defaultInstanceConfig(snapshot);
    stateDir = path.dirname(configPath);
  }

  const sources: BootEnvPlan["sources"] = [{ kind: "own", path: path.join(stateDir, ".env") }];
  if (mode === "instance" && !ownDisablesCwd) {
    const cwdEnv = path.resolve(cwd, ".env");
    if (!sameFile(cwdEnv, sources[0].path)) sources.push({ kind: "cwd", path: cwdEnv });
  }

  current.plan = { mode, configPath, stateDir, sources };
  if (current.instanceDespiteWorktreeFlag) {
    console.warn(
      "PAPERCLIP_IN_WORKTREE was set but this boot stayed in instance mode; the worktree layout was not adopted",
    );
  }
  return current.plan;
}

export function stageEnvSource(source: { kind: EnvSourceKind; path: string }): {
  status: "staged" | "absent" | "refused";
  refusal?: BootEnvRefusal;
  keys: string[];
} {
  const current = state();
  const resolved = path.resolve(source.path);
  let realPath = resolved;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    realPath = resolved;
  }
  const cached = current.staged.get(realPath) ?? current.staged.get(resolved);
  if (cached) {
    return { status: cached.status, refusal: cached.refusal, keys: Object.keys(cached.entries) };
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (code === "ENOENT") {
      const absent: StagedSource = { kind: source.kind, path: resolved, realPath, status: "absent", entries: {} };
      current.staged.set(resolved, absent);
      return { status: "absent", keys: [] };
    }
    const refusal: BootEnvRefusal = {
      kind: "unreadable",
      path: resolved,
      message: `Could not read env file ${resolved}`,
    };
    const refused: StagedSource = { kind: source.kind, path: resolved, realPath, status: "refused", entries: {}, refusal };
    current.staged.set(resolved, refused);
    return { status: "refused", refusal, keys: [] };
  }

  if (!stat.isFile()) {
    const refusal: BootEnvRefusal = {
      kind: "not-a-file",
      path: resolved,
      message: `Env file is not a regular file: ${resolved}`,
    };
    const refused: StagedSource = { kind: source.kind, path: resolved, realPath, status: "refused", entries: {}, refusal };
    current.staged.set(resolved, refused);
    return { status: "refused", refusal, keys: [] };
  }

  let contents: string;
  try {
    contents = fs.readFileSync(resolved, "utf8");
  } catch {
    const refusal: BootEnvRefusal = {
      kind: "unreadable",
      path: resolved,
      message: `Could not read env file ${resolved}`,
    };
    const refused: StagedSource = { kind: source.kind, path: resolved, realPath, status: "refused", entries: {}, refusal };
    current.staged.set(resolved, refused);
    return { status: "refused", refusal, keys: [] };
  }

  const vetInWorktree = current.plan?.mode === "worktree";
  if (vetInWorktree) {
    try {
      vetEnvFileContents(contents);
    } catch (error) {
      const refusal: BootEnvRefusal = {
        kind: "content",
        path: resolved,
        message: error instanceof Error ? error.message : String(error),
      };
      const refused: StagedSource = { kind: source.kind, path: resolved, realPath, status: "refused", entries: {}, refusal };
      current.staged.set(resolved, refused);
      current.staged.set(realPath, refused);
      return { status: "refused", refusal, keys: [] };
    }
  }

  let entries: Record<string, string> = {};
  try {
    entries = parseDotenv(contents);
  } catch (error) {
    const refusal: BootEnvRefusal = {
      kind: "content",
      path: resolved,
      message: error instanceof Error ? error.message : String(error),
    };
    const refused: StagedSource = { kind: source.kind, path: resolved, realPath, status: "refused", entries: {}, refusal };
    current.staged.set(resolved, refused);
    return { status: "refused", refusal, keys: [] };
  }

  const staged: StagedSource = { kind: source.kind, path: resolved, realPath, status: "staged", entries };
  current.staged.set(resolved, staged);
  current.staged.set(realPath, staged);
  for (const key of Object.keys(entries)) current.fileSuppliedKeys.add(key);
  return { status: "staged", keys: Object.keys(entries) };
}

const WORKTREE_FILE_BLOCKED = new Set(["DATABASE_URL", "DATABASE_MIGRATION_URL"]);

function snapshotHas(key: string): boolean {
  return Object.hasOwn(state().snapshot, key) && typeof state().snapshot[key] === "string";
}

export function commitBootEnv(): { applied: string[]; shadowed: string[] } {
  const current = state();
  if (current.refused || current.committed) return { applied: [], shadowed: [] };
  const applied: string[] = [];
  const shadowed: string[] = [];
  const ordered = [...current.staged.values()].filter((staged) => staged.status === "staged");
  ordered.sort((left, right) => (left.kind === right.kind ? 0 : left.kind === "own" ? -1 : 1));
  for (const staged of ordered) {
    for (const [key, value] of Object.entries(staged.entries)) {
      if (current.plan?.mode === "worktree" && WORKTREE_FILE_BLOCKED.has(key)) {
        shadowed.push(key);
        continue;
      }
      if (snapshotHas(key) || current.origins[key] === "operator" || current.origins[key] === "own" || current.origins[key] === "boot") {
        shadowed.push(key);
        continue;
      }
      process.env[key] = value;
      current.origins[key] = staged.kind;
      applied.push(key);
    }
  }
  current.committed = true;
  return { applied, shadowed };
}

export function refuseBootEnv(refusal: BootEnvRefusal): void {
  const current = state();
  current.refused = true;
  current.refusals.push(refusal);
  const keys = new Set(current.fileSuppliedKeys);
  for (const staged of current.staged.values()) {
    for (const key of Object.keys(staged.entries)) keys.add(key);
  }
  for (const key of keys) {
    const snapped = current.snapshot[key];
    if (typeof snapped === "string") {
      process.env[key] = snapped;
      current.origins[key] = "operator";
    } else {
      delete process.env[key];
      delete current.origins[key];
    }
  }
  console.warn(`Could not use env file ${refusal.path} (${refusal.kind}): ${refusal.message}`);
}

export function setBootDerivedEnv(key: string, value: string): void {
  captureOperatorEnv();
  process.env[key] = value;
  state().origins[key] = "boot";
}

export function operatorEnvForChild(): NodeJS.ProcessEnv {
  const current = state();
  const child: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, origin] of Object.entries(current.origins)) {
    if (origin === "own" || origin === "cwd") delete child[key];
  }
  for (const key of current.fileSuppliedKeys) {
    if (current.origins[key] !== "operator" && current.origins[key] !== "boot") delete child[key];
  }
  return child;
}

export function bootEnvReport(): {
  mode: BootEnvPlan["mode"] | null;
  sources: BootEnvPlan["sources"];
  refusals: BootEnvRefusal[];
  origins: Record<string, EnvOrigin>;
} {
  const current = state();
  return {
    mode: current.plan?.mode ?? null,
    sources: current.plan?.sources ?? [],
    refusals: [...current.refusals],
    origins: { ...current.origins },
  };
}

export function resetBootEnvForTests(): void {
  const holder = globalThis as typeof globalThis & { [STATE_KEY]?: BootEnvState };
  holder[STATE_KEY] = freshState();
}
