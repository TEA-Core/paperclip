import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
  workspaceRuntimeServices,
  type Db,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.ts";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.ts";
import {
  ensurePersistedExecutionWorkspaceAvailable,
  resetRuntimeServicesForTests,
} from "../services/workspace-runtime.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

async function git(args: string[], cwd: string) {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv });
  return stdout.trim();
}

async function commitFile(repo: string, name: string) {
  await fs.writeFile(path.join(repo, name), `${name}\n`);
  await git(["add", "-A"], repo);
  await git(["commit", "-qm", name], repo);
  return git(["rev-parse", "HEAD"], repo);
}

function quoteShell(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type CompanyScope = {
  companyId: string;
  agentId: string;
  projectId: string;
  projectWorkspaceId: string;
};



async function makeLinkedSource() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sup24747-drift-"));
  tempRoots.push(root);
  const owner = path.join(root, "owner");
  await git(["init", "-q", "-b", "branch-a", owner], root);
  const commitX = await commitFile(owner, "a.txt");
  await git(["branch", "branch-b"], owner);
  await git(["checkout", "-q", "-b", "parking"], owner);
  await git(["checkout", "-q", "branch-b"], owner);
  const commitY = await commitFile(owner, "b.txt");
  await git(["checkout", "-q", "parking"], owner);
  const source = path.join(root, "source");
  await git(["worktree", "add", "-q", source, "branch-a"], owner);
  return { root, owner, source, commitX, commitY };
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("same-source hygiene leaves the bound checkout alone", () => {
  afterEach(async () => {
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("does not force-checkout a bound linked source onto the configured base branch", async () => {
    const fixture = await makeLinkedSource();
    const realized = await ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: fixture.source,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "branch-b",
      },
      workspace: {
        id: "execution-workspace-1",
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: fixture.source,
        providerRef: fixture.source,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "branch-b",
        branchName: "branch-a",
        metadata: { createdByRuntime: true, gitBranchOwnershipVersion: 1 },
      },
      issue: { id: "issue-1", identifier: "SUP-24747", title: "Bound source" },
      agent: { id: "agent-1", name: "Coder", companyId: "company-1" },
      preserveRecordedCheckoutBranch: true,
    });

    expect(realized?.branchName).toBe("branch-a");
    await expect(git(["symbolic-ref", "--short", "HEAD"], fixture.source)).resolves.toBe("branch-a");
    await expect(git(["rev-parse", "HEAD"], fixture.source)).resolves.toBe(fixture.commitX);
  }, 30_000);

  it("treats a canonical symlink of the bound source as the same checkout", async () => {
    const fixture = await makeLinkedSource();
    const alias = path.join(fixture.root, "alias");
    await fs.symlink(fixture.source, alias);

    await ensurePersistedExecutionWorkspaceAvailable({
      base: {
        baseCwd: alias,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: "workspace-1",
        repoUrl: null,
        repoRef: "branch-b",
      },
      workspace: {
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        cwd: fixture.source,
        providerRef: fixture.source,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "branch-b",
        branchName: "branch-a",
      },
      issue: null,
      agent: { id: "agent-1", name: "Coder", companyId: "company-1" },
    });

    await expect(git(["symbolic-ref", "--short", "HEAD"], fixture.source)).resolves.toBe("branch-a");
    await expect(git(["rev-parse", "HEAD"], fixture.source)).resolves.toBe(fixture.commitX);
  }, 30_000);

  it("does not require git for an ordinary non-git project directory", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sup24747-nongit-"));
    tempRoots.push(dir);
    const realized = await ensurePersistedExecutionWorkspaceAvailable({
      preserveRecordedCheckoutBranch: true,
      base: {
        baseCwd: dir,
        source: "project_primary",
        projectId: "project-1",
        workspaceId: null,
        repoUrl: null,
        repoRef: null,
      },
      workspace: {
        mode: "shared_workspace",
        strategyType: "project_primary",
        cwd: dir,
        providerRef: null,
        projectId: "project-1",
        projectWorkspaceId: null,
        repoUrl: null,
        baseRef: null,
        branchName: "main",
      },
      issue: null,
      agent: { id: "agent-1", name: "Coder", companyId: "company-1" },
    });
    expect(realized?.cwd).toBe(dir);
    expect(realized?.branchName).toBe("main");
  });
});

