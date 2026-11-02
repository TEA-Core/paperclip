import { existsSync, lstatSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasVerifiedWorktreeSeedManifest, readVerifiedWorktreeSeedMode } from "./worktree-seed-manifest.js";
import { resolveWorktreeRootFromRuntimeEnv } from "./worktree-config.js";

function parseEnvFile(contents: string): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (!value) {
      entries[key] = "";
      continue;
    }
    if (value.startsWith("#")) {
      entries[key] = "";
      continue;
    }

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      entries[key] = value.slice(1, -1);
      continue;
    }

    entries[key] = value.replace(/\s+#.*$/, "").trim();
  }

  return entries;
}

type WorktreeEnvBootstrapResult =
  | { envPath: null; missingEnv: false }
  | { envPath: string; missingEnv: true }
  | { envPath: string; missingEnv: false };

export function isLinkedGitWorktreeCheckout(rootDir: string): boolean {
  const gitMetadataPath = path.join(rootDir, ".git");
  if (!existsSync(gitMetadataPath)) return false;

  const stat = lstatSync(gitMetadataPath);
  if (!stat.isFile()) return false;

  return readFileSync(gitMetadataPath, "utf8").trimStart().startsWith("gitdir:");
}

// SUP-14087: on a cross-uid worktree the canonical `.paperclip/` config/env/
// seed markers belong to another uid and are 0o600. Provisioning writes a
// uid-scoped state dir at `.paperclip/uid-<uid>/` instead; every consumer
// resolves through this rule — use the scoped dir when it exists for the
// running uid, else the canonical dir — so each uid reads only its own state.
export function resolveWorktreeStateDir(rootDir: string, uid: number = process.getuid?.() ?? -1): string {
  const scopedDir = path.resolve(rootDir, ".paperclip", `uid-${uid}`);
  return existsSync(path.join(scopedDir, ".env")) ? scopedDir : path.resolve(rootDir, ".paperclip");
}

export function resolveWorktreeEnvFilePath(rootDir: string): string {
  return path.join(resolveWorktreeStateDir(rootDir), ".env");
}

const WORKTREE_SECRETS_MASTER_KEY_ENV_KEYS = [
  "PAPERCLIP_SECRETS_MASTER_KEY",
  "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
] as const;

export function applyWorktreeSecretsMasterKeyEnvOverrides(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!isLinkedGitWorktreeCheckout(rootDir)) return env;

  const envPath = resolveWorktreeEnvFilePath(rootDir);
  if (!existsSync(envPath)) return env;

  const entries = parseEnvFile(readFileSync(envPath, "utf8"));
  // SUP-22348: in a minimal-no-secrets worktree the seeded .env owns the
  // secrets master key, so values inherited from a parent process must be
  // deleted when the worktree env does not carry them — overriding when
  // present is not enough, the inherited value must never survive.
  const seedMode = readVerifiedWorktreeSeedMode(
    path.join(resolveWorktreeStateDir(rootDir), "seed-manifest.json"),
  );
  for (const key of WORKTREE_SECRETS_MASTER_KEY_ENV_KEYS) {
    if (key in entries) env[key] = entries[key];
    else if (seedMode === "minimal-no-secrets") delete env[key];
  }
  return env;
}

// SUP-22348: the managed runtime-service path (`pnpm --filter
// @paperclipai/server dev` → `tsx src/index.ts`) runs with its working
// directory inside the server package rather than at the worktree root, so
// worktree detection cannot rely on cwd. Reuse the runtime context resolver,
// which walks ancestors from the resolved Paperclip config and only adopts
// genuine worktree layouts.
export function applyWorktreeSecretsMasterKeyEnvOverridesFromRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const rootDir = resolveWorktreeRootFromRuntimeEnv(env);
  if (!rootDir) return env;
  return applyWorktreeSecretsMasterKeyEnvOverrides(rootDir, env);
}

export function isWorktreeSeedPending(rootDir: string): boolean {
  // SUP-14087 partitions the marker dir per uid; upstream's seed-manifest
  // verification runs inside that partition rather than a fixed `.paperclip`.
  const markerDir = resolveWorktreeStateDir(rootDir);
  const manifestPath = path.join(markerDir, "seed-manifest.json");
  if (existsSync(manifestPath)) {
    return !hasVerifiedWorktreeSeedManifest(manifestPath);
  }
  return existsSync(path.join(markerDir, "seed-pending"))
    && !existsSync(path.join(markerDir, "seed-complete"));
}

function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}

function resolveDefaultWorktreeHome(env: NodeJS.ProcessEnv): string {
  return path.resolve(expandHomePrefix(env.PAPERCLIP_WORKTREES_DIR?.trim() || "~/.paperclip-worktrees"));
}

function repairStaleMigratedWorktreeEnvEntries(
  rootDir: string,
  entries: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const localConfigPath = path.join(resolveWorktreeStateDir(rootDir), "config.json");
  const configuredPath = entries.PAPERCLIP_CONFIG?.trim();
  if (!configuredPath) return entries;

  const resolvedConfiguredPath = resolveHomeAwarePath(configuredPath);
  const staleConfigPath =
    resolvedConfiguredPath !== localConfigPath &&
    !existsSync(resolvedConfiguredPath) &&
    existsSync(localConfigPath);
  if (!staleConfigPath) return entries;

  const homeDir = resolveDefaultWorktreeHome(env);
  return {
    ...entries,
    PAPERCLIP_HOME: homeDir,
    PAPERCLIP_CONFIG: localConfigPath,
    PAPERCLIP_CONTEXT: path.resolve(homeDir, "context.json"),
  };
}

export function bootstrapDevRunnerWorktreeEnv(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): WorktreeEnvBootstrapResult {
  if (!isLinkedGitWorktreeCheckout(rootDir)) {
    return {
      envPath: null,
      missingEnv: false,
    };
  }

  const envPath = resolveWorktreeEnvFilePath(rootDir);
  if (!existsSync(envPath)) {
    return {
      envPath,
      missingEnv: true,
    };
  }

  const entries = repairStaleMigratedWorktreeEnvEntries(
    rootDir,
    parseEnvFile(readFileSync(envPath, "utf8")),
    env,
  );
  for (const [key, value] of Object.entries(entries)) {
    if (typeof env[key] === "string" && env[key]!.trim().length > 0) continue;
    env[key] = value;
  }
  applyWorktreeSecretsMasterKeyEnvOverrides(rootDir, env);

  return {
    envPath,
    missingEnv: false,
  };
}
