/**
 * Fresh isolated worktree initialization (v3 `worktree-initialization`).
 *
 * Nothing in this module reads a parent instance: no parent config, `.env`,
 * secrets key, database, or inherited process environment value. The
 * destination config is a literal, every key is newly generated, and the
 * database starts empty from this build's migrations. The `synthetic-fixture`
 * profile then inserts a small named fixture whose every value is a literal
 * here.
 *
 * Progress is recorded in a v3 manifest that is written atomically through the
 * trusted-root state-file writer and validated before every write. The
 * terminal `verified` manifest is written last, with validation evidence bound
 * to the same attempt and generation.
 */

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { count } from "drizzle-orm";
import { agents, authUsers, companies, goals, issues, projects, type Db } from "@paperclipai/db";
import { resolveWorktreeStateRoot, writeStateFileAtomic } from "@paperclipai/shared/bounded-state-file";
import type { WorktreeSchemaRevision } from "@paperclipai/shared/worktree-initialization-identity";
import {
  computeWorktreeInitializationBinding,
  validateWorktreeInitializationManifest,
  WORKTREE_INITIALIZATION_KEY_BYTES,
  WORKTREE_INITIALIZATION_KEY_FILE,
  WORKTREE_INITIALIZATION_MANIFEST_KIND,
  WORKTREE_INITIALIZATION_MANIFEST_VERSION,
  WORKTREE_INITIALIZATION_POLICY_VERSION,
  type WorktreeInitializationDiagnostic,
  type WorktreeInitializationManifest,
  type WorktreeInitializationPhase,
} from "@paperclipai/shared/worktree-initialization-manifest";
import { writePaperclipEnvEntries } from "../config/env.js";
import type { PaperclipConfig } from "../config/schema.js";
import { buildWorktreeEnvEntries, type WorktreeLocalPaths, type WorktreeUiBranding } from "./worktree-lib.js";

export const WORKTREE_INIT_PROFILES = ["fresh", "synthetic-fixture"] as const;
export type WorktreeInitProfile = (typeof WORKTREE_INIT_PROFILES)[number];
/** Shape of a sanitized instance id: one path segment, no separators or dots. */
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isWorktreeInitProfile(value: string): value is WorktreeInitProfile {
  return (WORKTREE_INIT_PROFILES as readonly string[]).includes(value);
}

/**
 * Destination config built only from literals and destination paths. It never
 * takes a source config, so no parent `llm`, URL, provider or credential
 * setting can reach it.
 */
export function buildFreshWorktreeConfig(input: {
  paths: WorktreeLocalPaths;
  serverPort: number;
  databasePort: number;
  now?: Date;
}): PaperclipConfig {
  const { paths } = input;
  return {
    $meta: { version: 1, updatedAt: (input.now ?? new Date()).toISOString(), source: "configure" },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: paths.embeddedPostgresDataDir,
      embeddedPostgresPort: input.databasePort,
      backup: { enabled: false, intervalMinutes: 60, retentionDays: 7, dir: paths.backupDir },
    },
    logging: { mode: "file", logDir: paths.logDir },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      bind: "loopback",
      host: "127.0.0.1",
      port: input.serverPort,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    telemetry: { enabled: false },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: paths.storageDir },
      s3: { bucket: "paperclip", region: "us-east-1", prefix: "", forcePathStyle: false },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: true,
      localEncrypted: { keyFilePath: paths.secretsKeyFilePath },
    },
  };
}

/**
 * Write a new destination identity: a fresh 32-byte secrets master key file
 * (0600 in a 0700 directory) and a new `.env` with fresh agent JWT,
 * tool-action and decision-signing secrets. Refuses to run over an existing
 * `.env` or key file, so no earlier value is merged or carried forward.
 */
