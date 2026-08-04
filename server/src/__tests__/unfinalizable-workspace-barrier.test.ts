import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

const mockConfig = vi.hoisted(() => ({
  trust: "local_trusted",
  bind: "loopback",
  appUrl: "http://localhost:3000",
  host: "localhost",
  port: 3000,
  secret: "test-secret",
  db: { connectionString: "postgres://localhost:5432/test" },
  s3: { region: "us-east-1", bucket: "test", endpoint: "http://localhost:9000" },
  runLogStore: { type: "s3", bucket: "test-logs" },
  assets: { bucket: "test-assets" },
  onboarding: {},
  allowedOrigins: ["http://localhost:3000"],
}));
vi.mock("../config.ts", () => ({ loadConfig: () => mockConfig }));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres unfinalizable-workspace-barrier tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("unfinalizable-workspace-barrier", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-unfinalizable-barrier-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(workspaceOperations);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test Project",
      createdAt: new Date(),
      updatedAt: new Date(),
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
    return { companyId, agentId, projectId };
  }

  async function seedExecutionWorkspace({
    companyId,
    projectId,
    executionWorkspaceId,
  }: {
    companyId: string;
    projectId: string;
    executionWorkspaceId: string;
  }) {
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      mode: "agent",
      strategyType: "git_worktree",
      name: "Test Workspace",
    });
  }

  async function seedBlocker({
    companyId,
    projectId,
    executionWorkspaceId,
    status,
    checkoutRunId = null,
    executionRunId = null,
  }: {
    companyId: string;
    projectId: string;
    executionWorkspaceId: string;
    status: string;
    checkoutRunId?: string | null;
    executionRunId?: string | null;
  }) {
    const blockerId = randomUUID();
    await seedExecutionWorkspace({ companyId, projectId, executionWorkspaceId });
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Done blocker",
      status,
      priority: "high",
      executionWorkspaceId,
      checkoutRunId,
      executionRunId,
    });
    return blockerId;
  }

  async function seedDependent({
    companyId,
    agentId,
    blockerId,
    status,
  }: {
    companyId: string;
    agentId: string;
    blockerId: string;
    status: string;
  }) {
    const dependentId = randomUUID();
    await db.insert(issues).values({
      id: dependentId,
      companyId,
      title: `Dependent (${status})`,
      status,
      priority: "high",
      assigneeAgentId: agentId,
    });
    await db.insert(issueRelations).values({
      id: randomUUID(),
      companyId,
      issueId: blockerId,
      relatedIssueId: dependentId,
      type: "blocks",
    });
    return dependentId;
  }

  async function seedFailedFinalizeOp({
    companyId,
    executionWorkspaceId,
    heartbeatRunId = null,
  }: {
    companyId: string;
    executionWorkspaceId: string;
    heartbeatRunId?: string | null;
  }) {
    await db.insert(workspaceOperations).values({
      id: randomUUID(),
      companyId,
      executionWorkspaceId,
      heartbeatRunId,
      phase: "workspace_finalize",
      status: "failed",
      startedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function seedSucceededFinalizeOp({
    companyId,
    executionWorkspaceId,
    heartbeatRunId = null,
  }: {
    companyId: string;
    executionWorkspaceId: string;
    heartbeatRunId?: string | null;
  }) {
    await db.insert(workspaceOperations).values({
      id: randomUUID(),
      companyId,
      executionWorkspaceId,
      heartbeatRunId,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function seedActiveRun({
    companyId,
    agentId,
    executionWorkspaceId,
  }: {
    companyId: string;
    agentId: string;
    executionWorkspaceId: string;
  }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
    });
    await db.insert(workspaceOperations).values({
      id: randomUUID(),
      companyId,
      executionWorkspaceId,
      heartbeatRunId: runId,
      phase: "checkout",
      status: "succeeded",
      startedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return runId;
  }

  it("reports a blocked dependent whose done blocker has permanently failed finalize", async () => {
    const { companyId, agentId, projectId } = await seedCompanyAndAgent();
    const wsId = randomUUID();
    const blockerId = await seedBlocker({ companyId, projectId, executionWorkspaceId: wsId, status: "done" });
    const dependentId = await seedDependent({ companyId, agentId, blockerId, status: "blocked" });
    await seedFailedFinalizeOp({ companyId, executionWorkspaceId: wsId });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.listPermanentlyUnfinalizableBlockers({ companyId });

    expect(result.reported).toBe(1);
    expect(result.issueIds).toEqual([dependentId]);
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    const finding = result.findings.find((f) => f.dependentIssueId === dependentId);
    expect(finding).toBeDefined();
    expect(finding!.blockerIssueId).toBe(blockerId);
    expect(finding!.executionWorkspaceId).toBe(wsId);
    expect(finding!.latestOp).toEqual(
      expect.objectContaining({ phase: "workspace_finalize", status: "failed" }),
    );
  });

  it("reports a todo dependent gated by a permanently-unfinalizable blocker", async () => {
    const { companyId, agentId, projectId } = await seedCompanyAndAgent();
    const wsId = randomUUID();
    const blockerId = await seedBlocker({ companyId, projectId, executionWorkspaceId: wsId, status: "done" });
    const dependentId = await seedDependent({ companyId, agentId, blockerId, status: "todo" });
    await seedFailedFinalizeOp({ companyId, executionWorkspaceId: wsId });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.listPermanentlyUnfinalizableBlockers({ companyId });

    expect(result.reported).toBe(1);
    expect(result.issueIds).toEqual([dependentId]);
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    const finding = result.findings.find((f) => f.dependentIssueId === dependentId);
    expect(finding).toBeDefined();
  });

  it("excludes a dependent whose blocker has a live run on the workspace", async () => {
    const { companyId, agentId, projectId } = await seedCompanyAndAgent();
    const wsId = randomUUID();
    const blockerId = await seedBlocker({
      companyId,
      projectId,
      executionWorkspaceId: wsId,
      status: "done",
      checkoutRunId: null,
      executionRunId: null,
    });
    const dependentId = await seedDependent({ companyId, agentId, blockerId, status: "blocked" });
    await seedFailedFinalizeOp({ companyId, executionWorkspaceId: wsId });
    await seedActiveRun({ companyId, agentId, executionWorkspaceId: wsId });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.listPermanentlyUnfinalizableBlockers({ companyId });

    expect(result.reported).toBe(0);
    expect(result.issueIds).toEqual([]);
  });

  it("excludes a dependent whose done blocker has a successful finalize", async () => {
    const { companyId, agentId, projectId } = await seedCompanyAndAgent();
    const wsId = randomUUID();
    const blockerId = await seedBlocker({ companyId, projectId, executionWorkspaceId: wsId, status: "done" });
    const dependentId = await seedDependent({ companyId, agentId, blockerId, status: "blocked" });
    await seedSucceededFinalizeOp({ companyId, executionWorkspaceId: wsId });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.listPermanentlyUnfinalizableBlockers({ companyId });

    expect(result.reported).toBe(0);
    expect(result.issueIds).toEqual([]);
  });

  it("does not write issue status or wake anything (report-only)", async () => {
    const { companyId, agentId, projectId } = await seedCompanyAndAgent();
    const wsId = randomUUID();
    const blockerId = await seedBlocker({ companyId, projectId, executionWorkspaceId: wsId, status: "done" });
    const dependentId = await seedDependent({ companyId, agentId, blockerId, status: "blocked" });
    await seedFailedFinalizeOp({ companyId, executionWorkspaceId: wsId });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.listPermanentlyUnfinalizableBlockers({ companyId });

    expect(result.reported).toBe(1);

    const issueRow = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, dependentId))
      .then((rows) => rows[0]);
    expect(issueRow?.status).toBe("blocked");
  });

  it("logs an activity log entry when reporting", async () => {
    const { companyId, agentId, projectId } = await seedCompanyAndAgent();
    const wsId = randomUUID();
    const blockerId = await seedBlocker({ companyId, projectId, executionWorkspaceId: wsId, status: "done" });
    const dependentId = await seedDependent({ companyId, agentId, blockerId, status: "blocked" });
    await seedFailedFinalizeOp({ companyId, executionWorkspaceId: wsId });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.listPermanentlyUnfinalizableBlockers({ companyId });

    expect(result.reported).toBe(1);

    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, dependentId))
      .then((rows) => rows[0]);
    expect(audit?.action).toBe("issue.permanently_unfinalizable_blocker_detected");
    expect((audit?.details as Record<string, unknown> | null)?.source).toBe(
      "recovery.list_permanently_unfinalizable_blockers",
    );
  });
});
