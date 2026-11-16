import fs from "node:fs";
import path from "node:path";
import { parse as parseDotenv } from "dotenv";
import { expandHomePrefix, resolveWorktreeEnvTarget } from "./worktree-config.js";

/**
 * Keys whose worktree `.env` value beats an inherited process value inside a
 * real worktree (SUP-24365). Every key here is stripped by name from agent
 * child env (`sanitizeInheritedPaperclipEnv`), so changing which value wins
 * cannot change what an agent sees. Never add provider or cloud credentials:
 * those reach agent children.
 */
const WORKTREE_SECRET_KEYS = [
  "PAPERCLIP_AGENT_JWT_SECRET",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
  "PAPERCLIP_DECISION_SIGNING_SECRET",
  "PAPERCLIP_SECRETS_MASTER_KEY",
  "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
] as const;

const WORKTREE_IDENTITY_KEYS = [
  "PAPERCLIP_HOME",
  "PAPERCLIP_INSTANCE_ID",
  "PAPERCLIP_CONFIG",
  "PAPERCLIP_CONTEXT",
  "PAPERCLIP_WORKTREE_NAME",
] as const;

export const WORKTREE_ENV_PRECEDENCE_KEYS = [
  ...WORKTREE_SECRET_KEYS,
  ...WORKTREE_IDENTITY_KEYS,
] as const;

export type WorktreeEnvPrecedenceResult = {
  applied: boolean;
  overridden: string[];
  keptInherited: string[];
};

/**
 * Runs after the dotenv loads (which never override process env). Only when
 * the boot target passes the worktree gate, the worktree `.env` value replaces
 * an existing process value for each allowlisted key. An allowlisted key the
 * worktree `.env` does not set keeps its process value with a warning. Any
 * doubt leaves process env untouched. Logs name keys only, never values.
 */
export function applyWorktreeEnvPrecedence(): WorktreeEnvPrecedenceResult {
  const notApplied: WorktreeEnvPrecedenceResult = { applied: false, overridden: [], keptInherited: [] };
  const target = resolveWorktreeEnvTarget(process.env);
  if (!target) return notApplied;

  let fileEnv: Record<string, string>;
  try {
    fileEnv = parseDotenv(fs.readFileSync(target.envPath));
  } catch {
    return notApplied;
  }

  // Secrets always win under the gate. Identity keys win only when the worktree
  // env does not name another config; otherwise worktree repair owns them.
  const declaredConfigPath = fileEnv.PAPERCLIP_CONFIG?.trim();
  const identityAgrees =
    !declaredConfigPath || path.resolve(expandHomePrefix(declaredConfigPath)) === path.resolve(target.configPath);
  const identityKeys: readonly string[] = WORKTREE_IDENTITY_KEYS;

  const overridden: string[] = [];
  const keptInherited: string[] = [];
  for (const key of WORKTREE_ENV_PRECEDENCE_KEYS) {
    const current = process.env[key];
    if (current === undefined) continue;
    if (!identityAgrees && identityKeys.includes(key)) {
      keptInherited.push(key);
      continue;
    }
    const fileValue = fileEnv[key];
    if (fileValue === undefined || fileValue.trim() === "") {
      keptInherited.push(key);
      continue;
    }
    const nextValue = key === "PAPERCLIP_CONFIG" ? path.resolve(expandHomePrefix(fileValue.trim())) : fileValue;
    if (current === nextValue) continue;
    process.env[key] = nextValue;
    overridden.push(key);
  }

  if (overridden.length > 0) {
    console.warn(
      `[paperclip] Worktree env ${target.envPath} overrides inherited environment for: ${overridden.join(", ")}`,
    );
  }
  if (keptInherited.length > 0) {
    console.warn(
      `[paperclip] Worktree env ${target.envPath} does not set or does not own ${keptInherited.join(", ")}; keeping the inherited value.`,
    );
  }
  return { applied: true, overridden, keptInherited };
}
