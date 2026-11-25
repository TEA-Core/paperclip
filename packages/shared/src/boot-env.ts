import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { vetEnvFileContents } from "./env-file.js";
import { expandHomePrefix } from "./home-paths.js";
import { readWorktreePortRegistry } from "./worktree-port-registry.js";

export type EnvSourceKind = "own" | "cwd";
export type EnvOrigin = "operator" | "own" | "cwd" | "boot";
export type RefusalKind = "unreadable" | "not-a-file" | "content" | "persist" | "undeclared" | "identity";

export type BootEnvPlan = {
  mode: "instance" | "worktree";
  configPath: string;
  stateDir: string;
  sources: ReadonlyArray<Readonly<{ kind: EnvSourceKind; path: string }>>;
  evidence: readonly string[];
  undeclared: boolean;
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
  plan: Readonly<BootEnvPlan> | null;
  staged: Map<string, StagedSource>;
  origins: Record<string, EnvOrigin>;
  fileSuppliedKeys: Set<string>;
  refused: boolean;
  refusals: BootEnvRefusal[];
  committed: boolean;
};

const STATE_KEY = Symbol.for("paperclip.boot-env.v1");

function freshState(): BootEnvState {
  return {
    captured: false,
    snapshot: Object.create(null),
    plan: null,
    staged: new Map(),
    origins: Object.create(null),
    fileSuppliedKeys: new Set(),
    refused: false,
    refusals: [],
    committed: false,
  };
}

function state(): BootEnvState {
  const holder = globalThis as typeof globalThis & { [STATE_KEY]?: BootEnvState };
  holder[STATE_KEY] ??= freshState();
  return holder[STATE_KEY];
}

function copyEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = Object.create(null);
  for (const key of Object.keys(env)) snapshot[key] = env[key];
  return snapshot;
}
function requireCapture(): BootEnvState {
  const current = state();
  if (!current.captured) throw new Error("boot env was not captured");
  return current;
}

function setOrigin(key: string, next: EnvOrigin | null): void {
  const current = state();
  const previous = current.origins[key];
  if (next === "operator" && previous && previous !== "operator") {
    throw new Error(`Cannot promote file or boot origin for ${key}`);
  }
  if (next === null) delete current.origins[key];
  else current.origins[key] = next;
}


export function captureOperatorEnv(env: NodeJS.ProcessEnv = process.env): void {
  const current = state();
  if (current.captured) return;
  current.snapshot = copyEnv(env);
  current.captured = true;
  for (const key of Object.keys(current.snapshot)) setOrigin(key, "operator");
}

export function noteOperatorFlag(key: string, value: string): void {
  const current = requireCapture();
  if (current.plan) throw new Error("operator flags must precede the boot env plan");
  setOrigin(key, "operator");
  current.snapshot[key] = value;
  process.env[key] = value;
}

export function operatorEnvValue(key: string): string | undefined {
  const value = state().snapshot[key];
  return typeof value === "string" ? value : undefined;
}

export function bootEnvOrigin(key: string): EnvOrigin | null {
  return state().origins[key] ?? null;
}

