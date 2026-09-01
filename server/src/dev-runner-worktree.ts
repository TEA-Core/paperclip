import { existsSync, lstatSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasVerifiedWorktreeSeedManifest } from "./worktree-seed-manifest.js";

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

  return {
    envPath,
    missingEnv: false,
  };
}
