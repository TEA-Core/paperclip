import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { agents, authUsers, companies, createDb, issues, MIGRATIONS_FOLDER, type Db } from "@paperclipai/db";
import { computeWorktreeSchemaLineage } from "@paperclipai/shared/worktree-initialization-identity";
import {
  ensureWorktreeSeeded,
  readVerifiedWorktreeInitialization,
  worktreeInitCommand,
} from "../commands/worktree.js";
import {
  assertFreshInitializationRows,
  assertNoLinkBelow,
  FreshInitializationRecord,
  mintFreshWorktreeIdentity,
  resolveFreshWorktreeDeletionSet,
  resolveSyntheticWorktreeFixture,
} from "../commands/worktree-fresh-init.js";
import { resolveWorktreeLocalPaths } from "../commands/worktree-lib.js";
import type { PaperclipConfig } from "../config/schema.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const schemaHead = computeWorktreeSchemaLineage(MIGRATIONS_FOLDER).at(-1)!;
const RUNNING_PHASES = [
  "destination_validation",
  "generation_create",
  "schema_migration",
  "identity_mint",
  "populate",
  "validation",
] as const;

function itEmbeddedPostgres(name: string, fn: () => Promise<void>): void {
  if (!embeddedPostgresSupport.supported) {
    it.skip(name, fn);
    return;
  }
  it(name, fn, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
}

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("assertFreshInitializationRows", () => {
  itEmbeddedPostgres("accepts exactly the profile's rows and refuses any other row", async () => {
    const testDb = await startEmbeddedPostgresTestDatabase("paperclip-fresh-rows-");
    onTestFinished(() => testDb.cleanup());
    const db = createDb(testDb.connectionString);
    const starter = resolveSyntheticWorktreeFixture("starter");

    await expect(assertFreshInitializationRows(db, null)).resolves.toBeUndefined();
    await expect(assertFreshInitializationRows(db, starter)).rejects.toThrow(/exactly the rows/);

    await starter.populate(db);
    await expect(assertFreshInitializationRows(db, starter)).resolves.toBeUndefined();
    await expect(assertFreshInitializationRows(db, null)).rejects.toThrow(/exactly the rows/);

    // One more row of any counted table is not the fixture.
    await db.insert(authUsers).values({
      id: `user-${randomBytes(4).toString("hex")}`,
      name: "Extra",
      email: `extra-${randomBytes(4).toString("hex")}@example.test`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(assertFreshInitializationRows(db, starter)).rejects.toThrow(/exactly the rows/);
  });
});

function tempRoot(prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  onTestFinished(() => {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** A worktree state dir with a manifest written through the real fresh-initialization writer. */
async function writeRecordedInitialization(root: string, instanceId: string, failAt?: (typeof RUNNING_PHASES)[number]) {
  const stateDir = path.join(root, ".paperclip");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, ".env"), `PAPERCLIP_INSTANCE_ID=${instanceId}\n`, { mode: 0o600 });
  const record = new FreshInitializationRecord(path.join(stateDir, "seed-manifest.json"), {
    profile: "fresh",
    fixture: null,
    targetInstanceId: instanceId,
    schemaRevision: schemaHead,
  });
  for (const phase of RUNNING_PHASES) {
    await record.phase(phase, () => {
      if (phase === failAt) throw new Error(`fixture failure ${randomBytes(4).toString("hex")}`);
    });
  }
  record.complete();
  return { configPath: path.join(stateDir, "config.json"), manifestPath: path.join(stateDir, "seed-manifest.json") };
}

/** Plant generated parent secrets in the parent config, its `.env` and this process's environment. */
function plantParentCanaries(root: string) {
  const canary = () => `canary${randomBytes(16).toString("hex")}`;
  const canaries = {
    llmApiKey: canary(),
    envJwt: canary(),
    processJwt: canary(),
    processToolAction: canary(),
    processDecision: canary(),
    processMasterKey: canary(),
    envSafeFlag: canary(),
  };
  const parentDir = path.join(root, "parent", "instances", "default");
  fs.mkdirSync(path.join(parentDir, "secrets"), { recursive: true });
  const parentConfigPath = path.join(parentDir, "config.json");
  fs.writeFileSync(parentConfigPath, JSON.stringify({
    $meta: { version: 1, updatedAt: "2026-11-16T00:00:00.000Z", source: "configure" },
    llm: { provider: "claude", apiKey: canaries.llmApiKey },
    database: { mode: "embedded-postgres", embeddedPostgresDataDir: path.join(parentDir, "db"), embeddedPostgresPort: 54329 },
    logging: { mode: "file", logDir: path.join(parentDir, "logs") },
    server: { deploymentMode: "local_trusted", port: 3100 },
  }));
  fs.writeFileSync(
    path.join(parentDir, ".env"),
    `PAPERCLIP_AGENT_JWT_SECRET=${canaries.envJwt}\nSAFE_FLAG=${canaries.envSafeFlag}\n`,
  );
  fs.writeFileSync(path.join(parentDir, "secrets", "master.key"), canaries.processMasterKey);
  process.env.PAPERCLIP_CONFIG = parentConfigPath;
  process.env.PAPERCLIP_AGENT_JWT_SECRET = canaries.processJwt;
  process.env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET = canaries.processToolAction;
  process.env.PAPERCLIP_DECISION_SIGNING_SECRET = canaries.processDecision;
  process.env.PAPERCLIP_SECRETS_MASTER_KEY = canaries.processMasterKey;
  return Object.values(canaries);
}

/** Every regular file below `dir`, as text, for canary checks. */
function readTree(dir: string): Array<{ file: string; text: string }> {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return { file, text: fs.readFileSync(file).toString("latin1") };
    });
}

async function withTargetDb<T>(configPath: string, action: (db: Db) => Promise<T>): Promise<T> {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as PaperclipConfig;
  // Loaded lazily, as in worktree.test.ts: the native embedded-postgres package
  // is absent on hosts where these tests are skipped.
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const pg = new EmbeddedPostgres({
    databaseDir: config.database.embeddedPostgresDataDir,
    user: "paperclip",
    password: "paperclip",
    port: config.database.embeddedPostgresPort,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });
  await pg.start();
  const db = createDb(`postgres://paperclip:paperclip@127.0.0.1:${config.database.embeddedPostgresPort}/paperclip`);
  try {
    return await action(db);
  } finally {
    await db.$client.end({ timeout: 5 });
    await pg.stop();
  }
}

describe("fresh worktree initialization record", () => {
  it("is accepted by ensure-seeded as terminal and is never reseeded", async () => {
    const root = tempRoot("paperclip-fresh-record-");
    const { configPath, manifestPath } = await writeRecordedInitialization(root, "wt-fresh");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      version: 3,
      profile: "fresh",
      state: "verified",
      phase: "complete",
      targetInstanceId: "wt-fresh",
      migrationRevision: schemaHead.migrationRevision,
      schemaFingerprint: schemaHead.schemaFingerprint,
      source: null,
      validation: { kind: "fresh-ready", attemptId: manifest.attemptId, generationId: manifest.generationId },
    });
    if (process.platform !== "win32") {
      expect(fs.statSync(manifestPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(root, ".paperclip", "initialization.key")).mode & 0o777).toBe(0o600);
    }
    expect(readVerifiedWorktreeInitialization(configPath)?.generationId).toBe(manifest.generationId);
    await expect(ensureWorktreeSeeded({ config: configPath })).resolves.toEqual({
      seeded: false,
      reason: "verified_initialization",
    });

    // The same manifest bound to another instance is refused, not reseeded.
    fs.writeFileSync(path.join(root, ".paperclip", ".env"), "PAPERCLIP_INSTANCE_ID=wt-other\n");
    expect(() => readVerifiedWorktreeInitialization(configPath)).toThrow(/different target instance/);
    await expect(ensureWorktreeSeeded({ config: configPath })).rejects.toThrow(/different target instance/);
  });

  it("refuses a forged, edited or copied manifest at ensure-seeded instead of reseeding", async () => {
    const root = tempRoot("paperclip-fresh-record-forged-");
    const { configPath, manifestPath } = await writeRecordedInitialization(root, "wt-fresh");
    const written = fs.readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(written) as Record<string, unknown>;

    // A hand-written manifest: right shape, binding not produced by this worktree's key.
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, binding: `hmac-sha256:${randomBytes(32).toString("hex")}` }));
    await expect(ensureWorktreeSeeded({ config: configPath })).rejects.toThrow(/not bound to this worktree's initialization key/);

    // The writer's manifest with one field edited afterwards.
    const diagnostics = manifest.diagnostics as Array<Record<string, unknown>>;
    fs.writeFileSync(manifestPath, JSON.stringify({
      ...manifest,
      diagnostics: diagnostics.map((entry, index) => (index === 0 ? { ...entry, code: "attempt_edited" } : entry)),
    }));
    await expect(ensureWorktreeSeeded({ config: configPath })).rejects.toThrow(/not bound/);

    // Another worktree's real manifest for the same instance id, copied in.
    const other = tempRoot("paperclip-fresh-record-other-");
    const { manifestPath: otherManifest } = await writeRecordedInitialization(other, "wt-fresh");
    fs.copyFileSync(otherManifest, manifestPath);
    await expect(ensureWorktreeSeeded({ config: configPath })).rejects.toThrow(/not bound/);

    // The writer's own output still verifies.
    fs.writeFileSync(manifestPath, written);
    await expect(ensureWorktreeSeeded({ config: configPath })).resolves.toMatchObject({ reason: "verified_initialization" });
  });

  it("records a failed phase with a fixed code and no exception text", async () => {
    const root = tempRoot("paperclip-fresh-record-failed-");
    await expect(writeRecordedInitialization(root, "wt-fresh", "schema_migration")).rejects.toThrow(/fixture failure/);
    const manifestPath = path.join(root, ".paperclip", "seed-manifest.json");
    const text = fs.readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(text);
    expect(manifest).toMatchObject({ state: "failed", phase: "schema_migration", validation: null });
    expect(manifest.diagnostics.at(-1)).toMatchObject({ phase: "schema_migration", code: "phase_failed", status: "failed" });
    expect(text).not.toMatch(/fixture failure/);
    await expect(ensureWorktreeSeeded({ config: path.join(root, ".paperclip", "config.json") }))
      .rejects.toThrow(/has not completed/);
  });

  it("refuses to write through a linked state directory", () => {
    const root = tempRoot("paperclip-fresh-record-linked-");
    const otherState = path.join(root, "other-instance-state");
    fs.mkdirSync(otherState, { recursive: true });
    fs.mkdirSync(path.join(root, "worktree"));
    fs.symlinkSync(otherState, path.join(root, "worktree", ".paperclip"));
    expect(() => new FreshInitializationRecord(path.join(root, "worktree", ".paperclip", "seed-manifest.json"), {
      profile: "fresh",
      fixture: null,
      targetInstanceId: "wt-fresh",
      schemaRevision: schemaHead,
    })).toThrow();
    expect(fs.readdirSync(otherState)).toEqual([]);
  });

  it("refuses to write a manifest that breaks the v3 contract", () => {
    const root = tempRoot("paperclip-fresh-record-invalid-");
    const manifestPath = path.join(root, ".paperclip", "seed-manifest.json");
    fs.mkdirSync(path.dirname(manifestPath));
    // A synthetic-fixture manifest must name its fixture.
    expect(() => new FreshInitializationRecord(manifestPath, {
      profile: "synthetic-fixture",
      fixture: null,
      targetInstanceId: "wt-fresh",
      schemaRevision: schemaHead,
    })).toThrow(/invalid worktree initialization manifest \(field: fixtureId\)/);
    expect(fs.existsSync(manifestPath)).toBe(false);
  });

  it("never mints a fresh identity over an existing env file", () => {
    const root = tempRoot("paperclip-fresh-identity-");
    const paths = resolveWorktreeLocalPaths({ cwd: root, homeDir: path.join(root, "home"), instanceId: "wt-fresh" });
    fs.mkdirSync(paths.repoConfigDir);
    fs.writeFileSync(paths.envPath, "PAPERCLIP_AGENT_JWT_SECRET=earlier\n");
    expect(() => mintFreshWorktreeIdentity(paths, { name: "wt-fresh", color: "#336699" })).toThrow(/existing/);
    expect(fs.readFileSync(paths.envPath, "utf8")).toBe("PAPERCLIP_AGENT_JWT_SECRET=earlier\n");
    expect(fs.existsSync(paths.secretsKeyFilePath)).toBe(false);
  });

  it("keeps manifest times ordered when the wall clock steps back", async () => {
    const root = tempRoot("paperclip-fresh-record-clock-");
    fs.mkdirSync(path.join(root, ".paperclip"));
    let clock = Date.parse("2026-11-16T12:00:00.000Z");
    const record = new FreshInitializationRecord(path.join(root, ".paperclip", "seed-manifest.json"), {
      profile: "fresh",
      fixture: null,
      targetInstanceId: "wt-fresh",
      schemaRevision: schemaHead,
    }, () => new Date((clock -= 1_000)));
    for (const phase of RUNNING_PHASES) await record.phase(phase, () => undefined);
    expect(record.complete()).toMatchObject({ state: "verified", phase: "complete" });
  });

  it("checks the deletion set: a target outside the root, a forged instance path and a wrong entry kind", () => {
    const root = tempRoot("paperclip-fresh-deletion-set-");
    expect(() => assertNoLinkBelow(path.join(root, "wt"), path.join(root, "elsewhere", "config.json"), "file"))
      .toThrow(/not inside/);
    expect(() => assertNoLinkBelow(path.join(root, "wt"), path.join(root, "wt"), "directory")).toThrow(/not inside/);

    const paths = resolveWorktreeLocalPaths({ cwd: path.join(root, "wt"), homeDir: path.join(root, "home"), instanceId: "wt" });
    fs.mkdirSync(paths.repoConfigDir, { recursive: true });
    expect(resolveFreshWorktreeDeletionSet(paths).instanceRoot).toBe(paths.instanceRoot);
    expect(() => resolveFreshWorktreeDeletionSet({ ...paths, instanceRoot: path.join(root, "home") }))
      .toThrow(/not one instance directory/);
    expect(() => resolveFreshWorktreeDeletionSet({ ...paths, instanceId: "..", instanceRoot: path.join(root, "home", "instances", "..") }))
      .toThrow(/not one instance directory/);
    // A nested id would remove a directory below another instance directory.
    expect(() => resolveFreshWorktreeDeletionSet({
      ...paths,
      instanceId: "other/wt",
      instanceRoot: path.join(root, "home", "instances", "other", "wt"),
    })).toThrow(/not one instance directory/);

    // A state file that is a directory is refused before anything is removed.
    fs.writeFileSync(paths.envPath, "PAPERCLIP_INSTANCE_ID=wt\n");
    fs.mkdirSync(paths.configPath);
    expect(() => resolveFreshWorktreeDeletionSet(paths)).toThrow(/not a regular file/);
    expect(fs.existsSync(paths.envPath)).toBe(true);
    // A .paperclip that is a file, not a directory, is refused too.
    const other = resolveWorktreeLocalPaths({ cwd: path.join(root, "wt2"), homeDir: path.join(root, "home"), instanceId: "wt2" });
    fs.mkdirSync(other.cwd);
    fs.writeFileSync(other.repoConfigDir, "not a directory");
    expect(() => resolveFreshWorktreeDeletionSet(other)).toThrow(/not a directory/);
  });
});

