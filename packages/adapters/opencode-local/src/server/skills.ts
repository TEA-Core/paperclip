import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { ensureAgentAccessibleDir } from "@paperclipai/adapter-utils/agent-shared-dir";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export type OpenCodeSkillIsolationMode = "shared" | "desired-only";

/**
 * Resolve the per-agent `skillIsolation` adapter setting. `"shared"` is the
 * default and is the current behaviour: desired skills are symlinked into the
 * shared skills home, so a run sees the union of every agent's skills there.
 * `"desired-only"` makes a local run see only its own `desiredSkills` (see
 * prepareOpenCodeIsolatedSkillsHome). Any other value falls back to `"shared"`.
 */
export function resolveOpenCodeSkillIsolation(
  config: Record<string, unknown>,
): OpenCodeSkillIsolationMode {
  return asString(config.skillIsolation) === "desired-only" ? "desired-only" : "shared";
}

export function resolveOpenCodeSkillsHome(config: Record<string, unknown>) {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  return path.join(home, ".claude", "skills");
}

async function buildOpenCodeSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveOpenCodeSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "opencode_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "~/.claude/skills",
    installedDetail: "Installed in the shared Claude/OpenCode skills home.",
    missingDetail: "Configured but not currently linked into the shared Claude/OpenCode skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation in the shared skills home.",
    externalDetail: "Installed outside Paperclip management in the shared skills home.",
    warnings: [
      "OpenCode currently uses the shared Claude skills home (~/.claude/skills).",
    ],
  });
}

export async function listOpenCodeSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildOpenCodeSkillSnapshot(ctx.config);
}

export async function syncOpenCodeSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...resolveLegacyPaperclipDesiredSkillNames({}, availableEntries),
    ...desiredSkills,
  ]);
  const skillsHome = resolveOpenCodeSkillsHome(ctx.config);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    const target = path.join(skillsHome, available.runtimeName);
    await ensurePaperclipSkillSymlink(available.source, target);
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    if (!available) continue;
    if (desiredSet.has(available.key)) continue;
    if (installedEntry.targetPath !== available.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }

  return buildOpenCodeSkillSnapshot(ctx.config);
}

export function resolveOpenCodeDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
}

/**
 * Build the per-run HOME for a `skillIsolation: "desired-only"` local run.
 *
 * Verified against opencode 1.18.32 via `opencode debug skill` (SUP-17881):
 * opencode's external skill scan reads `$HOME/.claude/skills` and
 * `$HOME/.agents/skills`, so a per-run HOME whose `.claude/skills` points at
 * the desired-only skills directory makes the run's available-skills listing
 * exactly that set (plus opencode's built-in skills, which are part of the
 * binary, not the HOME).
 *
 * Everything else the run reads from HOME is carried over into the per-run
 * HOME by SYMLINK to the original home, so HOME-dependent behaviour is
 * unchanged from a shared-HOME run:
 * - `.gitconfig` / `.git-credentials` / `.ssh` — git identity and credentials
 * - `.local` — opencode's data dir: `OPENCODE_DB` is set per agent as a
 *   RELATIVE name that opencode joins to `$HOME/.local/share/opencode`, so the
 *   per-agent session database (and cross-run `--session` resume) stay put
 * - `.cache`, `.npm`, `.npmrc`, `.npm-global`, `.pnpm-store`, `.bun` — caches
 * - `.config` — non-XDG config lookups (opencode's own config is already
 *   repointed per-run via XDG_CONFIG_HOME by prepareOpenCodeRuntimeConfig)
 * - `.gh.json`, `.gnupg`, and every other entry — faithful pass-through
 *
 * Deliberately NOT carried over: `.agents` (an additional external skill
 * location — including it would break the desired-only guarantee) and
 * `.claude`, which is recreated with every entry carried over EXCEPT
 * `skills`, which is repointed at the filtered `skillsDir`.
 *
 * The original home is only ever read, never written. Each run gets its own
 * mkdtemp root, so concurrent desired-only runs of different agents cannot see
 * or alter each other's HOME.
 */
export async function prepareOpenCodeIsolatedSkillsHome(input: {
  config: Record<string, unknown>;
  skillsDir: string;
}): Promise<{ home: string; warnings: string[] }> {
  const env =
    typeof input.config.env === "object" &&
    input.config.env !== null &&
    !Array.isArray(input.config.env)
      ? (input.config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  const originalHome = configuredHome ? path.resolve(configuredHome) : os.homedir();

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-home-"));
  // Same 0700-mkdtemp hazard as the runtime config (SUP-13484): this path
  // becomes the agent child's HOME, and the child runs at uid 1001.
  await ensureAgentAccessibleDir(root);
  const warnings: string[] = [];

  const mirrorEntries = async (
    sourceDir: string,
    destDir: string,
    skipped: Set<string>,
  ): Promise<void> => {
    let entries: string[];
    try {
      entries = await fs.readdir(sourceDir);
    } catch {
      // Missing (or unreadable) source directory: mirror nothing rather than
      // fail the run. An absent original HOME/.claude just means the run has
      // no carried-over entries, same as today for a fresh HOME.
      return;
    }
    for (const name of entries) {
      if (skipped.has(name)) continue;
      const target = path.join(sourceDir, name);
      const link = path.join(destDir, name);
      await fs.symlink(target, link).catch(() => {
        warnings.push(
          `could not carry over ${target} into the isolated skills home; HOME-dependent behaviour for it is degraded for this run.`,
        );
      });
    }
  };

  await mirrorEntries(originalHome, root, new Set([".claude", ".agents"]));

  const claudeDir = path.join(root, ".claude");
  await fs.mkdir(claudeDir, { recursive: true });
  await ensureAgentAccessibleDir(claudeDir);
  let originalClaudeIsDir = false;
  try {
    originalClaudeIsDir = (await fs.stat(path.join(originalHome, ".claude"))).isDirectory();
  } catch {
    originalClaudeIsDir = false;
  }
  if (originalClaudeIsDir) {
    await mirrorEntries(path.join(originalHome, ".claude"), claudeDir, new Set(["skills"]));
  }
  await fs.symlink(input.skillsDir, path.join(claudeDir, "skills"));

  return { home: root, warnings };
}
