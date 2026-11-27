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
import { RUNTIME_EXPOSURE_APP_PORT_MIN, deriveViteHmrPort } from "@paperclipai/shared";
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
import { projectRoutes } from "../routes/projects.ts";
import type { BrokerClient, BrokerListenerRequest } from "../services/runtime-exposure/broker-client.ts";
import {
  ensurePersistedExecutionWorkspaceAvailable,
  listRuntimeServicePortReservationsForTests,
  resetRuntimeServicePortReservationsForTests,
  resetRuntimeServicesForTests,
  setWorkspaceRuntimeExposureDepsForTests,
  startRuntimeServicesForWorkspaceControl,
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



const HEX_BRANCH = "ab".repeat(20);

type LinkedSource = Awaited<ReturnType<typeof makeLinkedSource>>;

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

  it("does not force-checkout the bound checkout when the workspace runs from a subdirectory of it", async () => {
    const fixture = await makeLinkedSource();
    const app = path.join(fixture.source, "app");
    await fs.mkdir(app);
    await ensurePersistedExecutionWorkspaceAvailable({
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
        cwd: app,
        providerRef: fixture.source,
        projectId: "project-1",
        projectWorkspaceId: "workspace-1",
        repoUrl: null,
        baseRef: "branch-b",
        branchName: "branch-a",
        metadata: { createdByRuntime: true, gitBranchOwnershipVersion: 1 },
      },
      issue: { id: "issue-1", identifier: null, title: "Bound source" },
      agent: { id: "agent-1", name: "Coder", companyId: "company-1" },
      preserveRecordedCheckoutBranch: true,
    }).catch(() => null);

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
    resetRuntimeServicePortReservationsForTests();
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
    server.use("/api", projectRoutes(db));
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
    branchName: string | null;
    baseRef: string;
    projectCwd?: string | null;
    provisionCommand?: string | null;
    runtimeProvisionCommand?: string | null;
    serviceCommand?: string | null;
    runtimeOwned?: boolean;
    strategyType?: string;
    workspaceRuntime?: Record<string, unknown>;
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
      strategyType: input.strategyType ?? "git_worktree",
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
          runtimeProvisionCommand: input.runtimeProvisionCommand ?? null,
          workspaceRuntime: input.workspaceRuntime ?? (input.serviceCommand
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
            : { services: [{ name: "web", command: "true", port: { type: "auto" } }] }),
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

  /** A drift refusal is a 409 that carries its reason code, never a 500 or another 4xx. */
  function expectDriftRefusal(res: { status: number; body: unknown }, reasonCode: string) {
    const body = res.body as { details?: { code?: unknown; reasonCode?: unknown } };
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(body.details?.code, JSON.stringify(res.body)).toBe("checkout_branch_drift");
    expect(body.details?.reasonCode, JSON.stringify(res.body)).toBe(reasonCode);
  }

  async function expectNoStartingRuntimeRows() {
    const rows = await db.select({ id: workspaceRuntimeServices.id, status: workspaceRuntimeServices.status })
      .from(workspaceRuntimeServices);
    expect(rows.filter((row) => row.status === "starting")).toEqual([]);
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
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await expect(fs.stat(started)).resolves.toBeTruthy();
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

    expectDriftRefusal(res, "branch_mismatch");
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

  it.each([
    ["a refs/heads/ form", "refs/heads/branch-a", async () => {}],
    ["a detached checkout at the recorded tip", "branch-a", async (f: LinkedSource) => {
      await git(["checkout", "-q", "--detach", "branch-a"], f.source);
    }],
    ["a local branch named like a 40-hex commit", HEX_BRANCH, async (f: LinkedSource) => {
      await git(["branch", HEX_BRANCH, "branch-a"], f.owner);
      await git(["switch", "-q", HEX_BRANCH], f.source);
    }],
  ])("starts when the recorded ref is %s", async (_label, recordedRef, prepare) => {
    const fixture = await makeLinkedSource();
    await prepare(fixture);
    const scope = await seedCompany();
    const started = path.join(fixture.root, "started");
    const seeded = await seedWorkspace({
      scope,
      cwd: fixture.source,
      branchName: recordedRef,
      baseRef: "branch-a",
      projectCwd: null,
      strategyType: "project_primary",
      provisionCommand: "true",
      serviceCommand: httpCommand(started),
    });
    const res = await request(app())
      .post(`/api/execution-workspaces/${seeded.workspaceId}/runtime-services/start`)
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await expect(fs.stat(started)).resolves.toBeTruthy();
  }, 30_000);

  it("starts a project_primary row that never recorded a branch", async () => {
    const fixture = await makeLinkedSource();
    const scope = await seedCompany();
    const started = path.join(fixture.root, "started");
    const seeded = await seedWorkspace({
      scope,
      cwd: fixture.source,
      branchName: null,
      baseRef: "branch-a",
      projectCwd: null,
      strategyType: "project_primary",
      provisionCommand: "true",
      serviceCommand: httpCommand(started),
    });
    const res = await request(app())
      .post(`/api/execution-workspaces/${seeded.workspaceId}/runtime-services/start`)
      .send({});
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await expect(fs.stat(started)).resolves.toBeTruthy();
  }, 30_000);

  it.each([
    {
      label: "a local branch named like a 40-hex commit, checkout on another branch",
      recordedRef: HEX_BRANCH,
      reasonCode: "branch_mismatch",
      prepare: async (f: LinkedSource) => {
        await git(["branch", HEX_BRANCH, "branch-b"], f.owner);
      },
    },
    {
      label: "a detached checkout at a commit that is not the recorded tip",
      recordedRef: "branch-a",
      reasonCode: "detached_head_off_recorded_tip",
      prepare: async (f: LinkedSource) => {
        await git(["checkout", "-q", "--detach", "branch-b"], f.source);
      },
    },
    {
      label: "a recorded branch with no local ref",
      recordedRef: "deleted-topic",
      reasonCode: "recorded_ref_missing",
      prepare: async () => {},
    },
    {
      label: "a local origin/ branch for a recorded branch of the bare name",
      recordedRef: "branch-a",
      reasonCode: "branch_mismatch",
      prepare: async (f: LinkedSource) => {
        await git(["branch", "origin/branch-a", "branch-a"], f.owner);
        await git(["switch", "-q", "origin/branch-a"], f.source);
      },
    },
    {
      label: "a tag ref",
      recordedRef: "v1-tag",
      reasonCode: "recorded_ref_missing",
      prepare: async (f: LinkedSource) => {
        await git(["tag", "v1-tag", "branch-a"], f.owner);
      },
    },
    {
      label: "a deleted branch shadowed by a tag named like its full ref, with HEAD detached at that tag",
      recordedRef: "gone-topic",
      reasonCode: "recorded_ref_missing",
      prepare: async (f: LinkedSource) => {
        // `refs/tags/refs/heads/gone-topic`: revision parsing of
        // `refs/heads/gone-topic` falls back to it when the branch is gone.
        await git(["tag", "refs/heads/gone-topic", "branch-a"], f.owner);
        await git(["checkout", "-q", "--detach", "branch-a"], f.source);
      },
    },
    {
      label: "an unborn branch that HEAD names but no ref holds",
      recordedRef: "unborn-topic",
      reasonCode: "recorded_ref_missing",
      prepare: async (f: LinkedSource) => {
        await git(["checkout", "-q", "--orphan", "unborn-topic"], f.source);
      },
    },
  ])("refuses a start when the recorded ref is $label", async ({ recordedRef, reasonCode, prepare }) => {
    const fixture = await makeLinkedSource();
    await prepare(fixture);
    const headRefBefore = await git(["symbolic-ref", "--quiet", "HEAD"], fixture.source).catch(() => null);
    const headBefore = await git(["rev-parse", "--verify", "--quiet", "HEAD"], fixture.source).catch(() => null);
    const scope = await seedCompany();
    const started = path.join(fixture.root, "started");
    const seeded = await seedWorkspace({
      scope,
      cwd: fixture.source,
      branchName: recordedRef,
      baseRef: "branch-a",
      projectCwd: null,
      strategyType: "project_primary",
      provisionCommand: "true",
      serviceCommand: httpCommand(started),
    });
    const res = await request(app())
      .post(`/api/execution-workspaces/${seeded.workspaceId}/runtime-services/start`)
      .send({});

    expectDriftRefusal(res, reasonCode);
    await expect(fs.stat(started)).rejects.toThrow();
    await expect(git(["symbolic-ref", "--quiet", "HEAD"], fixture.source).catch(() => null))
      .resolves.toBe(headRefBefore);
    await expect(git(["rev-parse", "--verify", "--quiet", "HEAD"], fixture.source).catch(() => null))
      .resolves.toBe(headBefore);
    const row = await db.select({ branchName: executionWorkspaces.branchName })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.workspaceId))
      .then((rows) => rows[0]);
    expect(row?.branchName).toBe(recordedRef);
    const evidence = await operationText(seeded.workspaceId);
    expect(evidence).toContain(reasonCode);
    expect(evidence).toContain(seeded.workspaceId);
    expect(listRuntimeServicePortReservationsForTests()).toEqual([]);
    await expectNoStartingRuntimeRows();
  }, 30_000);

  it("returns the pre-spawn refusal while the start transaction holds the workspace row lock", async () => {
    const fixture = await makeLinkedSource();
    const scope = await seedCompany();
    const started = path.join(fixture.root, "started");
    // Runtime provisioning runs after restore and before the start
    // transaction, so only the pre-spawn check inside that transaction sees it.
    const seeded = await seedWorkspace({
      scope,
      cwd: fixture.source,
      branchName: "branch-a",
      baseRef: "branch-a",
      projectCwd: null,
      strategyType: "project_primary",
      provisionCommand: "true",
      runtimeProvisionCommand: "git checkout -q branch-b",
      serviceCommand: httpCommand(started),
    });
    const res = await request(app())
      .post(`/api/execution-workspaces/${seeded.workspaceId}/runtime-services/start`)
      .timeout({ response: 20_000 })
      .send({});

    expectDriftRefusal(res, "branch_mismatch");
    await expect(fs.stat(started)).rejects.toThrow();
    const evidence = await operationText(seeded.workspaceId);
    expect(evidence).toContain("checkoutBranchDrift");
    expect(evidence).toContain(fixture.commitY);
    expect(listRuntimeServicePortReservationsForTests()).toEqual([]);
    await expectNoStartingRuntimeRows();
  }, 30_000);

  it("does not rebind the recorded branch to the default branch during a managed start", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sup24747-rebind-"));
    tempRoots.push(root);
    const owner = path.join(root, "owner");
    await git(["init", "-q", "-b", "main", owner], root);
    await commitFile(owner, "a.txt");
    await git(["branch", "topic"], owner);
    await git(["checkout", "-q", "-b", "parking"], owner);
    const source = path.join(root, "source");
    await git(["worktree", "add", "-q", source, "topic"], owner);
    // The runtime-owned branch is deleted and the clean worktree sits on the
    // default branch: the shape the default-branch rebind repairs.
    await git(["switch", "-q", "main"], source);
    await git(["branch", "-D", "topic"], owner);
    const scope = await seedCompany();
    const started = path.join(root, "started");
    const seeded = await seedWorkspace({
      scope,
      cwd: source,
      branchName: "topic",
      baseRef: "main",
      projectCwd: owner,
      runtimeOwned: true,
      provisionCommand: "true",
      serviceCommand: httpCommand(started),
    });
    const res = await request(app())
      .post(`/api/execution-workspaces/${seeded.workspaceId}/runtime-services/start`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    await expect(fs.stat(started)).rejects.toThrow();
    const row = await db.select({ branchName: executionWorkspaces.branchName })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.workspaceId))
      .then((rows) => rows[0]);
    expect(row?.branchName).toBe("topic");
  }, 30_000);

  it("refuses a legacy git_worktree row with no recorded branch and names the reprovision remedy", async () => {
    const fixture = await makeLinkedSource();
    const scope = await seedCompany();
    const started = path.join(fixture.root, "started");
    const seeded = await seedWorkspace({
      scope,
      cwd: fixture.source,
      branchName: null,
      baseRef: "branch-a",
      projectCwd: fixture.owner,
      provisionCommand: "true",
      serviceCommand: httpCommand(started),
    });
    const res = await request(app())
      .post(`/api/execution-workspaces/${seeded.workspaceId}/runtime-services/start`)
      .send({});

    expectDriftRefusal(res, "recorded_branch_metadata_missing");
    await expect(fs.stat(started)).rejects.toThrow();
    await expect(git(["symbolic-ref", "--short", "HEAD"], fixture.source)).resolves.toBe("branch-a");
    const evidence = await operationText(seeded.workspaceId);
    expect(evidence).toContain("recorded_branch_metadata_missing");
    expect(evidence).toContain("Reprovision the execution workspace");
    expect(listRuntimeServicePortReservationsForTests()).toEqual([]);
    await expectNoStartingRuntimeRows();
  }, 30_000);

  it.each([
    {
      label: "a checkout drifted to another branch",
      branchName: "branch-a" as string | null,
      strategyType: "project_primary",
      prepare: async (f: LinkedSource) => {
        await git(["switch", "-q", "--ignore-other-worktrees", "branch-b"], f.source);
      },
    },
    {
      label: "a legacy git_worktree row with no recorded branch",
      branchName: null as string | null,
      strategyType: "git_worktree",
      prepare: async () => {},
    },
  ])("still runs a workspace job for $label", async ({ branchName, strategyType, prepare }) => {
    const fixture = await makeLinkedSource();
    await prepare(fixture);
    const headRefBefore = await git(["symbolic-ref", "--quiet", "HEAD"], fixture.source);
    const scope = await seedCompany();
    const marker = path.join(fixture.root, "job-ran");
    const seeded = await seedWorkspace({
      scope,
      cwd: fixture.source,
      branchName,
      baseRef: "branch-a",
      projectCwd: null,
      strategyType,
      provisionCommand: "true",
      workspaceRuntime: {
        commands: [{ id: "mark", name: "mark", kind: "job", command: `touch ${quoteShell(marker)}` }],
      },
    });

    const res = await request(app())
      .post(`/api/execution-workspaces/${seeded.workspaceId}/runtime-commands/run`)
      .send({ workspaceCommandId: "mark" });

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await expect(fs.stat(marker)).resolves.toBeTruthy();
    await expect(git(["symbolic-ref", "--quiet", "HEAD"], fixture.source)).resolves.toBe(headRefBefore);
    const row = await db.select({ branchName: executionWorkspaces.branchName })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, seeded.workspaceId))
      .then((rows) => rows[0]);
    expect(row?.branchName).toBe(branchName);
    expect(await operationText(seeded.workspaceId)).not.toContain("checkoutBranchDrift");
  }, 30_000);

  it.each([
    {
      label: "a defaultRef of origin/main",
      defaultRef: "origin/main",
      prepare: async () => {},
    },
    {
      label: "a primary checkout on a feature branch",
      defaultRef: "branch-a",
      prepare: async (f: LinkedSource) => {
        await git(["switch", "-q", "--ignore-other-worktrees", "branch-b"], f.source);
      },
    },
  ])("starts a project workspace service with $label", async ({ defaultRef, prepare }) => {
    const fixture = await makeLinkedSource();
    await prepare(fixture);
    const headRefBefore = await git(["symbolic-ref", "--quiet", "HEAD"], fixture.source);
    const scope = await seedCompany();
    const started = path.join(fixture.root, "started");
    await db.insert(projectWorkspaces).values({
      id: scope.projectWorkspaceId,
      companyId: scope.companyId,
      projectId: scope.projectId,
      name: "Primary",
      cwd: fixture.source,
      isPrimary: true,
      defaultRef,
      metadata: {
        runtimeConfig: {
          workspaceRuntime: {
            services: [{
              name: "web",
              command: httpCommand(started),
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 50,
              },
              lifecycle: "shared",
              reuseScope: "project_workspace",
              stopPolicy: { type: "manual" },
            }],
          },
        },
      },
    });

    const res = await request(app())
      .post(`/api/projects/${scope.projectId}/workspaces/${scope.projectWorkspaceId}/runtime-services/start`)
      .send({});

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    await expect(fs.stat(started)).resolves.toBeTruthy();
    await expect(git(["symbolic-ref", "--quiet", "HEAD"], fixture.source)).resolves.toBe(headRefBefore);
  }, 30_000);

  describe("a refusal immediately before spawn releases what the start reserved", () => {
    function controlInput(input: {
      scope: CompanyScope;
      fixture: LinkedSource;
      executionWorkspaceId: string;
      service: Record<string, unknown>;
    }) {
      return {
        db,
        actor: { id: null, name: "Board", companyId: input.scope.companyId },
        issue: null,
        workspace: {
          baseCwd: input.fixture.source,
          source: "project_primary" as const,
          projectId: input.scope.projectId,
          workspaceId: null,
          repoUrl: null,
          repoRef: null,
          strategy: "project_primary" as const,
          cwd: input.fixture.source,
          branchName: "branch-a",
          worktreePath: null,
          warnings: [],
          created: false,
          branchCreatedByRuntime: false,
        },
        executionWorkspaceId: input.executionWorkspaceId,
        config: { workspaceRuntime: { services: [input.service] } },
        adapterEnv: {},
        assertRecordedCheckoutBranch: true,
      };
    }

    async function driftedWorkspace() {
      const fixture = await makeLinkedSource();
      // The checkout leaves its recorded branch after restore and provisioning,
      // so only the guard right before spawn can see it.
      await git(["checkout", "-q", "branch-b"], fixture.source);
      const scope = await seedCompany();
      const seeded = await seedWorkspace({
        scope,
        cwd: fixture.source,
        branchName: "branch-a",
        baseRef: "branch-a",
        projectCwd: null,
        strategyType: "project_primary",
      });
      return { fixture, scope, seeded };
    }

    function installFakeBroker(input: { appPort: number; includeHmr: boolean; removeFails?: boolean }) {
      const brokerCalls: string[] = [];
      const reserved = new Map<string, BrokerListenerRequest[]>();
      const broker: BrokerClient = {
        async reserve(runtimeId, requested) {
          brokerCalls.push("reserve");
          const handle = `handle-${runtimeId}`;
          reserved.set(handle, requested);
          return { handle, reservedPorts: requested.map((listener) => listener.port) };
        },
        async expose(_runtimeId, handle) {
          brokerCalls.push("expose");
          return { handle, publicPorts: (reserved.get(handle) ?? []).map((listener) => listener.port) };
        },
        async remove(_runtimeId, handle) {
          brokerCalls.push("remove");
          if (input.removeFails) throw new Error("broker unavailable");
          const listeners = reserved.get(handle) ?? [];
          reserved.delete(handle);
          return { removedPorts: listeners.map((listener) => listener.port) };
        },
        async list() {
          return [];
        },
      };
      setWorkspaceRuntimeExposureDepsForTests({
        broker,
        isPortAvailable: async (port) =>
          port === input.appPort || (input.includeHmr && port === deriveViteHmrPort(input.appPort)),
        isBrokerAvailable: async () => true,
        resolveHostname: async () => "runner.tail123.ts.net",
        probeHealth: async () => true,
        now: () => new Date().toISOString(),
        diagnoseListenerBinds: async () => null,
      });
      return { brokerCalls, reserved };
    }

    async function withHttpsMode<T>(run: () => Promise<T>) {
      const previousHttpsMode = process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS;
      process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS = "auto";
      try {
        return await run();
      } finally {
        if (previousHttpsMode === undefined) delete process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS;
        else process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS = previousHttpsMode;
      }
    }

    async function freeExposureAppPort(offset: number) {
      for (let port = RUNTIME_EXPOSURE_APP_PORT_MIN + offset; port < RUNTIME_EXPOSURE_APP_PORT_MIN + offset + 200; port += 1) {
        const free = await new Promise<boolean>((resolve) => {
          const probe = net.createServer();
          probe.once("error", () => resolve(false));
          probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
        });
        if (free) return port;
      }
      throw new Error("no free exposure app port");
    }

    const exposeConfig = {
      type: "tailscale_https",
      hostname: "auto",
      publicPort: "same",
      includePaperclipViteHmr: false,
      failurePolicy: "fail_closed",
    } as const;

    it("keeps the HTTPS rollback record when runtime provisioning shares its row and removal is pending", async () => {
      await withHttpsMode(async () => {
        const appPort = RUNTIME_EXPOSURE_APP_PORT_MIN + 720;
        const broker = installFakeBroker({ appPort, includeHmr: true, removeFails: true });
        const { fixture, scope, seeded } = await driftedWorkspace();
        const started = path.join(fixture.root, "started");
        const input = controlInput({
          scope,
          fixture,
          executionWorkspaceId: seeded.workspaceId,
          service: {
            name: "preview",
            command: httpCommand(started),
            port: { type: "auto", envKey: "PORT" },
            readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 10, intervalMs: 50 },
            expose: exposeConfig,
          },
        });

        await expect(startRuntimeServicesForWorkspaceControl({
          ...input,
          config: { ...input.config, runtimeProvisionCommand: "true" },
        })).rejects.toThrow(/Managed checkout branch drift/);

        expect(broker.brokerCalls).toContain("remove");
        const rows = await db.select().from(workspaceRuntimeServices)
          .where(eq(workspaceRuntimeServices.executionWorkspaceId, seeded.workspaceId));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.status).toBe("stopped");
        // The broker still holds the reservation, so its handle must survive.
        expect((rows[0]?.exposure as { state?: string } | null)?.state).toBe("cleanup_pending");
        expect(rows[0]?.exposureHandle).toBeTruthy();
      });
    }, 30_000);

    it("refuses readiness-time drift before the broker publishes the backend", async () => {
      await withHttpsMode(async () => {
        const appPort = await freeExposureAppPort(800);
        const broker = installFakeBroker({ appPort, includeHmr: true });
        const fixture = await makeLinkedSource();
        const scope = await seedCompany();
        const seeded = await seedWorkspace({
          scope,
          cwd: fixture.source,
          branchName: "branch-a",
          baseRef: "branch-a",
          projectCwd: null,
          strategyType: "project_primary",
        });
        const barrierServer = net.createServer();
        await new Promise<void>((resolve) => barrierServer.listen(0, "127.0.0.1", () => resolve()));
        const barrierAddress = barrierServer.address();
        if (!barrierAddress || typeof barrierAddress === "string") throw new Error("barrier port missing");
        const connected = new Promise<net.Socket>((resolve) => barrierServer.once("connection", resolve));
        try {
          const pending = startRuntimeServicesForWorkspaceControl(controlInput({
            scope,
            fixture,
            executionWorkspaceId: seeded.workspaceId,
            service: {
              name: "preview",
              command: barrierCommand({ barrierPort: barrierAddress.port, exitAfterRelease: false }),
              port: { type: "auto", envKey: "PORT" },
              readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 15, intervalMs: 50 },
              expose: exposeConfig,
            },
          }));
          pending.catch(() => undefined);
          const socket = await Promise.race([
            connected,
            pending.then(() => {
              throw new Error("start finished before the service reached the barrier");
            }),
          ]);
          await git(["checkout", "-q", "branch-b"], fixture.source);
          socket.write("x");
          await expect(pending).rejects.toThrow(/Managed checkout branch drift/);
          socket.destroy();
        } finally {
          barrierServer.close();
        }
        expect(broker.brokerCalls).toContain("reserve");
        expect(broker.brokerCalls).not.toContain("expose");
      });
    }, 45_000);

    it("keeps the original startup error when the drift recheck cannot read the checkout", async () => {
      const fixture = await makeLinkedSource();
      const scope = await seedCompany();
      const seeded = await seedWorkspace({
        scope,
        cwd: fixture.source,
        branchName: "branch-a",
        baseRef: "branch-a",
        projectCwd: null,
        strategyType: "project_primary",
      });
      try {
        // The service locks the checkout's parent directory and exits before
        // readiness, so the recheck in the failure path gets EACCES.
        await expect(startRuntimeServicesForWorkspaceControl(controlInput({
          scope,
          fixture,
          executionWorkspaceId: seeded.workspaceId,
          service: {
            name: "web",
            command: `chmod 000 ${quoteShell(fixture.root)}; exit 2`,
            port: { type: "auto" },
            readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 10, intervalMs: 50 },
            lifecycle: "shared",
            reuseScope: "execution_workspace",
            stopPolicy: { type: "manual" },
          },
        }))).rejects.toThrow(/exited before readiness/);
      } finally {
        await fs.chmod(fixture.root, 0o755);
      }
    }, 30_000);

    it("releases the in-process port claim", async () => {
      const { fixture, scope, seeded } = await driftedWorkspace();
      const started = path.join(fixture.root, "started");

      await expect(startRuntimeServicesForWorkspaceControl(controlInput({
        scope,
        fixture,
        executionWorkspaceId: seeded.workspaceId,
        service: {
          name: "web",
          command: httpCommand(started),
          port: { type: "auto" },
          readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 10, intervalMs: 50 },
          lifecycle: "shared",
          reuseScope: "execution_workspace",
          stopPolicy: { type: "manual" },
        },
      }))).rejects.toThrow(/Managed checkout branch drift/);

      await expect(fs.stat(started)).rejects.toThrow();
      expect(listRuntimeServicePortReservationsForTests()).toEqual([]);
      await expectNoStartingRuntimeRows();
    }, 30_000);

    it("removes the HTTPS exposure and does not leave its record in starting", async () => {
      const previousHttpsMode = process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS;
      process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS = "auto";
      try {
        // The refusal comes before any bind, so the synthetic host only has to
        // offer one pair; no listener ever opens on it.
        const appPort = RUNTIME_EXPOSURE_APP_PORT_MIN + 700;
        const brokerCalls: string[] = [];
        const reserved = new Map<string, BrokerListenerRequest[]>();
        const broker: BrokerClient = {
          async reserve(runtimeId, requested) {
            brokerCalls.push("reserve");
            const handle = `handle-${runtimeId}`;
            reserved.set(handle, requested);
            return { handle, reservedPorts: requested.map((listener) => listener.port) };
          },
          async expose(_runtimeId, handle) {
            brokerCalls.push("expose");
            return { handle, publicPorts: (reserved.get(handle) ?? []).map((listener) => listener.port) };
          },
          async remove(_runtimeId, handle) {
            brokerCalls.push("remove");
            const listeners = reserved.get(handle) ?? [];
            reserved.delete(handle);
            return { removedPorts: listeners.map((listener) => listener.port) };
          },
          async list() {
            return [];
          },
        };
        setWorkspaceRuntimeExposureDepsForTests({
          broker,
          isPortAvailable: async (port) => port === appPort || port === deriveViteHmrPort(appPort),
          isBrokerAvailable: async () => true,
          resolveHostname: async () => "runner.tail123.ts.net",
          probeHealth: async () => true,
          now: () => new Date().toISOString(),
          diagnoseListenerBinds: async () => null,
        });
        const { fixture, scope, seeded } = await driftedWorkspace();
        const started = path.join(fixture.root, "started");

        await expect(startRuntimeServicesForWorkspaceControl(controlInput({
          scope,
          fixture,
          executionWorkspaceId: seeded.workspaceId,
          service: {
            name: "preview",
            command: httpCommand(started),
            port: { type: "auto", envKey: "PORT" },
            readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 10, intervalMs: 50 },
            expose: {
              type: "tailscale_https",
              hostname: "auto",
              publicPort: "same",
              includePaperclipViteHmr: true,
              failurePolicy: "fail_closed",
            },
          },
        }))).rejects.toThrow(/Managed checkout branch drift/);

        await expect(fs.stat(started)).rejects.toThrow();
        expect(brokerCalls).toContain("reserve");
        expect(brokerCalls).toContain("remove");
        expect(brokerCalls).not.toContain("expose");
        expect(reserved.size).toBe(0);
        const rows = await db.select().from(workspaceRuntimeServices)
          .where(eq(workspaceRuntimeServices.executionWorkspaceId, seeded.workspaceId));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.status).toBe("stopped");
        expect((rows[0]?.exposure as { state?: string } | null)?.state).toBe("removed");
        expect(listRuntimeServicePortReservationsForTests()).toEqual([]);
      } finally {
        if (previousHttpsMode === undefined) delete process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS;
        else process.env.PAPERCLIP_MANAGED_RUNTIME_HTTPS = previousHttpsMode;
      }
    }, 30_000);
  });

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
      let pid!: number;
      let res!: request.Response;
      try {
        const pending = request(app())
          .post(`/api/execution-workspaces/${seeded.workspaceId}/runtime-services/start`)
          .send({});
        pid = await Promise.race([
          barrier.pid,
          pending.then(async (early) => {
            throw new Error(
              `service never reached the barrier: ${early.status} ${JSON.stringify(early.body)} ${await operationText(seeded.workspaceId)}`,
            );
          }),
        ]);
        await git(["checkout", "-q", "branch-b"], fixture.source);
        barrier.release();
        res = await pending;
      } finally {
        barrier.close();
      }
      expectDriftRefusal(res, "branch_mismatch");
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