describeEmbeddedPostgres("managed runtime start detects checkout drift", () => {
  let db!: Db;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let previousHome: string | undefined;
  let previousInstanceId: string | undefined;
  let paperclipHome = "";

  beforeAll(async () => {
    previousHome = process.env.PAPERCLIP_HOME;
    previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "sup24747-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `sup24747-${randomUUID()}`;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sup24747-drift-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
    await fs.rm(paperclipHome, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(async () => {
    await resetRuntimeServicesForTests({ terminateProcesses: true });
    await db.delete(workspaceRuntimeServices);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    while (tempRoots.length > 0) {
      const dir = tempRoots.pop();
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  function app() {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "local-board",
        source: "local_implicit",
      } as typeof req.actor;
      next();
    });
    server.use("/api", executionWorkspaceRoutes(db));
    server.use(errorHandler);
    return server;
  }
  async function seedCompany(): Promise<CompanyScope> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Drift",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Drift",
      status: "in_progress",
    });
    return { companyId, agentId, projectId, projectWorkspaceId };
  }

  async function seedWorkspace(input: {
    scope: CompanyScope;
    cwd: string;
    branchName: string;
    baseRef: string;
    projectCwd?: string | null;
    provisionCommand?: string | null;
    serviceCommand?: string | null;
    runtimeOwned?: boolean;
  }) {
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const now = new Date();
    if (input.projectCwd) {
      await db.insert(projectWorkspaces).values({
        id: input.scope.projectWorkspaceId,
        companyId: input.scope.companyId,
        projectId: input.scope.projectId,
        name: "Base",
        cwd: input.projectCwd,
        isPrimary: true,
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId: input.scope.companyId,
      projectId: input.scope.projectId,
      title: "Bound source",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: input.scope.agentId,
      identifier: `D${issueId.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId: input.scope.companyId,
      projectId: input.scope.projectId,
      projectWorkspaceId: input.projectCwd ? input.scope.projectWorkspaceId : null,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Bound source",
      status: "active",
      cwd: input.cwd,
      providerRef: input.cwd,
      baseRef: input.baseRef,
      branchName: input.branchName,
      metadata: {
        ...(input.runtimeOwned
          ? { createdByRuntime: true, gitBranchOwnershipVersion: 1 }
          : {}),
        config: {
          provisionCommand: input.provisionCommand ?? null,
          workspaceRuntime: input.serviceCommand
            ? {
                services: [{
                  name: "web",
                  command: input.serviceCommand,
                  port: { type: "auto" },
                  readiness: {
                    type: "http",
                    urlTemplate: "http://127.0.0.1:{{port}}",
                    timeoutSec: 10,
                    intervalMs: 50,
                  },
                  lifecycle: "shared",
                  reuseScope: "execution_workspace",
                  stopPolicy: { type: "manual" },
                }],
              }
            : { services: [{ name: "web", command: "true", port: { type: "auto" } }] },
        },
      },
      lastUsedAt: now,
      updatedAt: now,
    });
    await db.update(issues).set({
      executionWorkspaceId: workspaceId,
      updatedAt: now,
    }).where(eq(issues.id, issueId));
    return { issueId, workspaceId };
  }

  async function seedCompetitor(input: {
    scope: CompanyScope;
    cwd: string;
    branchName: string;
    runStatus: "queued" | "running";
  }) {
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const runId = randomUUID();
    const now = new Date();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.scope.companyId,
      projectId: input.scope.projectId,
      title: "Competing checkout",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: input.scope.agentId,
      identifier: `C${issueId.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.scope.companyId,
      agentId: input.scope.agentId,
      invocationSource: "manual",
      status: input.runStatus,
      startedAt: now,
      updatedAt: now,
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId: input.scope.companyId,
      projectId: input.scope.projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Competitor",
      status: "active",
      cwd: input.cwd,
      providerRef: input.cwd,
      branchName: input.branchName,
      lastUsedAt: now,
      updatedAt: now,
    });
    await db.update(issues).set({
      executionWorkspaceId: workspaceId,
      executionRunId: runId,
      updatedAt: now,
    }).where(eq(issues.id, issueId));
    return { issueId, workspaceId, runId };
  }

  function httpCommand(startedFile: string) {
    const script = `
      const http = require("node:http");
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(startedFile)}, String(process.pid));
      http.createServer((_req, res) => res.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
    `;
    return `${quoteShell(process.execPath)} -e ${quoteShell(script)}`;
  }

  function barrierCommand(input: { barrierPort: number; exitAfterRelease: boolean }) {
    const script = `
      const net = require("node:net");
      const http = require("node:http");
      const socket = net.connect(${input.barrierPort}, "127.0.0.1");
      socket.write(String(process.pid) + "\\n");
      socket.once("data", () => {
        if (${input.exitAfterRelease ? "true" : "false"}) {
          console.error("fixture early exit");
          process.exit(2);
        }
        http.createServer((_req, res) => res.end("ok")).listen(Number(process.env.PORT), "127.0.0.1");
      });
    `;
    return `${quoteShell(process.execPath)} -e ${quoteShell(script)}`;
  }

  async function operationText(workspaceId: string) {
    const rows = await db.select().from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, workspaceId));
    return JSON.stringify(rows);
  }

  it("uses the workspace cwd when no project cwd is registered and keeps branch A", async () => {
    const fixture = await makeLinkedSource();
    const scope = await seedCompany();
    const started = path.join(fixture.root, "started");
    const seeded = await seedWorkspace({
      scope,
      cwd: fixture.source,
      branchName: "branch-a",
      baseRef: "branch-b",
      projectCwd: null,
      serviceCommand: httpCommand(started),
    });

    const res = await request(app())
      .post(`/api/execution-workspaces/${seeded.workspaceId}/runtime-services/start`)
      .send({});

    const branch = await git(["symbolic-ref", "--short", "HEAD"], fixture.source);
    const sha = await git(["rev-parse", "HEAD"], fixture.source);
    const row = await db.select({ branchName: executionWorkspaces.branchName })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.workspaceId))
      .then((rows) => rows[0]);
    expect(row?.branchName).toBe("branch-a");
    expect(branch, `start status ${res.status} left the checkout on ${branch}@${sha}`).toBe("branch-a");
    expect(sha).toBe(fixture.commitX);
    if (res.status < 300) expect(branch).toBe("branch-a");
  }, 30_000);

  it("fails before spawn when provisioning moves the checkout, and an unchanged checkout still starts", async () => {
    const drifted = await makeLinkedSource();
    const scope = await seedCompany();
    const started = path.join(drifted.root, "started");
    const switchCommand = `git checkout --force branch-b`;
    const seeded = await seedWorkspace({
      scope,
      cwd: drifted.source,
      branchName: "branch-a",
      baseRef: "branch-a",
      projectCwd: drifted.owner,
      provisionCommand: switchCommand,
      serviceCommand: httpCommand(started),
    });

    const res = await request(app())
      .post(`/api/execution-workspaces/${seeded.workspaceId}/runtime-services/start`)
      .send({});

    expect(res.status).toBeGreaterThanOrEqual(400);
    await expect(fs.stat(started)).rejects.toThrow();
    const row = await db.select({ branchName: executionWorkspaces.branchName })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.workspaceId))
      .then((rows) => rows[0]);
    expect(row?.branchName).toBe("branch-a");
    const evidence = await operationText(seeded.workspaceId);
    expect(evidence).toContain("branch-a");
    expect(evidence).toContain("branch-b");
    expect(evidence).toContain(drifted.commitY);
    expect(evidence).toContain(seeded.workspaceId);
    expect(evidence).toContain(drifted.source);

    const control = await makeLinkedSource();
    const controlStarted = path.join(control.root, "started-ok");
    const controlSeed = await seedWorkspace({
      scope,
      cwd: control.source,
      branchName: "branch-a",
      baseRef: "branch-a",
      projectCwd: null,
      provisionCommand: "true",
      serviceCommand: httpCommand(controlStarted),
    });
    const ok = await request(app())
      .post(`/api/execution-workspaces/${controlSeed.workspaceId}/runtime-services/start`)
      .send({});
    expect(ok.status).toBeLessThan(300);
    await expect(fs.stat(controlStarted)).resolves.toBeTruthy();
    await expect(git(["symbolic-ref", "--short", "HEAD"], control.source)).resolves.toBe("branch-a");
  }, 30_000);

  it("surfaces drift on readiness and keeps the original early-exit error", async () => {
    async function openBarrier() {
      const server = net.createServer();
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("barrier port missing");
      let socket: net.Socket | null = null;
      let buf = "";
      let settlePid: (pid: number) => void = () => undefined;
      const pid = new Promise<number>((resolve) => {
        settlePid = resolve;
      });
      server.on("connection", (conn) => {
        socket = conn;
        conn.on("data", (chunk) => {
          buf += chunk.toString();
          const line = buf.split("\n")[0] ?? "";
          if (line.length > 0) settlePid(Number(line));
        });
      });
      return {
        port: address.port,
        pid,
        release: () => {
          if (!socket) throw new Error("barrier has no service connection");
          socket.write("x");
        },
        close: () => {
          socket?.destroy();
          server.close();
        },
      };
    }

    async function runBarrier(exitAfterRelease: boolean) {
      const fixture = await makeLinkedSource();
      const scope = await seedCompany();
      const barrier = await openBarrier();
      const seeded = await seedWorkspace({
        scope,
        cwd: fixture.source,
        branchName: "branch-a",
        baseRef: "branch-a",
        projectCwd: fixture.owner,
        serviceCommand: barrierCommand({
          barrierPort: barrier.port,
          exitAfterRelease,
        }),
      });
      const pending = request(app())
        .post(`/api/execution-workspaces/${seeded.workspaceId}/runtime-services/start`)
        .send({});
      const pid = await Promise.race([
        barrier.pid,
        pending.then(async (early) => {
          throw new Error(
            `service never reached the barrier: ${early.status} ${JSON.stringify(early.body)} ${await operationText(seeded.workspaceId)}`,
          );
        }),
      ]);
      await git(["checkout", "-q", "branch-b"], fixture.source);
      barrier.release();
      const res = await pending;
      barrier.close();
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(() => process.kill(pid, 0)).toThrow();

      const row = await db.select({ branchName: executionWorkspaces.branchName })
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, seeded.workspaceId))
        .then((rows) => rows[0]);
      expect(row?.branchName).toBe("branch-a");
      const evidence = await operationText(seeded.workspaceId);
      expect(evidence).toContain("branch-a");
      expect(evidence).toContain("branch-b");
      expect(evidence).toContain(fixture.commitY);
      expect(evidence).toContain(seeded.workspaceId);
      if (exitAfterRelease) expect(evidence).toContain("exited before readiness");
      return evidence;
    }

    await runBarrier(false);
    await runBarrier(true);
  }, 45_000);

  it("does not let managed restore switch a claimed checkout, and omitting db does", async () => {
    async function claimedFixture(kind: "same-tip" | "divergent") {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "sup24747-claim-"));
      tempRoots.push(root);
      const owner = path.join(root, "owner");
      await git(["init", "-q", "-b", "branch-a", owner], root);
      await commitFile(owner, "a.txt");
      if (kind === "divergent") {
        await git(["checkout", "-q", "-b", "branch-b"], owner);
        await commitFile(owner, "b.txt");
        await git(["checkout", "-q", "branch-a"], owner);
        await commitFile(owner, "a2.txt");
      } else {
        await git(["branch", "branch-b"], owner);
      }
      await git(["checkout", "-q", "-b", "parking"], owner);
      const source = path.join(root, "source");
      await git(["worktree", "add", "-q", source, "branch-b"], owner);
      return { owner, source };
    }

    async function restore(input: {
      fixture: { owner: string; source: string };
      dbHandle: Db | null;
      workspaceId: string;
      issueId: string;
    }) {
      return ensurePersistedExecutionWorkspaceAvailable({
        db: input.dbHandle,
        preserveRecordedCheckoutBranch: true,
        base: {
          baseCwd: input.fixture.owner,
          source: "project_primary",
          projectId: "project-1",
          workspaceId: "workspace-1",
          repoUrl: null,
          repoRef: "branch-a",
        },
        workspace: {
          id: input.workspaceId,
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          cwd: input.fixture.source,
          providerRef: input.fixture.source,
          projectId: "project-1",
          projectWorkspaceId: "workspace-1",
          repoUrl: null,
          baseRef: "branch-a",
          branchName: "branch-a",
          metadata: { createdByRuntime: true, gitBranchOwnershipVersion: 1 },
        },
        issue: { id: input.issueId, identifier: null, title: "Recorded" },
        agent: { id: "agent-1", name: "Coder", companyId: "company-1" },
      });
    }

    for (const kind of ["same-tip", "divergent"] as const) {
      const unprotected = await claimedFixture(kind);
      await restore({
        fixture: unprotected,
        dbHandle: null,
        workspaceId: randomUUID(),
        issueId: randomUUID(),
      });
      await expect(git(["symbolic-ref", "--short", "HEAD"], unprotected.source)).resolves.toBe("branch-a");

      const protectedFixture = await claimedFixture(kind);
      const scope = await seedCompany();
      const issueId = randomUUID();
      const workspaceId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId: scope.companyId,
        projectId: scope.projectId,
        title: "Recorded",
        status: "in_progress",
        priority: "medium",
        identifier: `R${issueId.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      });
      await seedCompetitor({
        scope,
        cwd: protectedFixture.source,
        branchName: "branch-b",
        runStatus: kind === "same-tip" ? "queued" : "running",
      });
      await expect(restore({
        fixture: protectedFixture,
        dbHandle: db,
        workspaceId,
        issueId,
      })).rejects.toThrow(/branch-b|claims the live branch|checkout branch drift/i);
      await expect(git(["symbolic-ref", "--short", "HEAD"], protectedFixture.source)).resolves.toBe("branch-b");
    }
  }, 30_000);
});