/** Invented files in a directory outside the worktree; returns a snapshot to compare later. */
function plantDecoy(dir: string, names: string[]): Record<string, string> {
  fs.mkdirSync(dir, { recursive: true });
  const snapshot: Record<string, string> = {};
  for (const name of names) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    snapshot[file] = `decoy ${randomBytes(8).toString("hex")}\n`;
    fs.writeFileSync(file, snapshot[file]);
  }
  return snapshot;
}

function expectUntouched(snapshot: Record<string, string>): void {
  for (const [file, contents] of Object.entries(snapshot)) {
    expect(fs.readFileSync(file, "utf8"), file).toBe(contents);
  }
}

describe("worktree init --force through symbolic links", () => {
  const STATE_FILES = ["config.json", "config.json.backup", ".env", "seed-pending", "seed-complete", "seed-skip-no-source", "initialization.key"];

  function setup(prefix: string) {
    const root = tempRoot(prefix);
    const worktreeRoot = path.join(root, "wt");
    const home = path.join(root, "home");
    fs.mkdirSync(worktreeRoot);
    process.chdir(worktreeRoot);
    return { root, worktreeRoot, home };
  }

  it("refuses a linked .paperclip and removes nothing it points to", async () => {
    const { root, worktreeRoot, home } = setup("paperclip-force-linked-state-");
    const decoy = plantDecoy(path.join(root, "decoy-state"), STATE_FILES);
    fs.symlinkSync(path.join(root, "decoy-state"), path.join(worktreeRoot, ".paperclip"));
    for (const opts of [{ profile: "fresh" }, { seed: false, fromConfig: path.join(root, "missing", "config.json") }]) {
      await expect(worktreeInitCommand({ ...opts, name: "wt", home, force: true })).rejects.toThrow(/symbolic link/);
      expectUntouched(decoy);
    }
  });

  it("refuses a .paperclip that links to the worktree's parent directory", async () => {
    const { root, worktreeRoot, home } = setup("paperclip-force-linked-parent-");
    const decoy = plantDecoy(root, ["config.json", ".env", "seed-pending"]);
    fs.symlinkSync(root, path.join(worktreeRoot, ".paperclip"));
    await expect(worktreeInitCommand({ profile: "fresh", name: "wt", home, force: true })).rejects.toThrow(/symbolic link/);
    expectUntouched(decoy);
  });

  it("refuses a linked instances directory or instance directory under the worktree home", async () => {
    for (const linkAt of ["instances", path.join("instances", "wt")]) {
      const { root, home } = setup("paperclip-force-linked-instance-");
      const target = path.join(root, "decoy-instance");
      const decoy = plantDecoy(target, linkAt === "instances" ? ["wt/db/PG_VERSION", "wt/secrets/master.key"] : ["db/PG_VERSION", "secrets/master.key"]);
      fs.mkdirSync(path.dirname(path.join(home, linkAt)), { recursive: true });
      fs.symlinkSync(target, path.join(home, linkAt));
      for (const opts of [{ profile: "fresh" }, { seed: false, fromConfig: path.join(root, "missing", "config.json") }]) {
        await expect(worktreeInitCommand({ ...opts, name: "wt", home, force: true })).rejects.toThrow(/symbolic link/);
        expectUntouched(decoy);
      }
    }
  });

  it("refuses a state file that is itself a link, and keeps its target", async () => {
    const { root, worktreeRoot, home } = setup("paperclip-force-linked-file-");
    const decoy = plantDecoy(path.join(root, "outside"), ["config.json"]);
    fs.mkdirSync(path.join(worktreeRoot, ".paperclip"));
    fs.symlinkSync(path.join(root, "outside", "config.json"), path.join(worktreeRoot, ".paperclip", "config.json"));
    await expect(worktreeInitCommand({ profile: "fresh", name: "wt", home, force: true })).rejects.toThrow(/symbolic link/);
    expectUntouched(decoy);
  });

  it("refuses a linked .paperclip without --force before writing anything into it", async () => {
    const { root, worktreeRoot, home } = setup("paperclip-linked-state-no-force-");
    fs.mkdirSync(path.join(root, "empty-decoy"));
    fs.symlinkSync(path.join(root, "empty-decoy"), path.join(worktreeRoot, ".paperclip"));
    await expect(worktreeInitCommand({ profile: "fresh", name: "wt", home })).rejects.toThrow(/symbolic link/);
    expect(fs.readdirSync(path.join(root, "empty-decoy"))).toEqual([]);
  });
});

