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
import { issueService } from "../services/issues.js";

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
    const result = await heartbeat.reconcileUnfinalizableWorkspaceBarriers({ companyId });

    expect(result.reported).toBe(1);
    expect(result.findings.length).toBe(1);
    expect(result.findings.length).toBe(1);
    const finding = result.findings[0];
    expect(finding).toBeDefined();
    expect(finding.blockerIssueId).toBe(blockerId);
    expect(finding.executionWorkspaceId).toBe(wsId);
    expect(finding.gatedDependentIssueIds).toContain(dependentId)
  });

  it("reports a todo dependent gated by a permanently-unfinalizable blocker", async () => {
    const { companyId, agentId, projectId } = await seedCompanyAndAgent();
    const wsId = randomUUID();
    const blockerId = await seedBlocker({ companyId, projectId, executionWorkspaceId: wsId, status: "done" });
    const dependentId = await seedDependent({ companyId, agentId, blockerId, status: "todo" });
    await seedFailedFinalizeOp({ companyId, executionWorkspaceId: wsId });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileUnfinalizableWorkspaceBarriers({ companyId });

    expect(result.reported).toBe(1);
    expect(result.findings.length).toBe(1);
    expect(result.findings.length).toBe(1);
    const finding = result.findings[0];
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
    const result = await heartbeat.reconcileUnfinalizableWorkspaceBarriers({ companyId });

    expect(result.reported).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("excludes a dependent whose done blocker has a successful finalize", async () => {
    const { companyId, agentId, projectId } = await seedCompanyAndAgent();
    const wsId = randomUUID();
    const blockerId = await seedBlocker({ companyId, projectId, executionWorkspaceId: wsId, status: "done" });
    const dependentId = await seedDependent({ companyId, agentId, blockerId, status: "blocked" });
    await seedSucceededFinalizeOp({ companyId, executionWorkspaceId: wsId });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileUnfinalizableWorkspaceBarriers({ companyId });

    expect(result.reported).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("does not write issue status or wake anything (report-only)", async () => {
    const { companyId, agentId, projectId } = await seedCompanyAndAgent();
    const wsId = randomUUID();
    const blockerId = await seedBlocker({ companyId, projectId, executionWorkspaceId: wsId, status: "done" });
    const dependentId = await seedDependent({ companyId, agentId, blockerId, status: "blocked" });
    await seedFailedFinalizeOp({ companyId, executionWorkspaceId: wsId });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileUnfinalizableWorkspaceBarriers({ companyId });

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
    const result = await heartbeat.reconcileUnfinalizableWorkspaceBarriers({ companyId });

    expect(result.reported).toBe(1);

    const audit = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, wsId))
      .then((rows) => rows[0]);
    expect(audit?.action).toBe("issue.unfinalizable_workspace_barrier_detected");
    expect((audit?.details as Record<string, unknown> | null)?.source).toBe(
      "recovery.reconcile_unfinalizable_workspace_barriers",
    );
  });

  it("reports a dependent whose blocker is cancelled (terminal) with a failed finalize", async () => {
    const { companyId, agentId, projectId } = await seedCompanyAndAgent();
    const wsId = randomUUID();
    const blockerId = await seedBlocker({
      companyId,
      projectId,
      executionWorkspaceId: wsId,
      status: "cancelled",
    });
    const dependentId = await seedDependent({ companyId, agentId, blockerId, status: "blocked" });
    await seedFailedFinalizeOp({ companyId, executionWorkspaceId: wsId });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileUnfinalizableWorkspaceBarriers({ companyId });

    expect(result.reported).toBe(1);
    expect(result.findings.length).toBe(1);
    const finding = result.findings[0];
    expect(finding).toBeDefined();
    expect(finding.blockerIssueId).toBe(blockerId);
    expect(finding.executionWorkspaceId).toBe(wsId);
    expect(finding.gatedDependentIssueIds).toContain(dependentId);
  });

  it("does not report a blocker with no workspace operations at all", async () => {
    const { companyId, agentId, projectId } = await seedCompanyAndAgent();
    const wsId = randomUUID();
    const blockerId = await seedBlocker({ companyId, projectId, executionWorkspaceId: wsId, status: "done" });
    const dependentId = await seedDependent({ companyId, agentId, blockerId, status: "blocked" });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileUnfinalizableWorkspaceBarriers({ companyId });

    expect(result.reported).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("ignores a terminal issue with no execution workspace without dropping real findings", async () => {
    // The blocker query filters `isNotNull(executionWorkspaceId)` in SQL, but the column type
    // stays `string | null`. Narrowing that type must not change which rows survive: a terminal
    // issue that never had a workspace is not a finalize barrier and must stay excluded, while a
    // genuine unfinalizable blocker in the same company must still report.
    const { companyId, agentId, projectId } = await seedCompanyAndAgent();

    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Terminal issue that never had a workspace",
      status: "done",
      priority: "high",
      executionWorkspaceId: null,
    });

    const wsId = randomUUID();
    const blockerId = await seedBlocker({ companyId, projectId, executionWorkspaceId: wsId, status: "done" });
    await seedFailedFinalizeOp({ companyId, executionWorkspaceId: wsId });
    await seedDependent({ companyId, agentId, blockerId, status: "blocked" });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileUnfinalizableWorkspaceBarriers({ companyId });

    expect(result.reported).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.executionWorkspaceId).toBe(wsId);
  });

  it("does not report a blocker whose latest op is a provision-phase succeeded op", async () => {
    const { companyId, agentId, projectId } = await seedCompanyAndAgent();
    const wsId = randomUUID();
    const blockerId = await seedBlocker({ companyId, projectId, executionWorkspaceId: wsId, status: "done" });
    const dependentId = await seedDependent({ companyId, agentId, blockerId, status: "blocked" });
    await db.insert(workspaceOperations).values({
      id: randomUUID(),
      companyId,
      executionWorkspaceId: wsId,
      phase: "provision",
      status: "succeeded",
      startedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileUnfinalizableWorkspaceBarriers({ companyId });

    expect(result.reported).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("keeps listDependencyReadiness unchanged for a permanently-unfinalizable blocker (gate still holds)", async () => {
    const { companyId, agentId, projectId } = await seedCompanyAndAgent();
    const wsId = randomUUID();
    const blockerId = await seedBlocker({ companyId, projectId, executionWorkspaceId: wsId, status: "done" });
    const dependentId = await seedDependent({ companyId, agentId, blockerId, status: "blocked" });
    await seedFailedFinalizeOp({ companyId, executionWorkspaceId: wsId });

    const svc = issueService(db);
    const readinessMap = await svc.listDependencyReadiness(companyId, [dependentId]);
    const readiness = readinessMap.get(dependentId);
    expect(readiness).toBeDefined();
    expect(readiness!.blockerIssueIds).toContain(blockerId);
    expect(readiness!.unresolvedBlockerIssueIds).toContain(blockerId);
    expect(readiness!.unresolvedBlockerCount).toBe(1);
    expect(readiness!.pendingFinalizeBlockerIssueIds).toContain(blockerId);
    expect(readiness!.allBlockersDone).toBe(false);
    expect(readiness!.isDependencyReady).toBe(false);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileUnfinalizableWorkspaceBarriers({ companyId });
    expect(result.reported).toBe(1);

    const readinessMapAfter = await svc.listDependencyReadiness(companyId, [dependentId]);
    const readinessAfter = readinessMapAfter.get(dependentId);
    expect(readinessAfter).toBeDefined();
    expect(readinessAfter!.blockerIssueIds).toEqual(readiness!.blockerIssueIds);
    expect(readinessAfter!.unresolvedBlockerIssueIds).toEqual(readiness!.unresolvedBlockerIssueIds);
    expect(readinessAfter!.unresolvedBlockerCount).toBe(readiness!.unresolvedBlockerCount);
    expect(readinessAfter!.pendingFinalizeBlockerIssueIds).toEqual(readiness!.pendingFinalizeBlockerIssueIds);
    expect(readinessAfter!.allBlockersDone).toBe(readiness!.allBlockersDone);
    expect(readinessAfter!.isDependencyReady).toBe(readiness!.isDependencyReady);
  });

  it("performs no writes to workspace_operations or issues (report-only)", async () => {
    const { companyId, agentId, projectId } = await seedCompanyAndAgent();
    const wsId = randomUUID();
    const blockerId = await seedBlocker({ companyId, projectId, executionWorkspaceId: wsId, status: "done" });
    const dependentId = await seedDependent({ companyId, agentId, blockerId, status: "blocked" });
    await seedFailedFinalizeOp({ companyId, executionWorkspaceId: wsId });

    const opsBefore = await db
      .select({ id: workspaceOperations.id })
      .from(workspaceOperations)
      .where(eq(workspaceOperations.executionWorkspaceId, wsId));
    const blockerBefore = await db
      .select({ id: issues.id, status: issues.status, executionWorkspaceId: issues.executionWorkspaceId })
      .from(issues)
      .where(eq(issues.id, blockerId))
      .then((rows) => rows[0]);
    const dependentBefore = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(eq(issues.id, dependentId))
      .then((rows) => rows[0]);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileUnfinalizableWorkspaceBarriers({ companyId });
    expect(result.reported).toBe(1);

    const opsAfter = await db
      .select({ id: workspaceOperations.id })
      .from(workspaceOperations)
      .where(eq(workspaceOperations.executionWorkspaceId, wsId));
    expect(opsAfter.length).toBe(opsBefore.length);

    const blockerAfter = await db
      .select({ id: issues.id, status: issues.status, executionWorkspaceId: issues.executionWorkspaceId })
      .from(issues)
      .where(eq(issues.id, blockerId))
      .then((rows) => rows[0]);
    expect(blockerAfter).toEqual(blockerBefore);

    const dependentAfter = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(eq(issues.id, dependentId))
      .then((rows) => rows[0]);
    expect(dependentAfter).toEqual(dependentBefore);
  });

  it("reports exactly one finding for the e0036165 fixture (SUP-10197 + four gated dependents)", async () => {
    const { companyId, agentId, projectId } = await seedCompanyAndAgent();
    const wsId = "e0036165-c342-4eb9-a382-8da6ed199ea0";
    const blockerId = await seedBlocker({ companyId, projectId, executionWorkspaceId: wsId, status: "done" });
    const depBlocked1 = await seedDependent({ companyId, agentId, blockerId, status: "blocked" });
    const depTodo = await seedDependent({ companyId, agentId, blockerId, status: "todo" });
    const depBlocked2 = await seedDependent({ companyId, agentId, blockerId, status: "blocked" });
    const depBlocked3 = await seedDependent({ companyId, agentId, blockerId, status: "blocked" });

    const finalizeStartedAt = new Date("2026-08-02T18:34:17.182Z");
    await db.insert(workspaceOperations).values([
      {
        id: randomUUID(),
        companyId,
        executionWorkspaceId: wsId,
        phase: "checkout",
        status: "succeeded",
        startedAt: new Date("2026-08-02T17:39:52Z"),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: randomUUID(),
        companyId,
        executionWorkspaceId: wsId,
        phase: "workspace_finalize",
        status: "failed",
        startedAt: finalizeStartedAt,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reconcileUnfinalizableWorkspaceBarriers({ companyId });

    expect(result.reported).toBe(1);
    expect(result.findings.length).toBe(1);
    const finding = result.findings[0];
    expect(finding).toBeDefined();
    expect(finding.blockerIssueId).toBe(blockerId);
    expect(finding.executionWorkspaceId).toBe(wsId);
    expect(finding.gatedDependentIssueIds).toHaveLength(4);
    expect(finding.gatedDependentIssueIds).toEqual(
      expect.arrayContaining([depBlocked1, depTodo, depBlocked2, depBlocked3]),
    );

    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, wsId))
      .then((rows) => rows[0]);
    expect(audit?.action).toBe("issue.unfinalizable_workspace_barrier_detected");
    const details = audit?.details as Record<string, unknown> | null;
    expect(details?.latestOp).toBeDefined();
    expect((details?.latestOp as Record<string, unknown>)?.phase).toBe("workspace_finalize");
    expect((details?.latestOp as Record<string, unknown>)?.status).toBe("failed");
    expect((details?.latestOp as Record<string, unknown>)?.startedAt).toBe(finalizeStartedAt.toISOString());
  });
});