export function mintFreshWorktreeIdentity(paths: WorktreeLocalPaths, branding: WorktreeUiBranding): void {
  if (fs.existsSync(paths.envPath)) {
    throw new Error(`Refusing to mint a fresh worktree identity over the existing ${paths.envPath}.`);
  }
  fs.mkdirSync(path.dirname(paths.secretsKeyFilePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.secretsKeyFilePath, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
  writePaperclipEnvEntries(
    {
      ...buildWorktreeEnvEntries(paths, branding),
      PAPERCLIP_AGENT_JWT_SECRET: randomBytes(32).toString("hex"),
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: randomBytes(32).toString("hex"),
      PAPERCLIP_DECISION_SIGNING_SECRET: randomBytes(32).toString("hex"),
    },
    paths.envPath,
  );
}

/**
 * Refuse `target` when it, or any directory between the trusted `root` and
 * it, is a symbolic link or not the expected kind. Existing entries only: a
 * missing component ends the walk, because nothing below it exists. `root`
 * itself may be reached through links (it is resolved once with realpath).
 * `target` must lie strictly below `root`.
 */
export function assertNoLinkBelow(root: string, target: string, finalKind: "file" | "directory"): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing ${target}: it is not inside ${root}.`);
  }
  let current: string;
  try {
    current = fs.realpathSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const parts = relative.split(path.sep);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const shown = path.join(root, ...parts.slice(0, index + 1));
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing ${shown}: it is a symbolic link. Worktree state is never written or deleted through a link.`);
    }
    const wantDirectory = index < parts.length - 1 || finalKind === "directory";
    if (wantDirectory ? !stat.isDirectory() : !stat.isFile()) {
      throw new Error(`Refusing ${shown}: it is not a ${wantDirectory ? "directory" : "regular file"}.`);
    }
  }
}

export type FreshWorktreeDeletionSet = {
  /** Repo state files below the worktree root. */
  files: string[];
  /** The instance directory `<home>/instances/<instance-id>`. */
  instanceRoot: string;
};

/**
 * The explicit entries a clean generation (`--force`) removes, checked before
 * anything is written or removed: repo state files below the worktree root and
 * the instance directory below the worktree home, none reached through a
 * symbolic link, and the instance directory exactly
 * `<home>/instances/<instance-id>`. Sibling state such as
 * `.paperclip/worktrees/` and the manifest (replaced atomically) are not in the
 * set. Checking every entry first means a refusal removes nothing.
 */
export function resolveFreshWorktreeDeletionSet(paths: WorktreeLocalPaths): FreshWorktreeDeletionSet {
  const files = [
    paths.configPath,
    `${paths.configPath}.backup`,
    paths.envPath,
    path.join(paths.repoConfigDir, "seed-pending"),
    path.join(paths.repoConfigDir, "seed-complete"),
    path.join(paths.repoConfigDir, "seed-skip-no-source"),
    path.join(paths.repoConfigDir, WORKTREE_INITIALIZATION_KEY_FILE),
  ];
  for (const file of files) assertNoLinkBelow(paths.cwd, file, "file");
  const expectedInstanceRoot = path.join(path.resolve(paths.homeDir), "instances", paths.instanceId);
  if (!INSTANCE_ID_PATTERN.test(paths.instanceId) || path.resolve(paths.instanceRoot) !== expectedInstanceRoot) {
    throw new Error(
      `Refusing instance directory ${paths.instanceRoot}: it is not one instance directory directly below ${path.dirname(expectedInstanceRoot)}.`,
    );
  }
  assertNoLinkBelow(paths.homeDir, paths.instanceRoot, "directory");
  return { files, instanceRoot: paths.instanceRoot };
}

export function removeFreshWorktreeState(deletionSet: FreshWorktreeDeletionSet): void {
  for (const file of deletionSet.files) fs.rmSync(file, { force: true });
  fs.rmSync(deletionSet.instanceRoot, { recursive: true, force: true });
}

export type SyntheticWorktreeFixture = {
  id: string;
  version: number;
  expectedRows: FreshInitializationRowCounts;
  populate(db: Db): Promise<void>;
};

export type FreshInitializationRowCounts = {
  companies: number;
  agents: number;
  goals: number;
  projects: number;
  issues: number;
  authUsers: number;
};

const EMPTY_ROW_COUNTS: FreshInitializationRowCounts = {
  companies: 0,
  agents: 0,
  goals: 0,
  projects: 0,
  issues: 0,
  authUsers: 0,
};

/**
 * `starter@1`: one paused company with one paused `process` agent, a goal, a
 * project and two unassigned backlog issues. No adapter command, environment,
 * credential or routine exists, so nothing can start work.
 */
