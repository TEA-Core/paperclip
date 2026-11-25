import fs from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import * as executionTargetTools from "@paperclipai/adapter-utils/execution-target";
import * as ssh from "@paperclipai/adapter-utils/ssh";
const execFile = promisify(execFileCallback);
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agentFileStore, fileHash, inspectAgentFile, snapshotAgentFiles, MAX_AGENT_FILE_BYTES, MAX_AGENT_DIRECTORY_BYTES, MAX_AGENT_DIRECTORY_ENTRIES } from "../services/agent-file-store.js";
import { agents, companies, authUsers, companyMemberships, principalPermissionGrants, heartbeatRuns, environmentLeases, environments, agentInstructionWorkingCopies, agentInstructionRevisions, agentInstructionHeads, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentInstructionRevisionService } from "../services/agent-instruction-revisions.js";
import { agentInstructionWorkingCopyService, instructionWorkingCopyGuidance } from "../services/agent-instruction-working-copies.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { buildNativeRuntimeContext } from "../services/native-runtime/runtime-context.js";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.js";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.js";
import { AgentDirectoryReuseInvalidatedError, agentDirectoryWorkingCopyService } from "../services/agent-directory-working-copies.js";
import { withDirectoryMergeLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { heartbeatRunEvents } from "@paperclipai/db";

describe("persistent agent directories", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let copies: ReturnType<typeof agentInstructionWorkingCopyService>;
  let revisions: ReturnType<typeof agentInstructionRevisionService>;
  const previousHome = process.env.PAPERCLIP_HOME;
  let home: string;
  let companyId: string, agentId: string, userId: string, root: string;
  const entryFile = "policy/INSTRUCTIONS.txt";
  const initial = "\uFEFF# Original\r\n☃\n";
  const target = () => ({ companyId, agentId });
  const board = () => ({ type: "board" as const, userId, source: "session" as const });
  async function run(options: { warm?: boolean; reuseRunId?: string } = {}) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    return (await copies.prepare({ ...target(), runId, cwd: home, ...options }))!;
  }
  beforeAll(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "instruction-working-copies-")));
    process.env.PAPERCLIP_HOME = home;
    database = await startEmbeddedPostgresTestDatabase("instruction-copies-db-");
    db = createDb(database.connectionString);
    copies = agentInstructionWorkingCopyService(db);
    revisions = agentInstructionRevisionService(db);
  }, 90_000);
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await database?.cleanup();
    if (home) {
      const writable = async (dir: string) => {
        await fs.chmod(dir, 0o700);
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) await writable(path.join(dir, entry.name));
      };
      await writable(home);
      await fs.rm(home, { recursive: true, force: true });
    }
  });
  beforeEach(async () => {
    companyId = randomUUID(); agentId = randomUUID(); userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Instruction tests", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Editor", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    root = resolveManagedInstructionsRoot({ ...target(), id: agentId, name: "Target", adapterConfig: {} });
    await db.insert(agents).values({ id: agentId, companyId, name: "Target", adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    await fs.mkdir(path.dirname(path.join(root, entryFile)), { recursive: true });
    await fs.writeFile(path.join(root, entryFile), initial);
  });

  it.each([".paperclip-runtime/state", "notes/.paperclip-runtime/state", "promptTemplate.legacy.md"])("rejects reserved board path %s before mutation", async (reserved) => {
    await expect(agentFileStore(db).write({ ...target(), path: reserved, bytes: Buffer.from("reserved"), baseHash: null }, board())).rejects.toMatchObject({ status: 422 });
    await expect(fs.stat(path.join(root, reserved))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await run()).toBeTruthy();
  });

  it("round trips nested text, empty directories and binary bytes independently of task files", async () => {
    const first = await run();
    expect(first.localRoot.startsWith(path.join(home, ".paperclip-runtime"))).toBe(false);
    await fs.mkdir(path.join(first.localRoot, "notes", "empty"), { recursive: true });
    await fs.writeFile(path.join(first.localRoot, "notes", "fact.txt"), "remember me");
    const bytes = Buffer.from([0, 255, 17, 128, 9]);
    await fs.writeFile(path.join(first.localRoot, "image.bin"), bytes);
    await fs.writeFile(path.join(home, "task-only.txt"), "not personal");
    expect((await copies.collectStopped({ companyId, runId: first.runId }))?.state).toBe("saved");
    copies = agentInstructionWorkingCopyService(db);
    const next = await run();
    expect(await fs.readFile(path.join(next.localRoot, "notes", "fact.txt"), "utf8")).toBe("remember me");
    expect(await fs.readFile(path.join(next.localRoot, "image.bin"))).toEqual(bytes);
    expect((await fs.stat(path.join(next.localRoot, "notes", "empty"))).isDirectory()).toBe(true);
    await expect(fs.stat(path.join(next.localRoot, "task-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await db.select().from(agentInstructionRevisions).where(eq(agentInstructionRevisions.agentId, agentId))).toHaveLength(0);
  });

  async function withAgentsGid<T>(gid: number, fn: () => Promise<T>): Promise<T> {
    const previous = process.env.PAPERCLIP_AGENTS_GID;
    process.env.PAPERCLIP_AGENTS_GID = String(gid);
    try { return await fn(); } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_AGENTS_GID;
      else process.env.PAPERCLIP_AGENTS_GID = previous;
    }
  }
  const sharedFiles = ["AGENTS.md", "doctrine/mission.md", "doctrine/nested/policy.md"];
  async function writeShared() {
    for (const relative of sharedFiles) {
      await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(root, relative), relative, { mode: 0o644 });
      await fs.chmod(path.join(root, relative), 0o644);
    }
  }

  it("stages private group-readable instructions and doctrine despite a restrictive umask", async () => {
    const gid = process.getegid!();
    const previousUmask = process.umask();
    await writeShared();
    await fs.writeFile(path.join(root, "doctrine/run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    await fs.chmod(path.join(root, "doctrine/run.sh"), 0o755);
    await fs.mkdir(path.join(root, "empty"), { mode: 0o700 });
    try {
      process.umask(0o077);
      const copy = await withAgentsGid(gid, () => run());
      process.umask(previousUmask);
      const agentRoot = path.dirname(root);
      const directories = ["file-sync", "file-sync/runs", `file-sync/runs/${copy.runId}`];
      for (const relative of directories) {
        const stat = await fs.stat(path.join(agentRoot, relative));
        expect(stat.mode & 0o7777).toBe(0o750);
        expect(stat.gid).toBe(gid);
      }
      const checkTree = async (directory: string) => {
        const stat = await fs.stat(directory);
        expect(stat.mode & 0o7777).toBe(0o2750);
        expect(stat.gid).toBe(gid);
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const filename = path.join(directory, entry.name);
          if (entry.isDirectory()) await checkTree(filename);
          else {
            const file = await fs.stat(filename);
            expect(file.mode & 0o7777).toBe(entry.name === "run.sh" ? 0o750 : 0o640);
            expect(file.gid).toBe(gid);
          }
        }
      };
      await checkTree(copy.localRoot);
    } finally {
      process.umask(previousUmask);
    }
  });

  it.each([0o077, 0o002])("keeps the run private until every writable canonical entry has its final mode and group (umask=%s)", async (umask) => {
    await writeShared();
    const modes = { "private.md": 0o600, "private.sh": 0o700, "world-read.md": 0o604, "writable.md": 0o666 };
    for (const [relative, mode] of Object.entries(modes)) {
      await fs.writeFile(path.join(root, relative), relative);
      await fs.chmod(path.join(root, relative), mode);
    }
    await fs.chmod(path.join(root, "doctrine"), 0o777);
    const expected = { ...Object.fromEntries(sharedFiles.map(name => [name, 0o640])), [entryFile]: 0o640,
      "private.md": 0o600, "private.sh": 0o700, "world-read.md": 0o600, "writable.md": 0o640 };
    // Explicitly avoid depending on the host umask for the configured entry.
    await fs.chmod(path.join(root, entryFile), 0o644);
    const chmod = fs.chmod.bind(fs);
    const previousUmask = process.umask();
    let published = false;
    const publishing = vi.spyOn(fs, "chmod").mockImplementation(async (filename, mode) => {
      const name = String(filename);
      const runDir = name.split(`${path.sep}live`)[0]!;
      if (name.includes(`${path.sep}live`)) {
        expect((await fs.stat(runDir)).mode & 0o077).toBe(0);
      } else if (path.basename(path.dirname(name)) === "runs" && mode === 0o750) {
        expect((await fs.stat(name)).mode & 0o077).toBe(0);
        const check = async (directory: string) => {
          const stat = await fs.stat(directory);
          expect(stat.mode & 0o022).toBe(0);
          expect(stat.gid).toBe(process.getegid!());
          for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await check(file);
            else {
              const stat = await fs.stat(file);
              expect(stat.mode & 0o7777).toBe(expected[path.relative(path.join(name, "live"), file) as keyof typeof expected]);
              expect(stat.gid).toBe(process.getegid!());
            }
          }
        };
        await check(path.join(name, "live"));
        published = true;
      }
      return chmod(filename, mode);
    });
    try {
      process.umask(umask);
      const copy = await withAgentsGid(process.getegid!(), () => run());
      expect(published).toBe(true);
      expect(copy.receipt?.stagedGid).toBe(process.getegid!());
    } finally {
      publishing.mockRestore();
      process.umask(previousUmask);
    }
  });

  it.each([true, false])("protects staged files and controller metadata under umask 002 (shared=%s)", async (shared) => {
    const previousUmask = process.umask(0o002);
    try {
      await writeShared();
      await fs.mkdir(path.join(root, "permissive"));
      expect((await fs.stat(path.join(root, "permissive"))).mode & 0o777).toBe(0o775);
      await fs.writeFile(path.join(root, "permissive/public.md"), "public");
      await fs.writeFile(path.join(root, "private.md"), "private", { mode: 0o600 });
      await fs.writeFile(path.join(root, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
      const copy = await withAgentsGid(shared ? process.getegid!() : -1, () => run({ warm: true }));
      const check = async (directory: string) => {
        const stat = await fs.stat(directory);
        expect(stat.mode & 0o027).toBe(0);
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const filename = path.join(directory, entry.name);
          if (entry.isDirectory()) await check(filename);
          else expect((await fs.stat(filename)).mode & 0o7027).toBe(0);
        }
      };
      await check(copy.localRoot);
      expect((await fs.stat(path.join(copy.localRoot, "permissive"))).mode & 0o7777).toBe(shared ? 0o2750 : 0o700);
      expect((await fs.stat(path.join(copy.localRoot, "private.md"))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.join(copy.localRoot, "run.sh"))).mode & 0o777).toBe(shared ? 0o750 : 0o700);
      await fs.writeFile(path.join(copy.localRoot, entryFile), `${initial}checkpoint`);
      expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.state).toBe("warm_saved");
      const sync = path.join(path.dirname(root), "file-sync");
      const manifest = path.join(sync, "canonical-manifest.json");
      const owner = path.join(path.dirname(copy.localRoot), "owner.json");
      for (const filename of [manifest, owner]) expect((await fs.stat(filename)).mode & 0o7777).toBe(0o600);
      for (const directory of [sync, path.join(sync, "runs"), path.dirname(copy.localRoot)]) {
        expect((await fs.stat(directory)).mode & 0o2022).toBe(0);
      }
      // Refresh and handoff also replace old permissive metadata privately.
      await fs.writeFile(manifest, JSON.stringify({ version: 1, entries: [] }));
      await fs.chmod(manifest, 0o664);
      await fs.chmod(owner, 0o664);
      await run({ warm: true, reuseRunId: copy.runId });
      for (const filename of [manifest, owner]) expect((await fs.stat(filename)).mode & 0o7777).toBe(0o600);
      expect(JSON.parse(await fs.readFile(manifest, "utf8")).entries.length).toBeGreaterThan(0);
    } finally {
      process.umask(previousUmask);
    }
  });

  it.skipIf(process.getuid?.() !== 0)("denies non-owner agents-group create, replace and unlink under live and metadata paths (needs root)", async () => {
    const previousUmask = process.umask(0o002);
    try {
      await writeShared();
      await fs.chmod(path.join(root, "doctrine"), 0o775);
      const gid = process.getegid!();
      const copy = await withAgentsGid(gid, () => run({ warm: true }));
      await fs.writeFile(path.join(copy.localRoot, entryFile), `${initial}checkpoint`);
      expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.state).toBe("warm_saved");
      for (let dir = path.dirname(root); dir !== path.dirname(dir) && (dir === home || dir.startsWith(`${home}${path.sep}`)); dir = path.dirname(dir)) {
        await fs.chmod(dir, 0o750);
        await fs.chown(dir, 0, gid);
      }
      const targets = [path.join(copy.localRoot, "AGENTS.md"), path.join(copy.localRoot, "doctrine/mission.md"),
        path.join(path.dirname(copy.localRoot), "owner.json"), path.join(path.dirname(root), "file-sync/canonical-manifest.json")];
      const { stdout } = await execFile(process.execPath, ["-e", `
        const fs = require("node:fs");
        const os = require("node:os");
        const path = require("node:path");
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agent-peer-denials-"));
        const attempt = (fn) => { try { fn(); return null; } catch (error) { return error.code; } };
        try {
          console.log(JSON.stringify(process.argv.slice(1).map(target => {
            const replacement = path.join(scratch, "replacement");
            fs.writeFileSync(replacement, "replacement");
            return {
              target,
              write: attempt(() => fs.writeFileSync(target, "injected")),
              create: attempt(() => fs.writeFileSync(path.join(path.dirname(target), "peer-new"), "injected")),
              replace: attempt(() => fs.renameSync(replacement, target)),
              unlink: attempt(() => fs.unlinkSync(target)),
            };
          })));
        } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
      `, ...targets], { uid: 65534, gid });
      for (const result of JSON.parse(stdout)) {
        for (const operation of ["write", "create", "replace", "unlink"]) {
          expect(["EACCES", "EPERM"], `${result.target}: ${operation}`).toContain(result[operation]);
        }
      }
    } finally {
      process.umask(previousUmask);
    }
  });

  it.skipIf(process.getuid?.() !== 0)("lets a non-owner agents-group member read live/AGENTS.md and live/doctrine/* (needs root to switch uid)", async () => {
    const gid = process.getegid!();
    await writeShared();
    const copy = await withAgentsGid(gid, () => run());
    // Only the disposable home fixture is opened for traversal; production
    // ancestors remain the runtime's responsibility, outside the per-run tree.
    for (let dir = path.dirname(root); dir !== path.dirname(dir) && (dir === home || dir.startsWith(`${home}${path.sep}`)); dir = path.dirname(dir)) {
      await fs.chmod(dir, 0o750);
      await fs.chown(dir, 0, gid);
    }
    const { stdout } = await execFile(process.execPath, ["-e", `
      const fs = require("node:fs");
      const path = require("node:path");
      const root = process.argv[1];
      if (process.getuid() === fs.statSync(root).uid) process.exit(1);
      console.log(JSON.stringify(process.argv.slice(2).map(file => fs.readFileSync(path.join(root, file), "utf8"))));
    `, copy.localRoot, ...sharedFiles], { uid: 65534, gid });
    expect(JSON.parse(stdout)).toEqual(sharedFiles);
  });

  it.skipIf(process.getuid?.() === 0)("keeps the owner-only layout when the agents group cannot be assigned", async () => {
    let gid = 54_321;
    while (gid === process.getegid!() || process.getgroups!().includes(gid)) gid++;
    await writeShared();
    await fs.writeFile(path.join(root, "doctrine/run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    const copy = await withAgentsGid(gid, () => run());
    const agentRoot = path.dirname(root);
    for (const relative of ["file-sync/runs", `file-sync/runs/${copy.runId}`]) {
      const stat = await fs.stat(path.join(agentRoot, relative));
      expect(stat.mode & 0o077).toBe(0);
      expect(stat.gid).not.toBe(gid);
    }
    for (const [relative, mode] of [...sharedFiles.map(file => [file, 0o600] as const), ["doctrine/run.sh", 0o700] as const]) {
      const stat = await fs.stat(path.join(copy.localRoot, relative));
      expect(stat.mode & 0o7777).toBe(mode);
      expect(stat.gid).not.toBe(gid);
    }
  });

  it.each([false, true])("writes edited files back with their canonical modes unless the run changed the mode (warm=%s)", async (warm) => {
    const canonical = { "scripts/run.sh": 0o755, "scripts/private.sh": 0o700, "notes/private.md": 0o600, "notes/plain.md": 0o644, "notes/mode.md": 0o644 };
    for (const [relative, mode] of Object.entries(canonical)) {
      await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await fs.writeFile(path.join(root, relative), "before", { mode });
      await fs.chmod(path.join(root, relative), mode);
    }
    const gids = [...new Set([process.getegid!(), ...process.getgroups!()])];
    const originalGroups = new Map<string, number>();
    for (const [index, relative] of Object.keys(canonical).entries()) {
      await fs.chown(path.join(root, relative), -1, gids[index % gids.length]!);
      originalGroups.set(relative, (await fs.stat(path.join(root, relative))).gid);
    }
    const copy = await withAgentsGid(process.getegid!(), () => run({ warm }));
    expect(copy.receipt?.stagedGid).toBe(process.getegid!());
    expect((await fs.stat(path.join(copy.localRoot, "scripts/run.sh"))).mode & 0o7777).toBe(0o750);
    expect((await fs.stat(path.join(copy.localRoot, "notes/private.md"))).mode & 0o7777).toBe(0o600);
    expect((await fs.stat(path.join(copy.localRoot, "scripts/private.sh"))).mode & 0o7777).toBe(0o700);
    for (const relative of Object.keys(canonical)) await fs.writeFile(path.join(copy.localRoot, relative), `after ${relative}`);
    await fs.chmod(path.join(copy.localRoot, "notes/mode.md"), 0o600);
    const saved = await copies[warm ? "checkpointWarm" : "collectStopped"]({ companyId, runId: copy.runId });
    expect(saved?.state).toBe(warm ? "warm_saved" : "saved");
    const expected = { ...canonical, "notes/mode.md": 0o600 };
    for (const [relative, mode] of Object.entries(expected)) {
      expect(await fs.readFile(path.join(root, relative), "utf8")).toBe(`after ${relative}`);
      expect((await fs.stat(path.join(root, relative))).mode & 0o7777).toBe(mode);
      expect((await fs.stat(path.join(root, relative))).gid).toBe(originalGroups.get(relative));
    }
    if (warm) expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("unchanged");
  });

  it.each([false, true])("maps legacy group-staged modes back to canonical owner-only modes (warm=%s)", async (warm) => {
    const canonical = { "notes/private.md": 0o600, "scripts/private.sh": 0o700, "notes/plain.md": 0o644, "scripts/run.sh": 0o755 };
    for (const [relative, mode] of Object.entries(canonical)) {
      await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await fs.writeFile(path.join(root, relative), "before");
      await fs.chmod(path.join(root, relative), mode);
    }
    const copy = await withAgentsGid(process.getegid!(), () => run({ warm }));
    expect(copy.receipt?.stagedGid).toBe(process.getegid!());
    const { stagedModeVersion: _version, ...legacyReceipt } = copy.receipt!;
    await db.update(agentInstructionWorkingCopies).set({ receipt: legacyReceipt }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    const legacy = { "notes/private.md": 0o640, "scripts/private.sh": 0o750, "notes/plain.md": 0o640, "scripts/run.sh": 0o750 };
    for (const [relative, mode] of Object.entries(legacy)) {
      await fs.writeFile(path.join(copy.localRoot, relative), `after ${relative}`);
      await fs.chmod(path.join(copy.localRoot, relative), mode);
    }
    const saved = await copies[warm ? "checkpointWarm" : "collectStopped"]({ companyId, runId: copy.runId });
    expect(saved?.state).toBe(warm ? "warm_saved" : "saved");
    for (const [relative, mode] of Object.entries(canonical)) {
      expect(await fs.readFile(path.join(root, relative), "utf8")).toBe(`after ${relative}`);
      expect((await fs.stat(path.join(root, relative))).mode & 0o7777).toBe(mode);
    }
  });

  it.skipIf(process.getuid?.() === 0)("saves the run's own mode changes for an owner-only copy", async () => {
    let gid = 54_321;
    while (gid === process.getegid!() || process.getgroups!().includes(gid)) gid++;
    const canonical = { "scripts/run.sh": 0o755, "notes/x.md": 0o644, "notes/plain.md": 0o644 };
    for (const [relative, mode] of Object.entries(canonical)) {
      await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await fs.writeFile(path.join(root, relative), "before");
      await fs.chmod(path.join(root, relative), mode);
    }
    const copy = await withAgentsGid(gid, () => run());
    expect(copy.receipt?.stagedGid).toBeUndefined();
    for (const relative of Object.keys(canonical)) await fs.writeFile(path.join(copy.localRoot, relative), `after ${relative}`);
    await fs.chmod(path.join(copy.localRoot, "scripts/run.sh"), 0o750);
    await fs.chmod(path.join(copy.localRoot, "notes/x.md"), 0o640);
    expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("saved");
    for (const [relative, mode] of Object.entries({ "scripts/run.sh": 0o750, "notes/x.md": 0o640, "notes/plain.md": 0o644 })) {
      expect(await fs.readFile(path.join(root, relative), "utf8")).toBe(`after ${relative}`);
      expect((await fs.stat(path.join(root, relative))).mode & 0o7777).toBe(mode);
    }
  });

  it.skipIf(process.getuid?.() === 0)("saves the run's own mode changes for a legacy unversioned private copy", async () => {
    let gid = 54_321;
    while (gid === process.getegid!() || process.getgroups!().includes(gid)) gid++;
    await fs.mkdir(path.join(root, "notes"), { recursive: true });
    await fs.writeFile(path.join(root, "notes/shared.md"), "before");
    await fs.chmod(path.join(root, "notes/shared.md"), 0o664);
    const copy = await withAgentsGid(gid, () => run());
    expect(copy.receipt?.stagedGid).toBeUndefined();
    const { stagedModeVersion: _version, ...legacyReceipt } = copy.receipt!;
    await db.update(agentInstructionWorkingCopies).set({ receipt: legacyReceipt }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    await fs.writeFile(path.join(copy.localRoot, "notes/shared.md"), "after");
    await fs.chmod(path.join(copy.localRoot, "notes/shared.md"), 0o644);
    expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("saved");
    expect(await fs.readFile(path.join(root, "notes/shared.md"), "utf8")).toBe("after");
    expect((await fs.stat(path.join(root, "notes/shared.md"))).mode & 0o7777).toBe(0o644);
  });

  it("does not fail prepare when a directory occupies the manifest cache path", async () => {
    await writeShared();
    const manifest = path.join(path.dirname(root), "file-sync", "canonical-manifest.json");
    await fs.mkdir(manifest, { recursive: true });
    const copy = await run();
    expect(await fs.readFile(path.join(copy.localRoot, entryFile), "utf8")).toBe(initial);
    expect((await fs.lstat(manifest)).isDirectory()).toBe(true);
  });

  it.each(["EPERM", "EACCES"])("falls back to an owner-only copy when the live tree cannot be shared (%s)", async (code) => {
    await writeShared();
    await fs.writeFile(path.join(root, "notes.md"), "before");
    await fs.chmod(path.join(root, "notes.md"), 0o644);
    const chmod = fs.chmod.bind(fs);
    const denied = vi.spyOn(fs, "chmod").mockImplementation(async (filename, mode) => {
      if (String(filename).endsWith(`${path.sep}doctrine`) && mode === 0o2750) throw Object.assign(new Error("denied"), { code });
      return chmod(filename, mode);
    });
    let copy;
    try { copy = await withAgentsGid(process.getegid!(), () => run()); } finally { denied.mockRestore(); }
    expect(copy.receipt?.stagedGid).toBeUndefined();
    expect((await fs.stat(path.join(path.dirname(root), "file-sync/runs", copy.runId))).mode & 0o7777).toBe(0o700);
    for (const relative of sharedFiles) expect((await fs.stat(path.join(copy.localRoot, relative))).mode & 0o7777).toBe(0o600);
    expect((await fs.stat(path.join(copy.localRoot, "notes.md"))).mode & 0o7777).toBe(0o600);
    await fs.writeFile(path.join(copy.localRoot, "notes.md"), "after");
    await fs.chmod(path.join(copy.localRoot, "notes.md"), 0o640);
    expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("saved");
    expect(await fs.readFile(path.join(root, "notes.md"), "utf8")).toBe("after");
    expect((await fs.stat(path.join(root, "notes.md"))).mode & 0o7777).toBe(0o640);
  });

  it("does not change external targets of symlinks encountered while staging permissions", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "agent-copy-outside-"));
    const filename = path.join(outside, "private.md");
    await fs.writeFile(filename, "outside", { mode: 0o600 });
    const beforeDirectory = await fs.stat(outside);
    const beforeFile = await fs.stat(filename);
    const cp = fs.cp.bind(fs);
    const copyWithLinks = vi.spyOn(fs, "cp").mockImplementationOnce(async (...args: Parameters<typeof fs.cp>) => {
      await cp(...args);
      // Inject links after canonical validation, at the permission pass boundary.
      await fs.symlink(outside, path.join(String(args[1]), "external-directory"));
      await fs.symlink(filename, path.join(String(args[1]), "external-file"));
    });
    try {
      const copy = await run();
      expect((await fs.lstat(path.join(copy.localRoot, "external-directory"))).isSymbolicLink()).toBe(true);
      expect((await fs.lstat(path.join(copy.localRoot, "external-file"))).isSymbolicLink()).toBe(true);
      const afterDirectory = await fs.stat(outside);
      const afterFile = await fs.stat(filename);
      expect(afterDirectory.mode).toBe(beforeDirectory.mode);
      expect(afterDirectory.gid).toBe(beforeDirectory.gid);
      expect(afterFile.mode).toBe(beforeFile.mode);
      expect(afterFile.gid).toBe(beforeFile.gid);
      expect(await fs.readFile(filename, "utf8")).toBe("outside");
    } finally {
      copyWithLinks.mockRestore();
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  async function sparseFile(filename: string, size: number) {
    const handle = await fs.open(filename, "w");
    try { await handle.truncate(size); } finally { await handle.close(); }
  }

  it("saves and restores files beyond the former file and folder limits, with streaming inspection and download", async () => {
    const first = await run();
    const size = 66 * 1024 * 1024;
    await sparseFile(path.join(first.localRoot, "large.bin"), size);
    expect((await copies.collectStopped({ companyId, runId: first.runId }))?.state).toBe("saved");
    await copies.release(companyId, first.runId);
    const next = await run();
    const restored = await inspectAgentFile(next.localRoot, "large.bin");
    expect(restored).toMatchObject({ size, bytes: null });
    const store = agentFileStore(db);
    const download = (await store.download(companyId, agentId, "large.bin", board()))!;
    expect(download.size).toBe(size);
    // The lock is released before consuming the stream. An editor replacement
    // must not change the already opened download's bytes.
    await store.write({ ...target(), path: "large.bin", bytes: Buffer.from("replacement"), baseHash: restored!.hash }, board());
    const hash = createHash("sha256");
    let downloaded = 0;
    for await (const chunk of download.stream) { downloaded += chunk.length; hash.update(chunk); }
    expect(downloaded).toBe(size);
    expect(hash.digest("hex")).toBe(restored!.hash);
    expect(await fs.readFile(path.join(root, "large.bin"), "utf8")).toBe("replacement");
    await store.write({ ...target(), path: "empty.bin", bytes: Buffer.alloc(0), baseHash: null }, board());
    const empty = (await store.download(companyId, agentId, "empty.bin", board()))!;
    expect(empty.size).toBe(0);
    for await (const _chunk of empty.stream) throw new Error("Empty download must have no chunks");
  }, 30_000);

  it("accepts the exact 256 MiB file boundary without retaining a text buffer", async () => {
    expect(MAX_AGENT_FILE_BYTES).toBe(256 * 1024 * 1024);
    await sparseFile(path.join(root, "boundary.bin"), MAX_AGENT_FILE_BYTES);
    expect(await inspectAgentFile(root, "boundary.bin")).toMatchObject({ size: MAX_AGENT_FILE_BYTES, bytes: null });
  });

  it("checks quota for a small editor save without reading unrelated file bytes", async () => {
    const asset = path.join(root, "large.bin");
    await sparseFile(asset, MAX_AGENT_FILE_BYTES);
    const open = vi.spyOn(fs, "open");
    try {
      await agentFileStore(db).write({ ...target(), path: "note.txt", bytes: Buffer.from("small edit"), baseHash: null }, board());
      expect(open.mock.calls.some(([filename]) => filename === asset)).toBe(false);
      expect(await fs.readFile(path.join(root, "note.txt"), "utf8")).toBe("small edit");
    } finally { open.mockRestore(); }
  });

  it("reports an oversized run file without a partial save and removes its temporary copy", async () => {
    const copy = await run();
    await sparseFile(path.join(copy.localRoot, "too-large.bin"), MAX_AGENT_FILE_BYTES + 1);
    await fs.writeFile(path.join(copy.localRoot, entryFile), "changed instructions");
    const failed = await copies.collectStopped({ companyId, runId: copy.runId });
    expect(failed).toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_LIMIT_EXCEEDED", candidateHash: null, nextAttemptAt: null, attempts: 1 });
    expect(failed?.receipt?.storageWarning).toContain("Runs can continue");
    expect(failed?.errorMessage).toContain('"too-large.bin" exceeds the 256 MiB');
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(initial);
    await expect(fs.stat(path.join(root, "too-large.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await copies.reportUnavailable(companyId, copy.runId))?.errorCode).toBe("AGENT_FILES_LIMIT_EXCEEDED");
    await copies.release(companyId, copy.runId);
    await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await copies.get(companyId, copy.runId))?.receipt?.baseline).toBeUndefined();
    const next = await run();
    expect(await fs.readFile(path.join(next.localRoot, entryFile), "utf8")).toBe(initial);
    await fs.writeFile(path.join(next.localRoot, "next-task.txt"), "still working");
    expect((await copies.collectStopped({ companyId, runId: next.runId }))?.state).toBe("saved");
    expect(await fs.readFile(path.join(root, "next-task.txt"), "utf8")).toBe("still working");
  });

  it.each([false, true])("warns on each run at the file limit and clears the warning after ordinary agent cleanup (warm=%s)", async (warm) => {
    await sparseFile(path.join(root, "full.bin"), MAX_AGENT_FILE_BYTES);
    const first = await run({ warm });
    expect(first.receipt?.storageWarning).toContain("256 MiB");
    expect(instructionWorkingCopyGuidance(first)).toContain("Runs can continue");
    const unchanged = await copies[warm ? "checkpointWarm" : "collectStopped"]({ companyId, runId: first.runId });
    expect(unchanged).toMatchObject({ state: warm ? "warm_saved" : "unchanged", errorCode: null });
    if (warm) expect(unchanged?.receipt?.checkpointState).toBe("unchanged");
    expect(unchanged?.receipt?.storageWarning).toContain("Agent storage is full");
    copies = agentInstructionWorkingCopyService(db);
    const second = await run({ warm, ...(warm ? { reuseRunId: first.runId } : {}) });
    if (warm) expect(second.localRoot).toBe(first.localRoot);
    expect(second.receipt?.storageWarning).toContain("Agent storage is full");
    await fs.unlink(path.join(second.localRoot, "full.bin"));
    await fs.writeFile(path.join(second.localRoot, "task-output.txt"), "work continues");
    expect(await copies.collectStopped({ companyId, runId: second.runId })).toMatchObject({ state: "saved", receipt: { storageWarning: null } });
    const next = await run();
    expect(next.receipt?.storageWarning).toBeNull();
    expect(await fs.readFile(path.join(next.localRoot, "task-output.txt"), "utf8")).toBe("work continues");
  }, 30_000);

  it("starts successive runs with an already oversized saved file and lets the agent remove it", async () => {
    await sparseFile(path.join(root, "old-large.bin"), MAX_AGENT_FILE_BYTES + 1);
    const first = await run();
    expect(first.state).toBe("prepared");
    expect(first.receipt?.storageWarning).toContain("256 MiB");
    expect(await fs.readFile(path.join(first.localRoot, entryFile), "utf8")).toBe(initial);
    const stopped = await copies.collectStopped({ companyId, runId: first.runId });
    expect(stopped).toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_LIMIT_EXCEEDED" });
    await expect(fs.stat(first.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    copies = agentInstructionWorkingCopyService(db);
    const cleanup = await run();
    expect(cleanup.state).toBe("prepared");
    await fs.unlink(path.join(cleanup.localRoot, "old-large.bin"));
    expect(await copies.collectStopped({ companyId, runId: cleanup.runId })).toMatchObject({ state: "saved", receipt: { storageWarning: null } });
    expect((await run()).receipt?.storageWarning).toBeNull();
  }, 30_000);

  it("starts when the existing folder exceeds its total quota and accepts agent cleanup", async () => {
    for (let index = 0; index < 8; index++) await fs.writeFile(path.join(root, `quota-part-${index}.bin`), "fixture");
    const lstat = fs.lstat.bind(fs);
    // Keep this regression small on disk while exercising the real filesystem,
    // snapshots, database receipts, restore, and merge with 2 GiB of metadata.
    const sizes = vi.spyOn(fs, "lstat").mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await lstat(...args);
      if (path.basename(String(args[0])).startsWith("quota-part-")) Object.assign(stat, { size: MAX_AGENT_FILE_BYTES });
      return stat;
    });
    try {
      const first = await run();
      expect(first.receipt?.storageWarning).toContain("2 GiB");
      expect((await copies.collectStopped({ companyId, runId: first.runId }))?.errorCode).toBe("AGENT_FILES_LIMIT_EXCEEDED");
      const cleanup = await run();
      for (let index = 0; index < 8; index++) await fs.unlink(path.join(cleanup.localRoot, `quota-part-${index}.bin`));
      await fs.writeFile(path.join(cleanup.localRoot, "small.txt"), "recovered");
      expect(await copies.collectStopped({ companyId, runId: cleanup.runId })).toMatchObject({ state: "saved", receipt: { storageWarning: null } });
      expect((await run()).receipt?.storageWarning).toBeNull();
    } finally { sizes.mockRestore(); }
  });

  it("rejects more than 2 GiB in aggregate before hashing or saving any file", async () => {
    expect(MAX_AGENT_DIRECTORY_BYTES).toBe(2 * 1024 * 1024 * 1024);
    const copy = await run();
    for (let index = 0; index < 8; index++) await sparseFile(path.join(copy.localRoot, `part-${index}.bin`), MAX_AGENT_FILE_BYTES);
    // The eight allowed files exactly fill the quota; the entry is additional.
    const result = await copies.collectStopped({ companyId, runId: copy.runId });
    expect(result).toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_LIMIT_EXCEEDED" });
    expect(result?.errorMessage).toContain("2 GiB total storage limit");
    expect(await fs.readdir(root)).toEqual(["policy"]);
  });

  it("rejects excessive entry count before snapshotting", async () => {
    const directory = path.join(home, "many-entries");
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "empty"), "");
    const entries = await fs.readdir(directory, { withFileTypes: true });
    // Exercise the walker bound without creating 100,001 physical files.
    const readdir = vi.spyOn(fs, "readdir").mockResolvedValue(Array(MAX_AGENT_DIRECTORY_ENTRIES + 1).fill(entries[0]));
    try {
      await expect(snapshotAgentFiles(directory)).rejects.toMatchObject({ status: 422, message: expect.stringContaining("100,000-entry limit") });
    } finally { readdir.mockRestore(); }
  }, 30_000);

  it("keeps the entry's 1 MiB limit and cleans up failed synchronization", async () => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, entryFile), "a".repeat(1024 * 1024 + 1));
    const result = await copies.collectStopped({ companyId, runId: copy.runId });
    expect(result?.state).toBe("unavailable");
    await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result?.errorMessage).toContain("at most 1 MiB");
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(initial);
  });

  it("merges independent changes and uses the last synchronization for same-file edits", async () => {
    const a = await run(), b = await run();
    await fs.writeFile(path.join(a.localRoot, "a.txt"), "A");
    await fs.writeFile(path.join(b.localRoot, "b.txt"), "B");
    await Promise.all([a, b].map(copy => copies.collectStopped({ companyId, runId: copy.runId })));
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("A");
    expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("B");
    const c = await run(), d = await run();
    await fs.writeFile(path.join(c.localRoot, "a.txt"), "C");
    await fs.writeFile(path.join(d.localRoot, "a.txt"), "D");
    await fs.writeFile(path.join(c.localRoot, "b.txt"), "new B");
    expect((await copies.collectStopped({ companyId, runId: c.runId }))?.state).toBe("saved");
    expect((await copies.collectStopped({ companyId, runId: d.runId }))?.state).toBe("saved");
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("D");
    expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("new B");
    expect(await copies.list(companyId, agentId, board())).toEqual([]);
    for (const copy of [a, b, c, d]) await expect(fs.stat(path.dirname(copy.localRoot))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(path.join(path.dirname(root), "file-sync", "runs"))).toEqual([]);
  });

  it("makes concurrent edit/delete races last-sync-wins and preserves unrelated new files", async () => {
    await fs.mkdir(path.join(root, "notes"));
    await fs.writeFile(path.join(root, "notes", "old.txt"), "old");
    const deleting = await run(), editing = await run();
    await fs.rm(path.join(deleting.localRoot, "notes"), { recursive: true });
    await fs.writeFile(path.join(editing.localRoot, "notes", "old.txt"), "edited");
    await fs.writeFile(path.join(editing.localRoot, "notes", "new.txt"), "unrelated");
    await copies.collectStopped({ companyId, runId: editing.runId });
    expect((await copies.collectStopped({ companyId, runId: deleting.runId }))?.state).toBe("saved");
    await expect(fs.stat(path.join(root, "notes", "old.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(root, "notes", "new.txt"), "utf8")).toBe("unrelated");
    const remove = await run(), change = await run();
    await fs.unlink(path.join(remove.localRoot, "notes", "new.txt"));
    await fs.writeFile(path.join(change.localRoot, "notes", "new.txt"), "restored by later edit");
    await copies.collectStopped({ companyId, runId: remove.runId });
    await copies.collectStopped({ companyId, runId: change.runId });
    expect(await fs.readFile(path.join(root, "notes", "new.txt"), "utf8")).toBe("restored by later edit");
  });

  it("handles a concurrently replaced parent and keeps the later file change", async () => {
    await fs.mkdir(path.join(root, "notes"));
    await fs.writeFile(path.join(root, "notes", "fact.txt"), "old");
    const replacing = await run(), editing = await run();
    await fs.rm(path.join(replacing.localRoot, "notes"), { recursive: true });
    await fs.writeFile(path.join(replacing.localRoot, "notes"), "now a file");
    await fs.writeFile(path.join(editing.localRoot, "notes", "fact.txt"), "new fact");
    await copies.collectStopped({ companyId, runId: replacing.runId });
    expect(await fs.readFile(path.join(root, "notes"), "utf8")).toBe("now a file");
    expect((await copies.collectStopped({ companyId, runId: editing.runId }))?.state).toBe("saved");
    expect(await fs.readFile(path.join(root, "notes", "fact.txt"), "utf8")).toBe("new fact");
  });

  it("cleans stopped copies after a crash during cleanup without touching active copies", async () => {
    const finished = await run(), active = await run();
    await db.update(agentInstructionWorkingCopies).set({ state: "saved", processStoppedAt: new Date() }).where(eq(agentInstructionWorkingCopies.runId, finished.runId));
    copies = agentInstructionWorkingCopyService(db);
    await copies.recoverCaptured();
    await expect(fs.stat(finished.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(active.localRoot)).isDirectory()).toBe(true);
  });

  it("cleans up a staging failure before any provider starts", async () => {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    const shell = vi.spyOn(executionTargetTools, "runAdapterExecutionTargetShellCommand").mockResolvedValue({ exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "fixture failure" });
    try {
      await expect(copies.prepare({ ...target(), runId, cwd: home, target: { kind: "remote", transport: "ssh", environmentId: randomUUID(), remoteCwd: "/fixture/task",
        spec: { host: "unused.invalid", port: 22, username: "test", remoteCwd: "/fixture/task" } } })).rejects.toThrow("Could not exclude");
      const row = (await copies.get(companyId, runId))!;
      expect(row.state).toBe("unavailable");
      expect(row.receipt?.baseline).toBeUndefined();
      await expect(fs.stat(path.dirname(row.localRoot))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { shell.mockRestore(); }
  });

  it.each(["succeeded", "failed", "cancelled", "timed_out", "interrupted"])("registers staging ownership before copying and cleans preparation for a %s run after restart", async (status) => {
    const original = fs.cp.bind(fs);
    const copy = vi.spyOn(fs, "cp").mockImplementationOnce(async (source, destination, options) => {
      const rows = await db.select().from(agentInstructionWorkingCopies).where(eq(agentInstructionWorkingCopies.agentId, agentId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "preparing", localRoot: destination });
      return original(source, destination, options);
    });
    const interrupted = await run();
    copy.mockRestore();
    const active = await run();
    for (const row of [interrupted, active]) {
      await db.update(agentInstructionWorkingCopies).set({ state: "preparing", baseHash: "preparing", receipt: { schema: "paperclip.agent-files.v1" } }).where(eq(agentInstructionWorkingCopies.runId, row.runId));
    }
    await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, interrupted.runId));
    copies = agentInstructionWorkingCopyService(db);
    await copies.recoverStopped();
    expect((await copies.get(companyId, interrupted.runId))?.state).toBe("unavailable");
    await expect(fs.stat(path.dirname(interrupted.localRoot))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.stat(active.localRoot)).isDirectory()).toBe(true);
  });

  it("retains remote cleanup across restart and failed retries until the original lease is cleaned", async () => {
    const copy = await run();
    const environmentId = randomUUID(), leaseId = randomUUID(), remoteCwd = "/fixture/task";
    const executionRoot = path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", agentId, copy.runId);
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: copy.runId, provider: "daytona", providerLeaseId: "original-sandbox" });
    await db.update(agentInstructionWorkingCopies).set({ state: "saved", processStoppedAt: new Date(), location: `remote:${environmentId}`, executionRoot,
      receipt: { ...copy.receipt, cleanup: { leaseId, remoteCwd } } }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    copies = agentInstructionWorkingCopyService(db);
    await copies.recoverCaptured();
    const pending = (await copies.get(companyId, copy.runId))!;
    expect(pending.receipt).toMatchObject({ cleanupPending: true, cleanup: { leaseId, remoteCwd } });
    expect(pending.receipt?.baseline).toBeUndefined();
    await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const execute = vi.fn().mockRejectedValueOnce(new Error("provider temporarily unavailable")).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    copies = agentInstructionWorkingCopyService(db, { environmentRuntime: { execute } as unknown as EnvironmentRuntimeService });
    for (const expectedPending of [true, false]) {
      await db.update(agentInstructionWorkingCopies).set({ nextAttemptAt: null }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
      await copies.recoverCaptured();
      expect((await copies.get(companyId, copy.runId))?.receipt?.cleanupPending).toBe(expectedPending);
    }
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ lease: expect.objectContaining({ id: leaseId, providerLeaseId: "original-sandbox" }),
      command: "rm", args: ["-rf", "--", executionRoot], bypassSession: true }));
    await copies.recoverCaptured();
    expect(execute).toHaveBeenCalledTimes(2);
    await copies.release(companyId, copy.runId);
    expect((await copies.get(companyId, copy.runId))?.receipt?.cleanupPending).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("finishes remote cleanup from a destruction receipt after the environment is deleted", async () => {
    const copy = await run();
    const environmentId = randomUUID(), leaseId = randomUUID(), remoteCwd = "/fixture/task";
    const lease = { id: leaseId, companyId, environmentId, heartbeatRunId: copy.runId, provider: "daytona", providerLeaseId: "destroyed-sandbox" };
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    await db.insert(environmentLeases).values({ ...lease, status: "released", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }) } });
    await db.update(agentInstructionWorkingCopies).set({ state: "saved", processStoppedAt: new Date(), location: `remote:${environmentId}`,
      executionRoot: path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", agentId, copy.runId),
      receipt: { ...copy.receipt, cleanupPending: true, cleanup: { leaseId, remoteCwd } } }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    await db.delete(environments).where(eq(environments.id, environmentId));
    copies = agentInstructionWorkingCopyService(db);
    await copies.recoverCaptured();
    expect((await copies.get(companyId, copy.runId))?.receipt?.cleanupPending).toBe(false);
    await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("rejects symlinks without saving any part of the tree, preserving an existing full-storage warning: %s", async (full) => {
    if (full) await sparseFile(path.join(root, "full.bin"), MAX_AGENT_FILE_BYTES);
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, "innocent.txt"), "changed");
    await fs.symlink(path.join(home, "outside"), path.join(copy.localRoot, "escape"));
    const result = await copies.collectStopped({ companyId, runId: copy.runId });
    expect(result?.state).toBe("unavailable");
    expect(result?.errorCode).toBe("AGENT_FILES_SAVE_FAILED");
    expect(result?.receipt?.storageWarning).toBe(copy.receipt?.storageWarning);
    if (full) expect(result?.receipt?.storageWarning).toContain("Agent storage is full");
    await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(root, "innocent.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("adopts the last deployed head once and bridges an old collector without appending history", async () => {
    const id = randomUUID();
    const content = "last deployed revision";
    await db.insert(agentInstructionRevisions).values({ id, ...target(), entryFile, contentBase64: Buffer.from(content).toString("base64"), contentHash: fileHash(Buffer.from(content)), byteLength: content.length, source: "board" });
    await db.insert(agentInstructionHeads).values({ ...target(), entryFile, revisionId: id });
    const current = await revisions.readCurrent(target(), board());
    expect(current?.content).toBe(content);
    await revisions.commit({ ...target(), entryFile, content: "new directory contents", baseRevisionId: id, source: "cleanup" }, board());
    await revisions.materializeCurrent(target());
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe("new directory contents");
    await expect(revisions.commit({ ...target(), entryFile, content: "stale legacy run", baseRevisionId: id, source: "cleanup" }, board())).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(agentInstructionRevisions).where(eq(agentInstructionRevisions.agentId, agentId))).toHaveLength(1);
  });

  it("ordinary file edits leave the loaded instruction digest unchanged", async () => {
    const make = async () => {
      const copy = await run();
      const context = await buildNativeRuntimeContext({ db, agent: { id: agentId, companyId, name: "Target", adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } },
        runId: copy.runId, runtimeConfig: {}, runtimeSkillEntries: [], instructionWorkingCopy: { rootPath: copy.executionRoot, entryPath: entryFile, kind: "agent_files" } });
      return { copy, context };
    };
    const before = await make();
    await fs.writeFile(path.join(before.copy.localRoot, "notes.txt"), "new personal knowledge");
    await copies.collectStopped({ companyId, runId: before.copy.runId });
    const after = await make();
    expect(after.context.aggregateDigest).toBe(before.context.aggregateDigest);
    expect(after.context.instructions.bundle.fileCount).toBe(1);
  });
  it("checkpoints three managed turns into one live directory, fences old cleanup, and persists after retirement", async () => {
    let copy = await run({ warm: true });
    const original = copy;
    for (let turn = 1; turn <= 3; turn++) {
      await fs.appendFile(path.join(copy.localRoot, "memory.txt"), `turn ${turn}\n`);
      const saved = (await copies.checkpointWarm({ companyId, runId: copy.runId }))!;
      expect(saved.state).toBe("warm_saved");
      expect(saved.processStoppedAt).toBeNull();
      expect(await agentFileStore(db).read(companyId, agentId, "memory.txt", board())).toEqual(Buffer.from(Array.from({ length: turn }, (_, i) => `turn ${i + 1}\n`).join("")));
      await copies.release(companyId, copy.runId);
      expect(await fs.stat(copy.localRoot)).toBeTruthy();
      if (turn < 3) {
        expect(await copies.canReuseWarm(companyId, agentId, copy.runId)).toBe(true);
        copy = await run({ warm: true, reuseRunId: copy.runId });
        expect(copy.executionRoot).toBe(original.executionRoot);
        await copies.collectStopped({ companyId, runId: original.runId });
        await copies.release(companyId, original.runId);
        expect(await fs.stat(copy.localRoot)).toBeTruthy();
      }
    }
    // A child may write after the last turn's checkpoint; session retirement
    // must collect this delta using the current owner, not the first run.
    await fs.writeFile(path.join(copy.localRoot, "late.txt"), "after turn");
    expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("saved");
    await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const fresh = await run();
    expect(await fs.readFile(path.join(fresh.localRoot, "memory.txt"), "utf8")).toBe("turn 1\nturn 2\nturn 3\n");
    expect(await fs.readFile(path.join(fresh.localRoot, "late.txt"), "utf8")).toBe("after turn");
  });

  it("rechecks canonical edits at handoff and releases the writer lock before retirement and fresh restore", async () => {
    const first = await run({ warm: true });
    await copies.checkpointWarm({ companyId, runId: first.runId });
    expect(await copies.canReuseWarm(companyId, agentId, first.runId)).toBe(true);
    await agentFileStore(db).write({ ...target(), path: "editor.txt", bytes: Buffer.from("new canonical content"), baseHash: null }, board());

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    await expect(copies.prepare({ ...target(), runId, cwd: home, warm: true, reuseRunId: first.runId })).rejects.toBeInstanceOf(AgentDirectoryReuseInvalidatedError);
    expect(JSON.parse(await fs.readFile(path.join(path.dirname(first.localRoot), "owner.json"), "utf8")).runId).toBe(first.runId);
    // Both paths need the canonical writer lock. A handoff failure must release
    // it before orchestration stops the old session and restores a fresh copy.
    expect((await copies.collectStopped({ companyId, runId: first.runId }))?.state).toBe("unchanged");
    const next = (await copies.prepare({ ...target(), runId, cwd: home, warm: true }))!;
    expect(next.localRoot).not.toBe(first.localRoot);
    expect(await fs.readFile(path.join(next.localRoot, "editor.txt"), "utf8")).toBe("new canonical content");
  }, 10_000);

  it("attaches the successor collector before fallible post-handoff bookkeeping", async () => {
    const first = await run({ warm: true });
    await copies.checkpointWarm({ companyId, runId: first.runId });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    let collectorRunId = first.runId;
    const handoff = vi.fn((copy: typeof first) => { collectorRunId = copy.runId; });
    const directories = agentDirectoryWorkingCopyService(db, copies.get, async () => { throw new Error("injected post-handoff database failure"); });

    await expect(directories.prepare({ ...target(), runId, cwd: home, warm: true, reuseRunId: first.runId, onWarmHandoff: handoff }))
      .rejects.toThrow("injected post-handoff database failure");
    expect(handoff).toHaveBeenCalledOnce();
    expect(collectorRunId).toBe(runId);
    await fs.writeFile(path.join(first.localRoot, "last-write.txt"), "saved after failed handoff");
    // The stale collector cannot touch the successor; the attached collector
    // still saves and cleans the actual owner after process retirement.
    await copies.collectStopped({ companyId, runId: first.runId });
    expect((await fs.stat(first.localRoot)).isDirectory()).toBe(true);
    expect((await copies.collectStopped({ companyId, runId: collectorRunId }))?.state).toBe("saved");
    expect(await fs.readFile(path.join(root, "last-write.txt"), "utf8")).toBe("saved after failed handoff");
    await expect(fs.stat(first.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);
  it("retires loaded instruction edits while allowing ordinary personal-file edits to stay warm", async () => {
    const copy = await run({ warm: true });
    await fs.writeFile(path.join(copy.localRoot, entryFile), "# New loaded policy\n");
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.state).toBe("warm_saved");
    expect(await copies.canReuseWarm(companyId, agentId, copy.runId)).toBe(false);
    await copies.collectStopped({ companyId, runId: copy.runId });
    const fresh = await run({ warm: true });
    expect(fresh.executionRoot).not.toBe(copy.executionRoot);
    expect(await fs.readFile(path.join(fresh.localRoot, entryFile), "utf8")).toBe("# New loaded policy\n");
  });
  it("refreshes after editor changes and preserves concurrent unrelated files", async () => {
    const copy = await run({ warm: true });
    await fs.writeFile(path.join(copy.localRoot, "mine.txt"), "from run");
    await agentFileStore(db).write({ ...target(), path: "board.txt", bytes: Buffer.from("from board"), baseHash: null }, board());
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.state).toBe("warm_saved");
    expect(await copies.canReuseWarm(companyId, agentId, copy.runId)).toBe(false);
    expect(await fs.readFile(path.join(root, "board.txt"), "utf8")).toBe("from board");
    expect(await fs.readFile(path.join(root, "mine.txt"), "utf8")).toBe("from run");
    await copies.collectStopped({ companyId, runId: copy.runId });
  });
  it("keeps an invalid warm checkpoint unsaved and requests stopped collection", async () => {
    const copy = await run({ warm: true });
    await fs.symlink(root, path.join(copy.localRoot, "escape"));
    const failed = await copies.checkpointWarm({ companyId, runId: copy.runId });
    expect(failed?.state).toBe("prepared");
    expect(failed?.errorCode).toBe("AGENT_FILES_CHECKPOINT_UNSTABLE");
    expect(failed?.processStoppedAt).toBeNull();
    expect(await copies.canReuseWarm(companyId, agentId, copy.runId)).toBe(false);
    await fs.rm(path.join(copy.localRoot, "escape"));
    expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("unchanged");
  });
  it("rejects over-quota warm changes without replacing saved bytes, then permits a clean future run", async () => {
    const copy = await run({ warm: true });
    const handle = await fs.open(path.join(copy.localRoot, "too-large.bin"), "w");
    await handle.truncate(MAX_AGENT_FILE_BYTES + 1); await handle.close();
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.errorCode).toBe("AGENT_FILES_CHECKPOINT_UNSTABLE");
    const stopped = (await copies.collectStopped({ companyId, runId: copy.runId }))!;
    expect(stopped).toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_LIMIT_EXCEEDED" });
    expect(stopped.receipt?.storageWarning).toContain("Agent storage is full");
    expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(initial);
    await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await run({ warm: true })).toBeTruthy();
  });
  it("rechecks authorization even for an unchanged warm checkpoint", async () => {
    const copy = await run({ warm: true });
    await copies.checkpointWarm({ companyId, runId: copy.runId });
    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
    await db.update(companyMemberships).set({ membershipRole: "member" }).where(eq(companyMemberships.companyId, companyId));
    expect((await copies.checkpointWarm({ companyId, runId: copy.runId }))?.errorCode).toBe("AGENT_FILES_CHECKPOINT_UNSTABLE");
    expect(await copies.canReuseWarm(companyId, agentId, copy.runId)).toBe(false);
    expect((await copies.collectStopped({ companyId, runId: copy.runId }))?.state).toBe("unavailable");
  });
  it("reclaims a warm remote owner after verified sandbox destruction without claiming unsaved tail bytes", async () => {
    const copy = await run({ warm: true });
    await fs.writeFile(path.join(copy.localRoot, "saved.txt"), "checkpoint");
    await copies.checkpointWarm({ companyId, runId: copy.runId });
    const environmentId = randomUUID(), leaseId = randomUUID(), remoteCwd = "/fixture/task";
    const lease = { id: leaseId, companyId, environmentId, heartbeatRunId: copy.runId, provider: "daytona", providerLeaseId: "destroyed-warm" };
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    await db.insert(environmentLeases).values({ ...lease, status: "released", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }) } });
    await db.update(heartbeatRuns).set({ status: "succeeded", runtimeMode: "native" }).where(eq(heartbeatRuns.id, copy.runId));
    const saved = (await copies.get(companyId, copy.runId))!;
    await db.update(agentInstructionWorkingCopies).set({ location: `remote:${environmentId}`,
      executionRoot: path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", agentId, copy.runId),
      receipt: { ...saved.receipt, cleanup: { leaseId, remoteCwd } } }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    copies = agentInstructionWorkingCopyService(db);
    await copies.recoverStopped();
    const recovered = (await copies.get(companyId, copy.runId))!;
    expect(recovered).toMatchObject({ state: "unavailable", errorCode: "AGENT_FILES_FINAL_COLLECTION_UNAVAILABLE" });
    expect(recovered.receipt?.cleanupPending).toBe(false);
    expect(await fs.readFile(path.join(root, "saved.txt"), "utf8")).toBe("checkpoint");
    await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("uses the workspace transport to restore after destruction of the remote filesystem", async () => {
    const remoteCwd = path.join(home, "remote-task");
    await fs.mkdir(remoteCwd, { recursive: true });
    await execFile("git", ["init", remoteCwd]);
    const runner: import("@paperclipai/adapter-utils/command-managed-runtime").CommandManagedRuntimeRunner = {
      execute: async input => {
        const startedAt = new Date().toISOString();
        const env = { ...process.env, ...input.env };
        const args = [...(input.args ?? [])];
        if (input.stdin != null && (args[0] === "-c" || args[0] === "-lc")) {
          env.PAPERCLIP_TEST_STDIN = input.stdin;
          args[1] = `printf '%s' "$PAPERCLIP_TEST_STDIN" | (${args[1]})`;
        }
        try {
          const result = await execFile(input.command, args, { cwd: input.cwd, env, timeout: input.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
          return { exitCode: 0, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr, pid: null, startedAt };
        } catch (error) {
          const e = error as { code?: number; signal?: NodeJS.Signals; stdout?: string; stderr?: string };
          return { exitCode: typeof e.code === "number" ? e.code : 1, signal: e.signal ?? null, timedOut: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "", pid: null, startedAt };
        }
      },
    };
    const executionTarget = { kind: "remote" as const, transport: "sandbox" as const, environmentId: randomUUID(), remoteCwd, runner };
    const prepare = async () => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
      return (await copies.prepare({ ...target(), runId, cwd: home, target: executionTarget }))!;
    };
    await fs.mkdir(path.join(root, "build"));
    await fs.writeFile(path.join(root, "build", "personal.txt"), "cache-like names are still agent files");
    const first = await prepare();
    expect(await fs.readFile(path.join(first.executionRoot, "build", "personal.txt"), "utf8")).toBe("cache-like names are still agent files");
    await fs.mkdir(path.join(first.executionRoot, "notes"));
    await fs.writeFile(path.join(first.executionRoot, "notes", "bytes.bin"), Buffer.from([0, 128, 255]));
    await fs.mkdir(path.join(first.executionRoot, "node_modules"));
    await fs.writeFile(path.join(first.executionRoot, "node_modules", "personal.txt"), "retain this too");
    await fs.writeFile(path.join(remoteCwd, "task-only.txt"), "task");
    expect((await execFile("git", ["-C", remoteCwd, "status", "--porcelain", "--untracked-files=all"])).stdout).toBe("?? task-only.txt\n");
    expect((await copies.collectStopped({ companyId, runId: first.runId, target: executionTarget }))?.state).toBe("saved");
    await copies.release(companyId, first.runId);
    expect((await copies.get(companyId, first.runId))?.receipt?.baseline).toBeUndefined();
    await expect(fs.stat(first.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.rm(remoteCwd, { recursive: true });
    await fs.mkdir(remoteCwd);
    copies = agentInstructionWorkingCopyService(db);
    const second = await prepare();
    expect(await fs.readFile(path.join(second.executionRoot, "notes", "bytes.bin"))).toEqual(Buffer.from([0,128,255]));
    expect(await fs.readFile(path.join(second.executionRoot, "node_modules", "personal.txt"), "utf8")).toBe("retain this too");
    await expect(fs.stat(path.join(second.executionRoot, "task-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await copies.collectStopped({ companyId, runId: second.runId, target: executionTarget });
    await copies.release(companyId, second.runId);
  });

  it("checkpoints and reuses the remote directory through the real transport without copying unchanged bytes", async () => {
    const remoteCwd = path.join(home, "warm-remote-task");
    await fs.mkdir(remoteCwd, { recursive: true });
    const runner: import("@paperclipai/adapter-utils/command-managed-runtime").CommandManagedRuntimeRunner = {
      execute: async input => {
        const startedAt = new Date().toISOString();
        const env = { ...process.env, ...input.env };
        const args = [...(input.args ?? [])];
        if (input.stdin != null && (args[0] === "-c" || args[0] === "-lc")) {
          env.PAPERCLIP_TEST_STDIN = input.stdin;
          args[1] = `printf '%s' "$PAPERCLIP_TEST_STDIN" | (${args[1]})`;
        }
        try {
          const result = await execFile(input.command, args, { cwd: input.cwd, env, timeout: input.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
          return { exitCode: 0, signal: null, timedOut: false, stdout: result.stdout, stderr: result.stderr, pid: null, startedAt };
        } catch (error) {
          const e = error as { code?: number; signal?: NodeJS.Signals; stdout?: string; stderr?: string };
          return { exitCode: typeof e.code === "number" ? e.code : 1, signal: e.signal ?? null, timedOut: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "", pid: null, startedAt };
        }
      },
    };
    const executionTarget = { kind: "remote" as const, transport: "sandbox" as const, environmentId: randomUUID(), remoteCwd, runner };
    const prepare = async (reuseRunId?: string) => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
      return (await copies.prepare({ ...target(), runId, cwd: home, target: executionTarget, warm: true, reuseRunId }))!;
    };
    let copy = await prepare();
    const original = copy;
    await fs.writeFile(path.join(copy.executionRoot, "image.bin"), Buffer.alloc(32768, 93));
    for (let turn = 1; turn <= 3; turn++) {
      await fs.appendFile(path.join(copy.executionRoot, "memory.txt"), `turn ${turn}\n`);
      const saved = (await copies.checkpointWarm({ companyId, runId: copy.runId, target: executionTarget }))!;
      expect(saved, JSON.stringify({ code: saved.errorCode, message: saved.errorMessage })).toMatchObject({ state: "warm_saved", errorCode: null });
      if (turn > 1) expect(saved.receipt?.checkpointStats).toMatchObject({ copiedFiles: 1, copiedBytes: turn * 7, hashedBytes: turn * 7 });
      expect(await fs.readFile(path.join(root, "memory.txt"), "utf8")).toBe(Array.from({ length: turn }, (_, i) => `turn ${i + 1}\n`).join(""));
      expect((await fs.readdir(path.dirname(copy.localRoot))).filter(name => name.startsWith("checkpoint-"))).toEqual([]);
      expect((await fs.readdir(path.join(copy.executionRoot, ".paperclip-runtime"))).filter(name => name.startsWith("checkpoint-"))).toEqual([]);
      if (turn < 3) { copy = await prepare(copy.runId); expect(copy.executionRoot).toBe(original.executionRoot); }
    }
    await copies.collectStopped({ companyId, runId: original.runId, target: executionTarget });
    expect(await fs.stat(copy.executionRoot)).toBeTruthy();
    await copies.collectStopped({ companyId, runId: copy.runId, target: executionTarget });
    await expect(fs.stat(copy.executionRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stages SSH agent files at the registered root without a nested task workspace", async () => {
    const remoteCwd = path.join(home, "ssh-task");
    const exclude = vi.spyOn(executionTargetTools, "runAdapterExecutionTargetShellCommand").mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" });
    const stage = vi.spyOn(ssh, "syncDirectoryToSsh").mockImplementation(async input => {
      await fs.mkdir(path.dirname(input.remoteDir), { recursive: true });
      await fs.cp(input.localDir, input.remoteDir, { recursive: true });
    });
    const restore = vi.spyOn(ssh, "restoreWorkspaceFromSshExecution").mockImplementation(async input => {
      await fs.cp(input.remoteDir!, input.localDir, { recursive: true });
    });
    try {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
      const target = { kind: "remote" as const, transport: "ssh" as const, environmentId: randomUUID(), remoteCwd,
        spec: { host: "unused.invalid", port: 22, username: "test", remoteCwd } };
      const copy = (await copies.prepare({ companyId, agentId, runId, cwd: home, target }))!;
      expect(stage).toHaveBeenCalledWith(expect.objectContaining({ remoteDir: copy.executionRoot }));
      expect(await fs.readFile(path.join(copy.executionRoot, entryFile), "utf8")).toBe(initial);
      await fs.writeFile(path.join(copy.executionRoot, "ssh-note.txt"), "persistent SSH file");
      expect((await copies.collectStopped({ companyId, runId, target }))?.state).toBe("saved");
      expect(restore).toHaveBeenCalledWith(expect.objectContaining({ remoteDir: copy.executionRoot, restoreGitHistory: false }));
      expect(await fs.readFile(path.join(root, "ssh-note.txt"), "utf8")).toBe("persistent SSH file");
    } finally { stage.mockRestore(); restore.mockRestore(); exclude.mockRestore(); }
  });

  it("deduplicates concurrent stopped callbacks and discards completed operational snapshots", async () => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, "note.txt"), "one write");
    const results = await Promise.all([copies.collectStopped({ companyId, runId: copy.runId }), copies.collectStopped({ companyId, runId: copy.runId })]);
    expect(results.every(result => result?.state === "saved")).toBe(true);
    // Simulate a crash after save but before release. The restart sweeper must
    // reclaim operational baselines without touching canonical files.
    copies = agentInstructionWorkingCopyService(db);
    await copies.recoverCaptured();
    const row = await copies.get(companyId, copy.runId);
    expect(row?.receipt?.schema).toBe("paperclip.agent-files.v1");
    expect(row?.receipt?.baseline).toBeUndefined();
    expect(await fs.readFile(path.join(root, "note.txt"), "utf8")).toBe("one write");
  });

  it.each(["prepared", "unavailable", "warm_saved", "superseded", "saved", "unchanged", "resolved"])(
    "does not acquire a held directory lock for a no-op %s release", async state => {
      const copy = await run();
      const stopped = ["superseded", "saved", "unchanged", "resolved"].includes(state);
      await db.update(agentInstructionWorkingCopies).set({ state, processStoppedAt: stopped ? new Date() : null,
        receipt: { ...copy.receipt, ...(stopped ? { cleanupPending: false } : {}) } })
        .where(eq(agentInstructionWorkingCopies.runId, copy.runId));
      const before = await copies.get(companyId, copy.runId);
      await withDirectoryMergeLock(path.resolve(copy.localRoot, "../../.."), async () => {
        // Any attempted nested acquisition fails promptly instead of hanging the test.
        let now = Date.now();
        const clock = vi.spyOn(Date, "now").mockImplementation(() => now += 31_000);
        try { await copies.release(companyId, copy.runId); } finally { clock.mockRestore(); }
        expect(await copies.get(companyId, copy.runId)).toEqual(before);
        expect(await fs.readFile(path.join(copy.localRoot, entryFile), "utf8")).toBe(initial);
      });
    });

  async function unavailableRemote(options: { state?: "stopped" | "destroyed"; receiptMismatch?: string } = {}) {
    const copy = await run();
    const environmentId = randomUUID(), leaseId = randomUUID(), remoteCwd = "/fixture/cleanup-task";
    const lease = { id: leaseId, companyId, environmentId, heartbeatRunId: copy.runId, provider: "daytona", providerLeaseId: "cleanup-fixture" };
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    const receipt = options.state ? remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: options.state })! : undefined;
    if (receipt && options.receiptMismatch) (receipt as Record<string, unknown>)[options.receiptMismatch] = randomUUID();
    await db.insert(environmentLeases).values({ ...lease, ...(receipt ? { status: "released", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { remoteExecutionTermination: receipt } } : {}) });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, copy.runId));
    await db.update(agentInstructionWorkingCopies).set({ state: "unavailable", errorCode: "INSTRUCTION_COLLECTION_UNAVAILABLE",
      errorMessage: "Fixture could not collect files", candidateHash: "preserved-candidate", candidateBase64: Buffer.from("preserved bytes").toString("base64"), attempts: 3,
      location: `remote:${environmentId}`, executionRoot: path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", agentId, copy.runId),
      receipt: { ...copy.receipt, cleanup: { leaseId, remoteCwd } } }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    return { copy: (await copies.get(companyId, copy.runId))!, lease, environmentId };
  }

  it.each([undefined, "stopped", "companyId", "runId", "leaseId", "provider", "providerLeaseId"])(
    "defers unavailable cleanup without exact destruction proof (%s)", async proof => {
      const { copy } = await unavailableRemote({ state: proof === undefined ? undefined : proof === "stopped" ? "stopped" : "destroyed",
        receiptMismatch: proof && proof !== "stopped" ? proof : undefined });
      const execute = vi.fn();
      copies = agentInstructionWorkingCopyService(db, { environmentRuntime: { execute } as unknown as EnvironmentRuntimeService });
      const before = Date.now();
      await withDirectoryMergeLock(path.resolve(copy.localRoot, "../../.."), () => copies.recoverStopped());
      const deferred = (await copies.get(companyId, copy.runId))!;
      expect(deferred).toMatchObject({ state: "unavailable", processStoppedAt: null, attempts: 3,
        candidateHash: copy.candidateHash, candidateBase64: copy.candidateBase64, errorCode: copy.errorCode, errorMessage: copy.errorMessage, receipt: copy.receipt });
      expect(deferred.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 30_000);
      expect(await copies.recoverStopped()).toBe(0);
      expect(await fs.readFile(path.join(copy.localRoot, entryFile), "utf8")).toBe(initial);
      expect(execute).not.toHaveBeenCalled();
    });

  it("cleans an unavailable copy after exact destruction without claiming a save or executing remotely", async () => {
    const { copy, environmentId } = await unavailableRemote({ state: "destroyed" });
    await fs.writeFile(path.join(copy.localRoot, "unsaved.txt"), "unsaved edit");
    await db.delete(environments).where(eq(environments.id, environmentId));
    const execute = vi.fn();
    const shell = vi.spyOn(executionTargetTools, "runAdapterExecutionTargetShellCommand").mockRejectedValue(new Error("must not execute"));
    copies = agentInstructionWorkingCopyService(db, { environmentRuntime: { execute } as unknown as EnvironmentRuntimeService });
    try {
      await copies.recoverStopped();
      const recovered = (await copies.get(companyId, copy.runId))!;
      expect(recovered).toMatchObject({ state: "unavailable", candidateHash: copy.candidateHash, candidateBase64: copy.candidateBase64, attempts: 3,
        errorCode: copy.errorCode, errorMessage: copy.errorMessage, receipt: { cleanupPending: false } });
      expect(recovered.processStoppedAt).toBeInstanceOf(Date);
      expect(recovered.nextAttemptAt).toBeNull();
      await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(path.join(root, "unsaved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(root, entryFile), "utf8")).toBe(initial);
      expect(execute).not.toHaveBeenCalled(); expect(shell).not.toHaveBeenCalled();
    } finally { shell.mockRestore(); }
  });

  it.each([false, true])("preserves uncollected local edits and their unavailable receipt even after local stop proof (%s)", async stopped => {
    const copy = await run();
    await fs.writeFile(path.join(copy.localRoot, "unsaved-local.txt"), "recoverable local edit");
    await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native" }).where(eq(heartbeatRuns.id, copy.runId));
    await copies.reportUnavailable(companyId, copy.runId);
    if (stopped) await db.insert(heartbeatRunEvents).values({ companyId, runId: copy.runId, agentId, seq: 1, eventType: "native.local_process_stopped", stream: "system", level: "info", message: "fixture stop" });
    const before = (await copies.get(companyId, copy.runId))!;
    expect(before).toMatchObject({ state: "unavailable", attempts: 0, processStoppedAt: null });
    await copies.recoverStopped();
    const patch = vi.fn(async () => { throw new Error("local copy must not be changed"); });
    await agentDirectoryWorkingCopyService(db, copies.get, patch).recoverUnavailable(before);
    expect(patch).not.toHaveBeenCalled();
    expect(await copies.get(companyId, copy.runId)).toEqual(before);
    expect(await fs.readFile(path.join(copy.localRoot, "unsaved-local.txt"), "utf8")).toBe("recoverable local edit");
    await expect(fs.stat(path.join(root, "unsaved-local.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes same-run preparation after recovery commits stop proof and before it removes bytes", async () => {
    const { copy, lease } = await unavailableRemote({ state: "destroyed" });
    const remoteCwd = "/fixture/cleanup-task";
    const executionTarget = { kind: "remote" as const, transport: "ssh" as const, environmentId: lease.environmentId, leaseId: lease.id, remoteCwd,
      spec: { host: "unused.invalid", port: 22, username: "test", remoteCwd, remoteWorkspacePath: remoteCwd, privateKey: null, knownHosts: null, strictHostKeyChecking: true } };
    const shell = vi.spyOn(executionTargetTools, "runAdapterExecutionTargetShellCommand").mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: null });
    const stage = vi.spyOn(ssh, "syncDirectoryToSsh").mockResolvedValue(undefined);
    let stopCommitted!: () => void, finishCleanup!: () => void;
    const committed = new Promise<void>(resolve => { stopCommitted = resolve; });
    const proceed = new Promise<void>(resolve => { finishCleanup = resolve; });
    const directories = agentDirectoryWorkingCopyService(db, copies.get, async (row, values) => {
      const [updated] = await db.update(agentInstructionWorkingCopies).set(values).where(eq(agentInstructionWorkingCopies.runId, row.runId)).returning();
      if (values.processStoppedAt) { stopCommitted(); await proceed; }
      return updated!;
    });
    const recovering = directories.recoverUnavailable(copy);
    await committed;
    let prepareSettled = false;
    const preparing = copies.prepare({ ...target(), runId: copy.runId, cwd: home, target: executionTarget }).then(row => { prepareSettled = true; return row; });
    try {
      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(prepareSettled).toBe(false);
        expect((await copies.get(companyId, copy.runId))?.state).toBe("unavailable");
      } finally { finishCleanup(); await recovering; }
      const prepared = await preparing;
      expect(prepared).toMatchObject({ state: "prepared", processStoppedAt: null });
      expect(await fs.readFile(path.join(copy.localRoot, entryFile), "utf8")).toBe(initial);
      // A stale cleanup callback now observes the live lifecycle and does nothing.
      await directories.release(copy);
      expect(await fs.readFile(path.join(copy.localRoot, entryFile), "utf8")).toBe(initial);
    } finally { shell.mockRestore(); stage.mockRestore(); }
  });

  it("keeps stopped pending cleanup behind a held lock and lets recovery proceed to other agents", async () => {
    const blocked = await run();
    await db.update(agentInstructionWorkingCopies).set({ state: "unavailable", processStoppedAt: new Date() }).where(eq(agentInstructionWorkingCopies.runId, blocked.runId));
    // A distinct canonical agent has its own lifecycle lock.
    const firstAgent = agentId, firstRoot = root;
    agentId = randomUUID();
    root = resolveManagedInstructionsRoot({ ...target(), id: agentId, name: "Other", adapterConfig: {} });
    await db.insert(agents).values({ id: agentId, companyId, name: "Other", adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: entryFile } });
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agentId, membershipRole: "member" });
    await db.update(principalPermissionGrants).set({ scope: { agentIds: [firstAgent, agentId] } }).where(eq(principalPermissionGrants.companyId, companyId));
    await fs.mkdir(path.dirname(path.join(root, entryFile)), { recursive: true }); await fs.writeFile(path.join(root, entryFile), initial);
    const other = await run();
    await db.update(agentInstructionWorkingCopies).set({ state: "unavailable", processStoppedAt: new Date() }).where(eq(agentInstructionWorkingCopies.runId, other.runId));
    agentId = firstAgent; root = firstRoot;
    await withDirectoryMergeLock(path.resolve(blocked.localRoot, "../../.."), async () => {
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now += 31_000);
      try {
        await expect(copies.release(companyId, blocked.runId)).rejects.toMatchObject({ code: "ERR_WORKSPACE_RESTORE_LOCK_TIMEOUT" });
        await copies.recoverCaptured();
      } finally { clock.mockRestore(); }
      expect((await copies.get(companyId, blocked.runId))?.nextAttemptAt).toBeInstanceOf(Date);
      expect(await fs.readFile(path.join(blocked.localRoot, entryFile), "utf8")).toBe(initial);
      await expect(fs.stat(other.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
    // A fresh recovery worker retries after the holder releases the lock. It
    // cleans the pending copy without changing the failed-save receipt.
    const deferred = (await copies.get(companyId, blocked.runId))!;
    await db.update(agentInstructionWorkingCopies).set({ nextAttemptAt: new Date(0) })
      .where(eq(agentInstructionWorkingCopies.runId, blocked.runId));
    await agentInstructionWorkingCopyService(db).recoverCaptured();
    expect(await copies.get(companyId, blocked.runId)).toMatchObject({ state: deferred.state,
      errorCode: deferred.errorCode, errorMessage: deferred.errorMessage,
      candidateHash: deferred.candidateHash, receipt: { cleanupPending: false }, nextAttemptAt: null });
    await expect(fs.stat(blocked.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["environment", "path", "lease-run"])("rejects destruction outside the registered copy binding (%s)", async mismatch => {
    const { copy, lease } = await unavailableRemote({ state: "destroyed" });
    if (mismatch === "environment") await db.update(agentInstructionWorkingCopies).set({ location: `remote:${randomUUID()}` }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    if (mismatch === "path") await db.update(agentInstructionWorkingCopies).set({ executionRoot: "/fixture/foreign" }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    if (mismatch === "lease-run") {
      const other = await run();
      const moved = { ...lease, heartbeatRunId: other.runId };
      await db.update(environmentLeases).set({ heartbeatRunId: other.runId, metadata: { remoteExecutionTermination: remoteTerminationReceipt(moved, { providerLeaseId: moved.providerLeaseId, state: "destroyed" }) } }).where(eq(environmentLeases.id, lease.id));
    }
    await copies.recoverStopped();
    expect((await copies.get(companyId, copy.runId))?.processStoppedAt).toBeNull();
    expect(await fs.readFile(path.join(copy.localRoot, entryFile), "utf8")).toBe(initial);
  });

  it("backs off an unproven batch so the next unavailable copy can be cleaned", async () => {
    const deferred: string[] = [];
    for (let i = 0; i < 20; i++) {
      const { copy } = await unavailableRemote();
      deferred.push(copy.runId);
      await db.update(agentInstructionWorkingCopies).set({ updatedAt: new Date(i) }).where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    }
    const { copy: ready } = await unavailableRemote({ state: "destroyed" });
    await db.update(agentInstructionWorkingCopies).set({ updatedAt: new Date(20) }).where(eq(agentInstructionWorkingCopies.runId, ready.runId));
    await copies.recoverStopped();
    expect((await copies.get(companyId, ready.runId))?.processStoppedAt).toBeNull();
    await copies.recoverStopped();
    expect((await copies.get(companyId, ready.runId))?.receipt?.cleanupPending).toBe(false);
    for (const runId of deferred) expect(await copies.get(companyId, runId)).toMatchObject({ state: "unavailable", processStoppedAt: null, attempts: 3 });
  });

  it("continues cleanup when both retry-reservation writes fail for the first copy", async () => {
    const first = await run(), second = await run();
    for (const [index, copy] of [first, second].entries()) {
      await db.update(agentInstructionWorkingCopies).set({ state: "unavailable", processStoppedAt: new Date(), updatedAt: new Date(index),
        errorCode: "INSTRUCTION_COLLECTION_UNAVAILABLE", candidateHash: "preserved", candidateBase64: Buffer.from("candidate").toString("base64") })
        .where(eq(agentInstructionWorkingCopies.runId, copy.runId));
    }
    const before = await copies.get(companyId, first.runId);
    const failReservation = () => { throw new Error("fixture retry-reservation write failure"); };
    const update = vi.spyOn(db, "update").mockImplementationOnce(failReservation).mockImplementationOnce(failReservation);
    try { await copies.recoverCaptured(); } finally { update.mockRestore(); }
    expect(await copies.get(companyId, first.runId)).toEqual(before);
    expect(await fs.readFile(path.join(first.localRoot, entryFile), "utf8")).toBe(initial);
    expect(await copies.get(companyId, second.runId)).toMatchObject({ state: "unavailable", errorCode: "INSTRUCTION_COLLECTION_UNAVAILABLE", candidateHash: "preserved", receipt: { cleanupPending: false } });
    await expect(fs.stat(second.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("does not execute a cached transport after destruction, including an ambiguous stop-proof commit (%s)", async interrupted => {
    const runId = randomUUID(), environmentId = randomUUID(), leaseId = randomUUID(), remoteCwd = "/fixture/cached-task";
    const lease = { id: leaseId, companyId, environmentId, heartbeatRunId: runId, provider: "daytona", providerLeaseId: "cached-fixture" };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", responsibleUserId: userId });
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "sandbox" });
    await db.insert(environmentLeases).values(lease);
    const execute = vi.fn(), restoreWorkspace = vi.fn(), cleanupWorkspaceSnapshot = vi.fn().mockResolvedValue(undefined);
    const executionTarget = { kind: "remote" as const, transport: "sandbox" as const, environmentId, leaseId, remoteCwd, runner: { execute } };
    const shell = vi.spyOn(executionTargetTools, "runAdapterExecutionTargetShellCommand").mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: null, startedAt: null });
    const stage = vi.spyOn(executionTargetTools, "prepareAdapterExecutionTargetRuntime").mockImplementation(async () => ({ target: executionTarget,
      workspaceRemoteDir: path.posix.join(remoteCwd, ".paperclip-runtime", "agent-files", agentId, runId), runtimeRootDir: null,
      assetDirs: {}, additionalSourceDirs: {}, additionalSourceFailures: [], workspaceSyncSnapshot: null, restoreWorkspace, cleanupWorkspaceSnapshot }));
    try {
      const copy = (await copies.prepare({ ...target(), runId, cwd: home, target: executionTarget }))!;
      await copies.reportUnavailable(companyId, runId);
      await copies.release(companyId, runId);
      expect(cleanupWorkspaceSnapshot).not.toHaveBeenCalled();
      shell.mockClear(); stage.mockClear();
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, runId));
      await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success",
        metadata: { remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "destroyed" }) } }).where(eq(environmentLeases.id, leaseId));
      if (interrupted) {
        const directories = agentDirectoryWorkingCopyService(db, copies.get, async (row, values) => {
          const [updated] = await db.update(agentInstructionWorkingCopies).set(values).where(eq(agentInstructionWorkingCopies.runId, row.runId)).returning();
          if (values.processStoppedAt) throw new Error("fixture lost update response after commit");
          return updated!;
        });
        await expect(directories.recoverUnavailable((await copies.get(companyId, runId))!)).rejects.toThrow("lost update response");
        expect((await copies.get(companyId, runId))?.receipt?.cleanupDestroyedOnly).toBe(true);
        await copies.recoverCaptured();
      } else await copies.recoverStopped();
      expect(await copies.get(companyId, runId)).toMatchObject({ state: "unavailable", errorCode: "INSTRUCTION_COLLECTION_UNAVAILABLE", receipt: { cleanupPending: false } });
      await expect(fs.stat(copy.localRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(cleanupWorkspaceSnapshot).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled(); expect(restoreWorkspace).not.toHaveBeenCalled(); expect(shell).not.toHaveBeenCalled(); expect(stage).not.toHaveBeenCalled();
    } finally { shell.mockRestore(); stage.mockRestore(); }
  });

});
