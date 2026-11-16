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
  validateWorktreeInitializationManifest,
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
 * Durable record of one fresh initialization attempt. Every write is validated
 * against the v3 contract first and goes through the trusted-root atomic
 * writer, so a linked state directory is refused and a reader sees either the
 * previous or the next complete manifest.
 */
export class FreshInitializationRecord {
  private manifest: WorktreeInitializationManifest;
  private readonly trustedRoot: string;

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

  private timestamp(): string {
    return this.now().toISOString();
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
    const validated = validateWorktreeInitializationManifest(this.manifest);
    if (!validated.ok) {
      throw new Error(`Refusing to write an invalid worktree initialization manifest (field: ${validated.field}).`);
    }
    writeStateFileAtomic(this.manifestPath, `${JSON.stringify(this.manifest, null, 2)}\n`, {
      trustedRoot: this.trustedRoot,
    });
  }
}