const STARTER_FIXTURE: SyntheticWorktreeFixture = {
  id: "starter",
  version: 1,
  expectedRows: { ...EMPTY_ROW_COUNTS, companies: 1, agents: 1, goals: 1, projects: 1, issues: 2 },
  async populate(db) {
    const pausedAt = new Date();
    await db.transaction(async (tx) => {
      const [company] = await tx.insert(companies).values({
        name: "Fixture Company",
        description: "Synthetic fixture company for a fresh worktree preview.",
        status: "paused",
        pauseReason: "manual",
        pausedAt,
        issuePrefix: "FIX",
        issueCounter: 2,
      }).returning({ id: companies.id });
      const [agent] = await tx.insert(agents).values({
        companyId: company.id,
        name: "Fixture Agent",
        role: "general",
        status: "paused",
        pauseReason: "manual",
        pausedAt,
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      }).returning({ id: agents.id });
      const [goal] = await tx.insert(goals).values({
        companyId: company.id,
        title: "Fixture goal",
        level: "company",
        status: "planned",
        ownerAgentId: agent.id,
      }).returning({ id: goals.id });
      const [project] = await tx.insert(projects).values({
        companyId: company.id,
        goalId: goal.id,
        name: "Fixture project",
        status: "backlog",
        leadAgentId: agent.id,
      }).returning({ id: projects.id });
      await tx.insert(issues).values([1, 2].map((issueNumber) => ({
        companyId: company.id,
        projectId: project.id,
        goalId: goal.id,
        title: `Fixture issue ${issueNumber}`,
        status: "backlog",
        priority: "medium",
        issueNumber,
        identifier: `FIX-${issueNumber}`,
      })));
    });
  },
};

export const SYNTHETIC_WORKTREE_FIXTURES: readonly SyntheticWorktreeFixture[] = [STARTER_FIXTURE];

export function resolveSyntheticWorktreeFixture(id: string): SyntheticWorktreeFixture {
  const fixture = SYNTHETIC_WORKTREE_FIXTURES.find((candidate) => candidate.id === id);
  if (!fixture) {
    const known = SYNTHETIC_WORKTREE_FIXTURES.map((candidate) => candidate.id).join(", ");
    throw new Error(`Unknown worktree fixture "${id}". Expected one of: ${known}.`);
  }
  return fixture;
}

/**
 * Assert that a fresh or synthetic-fixture destination holds exactly the rows
 * of its profile: none for `fresh`, the fixture's rows for `synthetic-fixture`.
 * Auth users are always zero: the preview has no copied or pre-created login;
 * the server itself creates a local board identity.
 */
export async function assertFreshInitializationRows(db: Db, fixture: SyntheticWorktreeFixture | null): Promise<void> {
  const total = async (table: typeof companies | typeof agents | typeof goals | typeof projects | typeof issues | typeof authUsers) => {
    const [row] = await db.select({ value: count() }).from(table);
    return Number(row?.value ?? 0);
  };
  const rows: FreshInitializationRowCounts = {
    companies: await total(companies),
    agents: await total(agents),
    goals: await total(goals),
    projects: await total(projects),
    issues: await total(issues),
    authUsers: await total(authUsers),
  };
  if (!isDeepStrictEqual(rows, fixture?.expectedRows ?? EMPTY_ROW_COUNTS)) {
    throw new Error("Fresh worktree database does not hold exactly the rows of the selected profile.");
  }
}

/**
 * Durable record of one fresh initialization attempt. Every write is bound
 * under the generation's initialization key, validated against the v3
 * contract, and written through the trusted-root atomic writer, so a linked
 * state directory is refused and a reader sees either the previous or the
 * next complete manifest.
 */
export class FreshInitializationRecord {
  private manifest: WorktreeInitializationManifest;
  private readonly trustedRoot: string;
  private readonly key: Buffer;
  private lastTimestampMs = 0;