export function currentBootEnvPlan(): Readonly<BootEnvPlan> | null {
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

export function findAncestorConfig(start: string): string | null {
  const bound = checkoutBound(start);
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(current, ".paperclip", "config.json");
    if (isRegularFile(candidate)) return candidate;
    if (current === bound) return null;
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

export function resolveBootEnvPlan(input: { cwd: string }): Readonly<BootEnvPlan> {
  const current = requireCapture();
  if (current.plan) return current.plan;
  const snapshot = Object.freeze(current.snapshot);
  const cwd = path.resolve(input.cwd);
  const bound = checkoutBound(cwd);
  const operatorInWorktree = snapshot.PAPERCLIP_IN_WORKTREE === "true";
  const localState = findStateDir(cwd, operatorHome(snapshot), operatorInWorktree) ?? path.join(bound, ".paperclip");
  const localEntries = peekEntries(path.join(localState, ".env"));
  const worktreesHome = path.resolve(expandHomePrefix(snapshot.PAPERCLIP_WORKTREES_DIR?.trim() || "~/.paperclip-worktrees"));
  const evidence: string[] = [];
  if (operatorInWorktree) evidence.push("operator-flag");
  if (localEntries?.PAPERCLIP_IN_WORKTREE === "true") evidence.push("own-declaration");
  if (bound.includes(`${path.sep}.paperclip${path.sep}worktrees${path.sep}`) ||
      (snapshot.PAPERCLIP_WORKTREES_DIR && isInside(bound, worktreesHome))) evidence.push("worktree-layout");
  if (readWorktreePortRegistry(worktreesHome).has(path.join(localState, "config.json"))) evidence.push("port-registry");

  const override = snapshot.PAPERCLIP_CONFIG?.trim();
  let configPath = override
    ? path.resolve(expandHomePrefix(override))
    : path.join(localState, "config.json");
  let stateDir = path.dirname(configPath);
  const own = stateDir === localState ? localEntries : peekEntries(path.join(stateDir, ".env"));
  const declared = own?.PAPERCLIP_IN_WORKTREE === "true";
  const mode: BootEnvPlan["mode"] = override
    ? (isCanonicalStateDir(stateDir) && (declared || operatorInWorktree) ? "worktree" : "instance")
    : (evidence.length > 0 ? "worktree" : "instance");
  const undeclared = mode === "worktree" && own !== null && !declared;
  if (!override && mode === "instance") {
    configPath = findAncestorConfig(cwd) ?? defaultInstanceConfig(snapshot);
    stateDir = path.dirname(configPath);
  }
  const sources: Array<{ kind: EnvSourceKind; path: string }> = [{ kind: "own", path: path.join(stateDir, ".env") }];
  const ownEntries = stateDir === localState ? localEntries : peekEntries(sources[0].path);
  // An own-file opt-out may remove a source, never add one to the frozen plan.
  const disableCwdEnv = snapshot.PAPERCLIP_DISABLE_CWD_ENV_FILE === "true" ||
    ownEntries?.PAPERCLIP_DISABLE_CWD_ENV_FILE === "true";
  const cwdEnv = path.join(cwd, ".env");
  if (mode === "instance" && evidence.length > 0) {
    console.warn(`Skipping cwd env file ${cwdEnv}: worktree evidence is present`);
  } else if (mode === "instance" && !disableCwdEnv && !sameFile(cwdEnv, sources[0].path)) {
    sources.push({ kind: "cwd", path: cwdEnv });
  }
  current.plan = Object.freeze({
    mode, configPath, stateDir, undeclared,
    sources: Object.freeze(sources.map((source) => Object.freeze(source))),
    evidence: Object.freeze(evidence),
  });
  return current.plan;
}

type EnvRead = {
  status: "ok" | "absent" | "refused";
  entries: Record<string, string>;
  refusal?: BootEnvRefusal;
};

function readEnvFile(filePath: string, vet: boolean): EnvRead {
  const resolved = path.resolve(filePath);
  const refuse = (kind: RefusalKind, message: string): EnvRead => ({
    status: "refused", entries: {}, refusal: { kind, path: resolved, message },
  });
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { status: "absent", entries: {} };
    }
    return refuse("unreadable", `Could not read env file ${resolved}`);
  }
  if (!stat.isFile()) return refuse("not-a-file", `Env file is not a regular file: ${resolved}`);
  let contents: string;
  try {
    contents = fs.readFileSync(resolved, "utf8");
  } catch {
    return refuse("unreadable", `Could not read env file ${resolved}`);
  }
  try {
    if (vet) vetEnvFileContents(contents);
    return { status: "ok", entries: parseDotenv(contents) };
  } catch (error) {
    return refuse("content", error instanceof Error ? error.message : String(error));
  }
}

export function readEnvFileVetted(filePath: string): EnvRead {
  return readEnvFile(filePath, true);
}

function stageEnvSource(source: { kind: EnvSourceKind; path: string }): void {
  const current = requireCapture();
  const resolved = path.resolve(source.path);
  if (!current.plan?.sources.some((entry) => entry.kind === source.kind && entry.path === resolved)) {
    throw new Error("Cannot stage an undeclared boot env source");
  }
  const read = source.kind === "own" && current.plan.undeclared
    ? { status: "refused" as const, entries: {}, refusal: {
      kind: "undeclared" as const, path: resolved, message: "Worktree evidence exists but PAPERCLIP_IN_WORKTREE is not declared",
    } }
    : readEnvFile(resolved, current.plan.mode === "worktree");
  const staged: StagedSource = {
    ...source, path: resolved, realPath: resolved, entries: read.entries,
    status: read.status === "ok" ? "staged" : read.status, refusal: read.refusal,
  };
  current.staged.set(resolved, staged);
  for (const key of Object.keys(read.entries)) current.fileSuppliedKeys.add(key);
  if (read.refusal) {
    if (current.plan.mode === "worktree") refuseBootEnv(read.refusal);
    else {
      current.refusals.push(read.refusal);
      console.warn(`Could not use env file ${resolved} (${read.refusal.kind}): ${read.refusal.message}`);
    }
  }
}

