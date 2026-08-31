import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  activityLog,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueInboxArchives,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { logger } from "../middleware/logger.js";
import { issueRoutes } from "../routes/issues.js";
import { buildPaperclipWakePayload } from "../services/heartbeat.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { recoveryService } from "../services/recovery/service.js";
import { noticeMetadataReferencesRecoveryAction } from "../services/recovery/successful-run-handoff.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function makeRecoveryActionRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-05-09T19:30:00.000Z");
  return {
    id: randomUUID(),
    companyId: "company-1",
    sourceIssueId: "source-1",
    recoveryIssueId: null,
    kind: "missing_disposition",
    status: "active",
    ownerType: "agent",
    ownerAgentId: "agent-1",
    ownerUserId: null,
    previousOwnerAgentId: null,
    returnOwnerAgentId: null,
    cause: "successful_run_missing_issue_disposition",
    fingerprint: "missing-disposition:fingerprint",
    evidence: {},
    nextAction: "Choose a valid issue disposition.",
    wakePolicy: null,
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: null,
    timeoutAt: null,
    lastAttemptAt: now,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("issueRecoveryActionService", () => {
  it("does not reactivate an action resolved between the active read and update", async () => {
    const existingRow = makeRecoveryActionRow({ id: "existing-action", attemptCount: 1 });
    const createdRow = makeRecoveryActionRow({ id: "new-action", attemptCount: 1 });
    const selectResults = [[existingRow], []];

    const makeSelectQuery = (rows: unknown[]) => ({
      from() {
        return this;
      },
      where() {
        return this;
      },
      orderBy() {
        return this;
      },
      limit() {
        return Promise.resolve(rows);
      },
    });

    const fakeDb = {
      select: vi.fn(() => makeSelectQuery(selectResults.shift() ?? [])),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => []),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [createdRow]),
        })),
      })),
    };

    const result = await issueRecoveryActionService(fakeDb as never).upsertSourceScoped({
      companyId: "company-1",
      sourceIssueId: "source-1",
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: "agent-1",
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      nextAction: "Choose a valid issue disposition.",
    });

    expect(result).toMatchObject({ id: "new-action", status: "active" });
    expect(fakeDb.update).toHaveBeenCalledTimes(1);
    expect(fakeDb.insert).toHaveBeenCalledTimes(1);
  });
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue recovery action tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue recovery actions", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-recovery-actions-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(environments);
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `RA${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Implement backend recovery",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    return { companyId, managerId, coderId, sourceIssueId, prefix, sourceIssue: sourceIssue! };
  }

  async function seedHeartbeatRun(input: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId?: string;
    status?: string;
  }) {
    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "manual",
      status: input.status ?? "running",
      startedAt: new Date("2026-05-13T18:00:00.000Z"),
      contextSnapshot: input.issueId ? { issueId: input.issueId } : undefined,
    });
  }

  // Backlog + unassigned so it never enters reconcileStrandedAssignedIssues' own candidate scan.
  async function seedUnresolvedBlocker(input: { companyId: string; prefix: string; relatedIssueId: string }) {
    const blockerIssueId = randomUUID();
    const issueNumber = 1000 + Math.floor(Math.random() * 900000);
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId: input.companyId,
      title: "Real dependency blocking the source issue",
      status: "backlog",
      priority: "medium",
      issueNumber,
      identifier: `${input.prefix}-${issueNumber}`,
    });
    await db.insert(issueRelations).values({
      companyId: input.companyId,
      issueId: blockerIssueId,
      relatedIssueId: input.relatedIssueId,
      type: "blocks",
    });
    return blockerIssueId;
  }

  function createApp(
    actor: any = { type: "board", source: "local_implicit" },
    opts: Parameters<typeof issueRoutes>[2] = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, opts));
    app.use(errorHandler);
    return app;
  }

  it("upserts one active source-scoped action per issue and keeps company scoping explicit", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);

    const first = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });
    const second = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-2" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });

    expect(second.id).toBe(first.id);
    expect(second.attemptCount).toBe(2);
    expect(second.evidence).toMatchObject({ latestRunId: "run-2" });
    expect(await svc.getActiveForIssue(companyId, sourceIssueId)).toMatchObject({ id: first.id });
    expect(await svc.getActiveForIssue(randomUUID(), sourceIssueId)).toBeNull();
  });

  it("does not resurrect an exhausted action via upsertSourceScoped", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);
    const actionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: actionId,
      companyId,
      sourceIssueId,
      recoveryIssueId: null,
      kind: "stranded_assigned_issue",
      status: "escalated",
      ownerType: "board",
      ownerAgentId: null,
      ownerUserId: null,
      previousOwnerAgentId: managerId,
      returnOwnerAgentId: null,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
      monitorPolicy: null,
      attemptCount: 5,
      maxAttempts: null,
      timeoutAt: null,
      lastAttemptAt: new Date("2026-05-09T19:30:00.000Z"),
      outcome: "exhausted",
      resolutionNote: null,
      resolvedAt: null,
    });

    const result = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-2" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });

    expect(result.id).toBe(actionId);
    expect(result.status).toBe("escalated");
    expect(result.outcome).toBe("exhausted");
    expect(result.attemptCount).toBe(5);

    const row = await db
      .select({
        status: issueRecoveryActions.status,
        outcome: issueRecoveryActions.outcome,
        attemptCount: issueRecoveryActions.attemptCount,
      })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId))
      .then((rows) => rows[0]);
    expect(row).toMatchObject({
      status: "escalated",
      outcome: "exhausted",
      attemptCount: 5,
    });
  });

  it("emits the exhaustion comment at most once across sweep + producer upsert cycles", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const staleAt = new Date(Date.now() - 30 * 60 * 1000);
    const actionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: actionId,
      companyId,
      sourceIssueId,
      recoveryIssueId: null,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: managerId,
      ownerUserId: null,
      previousOwnerAgentId: null,
      returnOwnerAgentId: null,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner", reason: "test" },
      monitorPolicy: null,
      attemptCount: 5,
      maxAttempts: null,
      timeoutAt: null,
      lastAttemptAt: staleAt,
    });

    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
    const svc = issueRecoveryActionService(db);

    const first = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60 * 1000 });
    expect(first.maxAttemptsReached).toBe(1);

    const upserted = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-2" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });
    expect(upserted.status).toBe("escalated");
    expect(upserted.outcome).toBe("exhausted");

    const second = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60 * 1000 });
    expect(second.maxAttemptsReached).toBe(0);

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, sourceIssueId));
    const exhaustionComments = comments.filter((c) => (c.body ?? "").includes("exhausted its attempt ceiling"));
    expect(exhaustionComments).toHaveLength(1);
  });

  async function seedExhaustedSweepCandidate(input: { companyId: string; managerId: string; sourceIssueId: string; fingerprint: string }) {
    const staleAt = new Date(Date.now() - 30 * 60 * 1000);
    const actionId = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id: actionId,
      companyId: input.companyId,
      sourceIssueId: input.sourceIssueId,
      recoveryIssueId: null,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "agent",
      ownerAgentId: input.managerId,
      ownerUserId: null,
      previousOwnerAgentId: null,
      returnOwnerAgentId: null,
      cause: "stranded_assigned_issue",
      fingerprint: input.fingerprint,
      evidence: { latestRunId: "run-1" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner", reason: "test" },
      monitorPolicy: null,
      attemptCount: 5,
      maxAttempts: null,
      timeoutAt: null,
      lastAttemptAt: staleAt,
    });
    return { actionId, staleAt };
  }

  it("keeps a swept-exhausted action sticky against ordinary resolution and refuses to re-mint a post-ceiling action", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const fingerprint = "recovery:stuck:fingerprint";
    const { actionId } = await seedExhaustedSweepCandidate({ companyId, managerId, sourceIssueId, fingerprint });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
    const svc = issueRecoveryActionService(db);

    const sweep = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60 * 1000 });
    expect(sweep.maxAttemptsReached).toBe(1);

    // Ordinary (non-board) resolution, e.g. source revalidation, must not clear the exhaustion.
    const cleared = await svc.resolveActiveForIssue({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      fingerprint,
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Source revalidation claims the issue recovered.",
    });
    expect(cleared).toBeNull();

    const [row] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId));
    expect(row).toMatchObject({ status: "escalated", outcome: "exhausted", attemptCount: 5 });

    // A producer upsert for the same fingerprint must return the terminal row, not mint a new one.
    const upserted = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint,
      evidence: { latestRunId: "run-2" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });
    expect(upserted.id).toBe(actionId);
    expect(upserted.status).toBe("escalated");
    expect(upserted.outcome).toBe("exhausted");
    expect(upserted.attemptCount).toBe(5);

    // Repeated sweeps must not post further exhaustion comments.
    const repeat = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60 * 1000 });
    expect(repeat.maxAttemptsReached).toBe(0);
    const again = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60 * 1000 });
    expect(again.maxAttemptsReached).toBe(0);

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, sourceIssueId));
    expect(comments.filter((c) => (c.body ?? "").includes("exhausted its attempt ceiling"))).toHaveLength(1);
  });

  it("lets an explicit board resolution clear a swept-exhausted action and re-mint a fresh attempt budget", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const fingerprint = "recovery:board:fingerprint";
    const { actionId } = await seedExhaustedSweepCandidate({ companyId, managerId, sourceIssueId, fingerprint });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
    const svc = issueRecoveryActionService(db);

    const sweep = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60 * 1000 });
    expect(sweep.maxAttemptsReached).toBe(1);

    const cleared = await svc.resolveActiveForIssue({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      fingerprint,
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Board reviewed; recovery no longer needed.",
      boardResolution: true,
    });
    expect(cleared?.id).toBe(actionId);
    expect(cleared?.status).toBe("cancelled");
    expect(await svc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();

    const upserted = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint,
      evidence: { latestRunId: "run-2" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });
    expect(upserted.id).not.toBe(actionId);
    expect(upserted.status).toBe("active");
    expect(upserted.attemptCount).toBe(1);
    expect(upserted.outcome).toBeNull();
  });

  it("lets the resolve endpoint clear a swept-exhausted action so a fresh action can be minted", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const fingerprint = "recovery:endpoint:fingerprint";
    const { actionId } = await seedExhaustedSweepCandidate({ companyId, managerId, sourceIssueId, fingerprint });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const sweep = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60 * 1000 });
    expect(sweep.maxAttemptsReached).toBe(1);

    const app = createApp();
    const res = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        outcome: "cancelled",
        sourceIssueStatus: "done",
        resolutionNote: "Board cleared the escalation.",
      })
      .expect(200);
    expect(res.body.recoveryAction).toMatchObject({
      id: actionId,
      status: "cancelled",
      outcome: "cancelled",
    });
    expect(res.body.issue).toMatchObject({ id: sourceIssueId, status: "done", activeRecoveryAction: null });

    const upserted = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint,
      evidence: { latestRunId: "run-2" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });
    expect(upserted.id).not.toBe(actionId);
    expect(upserted.status).toBe("active");
    expect(upserted.attemptCount).toBe(1);
  });

  it("preserves legacy recovery ownership when new evidence is folded into an active action", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);
    const legacy = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "process_lost",
      fingerprint: "legacy-recovery",
      evidence: { latestRunId: "run-1" },
      nextAction: "Repair the execution path.",
      wakePolicy: { type: "bounded_recovery_owner", ownerAgentId: managerId, attempt: 1, maxAttempts: 5 },
      attemptCount: 1,
      maxAttempts: 5,
    });

    const updated = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "process_lost",
      fingerprint: "legacy-recovery",
      evidence: { latestRunId: "run-2" },
      evidenceOnCreate: { routingPolicy: "board_escalation_no_takeover_v1" },
      nextAction: "Board decision required.",
      wakePolicy: { type: "board_escalation" },
      preserveExistingOwner: true,
    });

    expect(updated).toMatchObject({
      id: legacy.id,
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      attemptCount: 2,
      maxAttempts: 5,
      nextAction: "Repair the execution path.",
      evidence: expect.objectContaining({ latestRunId: "run-2" }),
      wakePolicy: expect.objectContaining({ type: "bounded_recovery_owner" }),
    });
    expect(updated.evidence).not.toHaveProperty("routingPolicy");
  });

  it("escalates stranded assigned work into a source action instead of a recovery issue", async () => {
    const { companyId, coderId, sourceIssue, prefix } = await seedCompany();
    const blockerIssueId = await seedUnresolvedBlocker({ companyId, prefix, relatedIssueId: sourceIssue.id });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const latestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    await Promise.all([
      recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        comment: "Automatic continuation recovery failed.",
      }),
      recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        comment: "Automatic continuation recovery failed.",
      }),
    ]);

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(updatedIssue).toMatchObject({
      status: "blocked",
    });
    const relations = await db
      .select()
      .from(issueRelations)
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.relatedIssueId, sourceIssue.id)));
    expect(relations.map((row) => row.issueId)).toEqual([blockerIssueId]);
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
    // The fork routes a stranded action to an owner agent and wakes it; upstream's
    // `board_escalation_no_takeover_v1` neither reassigns nor wakes.
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
    expect(enqueueWakeup.mock.calls[0]?.[1]?.payload).toMatchObject({
      issueId: sourceIssue.id,
      sourceIssueId: sourceIssue.id,
      recoveryCause: "stranded_assigned_issue",
    });
  });

  // Model the production payload: `requestedRef` keeps the operator spelling,
  // and the fingerprint carries the canonical remote ref. Two equivalent
  // spellings of one remote branch share `identityRef`, so they share one
  // fingerprint. A different branch gets a different `identityRef`.
  const makeUnresolvedBaseRefRun = (agentId: string, issueId: string) =>
    (requestedRef: string, identityRef: string) =>
      ({
        id: randomUUID(),
        agentId,
        status: "failed",
        error: `Configured workspace base ref "${requestedRef}" did not resolve to a commit on origin after an authenticated fetch.`,
        errorCode: "configuration_incomplete",
        contextSnapshot: { issueId },
        livenessState: "needs_followup",
        resultJson: {
          configurationIncomplete: {
            reason: "workspace_base_ref_unresolved",
            requestedRef,
            attemptedRefs: [identityRef],
            fingerprint: `workspace_base_ref:${identityRef}`,
          },
        },
      }) as const;

  it("bounds configuration-incomplete recovery by the unresolved base ref fingerprint", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const makeRun = makeUnresolvedBaseRefRun(coderId, sourceIssue.id);

    // Two reconciliations with the same unresolved ref reuse one active action.
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      cause: "configuration_incomplete",
      status: "active",
      attemptCount: 2,
    });
    // The fingerprint carries the canonical remote ref, so the same branch stays
    // one action and a different branch would make a distinct fingerprint.
    expect(actions[0]?.fingerprint).toBe(
      `source_scoped_recovery:${sourceIssue.companyId}:${sourceIssue.id}:configuration_incomplete:workspace_base_ref:origin/fix/foo`,
    );
  });

  it("keeps equivalent spellings of one unresolved base ref under one recovery identity", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const makeRun = makeUnresolvedBaseRefRun(coderId, sourceIssue.id);

    // The operator retries the same remote branch under two spellings. Both map
    // to the canonical `origin/fix/foo` identity, so recovery must not reset the
    // attempt count or post a second notice.
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("origin/fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    // One identity, one active action, the attempt count advances.
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      cause: "configuration_incomplete",
      status: "active",
      attemptCount: 2,
    });
    expect(actions[0]?.fingerprint).toBe(
      `source_scoped_recovery:${sourceIssue.companyId}:${sourceIssue.id}:configuration_incomplete:workspace_base_ref:origin/fix/foo`,
    );

    // The operator gets one notice, bound to the one action.
    const notices = await db
      .select({ metadata: issueComments.metadata })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, sourceIssue.id),
          eq(issueComments.authorType, "system"),
        ),
      );
    expect(
      notices.filter((row) =>
        noticeMetadataReferencesRecoveryAction(row.metadata, actions[0]!.id),
      ),
    ).toHaveLength(1);
  });

  it("gives a distinct recovery identity and a new operator notice when the unresolved base ref changes", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const makeRun = makeUnresolvedBaseRefRun(coderId, sourceIssue.id);

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/bar", "origin/fix/bar"),
      recoveryCause: "configuration_incomplete",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    // The prior ref keeps its own record and the new ref gets a fresh identity.
    expect(actions).toHaveLength(2);
    const priorAction = actions.find((row) =>
      row.fingerprint.endsWith("workspace_base_ref:origin/fix/foo"),
    );
    const newAction = actions.find((row) =>
      row.fingerprint.endsWith("workspace_base_ref:origin/fix/bar"),
    );
    expect(priorAction?.status).toBe("cancelled");
    expect(priorAction?.outcome).toBe("cancelled");
    expect(newAction?.status).toBe("active");
    expect(newAction?.attemptCount).toBe(1);
    expect(newAction?.id).not.toBe(priorAction?.id);

    // The operator gets one notice per distinct ref, each bound to its action.
    const systemComments = await db
      .select({ metadata: issueComments.metadata })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, sourceIssue.id),
          eq(issueComments.authorType, "system"),
        ),
      );
    expect(
      systemComments.some((row) =>
        noticeMetadataReferencesRecoveryAction(row.metadata, priorAction!.id),
      ),
    ).toBe(true);
    expect(
      systemComments.some((row) =>
        noticeMetadataReferencesRecoveryAction(row.metadata, newAction!.id),
      ),
    ).toBe(true);
  });

  it("blocks with an empty blocker set when escalating stranded assigned work, because the recovery action owns the wake", async () => {
    const { companyId, coderId, sourceIssue } = await seedCompany();
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const latestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    const updated = await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun,
      comment: "Automatic continuation recovery failed.",
    });

    // The escalation records an owned recovery action before it writes. That action —
    // and the #46 sweep behind it — is the wake path, so the empty issue-level blocker
    // set is not grounds to skip the write. Skipping here would leave the issue
    // in_progress and re-dispatchable, which is what containment must prevent.
    expect(updated).not.toBeNull();
    const [afterEscalate] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterEscalate?.status).toBe("blocked");
    const relations = await db
      .select()
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, sourceIssue.id));
    expect(relations).toHaveLength(0);
    const ownedActions = await db
      .select()
      .from(issueRecoveryActions)
      .where(
        and(
          eq(issueRecoveryActions.companyId, companyId),
          eq(issueRecoveryActions.sourceIssueId, sourceIssue.id),
          inArray(issueRecoveryActions.status, ["active", "escalated"]),
        ),
      );
    expect(ownedActions.length).toBeGreaterThan(0);
    expect(infoSpy).toHaveBeenCalledWith(
      {
        issueId: sourceIssue.id,
        identifier: sourceIssue.identifier,
        source: "recovery.reconcile_stranded_assigned_issue",
        previousStatus: "in_progress",
      },
      expect.any(String),
    );
    infoSpy.mockRestore();
  });

  it("blocks a recovery issue in place with an empty blocker set and logs it for the zero-blocker heal", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const recoveryIssueId = randomUUID();
    await db.insert(issues).values({
      id: recoveryIssueId,
      companyId,
      title: "Recover stalled issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: managerId,
      parentId: sourceIssueId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
      originKind: "stranded_issue_recovery",
      originId: sourceIssueId,
      originFingerprint: `stranded_issue_recovery:${sourceIssueId}`,
    });
    const [recoveryIssue] = await db.select().from(issues).where(eq(issues.id, recoveryIssueId));
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const updated = await recovery.escalateStrandedAssignedIssue({
      issue: recoveryIssue!,
      previousStatus: "in_progress",
      latestRun: {
        id: randomUUID(),
        agentId: managerId,
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
      },
    });

    // No issue-level blocker and no recovery action owns the recovery issue itself, so the
    // dependency-wake backstop's zero-blocker heal (#41) is what wakes it. The write must
    // still happen — skipping it would leave the recovery issue dispatchable.
    expect(updated).not.toBeNull();
    const [afterEscalate] = await db.select().from(issues).where(eq(issues.id, recoveryIssueId));
    expect(afterEscalate?.status).toBe("blocked");
    const relations = await db
      .select()
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, recoveryIssueId));
    expect(relations).toHaveLength(0);
    expect(infoSpy).toHaveBeenCalledWith(
      {
        issueId: recoveryIssueId,
        identifier: `${prefix}-2`,
        source: "recovery.reconcile_stranded_recovery_issue",
        previousStatus: "in_progress",
      },
      expect.any(String),
    );
    infoSpy.mockRestore();
  });

  it("re-blocks with an empty blocker set when a recovery owner re-takes an issue it already owns", async () => {
    const { companyId, coderId, sourceIssue, prefix } = await seedCompany();
    const blockerIssueId = await seedUnresolvedBlocker({ companyId, prefix, relatedIssueId: sourceIssue.id });
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    const enqueueWakeup = vi.fn(async () => {
      // Simulate a race: the blocker resolves and the issue leaves "blocked" between the
      // site-2 write and the reblock check, so the reblock attempt sees an empty blocker set.
      await db.delete(issueRelations).where(eq(issueRelations.issueId, blockerIssueId));
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, sourceIssue.id));
      return null;
    });
    const recovery = recoveryService(db, { enqueueWakeup });
    const latestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "process lost",
      errorCode: "process_lost",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    const updated = await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun,
    });

    // The blocker resolved mid-flight, so the reblock sees an empty blocker set — but the
    // recovery owner still holds the issue, so the reblock proceeds rather than leaving the
    // issue in_progress for the dispatcher to pick up again.
    expect(updated).not.toBeNull();
    const [afterEscalate] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterEscalate?.status).toBe("blocked");
    expect(infoSpy).toHaveBeenCalledWith(
      {
        issueId: sourceIssue.id,
        identifier: sourceIssue.identifier,
        source: "recovery.reconcile_stranded_assigned_issue",
        previousStatus: "in_progress",
      },
      expect.any(String),
    );
    infoSpy.mockRestore();
  });

  it.each([
    ["process_lost", undefined, "coder"],
    ["adapter_failed", "successful_run_missing_state", "coder"],
    ["codex_output_inactivity_monitor", undefined, "coder"],
    ["workspace_validation_failed", "workspace_validation_failed", "manager"],
    ["adapter_failed", undefined, "manager"],
  ] as const)(
    "routes %s recovery through the cause-keyed playbook",
    async (errorCode, explicitCause, expectedOwner) => {
      const { companyId, managerId, coderId, sourceIssue, prefix } = await seedCompany();
      await seedUnresolvedBlocker({ companyId, prefix, relatedIssueId: sourceIssue.id });
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });
      const latestRun = {
        id: randomUUID(),
        agentId: coderId,
        status: errorCode === "adapter_failed" && explicitCause === "successful_run_missing_state"
          ? "succeeded"
          : "failed",
        error: `${errorCode} failure`,
        errorCode,
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
        resultJson: errorCode === "workspace_validation_failed"
          ? { workspaceValidation: { reason: "missing_workspace", fingerprint: "workspace:test" } }
          : null,
      } as const;

      await recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        ...(explicitCause ? { recoveryCause: explicitCause } : {}),
      });

      const expectedOwnerId = expectedOwner === "coder" ? coderId : managerId;
      const [action] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
      expect(action?.ownerAgentId).toBe(expectedOwnerId);
      expect(enqueueWakeup).toHaveBeenCalledWith(
        expectedOwnerId,
        expect.objectContaining({
          reason: "source_scoped_recovery_action",
          payload: expect.objectContaining({
            recoveryCause: explicitCause ?? (errorCode === "adapter_failed" ? "stranded_assigned_issue" : errorCode),
          }),
        }),
      );
    },
  );

  it("stands down while the latest run was cancelled by a board operator", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "cancelled",
      error: "Cancelled by a board operator",
      errorCode: "cancelled",
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "board-user" },
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(1);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("stands down after an operator interrupt cancellation", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "cancelled",
      error: "Interrupted by board comment",
      errorCode: "operator_interrupted",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("still recovers system-cancelled runs with no operator attribution", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "cancelled",
      error: "Cancelled because the workspace lease expired",
      errorCode: "cancelled",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(0);
    // The system-cancelled run still flows into the pre-existing recovery
    // behavior (a continuation requeue or escalation — either produces a
    // wake), proving the stand-down is scoped to operator attribution.
    expect(enqueueWakeup).toHaveBeenCalled();
  });

  it("schedules a provider-quota monitor for the original assignee without creating recovery work", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      error: "You've hit your usage limit for GPT-5. Try again at 12:00 AM (UTC).",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
      monitorScheduledBy: "assignee",
      monitorNotes: "Provider usage quota reached; retry the original assignee at the provider reset time.",
    });
    expect(updatedIssue?.monitorNextCheckAt).toBeInstanceOf(Date);
    expect(updatedIssue?.executionPolicy).toMatchObject({
      monitor: {
        serviceName: "AI provider quota",
        externalRef: runId,
        maxAttempts: null,
        recoveryPolicy: "wake_owner",
      },
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun).toMatchObject({ errorCode: "provider_quota" });
    expect(updatedRun?.resultJson).toMatchObject({ errorFamily: "provider_quota" });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const secondResult = await recovery.reconcileStrandedAssignedIssues();
    expect(secondResult).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
  });

  it("schedules another provider-quota monitor after a prior quota monitor fired", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ monitorAttemptCount: 1 }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T21:00:00.000Z"),
      finishedAt: new Date("2026-07-15T21:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue?.executionPolicy).toMatchObject({
      monitor: {
        maxAttempts: null,
        externalRef: runId,
      },
    });
  });

  it("skips provider-quota monitor scheduling for todo issues without aborting reconciliation", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not create takeover recovery when a quota monitor cannot be scheduled", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("schedules a quota monitor for a cross-agent active review participant", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const [reviewIssueBeforeRecovery] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(reviewIssueBeforeRecovery).toMatchObject({
      assigneeAgentId: coderId,
      executionState: {
        currentParticipant: { type: "agent", agentId: managerId },
        returnAssignee: { type: "agent", agentId: coderId },
      },
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 1, reviewParticipantRequeued: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: expect.any(Date),
      monitorNotes: "Provider usage quota reached; retry the active review participant after the default recovery backoff.",
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("provider_quota");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not restamp an in_review quota monitor when the assignee has a newer terminal run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const participantRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: participantRunId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const firstResult = await recovery.reconcileStrandedAssignedIssues();

    expect(firstResult).toMatchObject({ providerQuotaMonitored: 1 });
    const [monitoredIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    const firstNextCheckAt = monitoredIssue?.monitorNextCheckAt;
    expect(firstNextCheckAt).toBeInstanceOf(Date);
    expect(monitoredIssue?.executionPolicy).toMatchObject({
      monitor: {
        serviceName: "AI provider quota",
        externalRef: participantRunId,
      },
    });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "automation",
      status: "failed",
      error: "Stale assignee wake fired after the issue entered review.",
      errorCode: "issue_assignee_changed",
      startedAt: new Date("2026-07-15T20:02:00.000Z"),
      finishedAt: new Date("2026-07-15T20:03:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });

    const secondResult = await recovery.reconcileStrandedAssignedIssues();

    expect(secondResult).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [unchangedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(unchangedIssue?.monitorNextCheckAt?.getTime()).toBe(firstNextCheckAt?.getTime());
    expect(unchangedIssue?.executionPolicy).toMatchObject({
      monitor: {
        serviceName: "AI provider quota",
        externalRef: participantRunId,
      },
    });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("classifies review recovery from the active participant run instead of a newer assignee run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const participantRunId = randomUUID();
    const assigneeRunId = randomUUID();
    await db.insert(heartbeatRuns).values([{
      id: participantRunId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      error: "review process exited unexpectedly",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    }, {
      id: assigneeRunId,
      companyId,
      agentId: coderId,
      invocationSource: "automation",
      status: "failed",
      error: "You've hit your usage limit. Try again at 11:00 PM (UTC)",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:02:00.000Z"),
      finishedAt: new Date("2026-07-15T20:03:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    }]);
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, reviewParticipantRequeued: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [assigneeRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, assigneeRunId));
    expect(assigneeRun?.errorCode).toBe("adapter_failed");
    expect(enqueueWakeup).toHaveBeenCalledWith(managerId, expect.objectContaining({
      reason: "execution_review_participant_recovery",
      payload: expect.objectContaining({ issueId: sourceIssueId, retryOfRunId: participantRunId }),
    }));
  });

  it("blocks a cross-agent review participant with incomplete configuration", async () => {
    const { companyId, managerId, coderId, sourceIssueId, prefix } = await seedCompany();
    await seedUnresolvedBlocker({ companyId, prefix, relatedIssueId: sourceIssueId });
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      error: "model_not_found: requested review model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 1, reviewParticipantRequeued: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    // SUP-13526: the recovery reassignment to managerId is refused because the
    // manager is the sole participant of their own incomplete review stage;
    // the issue still blocks but keeps its original assignee.
    expect(updatedIssue).toMatchObject({
      status: "blocked",
      assigneeAgentId: coderId,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("configuration_incomplete");
    const [action] = await db.select().from(issueRecoveryActions);
    expect(action).toMatchObject({
      sourceIssueId,
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      cause: "configuration_incomplete",
      recoveryIssueId: null,
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("refuses to assign an unassigned blocker whose review stage only its creator can clear", async () => {
    const { companyId, coderId, sourceIssueId, prefix } = await seedCompany();
    const blockerId = randomUUID();
    const stageId = randomUUID();
    const issueNumber = 1000 + Math.floor(Math.random() * 900000);
    // SUP-13526: the creator (coder) is the sole participant of the blocker's
    // own incomplete review stage. Assigning the creator to the blocker would
    // make the stage self-satisfiable, so the recovery path must refuse.
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Orphan blocker with a self-satisfiable review stage",
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByAgentId: coderId,
      issueNumber,
      identifier: `${prefix}-${issueNumber}`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: coderId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        completedStageIds: [],
        skippedStageIds: [],
      },
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ orphanBlockersAssigned: 0 });
    const [blocker] = await db.select().from(issues).where(eq(issues.id, blockerId));
    expect(blocker?.assigneeAgentId).toBeNull();
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("still assigns an unassigned blocker whose review stage does not require the creator", async () => {
    const { companyId, managerId, coderId, sourceIssueId, prefix } = await seedCompany();
    const blockerId = randomUUID();
    const stageId = randomUUID();
    const issueNumber = 1000 + Math.floor(Math.random() * 900000);
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Orphan blocker with an independent review stage",
      status: "todo",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
      createdByAgentId: coderId,
      issueNumber,
      identifier: `${prefix}-${issueNumber}`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        completedStageIds: [],
        skippedStageIds: [],
      },
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ orphanBlockersAssigned: 1 });
    const [blocker] = await db.select().from(issues).where(eq(issues.id, blockerId));
    expect(blocker?.assigneeAgentId).toBe(coderId);
    expect(enqueueWakeup).toHaveBeenCalledWith(
      coderId,
      expect.objectContaining({
        reason: "issue_assigned",
        payload: expect.objectContaining({ mutation: "unassigned_blocker_recovery" }),
      }),
    );
  });

  it("uses the default quota backoff when the provider does not state a reset time", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
      monitorNotes: "Provider usage quota reached; retry the original assignee after the default recovery backoff.",
    });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
  });

  it("classifies model lookup failures as configuration incomplete without waking a recovery owner", async () => {
    const { companyId, coderId, sourceIssueId, prefix } = await seedCompany();
    await seedUnresolvedBlocker({ companyId, prefix, relatedIssueId: sourceIssueId });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      error: "model_not_found: requested model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 1, skipped: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue?.status).toBe("blocked");
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("configuration_incomplete");
    const [action] = await db.select().from(issueRecoveryActions);
    expect(action).toMatchObject({
      sourceIssueId,
      cause: "configuration_incomplete",
      recoveryIssueId: null,
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not classify stale configuration failures from a non-assignee run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "manual",
      status: "failed",
      error: "model_not_found: previous assignee model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("reuses the same source-scoped action when latest run IDs change while the cause stays the same", async () => {
    const { companyId, managerId, coderId, sourceIssue, prefix } = await seedCompany();
    await seedUnresolvedBlocker({ companyId, prefix, relatedIssueId: sourceIssue.id });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;
    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Automatic continuation recovery failed.",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });
    expect(actionRows[0]?.evidence).toMatchObject({ latestRunId: secondLatestRun.id });
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
    expect(enqueueWakeup.mock.calls[1]?.[1]?.payload).toMatchObject({
      issueId: sourceIssue.id,
      sourceIssueId: sourceIssue.id,
      strandedRunId: secondLatestRun.id,
      recoveryCause: "stranded_assigned_issue",
    });
  });

  it("deduplicates workspace-incoherence recovery actions by the typed workspace fingerprint", async () => {
    const { companyId, coderId, sourceIssue, prefix } = await seedCompany();
    await seedUnresolvedBlocker({ companyId, prefix, relatedIssueId: sourceIssue.id });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const workspaceFingerprint = `workspace_incoherence:v1:sha256:${"a".repeat(64)}`;
    const workspaceValidation = {
      reason: "git_worktree_branch_incoherence",
      fingerprint: workspaceFingerprint,
      sourceIssueId: sourceIssue.id,
      sourceIdentifier: sourceIssue.identifier,
      executionWorkspaceId: "execution-workspace-1",
      expectedBranch: "PAP-1-expected",
      actualBranch: "PAP-1-publish",
      cleanliness: "dirty",
      provenance: {
        expectedBranchExists: true,
        actualBranchExists: true,
        expectedHeadSha: "1111111111111111111111111111111111111111",
        actualHeadSha: "2222222222222222222222222222222222222222",
        sameHead: false,
      },
      safeRepair: {
        eligible: false,
        attempted: false,
        succeeded: false,
        reason: "worktree is not clean",
      },
    };
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "workspace branch mismatch",
      errorCode: "workspace_validation_failed",
      contextSnapshot: {},
      livenessState: "failed",
      resultJson: { workspaceValidation },
    } as const;
    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Workspace failed validation.",
      recoveryCause: "workspace_validation_failed",
    });
    // Prove dedupe uses the structured recovery-action reference rather than
    // depending only on the legacy body marker.
    await db
      .update(issueComments)
      .set({ body: "Workspace recovery was already escalated." })
      .where(eq(issueComments.issueId, sourceIssue.id));
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Workspace failed validation.",
      recoveryCause: "workspace_validation_failed",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "workspace_validation",
      cause: "workspace_validation_failed",
      status: "active",
      attemptCount: 2,
      fingerprint: expect.stringContaining(workspaceFingerprint),
      evidence: expect.objectContaining({
        latestRunId: secondLatestRun.id,
        latestRunErrorCode: "workspace_validation_failed",
        workspaceValidation: expect.objectContaining({
          reason: "git_worktree_branch_incoherence",
          fingerprint: workspaceFingerprint,
          sourceIssueId: sourceIssue.id,
          executionWorkspaceId: "execution-workspace-1",
          expectedBranch: "PAP-1-expected",
          actualBranch: "PAP-1-publish",
          cleanliness: "dirty",
        }),
      }),
      nextAction: expect.stringContaining("git worktree branch incoherence"),
      wakePolicy: expect.objectContaining({
        type: "wake_owner",
        reason: "source_scoped_recovery_action",
        ownerAgentId: expect.any(String),
      }),
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const escalationComments = comments.filter((comment) =>
      noticeMetadataReferencesRecoveryAction(comment.metadata, actionRows[0]!.id),
    );
    expect(escalationComments).toHaveLength(1);
    expect(escalationComments[0]?.presentation).toMatchObject({
      kind: "system_notice",
      tone: "danger",
      title: "Workspace validation failed",
    });
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
    expect(enqueueWakeup).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        reason: "source_scoped_recovery_action",
        payload: expect.objectContaining({ recoveryCause: "workspace_validation_failed" }),
      }),
    );
    expect(escalationComments).toHaveLength(1);
    expect(escalationComments[0]?.presentation).toMatchObject({
      kind: "system_notice",
      tone: "danger",
      title: "Workspace validation failed",
    });
  });

  // SUP-13090: SUP-12986/SUP-12996 minted a fresh workspace_validation action every ~8s for
  // hours while `evidence.failureSummary` read only the "withheld" placeholder, so the real
  // cause (ERR_PNPM_LOCKFILE_CONFIG_MISMATCH) was unreadable from the API.
  it("surfaces the workspace validation reason and cause in evidence.failureSummary", async () => {
    const { sourceIssue, coderId, prefix, companyId } = await seedCompany();
    await seedUnresolvedBlocker({ companyId, prefix, relatedIssueId: sourceIssue.id });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
    const cause =
      'Execution workspace provision command "corepack enable && pnpm install --frozen-lockfile --prefer-offline" failed:  ERR_PNPM_LOCKFILE_CONFIG_MISMATCH  Cannot proceed with the frozen installation.';

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: {
        id: randomUUID(),
        agentId: coderId,
        status: "failed",
        error: "workspace reuse failed",
        errorCode: "workspace_validation_failed",
        contextSnapshot: {},
        livenessState: "failed",
        resultJson: {
          workspaceValidation: {
            reason: "inherited_workspace_reuse_failed",
            executionWorkspaceId: "execution-workspace-1",
            cause,
          },
        },
      },
      comment: "Workspace failed validation.",
      recoveryCause: "workspace_validation_failed",
    });

    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    const failureSummary = (action?.evidence as Record<string, unknown> | null)?.failureSummary;
    expect(failureSummary).toBe(`inherited_workspace_reuse_failed: ${cause}`);
    expect(failureSummary).not.toMatch(/withheld/);
  });

  // Control: with no structured payload the placeholder must survive — it is what keeps
  // agent transcript content out of the issue thread.
  it("keeps the withheld placeholder when the run recorded no workspace validation payload", async () => {
    const { sourceIssue, coderId, prefix, companyId } = await seedCompany();
    await seedUnresolvedBlocker({ companyId, prefix, relatedIssueId: sourceIssue.id });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: {
        id: randomUUID(),
        agentId: coderId,
        status: "failed",
        error: "adapter died",
        errorCode: "adapter_failed",
        contextSnapshot: {},
        livenessState: "failed",
        resultJson: {},
      },
      comment: "Run failed.",
    });

    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect((action?.evidence as Record<string, unknown> | null)?.failureSummary).toMatch(/withheld/);
  });

  it("keeps the source issue blocked when source-scoped wakeup is claimed synchronously", async () => {
    const { companyId, managerId, coderId, sourceIssue, prefix } = await seedCompany();
    await seedUnresolvedBlocker({ companyId, prefix, relatedIssueId: sourceIssue.id });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, managerId));
    const enqueueWakeup = vi.fn(async () => {
      await db
        .update(issues)
        .set({ status: "in_progress" })
        .where(eq(issues.id, sourceIssue.id));
      return null;
    });
    const recovery = recoveryService(db, { enqueueWakeup });
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const [afterFirst] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterFirst?.status).toBe("blocked");
    expect(afterFirst?.assigneeAgentId).toBe(coderId);

    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });
    const [afterSecond] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterSecond?.status).toBe("blocked");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    expect(comments).toHaveLength(1);
    // Dedupe for structured notices is metadata-based: the short body no longer
    // carries the `Recovery action: \`id\`` marker line.
    expect(comments[0]?.body).not.toContain("Recovery action:");
    expect(noticeMetadataReferencesRecoveryAction(comments[0]?.metadata, actionRows[0]!.id)).toBe(true);
    expect(comments[0]?.presentation).toMatchObject({ kind: "system_notice", tone: "danger" });
  });

  it("does not create nested recovery artifacts when issue-backed fallback work itself fails", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const recoveryIssueId = randomUUID();
    await db.insert(issues).values({
      id: recoveryIssueId,
      companyId,
      title: "Recover stalled issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: managerId,
      parentId: sourceIssueId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
      originKind: "stranded_issue_recovery",
      originId: sourceIssueId,
      originFingerprint: `stranded_issue_recovery:${sourceIssueId}`,
    });
    await seedUnresolvedBlocker({ companyId, prefix, relatedIssueId: recoveryIssueId });
    const [recoveryIssue] = await db.select().from(issues).where(eq(issues.id, recoveryIssueId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await recovery.escalateStrandedAssignedIssue({
      issue: recoveryIssue!,
      previousStatus: "in_progress",
      latestRun: {
        id: randomUUID(),
        agentId: managerId,
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
      },
    });

    const actionRows = await db.select().from(issueRecoveryActions);
    expect(actionRows).toHaveLength(0);
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(1);
    expect(recoveryIssues[0]?.status).toBe("blocked");
  });

  it("exposes active recovery actions on the issue read API", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toMatchObject({
      id: action.id,
      sourceIssueId,
      kind: "missing_disposition",
      ownerAgentId: managerId,
    });

    const list = await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions`).expect(200);
    expect(list.body.active).toMatchObject({ id: action.id });
    expect(list.body.actions).toHaveLength(1);
    expect(list.body.actions[0].id).toBe(action.id);
  });

  it("lists retired recovery actions on the issue read API so exhaustion is visible", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    await recoveryActionSvc.resolveActiveForIssue({
      companyId,
      sourceIssueId,
      actionId: action.id,
      status: "resolved",
      outcome: "restored",
      resolutionNote: "Resolved.",
    });
    const app = createApp();

    const list = await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions`).expect(200);
    expect(list.body.active).toBeNull();
    expect(list.body.actions).toHaveLength(1);
    expect(list.body.actions[0]).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "restored",
    });
  });

  it("projects recovery action metadata into the structured wake payload", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:wake-payload",
      evidence: {
        failureSummary: "Worktree branch does not match the pinned branch.",
        routingFallbackReason: null,
      },
      nextAction: "Repair the worktree, then return the issue to the coder.",
      wakePolicy: { type: "wake_owner" },
      maxAttempts: 3,
    });

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId: sourceIssueId,
        wakeReason: "source_scoped_recovery_action",
        recoveryActionId: action.id,
        recoveryCause: action.cause,
      },
    });

    expect(payload?.recovery).toEqual({
      cause: "workspace_validation_failed",
      failureSummary: "Worktree branch does not match the pinned branch.",
      originalAssignee: { id: coderId, name: "Coder" },
      attemptCount: 1,
      maxAttempts: 3,
      nextAction: "Repair the worktree, then return the issue to the coder.",
      routingFallbackReason: null,
    });
  });

  it("resolves an active recovery action and removes it from active projections", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Operator confirmed the source issue is complete.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "done",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "owner_completed",
      resolutionNote: "Operator confirmed the source issue is complete.",
    });
    expect(resolved.body.recoveryAction.resolvedAt).toBeTruthy();
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
    expect(
      await db
        .select()
        .from(issueInboxArchives)
        .where(eq(issueInboxArchives.issueId, sourceIssueId)),
    ).toHaveLength(1);

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["issue.updated", "issue.recovery_action_resolved"]),
    );
  });

  it("wakes dependents blocked on the source issue when recovery resolution closes it", async () => {
    const { companyId, managerId, coderId, sourceIssueId, prefix } = await seedCompany();
    const dependentIssueId = randomUUID();
    await db.insert(issues).values({
      id: dependentIssueId,
      companyId,
      title: "Dependent work",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: sourceIssueId,
      relatedIssueId: dependentIssueId,
      type: "blocks",
    });
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:dependent-cascade",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    // Hand the source issue to the board so the assignee clause of
    // assertRecoveryActionAuthority cannot fire: managerId gets through only as the
    // recovery action's owner. A board caller proves nothing about owner authority.
    await db
      .update(issues)
      .set({ assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const wakeCalls: Array<{ agentId: string; wakeup: any }> = [];
    const runId = randomUUID();
    const app = createApp(
      { type: "agent", agentId: managerId, companyId, runId, source: "agent_jwt" },
      {
        recoveryActionEnqueueWakeup: (async (agentId: string, wakeup: any) => {
          wakeCalls.push({ agentId, wakeup });
          return null;
        }) as any,
      },
    );
    await seedHeartbeatRun({ companyId, agentId: managerId, runId, issueId: sourceIssueId });

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Owner confirmed the source issue is complete.",
      })
      .expect(200);

    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "owner_completed",
      resolutionNote: "Owner confirmed the source issue is complete.",
    });

    const dependencyWakes = wakeCalls.filter(
      (call) => call.wakeup?.reason === "issue_blockers_resolved",
    );
    expect(dependencyWakes).toHaveLength(1);
    expect(dependencyWakes[0]!.agentId).toBe(coderId);
    expect(dependencyWakes[0]!.wakeup).toMatchObject({
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      // Upstream re-keyed this wake as
      // `issue_blockers_resolved:state:<dependent>:<generation>:<hash>`; the
      // dependent id is the stable part, and this test is about the cascade
      // firing once, not about the key's exact shape.
      idempotencyKey: expect.stringContaining(`issue_blockers_resolved:state:${dependentIssueId}:`),
      requestedByActorType: "agent",
      requestedByActorId: managerId,
      payload: {
        issueId: dependentIssueId,
        resolvedBlockerIssueId: sourceIssueId,
        mutation: "recovery_action_resolution",
      },
      contextSnapshot: {
        issueId: dependentIssueId,
        taskId: dependentIssueId,
        wakeReason: "issue_blockers_resolved",
        source: "issue.blockers_resolved",
        resolvedBlockerIssueId: sourceIssueId,
      },
    });

    // The audit trail is part of the cascade contract, not a nice-to-have: without
    // it the recovery path is indistinguishable from a wake that never fired.
    const wakeAudits = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.blockers_resolved_wake_emitted"),
        ),
      );
    expect(wakeAudits).toHaveLength(1);
    expect(wakeAudits[0]).toMatchObject({
      entityType: "issue",
      entityId: dependentIssueId,
      agentId: coderId,
      details: {
        source: "issue.blockers_resolved",
        // Upstream re-keyed this wake as
      // `issue_blockers_resolved:state:<dependent>:<generation>:<hash>`; the
      // dependent id is the stable part, and this test is about the cascade
      // firing once, not about the key's exact shape.
      idempotencyKey: expect.stringContaining(`issue_blockers_resolved:state:${dependentIssueId}:`),
        resolvedBlockerIssueId: sourceIssueId,
      },
    });
  });

  it("refuses the dependent cascade to an agent that owns neither the issue nor the recovery action", async () => {
    const { companyId, managerId, coderId, sourceIssueId, prefix } = await seedCompany();
    const dependentIssueId = randomUUID();
    await db.insert(issues).values({
      id: dependentIssueId,
      companyId,
      title: "Dependent work",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: sourceIssueId,
      relatedIssueId: dependentIssueId,
      type: "blocks",
    });
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:dependent-cascade-unauthorized",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    await db
      .update(issues)
      .set({ assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const wakeCalls: Array<{ agentId: string; wakeup: any }> = [];
    const app = createApp(
      { type: "agent", agentId: coderId, companyId, runId: randomUUID(), source: "agent_jwt" },
      {
        recoveryActionEnqueueWakeup: (async (agentId: string, wakeup: any) => {
          wakeCalls.push({ agentId, wakeup });
          return null;
        }) as any,
      },
    );

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Not my action to resolve.",
      })
      .expect(403);

    expect(wakeCalls).toHaveLength(0);
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");
  });

  it("hands restored work back to the recorded return owner and records the outcome", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: coderId })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Repair the workspace and hand the issue back.",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueRecoveryActionWakeup = vi.fn(async () => null);
    const resolved = await request(createApp(undefined, {
      recoveryActionEnqueueWakeup: enqueueRecoveryActionWakeup,
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Workspace repaired.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      assigneeAgentId: coderId,
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "handed_back",
    });
    expect(enqueueRecoveryActionWakeup).toHaveBeenCalledWith(
      coderId,
      expect.objectContaining({
        reason: "issue_recovery_action_restored",
        payload: expect.objectContaining({ issueId: sourceIssueId, recoveryActionId: action.id }),
      }),
    );
  });

  it("does not enqueue a restored wake when todo status and assignee are unchanged", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "todo", assigneeAgentId: coderId })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:already-restored",
      evidence: { latestRunId: "run-1" },
      nextAction: "Confirm the workspace remains healthy.",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueRecoveryActionWakeup = vi.fn(async () => null);
    await request(createApp(undefined, {
      recoveryActionEnqueueWakeup: enqueueRecoveryActionWakeup,
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Workspace was already restored.",
      })
      .expect(200);

    expect(enqueueRecoveryActionWakeup).not.toHaveBeenCalled();
  });

  it("resolves an active recovery action by returning the source issue to todo", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:try-again",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Try the source issue again.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "restored",
      resolutionNote: "Try the source issue again.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
  });

  it("marks a recovery action stale when a blocked source issue is manually moved to todo", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:manual-restore",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const patched = await request(app)
      .patch(`/api/issues/${sourceIssueId}`)
      .send({ status: "todo" })
      .expect(200);

    expect(patched.body).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      activeRecoveryAction: null,
    });

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue was manually moved from blocked to todo.",
    });
    expect(actionRow?.resolvedAt).toBeTruthy();
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["issue.updated", "issue.recovery_action_resolved"]),
    );
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "issue_update",
    });
  });

  it("folds stale recovery during read projection after the source issue reaches done", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:done-projection",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, sourceIssueId));
    const app = createApp();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);

    expect(detail.body).toMatchObject({
      id: sourceIssueId,
      status: "done",
      activeRecoveryAction: null,
    });
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue reached done.",
    });
    expect(actionRow?.resolvedAt).toBeTruthy();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "read_projection",
      recoveryActionId: action.id,
    });
  });

  it("keeps active recovery visible when a plain comment does not create a live path", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:plain-comment",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/comments`)
      .send({ body: "I am looking at this, but not changing the disposition." })
      .expect(201);

    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toMatchObject({
      id: action.id,
      status: "active",
    });
    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toMatchObject({ id: action.id });
  });

  it("folds stale recovery when a structured resume comment restores todo dispatch", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:resume-comment",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/comments`)
      .send({ body: "Resume this now.", resume: true })
      .expect(201);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("todo");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue was manually moved from blocked to todo.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "comment",
      recoveryActionId: action.id,
    });
  });

  it("rejects peer-agent source issue updates that would hide another owner's recovery action", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:peer-status-update",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp({
      type: "agent",
      agentId: coderId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .patch(`/api/issues/${sourceIssueId}`)
      .send({ status: "todo" })
      .expect(403);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("blocked");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("rejects peer-agent recovery action resolution on a board-owned source issue", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:peer-resolution",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp({
      type: "agent",
      agentId: coderId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Peer agent should not be able to clear this recovery.",
      })
      .expect(403);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("blocked");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  // Upstream test removed: it asserts `board_escalation_no_takeover_v1`, where a
  // stranded recovery action is owned by the BOARD and its named owner may not
  // complete the source issue. This fork routes stranded recovery to an owner
  // AGENT through the manager ladder (`resolveStrandedRecoveryRouting`), and
  // "wakes dependents blocked on the source issue when recovery resolution
  // closes it" above covers the fork behaviour: a proven action owner may close
  // the source. Keeping both would hand an agent an action it cannot act on.

  it("rejects blocked recovery resolution when the source issue has no first-class blockers", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:blocked-without-blocker",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Choose a disposition with a live continuation path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const rejected = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "blocked",
        sourceIssueStatus: "blocked",
      })
      .expect(422);

    expect(rejected.body.error).toContain("requires an unresolved first-class blocker");

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("allows blocked recovery resolution when the source issue has an unresolved first-class blocker", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Unblock recovery disposition",
      status: "todo",
      priority: "medium",
      assigneeAgentId: managerId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:blocked-with-blocker",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Wait for the blocker before continuing.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "blocked",
        sourceIssueStatus: "blocked",
        resolutionNote: "The source issue is explicitly blocked by a follow-up.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "blocked",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "blocked",
      resolutionNote: "The source issue is explicitly blocked by a follow-up.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
  });

  it("rejects false-positive recovery resolution without an explicit source issue status", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:fingerprint",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Confirm whether the issue is actually stranded.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "false_positive",
        resolutionNote: "The source issue still has a live execution path.",
      })
      .expect(400);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolutionNote: null,
    });
  });

  it("allows false-positive recovery resolution to restore a blocked source issue in the same request", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:false-positive-unblock",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Confirm whether the issue is actually stranded.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "false_positive",
        sourceIssueStatus: "done",
        resolutionNote: "Recovery signal was stale; issue is actually complete.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "done",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "false_positive",
      resolutionNote: "Recovery signal was stale; issue is actually complete.",
    });
  });

  it("enforces company scope when resolving recovery actions", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp({
      type: "agent",
      agentId: randomUUID(),
      companyId: randomUUID(),
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
      })
      .expect(404);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow?.status).toBe("active");
  });

  it("rejects a board-authored recovery restore to in_review without a review path", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "todo", assigneeAgentId: managerId, executionState: null })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp({ type: "board", source: "local_implicit" });

    const res = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "in_review",
        resolutionNote: "Board bulk-resolved as restored.",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("invalid_issue_disposition");
    expect(res.body.details).toMatchObject({
      code: "invalid_issue_disposition",
      missing: "review_path",
    });

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow?.status).toBe("active");

    const [issueRow] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(issueRow?.status).toBe("todo");
  });

  it("preserves attemptCount across resolve-then-re-mint cycles so the sweep ceiling is reachable", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);
    const fingerprint = "stranded:fingerprint";
    const baseInput = {
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue" as const,
      ownerType: "agent" as const,
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint,
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" as const },
    };

    for (let cycle = 1; cycle <= 5; cycle++) {
      const action = await svc.upsertSourceScoped(baseInput);
      expect(action.status).toBe("active");
      expect(action.attemptCount).toBe(cycle);

      await svc.resolveActiveForIssue({
        companyId,
        sourceIssueId,
        kind: "stranded_assigned_issue",
        fingerprint,
        status: "resolved",
        outcome: "false_positive",
        resolutionNote: `Cycle ${cycle} resolved.`,
      });

      const resolved = await svc.getActiveForIssue(companyId, sourceIssueId);
      expect(resolved).toBeNull();
    }

    const active = await svc.upsertSourceScoped(baseInput);
    expect(active.status).toBe("active");
    // SUP-14151: the carried count (prev.attemptCount 5 + 1) is clamped to the
    // default ceiling, so the 6th re-mint lands exactly on it instead of past it.
    expect(active.attemptCount).toBe(5);

    const all = await svc.listAllForIssue(companyId, sourceIssueId);
    expect(all).toHaveLength(6);
    expect(all[0].id).toBe(active.id);
    expect(all[0].status).toBe("active");
    expect(all[0].attemptCount).toBe(5);
    expect(all[5].attemptCount).toBe(1);
    expect(all[5].status).toBe("resolved");

    // Backdate so the stale-wake sweep selects the action, then prove the sweep
    // ceiling turns the 6th re-mint into an escalated/exhausted action.
    const staleAt = new Date(Date.now() - 10 * 60_000);
    await db
      .update(issueRecoveryActions)
      .set({ lastAttemptAt: staleAt })
      .where(eq(issueRecoveryActions.id, active.id));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
    const sweepResult = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 0 });
    expect(sweepResult.maxAttemptsReached).toBe(1);

    const [escalated] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, active.id));
    expect(escalated?.status).toBe("escalated");
    expect(escalated?.outcome).toBe("exhausted");
    expect(escalated?.attemptCount).toBe(5);
    expect(escalated?.maxAttempts).toBe(5);
  });

  it("does not reset an exhausted escalated action to active on re-mint", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);
    const fingerprint = "stranded:exhausted:fingerprint";
    const baseInput = {
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue" as const,
      ownerType: "agent" as const,
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint,
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" as const },
    };

    const action = await svc.upsertSourceScoped(baseInput);
    expect(action.status).toBe("active");
    expect(action.attemptCount).toBe(1);

    await db
      .update(issueRecoveryActions)
      .set({
        attemptCount: 5,
        status: "escalated",
        outcome: "exhausted",
        ownerType: "board",
        ownerAgentId: null,
        updatedAt: new Date(),
      })
      .where(eq(issueRecoveryActions.id, action.id));

    const reminted = await svc.upsertSourceScoped(baseInput);
    expect(reminted.id).toBe(action.id);
    expect(reminted.status).toBe("escalated");
    expect(reminted.outcome).toBe("exhausted");
    expect(reminted.attemptCount).toBe(5);

    const active = await svc.getActiveForIssue(companyId, sourceIssueId);
    expect(active).toMatchObject({ id: action.id, status: "escalated", outcome: "exhausted" });
  });

  it("clamps a re-minted successor to the default ceiling when the predecessor's maxAttempts is null", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);
    const fingerprint = "stranded:null-ceiling:fingerprint";
    const baseInput = {
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue" as const,
      ownerType: "agent" as const,
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint,
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" as const },
    };

    // Consume the full default sweep budget on a predecessor that never had a
    // maxAttempts ceiling stamped (the common case: no caller stamps one).
    const first = await svc.upsertSourceScoped(baseInput);
    expect(first.attemptCount).toBe(1);
    await db
      .update(issueRecoveryActions)
      .set({ attemptCount: 5 })
      .where(eq(issueRecoveryActions.id, first.id));
    await svc.resolveActiveForIssue({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      fingerprint,
      status: "resolved",
      outcome: "false_positive",
      resolutionNote: "Cycle resolved.",
    });

    // SUP-14151: pre-fix this minted attemptCount 6 (prev.attemptCount + 1) even
    // though nothing stamps a ceiling — the successor lands past the budget the
    // sweep will hold it to the moment it acquires one.
    const successor = await svc.upsertSourceScoped(baseInput);
    expect(successor.status).toBe("active");
    expect(successor.attemptCount).toBe(5);
    expect(successor.attemptCount).toBeLessThanOrEqual(successor.maxAttempts ?? 5);
  });

  it("clamps a re-minted successor to an explicit successor ceiling", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);
    const fingerprint = "stranded:explicit-ceiling:fingerprint";
    const baseInput = {
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue" as const,
      ownerType: "agent" as const,
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint,
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" as const },
    };

    const first = await svc.upsertSourceScoped(baseInput);
    await db
      .update(issueRecoveryActions)
      .set({ attemptCount: 5 })
      .where(eq(issueRecoveryActions.id, first.id));
    await svc.resolveActiveForIssue({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      fingerprint,
      status: "resolved",
      outcome: "false_positive",
      resolutionNote: "Cycle resolved.",
    });

    const successor = await svc.upsertSourceScoped({ ...baseInput, maxAttempts: 3 });
    expect(successor.status).toBe("active");
    expect(successor.attemptCount).toBe(3);
    expect(successor.attemptCount).toBeLessThanOrEqual(successor.maxAttempts ?? 5);
  });

  it("never bumps an active action past its ceiling on a same-issue re-upsert", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);
    const baseInput = {
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue" as const,
      ownerType: "agent" as const,
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" as const },
    };

    const first = await svc.upsertSourceScoped({ ...baseInput, fingerprint: "stranded:ceiling:a" });
    await db
      .update(issueRecoveryActions)
      .set({ attemptCount: 5, maxAttempts: 5 })
      .where(eq(issueRecoveryActions.id, first.id));

    const bumped = await svc.upsertSourceScoped({ ...baseInput, fingerprint: "stranded:ceiling:b" });
    expect(bumped.id).toBe(first.id);
    expect(bumped.status).toBe("active");
    expect(bumped.attemptCount).toBe(5);
    expect(bumped.attemptCount).toBeLessThanOrEqual(bumped.maxAttempts ?? 5);
  });
});