  constructor(
    private readonly manifestPath: string,
    input: {
      profile: WorktreeInitProfile;
      fixture: SyntheticWorktreeFixture | null;
      targetInstanceId: string;
      schemaRevision: WorktreeSchemaRevision;
    },
    private readonly now: () => Date = () => new Date(),
  ) {
    this.trustedRoot = resolveWorktreeStateRoot(manifestPath);
    // A new key per generation, written 0600 next to the manifest before the
    // first manifest write. Every manifest is bound under it, so readers can
    // tell this writer's output from a hand-written, edited or copied file, and
    // a manifest of an earlier generation stops verifying.
    this.key = randomBytes(WORKTREE_INITIALIZATION_KEY_BYTES);
    writeStateFileAtomic(path.join(path.dirname(manifestPath), WORKTREE_INITIALIZATION_KEY_FILE), this.key, {
      trustedRoot: this.trustedRoot,
    });
    this.manifest = {
      version: WORKTREE_INITIALIZATION_MANIFEST_VERSION,
      kind: WORKTREE_INITIALIZATION_MANIFEST_KIND,
      profile: input.profile,
      policyVersion: WORKTREE_INITIALIZATION_POLICY_VERSION,
      schemaFingerprint: input.schemaRevision.schemaFingerprint,
      migrationRevision: input.schemaRevision.migrationRevision,
      targetInstanceId: input.targetInstanceId,
      generationId: randomUUID(),
      attemptId: randomUUID(),
      state: "pending",
      phase: "pending",
      startedAt: null,
      finishedAt: null,
      source: null,
      ...(input.fixture ? { fixtureId: input.fixture.id, fixtureVersion: input.fixture.version } : {}),
      diagnostics: [{ phase: "pending", code: "attempt_pending", status: "succeeded", at: this.timestamp() }],
      validation: null,
      binding: "",
    };
    this.write();
  }

  get current(): WorktreeInitializationManifest {
    return this.manifest;
  }

  /**
   * Run one phase. A failure records a `failed` manifest with a bounded
   * diagnostic (fixed code, no exception text) and is rethrown.
   */
  async phase<T>(phase: Exclude<WorktreeInitializationPhase, "pending" | "complete">, action: () => Promise<T> | T): Promise<T> {
    const startedAt = this.manifest.startedAt ?? this.timestamp();
    this.update({ state: "running", phase, startedAt }, { phase, code: "phase_started", status: "started" });
    let result: T;
    try {
      result = await action();
    } catch (error) {
      this.update(
        { state: "failed", phase, finishedAt: this.timestamp() },
        { phase, code: "phase_failed", status: "failed" },
      );
      throw error;
    }
    this.update({}, { phase, code: "phase_succeeded", status: "succeeded" });
    return result;
  }

  /** Publish the terminal `verified` manifest. Called only after every phase succeeded. */
  complete(): WorktreeInitializationManifest {
    const finishedAt = this.timestamp();
    this.update(
      {
        state: "verified",
        phase: "complete",
        finishedAt,
        validation: {
          kind: "fresh-ready",
          attemptId: this.manifest.attemptId,
          generationId: this.manifest.generationId,
          completedAt: finishedAt,
        },
      },
      { phase: "complete", code: "fresh_ready", status: "succeeded" },
    );
    return this.manifest;
  }

  /**
   * Never earlier than the previous timestamp of this record, so a wall clock
   * that steps back during initialization cannot produce a manifest whose
   * finish precedes its start.
   */
  private timestamp(): string {
    this.lastTimestampMs = Math.max(this.now().getTime(), this.lastTimestampMs);
    return new Date(this.lastTimestampMs).toISOString();
  }

  private update(
    patch: Partial<WorktreeInitializationManifest>,
    diagnostic: Omit<WorktreeInitializationDiagnostic, "at">,
  ): void {
    this.manifest = {
      ...this.manifest,
      ...patch,
      diagnostics: [...this.manifest.diagnostics, { ...diagnostic, at: this.timestamp() }],
    };
    this.write();
  }

  private write(): void {
    this.manifest = { ...this.manifest, binding: computeWorktreeInitializationBinding(this.key, this.manifest) };
    const validated = validateWorktreeInitializationManifest(this.manifest);
    if (!validated.ok) {
      throw new Error(`Refusing to write an invalid worktree initialization manifest (field: ${validated.field}).`);
    }
    writeStateFileAtomic(this.manifestPath, `${JSON.stringify(this.manifest, null, 2)}\n`, {
      trustedRoot: this.trustedRoot,
    });
  }
}