export function loadBootEnv(input: { cwd: string }): {
  plan: Readonly<BootEnvPlan>; refusals: BootEnvRefusal[];
} {
  const plan = resolveBootEnvPlan(input);
  const current = requireCapture();
  if (!current.committed) {
    for (const source of plan.sources) stageEnvSource(source);
    commitBootEnv();
    current.committed = true;
  }
  return { plan, refusals: [...current.refusals] };
}

const IDENTITY_KEYS: Record<string, true> = {
  PAPERCLIP_HOME: true, PAPERCLIP_INSTANCE_ID: true, PAPERCLIP_WORKTREE_NAME: true,
  PAPERCLIP_WORKTREES_DIR: true,
  PAPERCLIP_CONFIG: true, PAPERCLIP_CONTEXT: true, PAPERCLIP_IN_WORKTREE: true,
};
const WORKTREE_FILE_ALLOWED: Record<string, true> = {
  PAPERCLIP_SECRETS_MASTER_KEY: true, PAPERCLIP_AGENT_JWT_SECRET: true, BETTER_AUTH_SECRET: true,
  PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: true, PAPERCLIP_DECISION_SIGNING_SECRET: true, PAPERCLIP_WORKTREE_COLOR: true,
};
const PROTECTED_KEY = /^(?:PAPERCLIP_|DATABASE_|BETTER_AUTH_|DOTENV_|NODE_|GIT_|RUN_LOG_)|^(?:HOME|USERPROFILE|PATH|TMPDIR)$/;

function isOperatorOnlyKey(key: string, mode: BootEnvPlan["mode"] | undefined): boolean {
  return Object.hasOwn(IDENTITY_KEYS, key) ||
    (mode === "worktree" && PROTECTED_KEY.test(key) && !Object.hasOwn(WORKTREE_FILE_ALLOWED, key));
}

function snapshotHas(key: string): boolean {
  return Object.hasOwn(state().snapshot, key) && typeof state().snapshot[key] === "string";
}

function commitBootEnv(): { applied: string[]; shadowed: string[] } {
  const current = state();
  if (current.refused) return { applied: [], shadowed: [] };
  const applied: string[] = [];
  const shadowed: string[] = [];
  const blocked = new Set<string>();
  const ordered = [...current.staged.values()].filter((staged) => staged.status === "staged");
  ordered.sort((left, right) => (left.kind === right.kind ? 0 : left.kind === "own" ? -1 : 1));
  for (const staged of ordered) {
    for (const [key, value] of Object.entries(staged.entries)) {
      if (isOperatorOnlyKey(key, current.plan?.mode)) {
        blocked.add(key);
        shadowed.push(key);
        continue;
      }
      if (snapshotHas(key) || current.origins[key] === "operator" || current.origins[key] === "boot") {
        shadowed.push(key);
        continue;
      }
      if (current.origins[key] === "own" && staged.kind === "cwd") {
        shadowed.push(key);
        continue;
      }
      process.env[key] = value;
      setOrigin(key, staged.kind);
      applied.push(key);
    }
  }
  if (blocked.size > 0) console.warn(`Ignoring operator-only env keys from ${current.plan?.sources.map((source) => source.path).join(", ")}: ${[...blocked].join(", ")}`);
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
    } else {
      delete process.env[key];
      setOrigin(key, null);
    }
  }
  console.warn(`Could not use env file ${refusal.path} (${refusal.kind}): ${refusal.message}`);
}

export function setBootDerivedEnv(key: string, value: string): void {
  requireCapture();
  process.env[key] = value;
  setOrigin(key, "boot");
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
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") throw new Error("boot env reset is test-only");
  const holder = globalThis as typeof globalThis & { [STATE_KEY]?: BootEnvState };
  holder[STATE_KEY] = freshState();
}