describe("worktree init --profile", () => {
  it("rejects an unknown profile, parent-source options and a fixture without its profile", async () => {
    const root = tempRoot("paperclip-fresh-options-");
    const worktreeRoot = path.join(root, "wt");
    fs.mkdirSync(worktreeRoot);
    process.chdir(worktreeRoot);
    const home = path.join(root, "home");
    await expect(worktreeInitCommand({ profile: "clone", home })).rejects.toThrow(/Unsupported initialization profile/);
    await expect(worktreeInitCommand({ profile: "fresh", home, fromConfig: path.join(root, "parent.json") }))
      .rejects.toThrow(/without a parent source/);
    await expect(worktreeInitCommand({ profile: "fresh", home, fixture: "starter" }))
      .rejects.toThrow(/--fixture requires --profile synthetic-fixture/);
    await expect(worktreeInitCommand({ fixture: "starter", home, seed: false }))
      .rejects.toThrow(/--fixture requires --profile synthetic-fixture/);
    await expect(worktreeInitCommand({ profile: "synthetic-fixture", fixture: "unknown", home }))
      .rejects.toThrow(/Unknown worktree fixture/);
    expect(fs.existsSync(path.join(worktreeRoot, ".paperclip"))).toBe(false);

    // Existing worktree state is never merged into a fresh generation without --force.
    fs.mkdirSync(path.join(worktreeRoot, ".paperclip"));
    fs.writeFileSync(path.join(worktreeRoot, ".paperclip", "config.json"), "existing");
    await expect(worktreeInitCommand({ profile: "fresh", home })).rejects.toThrow(/Re-run with --force/);
    expect(fs.readFileSync(path.join(worktreeRoot, ".paperclip", "config.json"), "utf8")).toBe("existing");
  });

  itEmbeddedPostgres("creates a fresh instance with new keys and an empty database, reading no parent secret", async () => {
    const root = tempRoot("paperclip-fresh-init-");
    const canaries = plantParentCanaries(root);
    const worktreeRoot = path.join(root, "fresh-wt");
    const home = path.join(root, "worktrees-home");
    fs.mkdirSync(worktreeRoot);
    process.chdir(worktreeRoot);

    await worktreeInitCommand({ profile: "fresh", name: "fresh-wt", home });

    const stateDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(stateDir, "config.json");
    expect(readVerifiedWorktreeInitialization(configPath)).toMatchObject({
      profile: "fresh",
      state: "verified",
      targetInstanceId: "fresh-wt",
      migrationRevision: schemaHead.migrationRevision,
    });
    await expect(ensureWorktreeSeeded({ config: configPath })).resolves.toMatchObject({ reason: "verified_initialization" });

    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as PaperclipConfig;
    expect(config.llm).toBeUndefined();
    expect(config).toMatchObject({
      server: { deploymentMode: "local_trusted", bind: "loopback", host: "127.0.0.1" },
      telemetry: { enabled: false },
      database: { backup: { enabled: false } },
      secrets: { provider: "local_encrypted", strictMode: true },
    });
    const env = fs.readFileSync(path.join(stateDir, ".env"), "utf8");
    for (const key of ["PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET", "PAPERCLIP_DECISION_SIGNING_SECRET"]) {
      expect(env).toMatch(new RegExp(`^${key}="?[0-9a-f]{64}"?$`, "m"));
    }
    expect(env).toMatch(/^PAPERCLIP_INSTANCE_ID="?fresh-wt"?$/m);
    const keyPath = config.secrets.localEncrypted.keyFilePath;
    expect(Buffer.from(fs.readFileSync(keyPath, "utf8"), "base64")).toHaveLength(32);
    if (process.platform !== "win32") {
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(keyPath)).mode & 0o777).toBe(0o700);
    }
    expect(fs.existsSync(`${configPath}.backup`)).toBe(false);

    // No generated parent secret reaches the repo state or the instance, including the database files.
    const written = [...readTree(stateDir), ...readTree(path.join(home, "instances", "fresh-wt"))];
    expect(written.length).toBeGreaterThan(0);
    for (const { file, text } of written) {
      for (const value of canaries) expect(text.includes(value), `${file} holds a parent canary`).toBe(false);
    }

    const counts = await withTargetDb(configPath, async (db) => ({
      companies: (await db.select({ id: companies.id }).from(companies)).length,
      users: (await db.select({ id: authUsers.id }).from(authUsers)).length,
    }));
    expect(counts).toEqual({ companies: 0, users: 0 });
  });

  itEmbeddedPostgres("populates only the synthetic fixture and makes a new generation on --force", async () => {
    const root = tempRoot("paperclip-fresh-fixture-");
    const worktreeRoot = path.join(root, "fixture-wt");
    const home = path.join(root, "worktrees-home");
    fs.mkdirSync(worktreeRoot);
    process.chdir(worktreeRoot);

    await worktreeInitCommand({ profile: "synthetic-fixture", name: "fixture-wt", home });
    const stateDir = path.join(worktreeRoot, ".paperclip");
    const configPath = path.join(stateDir, "config.json");
    const first = readVerifiedWorktreeInitialization(configPath);
    expect(first).toMatchObject({ profile: "synthetic-fixture", fixtureId: "starter", fixtureVersion: 1 });

    const rows = await withTargetDb(configPath, async (db) => ({
      companies: await db.select({ status: companies.status }).from(companies),
      agents: await db.select({ status: agents.status, adapterType: agents.adapterType }).from(agents),
      issues: await db.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId }).from(issues),
      users: (await db.select({ id: authUsers.id }).from(authUsers)).length,
    }));
    expect(rows).toEqual({
      companies: [{ status: "paused" }],
      agents: [{ status: "paused", adapterType: "process" }],
      issues: [{ status: "backlog", assigneeAgentId: null }, { status: "backlog", assigneeAgentId: null }],
      users: 0,
    });

    const firstEnv = fs.readFileSync(path.join(stateDir, ".env"), "utf8");
    // A backup left by an earlier clone generation is removed with the generation it belongs to.
    fs.writeFileSync(`${configPath}.backup`, "earlier generation config\n");
    await worktreeInitCommand({ profile: "fresh", name: "fixture-wt", home, force: true });
    expect(fs.existsSync(`${configPath}.backup`)).toBe(false);
    const second = readVerifiedWorktreeInitialization(configPath);
    expect(second?.profile).toBe("fresh");
    expect(second?.generationId).not.toBe(first?.generationId);
    const jwt = (text: string) => /^PAPERCLIP_AGENT_JWT_SECRET="?([0-9a-f]{64})"?$/m.exec(text)?.[1];
    expect(jwt(fs.readFileSync(path.join(stateDir, ".env"), "utf8"))).not.toBe(jwt(firstEnv));
    const companiesAfter = await withTargetDb(configPath, async (db) => db.select({ id: companies.id }).from(companies));
    expect(companiesAfter).toEqual([]);
  });
});
