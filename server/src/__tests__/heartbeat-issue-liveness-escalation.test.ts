import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  agentRuntimeState,
  budgetPolicies,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged liveness escalation.",
    provider: "test",
    model: "test-model",
  })),
);

const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../config.js", () => ({
  loadConfig: loadConfigMock,
  // SUP-15369: issues.ts imports this env-only re-arm-window accessor; mirror the
  // production formula (config.ts) so the mock stays faithful without loadConfig's
  // tailnet-probe side effects.
  pendingReviewRearmWindowMsFromEnv: () =>
    Math.max(30 * 60 * 1000, Number(process.env.PENDING_REVIEW_REARM_WINDOW_MS) || 30 * 60 * 1000),
  // SUP-15565: issues.ts also imports this env-only participant-grace accessor.
  pendingReviewParticipantGraceMsFromEnv: () =>
    Math.max(30 * 60 * 1000, Number(process.env.PENDING_REVIEW_PARTICIPANT_GRACE_MS) || 30 * 60 * 1000),
}));

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { attentionService } from "../services/attention.ts";
import { issueService } from "../services/issues.ts";
import { runningProcesses } from "../adapters/index.ts";
import { recoveryService } from "../services/recovery/service.ts";
import {
  buildIssueBlockersResolvedWakeStateKey,
  buildIssueBlockersResolvedWakeStateKeyWithoutCycle,
} from "../services/issue-dependency-wakeups.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue liveness escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat issue graph liveness escalation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  function buildTestConfig() {
    return {
      deploymentMode: "authenticated" as const,
      bind: "loopback" as const,
      resolvedDependencyWakeRearmWindowMs: 6 * 60 * 60 * 1000,
      resolvedDependencyWakeRearmMaxCount: 3,
    };
  }

  function recoveryServiceWithMocks(deps: { enqueueWakeup?: (agentId: string) => Promise<{ id: string } | null> } = {}) {
    loadConfigMock.mockReturnValue(buildTestConfig());
    const enqueueWakeup = deps.enqueueWakeup ?? vi.fn(async () => ({ id: randomUUID() }));
    return recoveryService(db as never, { enqueueWakeup: enqueueWakeup as never });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-liveness-");
    db = createDb(tempDb.connectionString);
    loadConfigMock.mockReturnValue(buildTestConfig());
  }, 30_000);

  afterEach(async () => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue(buildTestConfig());
    runningProcesses.clear();
    // Dependency reconciliation heals missing wakes by enqueuing an
    // on-demand wake, which dispatches a heartbeat run fire-and-forget (see
    // startNextQueuedRunForAgent → executeRun in the heartbeat service). That
    // background run keeps writing rows (workspace_operations, heartbeat_run_events)
    // after the awaited call resolves. Deterministically await those in-flight
    // executions before clearing tables — otherwise an escaping heartbeat_run_events
    // insert can land between the events delete and the heartbeat_runs delete and
    // trip the run_events → runs foreign key.
    await heartbeatService(db).drainActiveRunExecutions();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedBlockedChain(opts: {
    outsideLookback?: boolean;
    blockerStatus?: string;
    blockerAssigneeAgentId?: "coder" | "manager" | null;
  } = {}) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
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
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
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
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);

    const issueTimestamp = opts.outsideLookback === true
      ? new Date(Date.now() - 25 * 60 * 60 * 1000)
      : new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked parent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
      {
        id: blockerIssueId,
        companyId,
        title: "Missing unblock owner",
        status: opts.blockerStatus ?? "todo",
        priority: "medium",
        assigneeAgentId: opts.blockerAssigneeAgentId === "coder"
          ? coderId
          : opts.blockerAssigneeAgentId === "manager"
            ? managerId
            : null,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
    ]);

    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    return { companyId, managerId, coderId, blockedIssueId, blockerIssueId };
  }

  async function seedResolvedDependencyBackstopFixture(opts: {
    workspaceState?: "none" | "not_finalized" | "finalized";
    assignee?: "agent" | null;
  } = {}) {
    const workspaceState = opts.workspaceState ?? "none";
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerUserId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Priya",
      role: "engineer",
      status: "idle",
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    if (workspaceState !== "none") {
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Synthetic dependency project",
        status: "in_progress",
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Synthetic workspace",
        sourceType: "git_worktree",
      });
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Synthetic execution workspace",
        providerType: "git_worktree",
      });
    }

    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        projectId: workspaceState === "none" ? null : projectId,
        title: "Synthetic blocked dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: opts.assignee === null ? null : agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockerIssueId,
        companyId,
        projectId: workspaceState === "none" ? null : projectId,
        title: "Synthetic completed blocker",
        status: "done",
        priority: "medium",
        executionWorkspaceId: workspaceState === "none" ? null : executionWorkspaceId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    if (workspaceState === "not_finalized") {
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "adapter_execute",
        status: "succeeded",
        startedAt: new Date(Date.now() - 60_000),
      });
    } else if (workspaceState === "finalized") {
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date(),
      });
    }

    return { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId };
  }

  async function seedZeroBlockerBackstopFixture(opts: {
    withActiveRecoveryAction?: boolean;
    withExhaustedRecoveryAction?: boolean;
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockedIssueId = randomUUID();
    const issuePrefix = `Z${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: randomUUID(),
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Priya",
      role: "engineer",
      status: "idle",
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: blockedIssueId,
      companyId,
      title: "Synthetic zero-blocker blocked issue",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    if (opts.withActiveRecoveryAction) {
      await db.insert(issueRecoveryActions).values({
        companyId,
        sourceIssueId: blockedIssueId,
        kind: "stranded_assigned_issue",
        status: "active",
        ownerType: "agent",
        ownerAgentId: agentId,
        cause: "stranded_assigned_issue",
        fingerprint: `zero-blocker-test:${companyId}:${blockedIssueId}`,
        evidence: {},
        nextAction: "Restore a live execution path",
      });
    }

    if (opts.withExhaustedRecoveryAction) {
      // Walked its attempt ceiling: escalated to the board, no owner agent left
      // to re-arm the issue. Must not count as a live recovery action.
      await db.insert(issueRecoveryActions).values({
        companyId,
        sourceIssueId: blockedIssueId,
        kind: "stranded_assigned_issue",
        status: "escalated",
        outcome: "exhausted",
        ownerType: "board",
        ownerAgentId: null,
        cause: "stranded_assigned_issue",
        fingerprint: `zero-blocker-exhausted-test:${companyId}:${blockedIssueId}`,
        evidence: {},
        nextAction: "Assign an invokable recovery owner",
      });
    }

    return { companyId, agentId, blockedIssueId };
  }

  it("runs exactly one bounded review-path recovery before surfacing a stalled decision", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Review Recovery Co",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Review Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "PAP-14994 fingerprint",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const heartbeat = heartbeatService(db);
    const followUpRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {
        issueId,
        interactionId: "superseded-confirmation",
        reviewPathLost: true,
        reviewPathConsumedRef: "superseded-confirmation",
      },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_commented",
        interactionId: "superseded-confirmation",
        reviewPathLost: true,
        reviewPathConsumedRef: "superseded-confirmation",
      },
    });
    expect(followUpRun).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();

    const recoveryWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.reason, "issue_review_path_lost"),
      ));
    expect(recoveryWakes).toHaveLength(1);
    expect(recoveryWakes[0]).toMatchObject({
      status: "completed",
      payload: expect.objectContaining({
        issueId,
        reviewPathConsumedRef: "superseded-confirmation",
        reviewPathRecoveryAttempt: 1,
        maxReviewPathRecoveryAttempts: 1,
      }),
    });

    const attention = await issueService(db)
      .listReviewAttention(companyId, [{ id: issueId, companyId, status: "in_review" }]);
    expect(attention.get(issueId)).toMatchObject({ state: "stalled", paths: [] });

    const feed = await attentionService(db).list(companyId, { userId: "responsible-user" });
    expect(feed.items.find((item) => item.subject.id === issueId)).toMatchObject({
      sourceKind: "review",
      decisionVerbs: expect.arrayContaining([
        expect.objectContaining({ id: "choose_review_path", label: "Choose review path" }),
      ]),
    });
  });

  it("keeps resolved dependency wake reconciliation active", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(
      buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    );
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const events = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityId: blockedIssueId,
      details: expect.objectContaining({ source: "issue_graph_liveness.backstop" }),
    });
  });

  // Fork divergence: upstream #12681 retired the escalation pass along with its scheduling, but the
  // server still schedules reconcileIssueGraphLiveness as the orchestrator of the fork sweeps that
  // share its timer. Pin that the dependency-wake backstop is still one of them.
  it("runs the resolved dependency wake backstop through the scheduled liveness orchestrator", async () => {
    const { agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.dependencyWakesHealed).toBe(1);
    expect(result.dependencyWakeIssueIds).toEqual([blockedIssueId]);
    expect(result.escalationsCreated).toBe(0);

    const wake = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);
    expect(wake).toMatchObject({
      reason: "issue_blockers_resolved",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });
  });

  it("heals a blocked dependent whose done blocker has no workspace finalize obligation", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(
      buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    );
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const events = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityId: blockedIssueId });
  });

  it("reconciles a resolved blocked dependency after the assignee-null window closes", async () => {
    const { agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none", assignee: null });
    const heartbeat = heartbeatService(db);

    const beforeAssignment = await heartbeat.reconcileResolvedDependencyWakes();

    expect(beforeAssignment.healed).toBe(0);
    expect(beforeAssignment.checked).toBe(0);

    await db
      .update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, blockedIssueId));

    const afterAssignment = await heartbeat.reconcileResolvedDependencyWakes();

    expect(afterAssignment.healed).toBe(1);
    expect(afterAssignment.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);
    expect(wake).toMatchObject({
      reason: "issue_blockers_resolved",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });
  });

  it("retries a resolved dependency wake when the prior wake was skipped as stale", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    // The route-time wake writes the level-triggered state key. A skip records a
    // `skipped` row with that key. `skipped` is not an in-flight status, so the
    // backstop must still re-emit for the same ready state.
    const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "skipped",
      finishedAt: new Date(),
      error: "Cancelled because issue assignee changed before the queued run could start",
      idempotencyKey,
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.existingWakeSkipped).toBe(0);

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")))
      .orderBy(agentWakeupRequests.requestedAt);

    expect(wakes).toHaveLength(2);
    expect(wakes.map((wake) => wake.status)).toContain("skipped");
    expect(wakes.every((wake) => wake.idempotencyKey === idempotencyKey)).toBe(true);
    expect(wakes.some((wake) => ["queued", "claimed", "completed"].includes(wake.status))).toBe(true);
  });

  it("waits for workspace finalize before healing a resolved blocked dependent", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "not_finalized" });
    const heartbeat = heartbeatService(db);

    const beforeFinalize = await heartbeat.reconcileResolvedDependencyWakes();

    expect(beforeFinalize.healed).toBe(0);
    expect(beforeFinalize.notReadySkipped).toBe(1);

    const wakesBeforeFinalize = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakesBeforeFinalize).toHaveLength(0);

    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: blockerIssueId,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date(),
    });

    const afterFinalize = await heartbeat.reconcileResolvedDependencyWakes();

    expect(afterFinalize.healed).toBe(1);
    expect(afterFinalize.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);
    expect(wake).toMatchObject({
      reason: "issue_blockers_resolved",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });
  });

  it("does not duplicate an existing dependency wake keyed to any resolved blocker", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const secondBlockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondBlockerIssueId,
      companyId,
      title: "Second completed blocker",
      status: "done",
      priority: "medium",
      issueNumber: 3,
      identifier: "R-MULTI-3",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: secondBlockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const readiness = await issueService(db).getDependencyReadiness(blockedIssueId);
    const blockerIdNotUsedByBackstop = readiness.blockerIssueIds.find((id) => id !== blockerIssueId);
    if (!blockerIdNotUsedByBackstop) {
      throw new Error("Expected a second blocker id in dependency readiness");
    }
    expect(blockerIdNotUsedByBackstop).toBe(secondBlockerIssueId);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIdNotUsedByBackstop,
      },
      status: "queued",
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${blockerIdNotUsedByBackstop}`,
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.existingWakeSkipped).toBe(1);

    const wakes = await db
      .select({
        id: agentWakeupRequests.id,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.idempotencyKey).toBe(
      `issue_blockers_resolved:${blockedIssueId}:${blockerIdNotUsedByBackstop}`,
    );
  });

  it("heals a zero-blocker blocked issue with an assignee and no live recovery action", async () => {
    const { companyId, agentId, blockedIssueId } = await seedZeroBlockerBackstopFixture();

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.dependencyWakeZeroBlockerObserved).toBe(1);
    expect(result.dependencyWakeZeroBlockerHealed).toBe(1);
    expect(result.dependencyWakesHealed).toBe(1);
    expect(result.dependencyWakeNotReadySkipped).toBe(0);
    expect(result.dependencyWakeIssueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(`issue_blockers_resolved:${blockedIssueId}:zero_blocker`);
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const events = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityId: blockedIssueId,
      details: expect.objectContaining({ zeroBlockerHeal: true }),
    });
  });

  it("does not re-wake a zero-blocker issue whose heal wake already exists", async () => {
    const { companyId, agentId, blockedIssueId } = await seedZeroBlockerBackstopFixture();
    const idempotencyKey = `issue_blockers_resolved:${blockedIssueId}:zero_blocker`;
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        zeroBlockerHeal: true,
      },
      status: "completed",
      finishedAt: new Date(),
      idempotencyKey,
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.dependencyWakeZeroBlockerObserved).toBe(1);
    expect(result.dependencyWakeZeroBlockerHealed).toBe(0);
    expect(result.dependencyWakesHealed).toBe(0);
    expect(result.dependencyWakeExistingSkipped).toBe(1);

    const wakes = await db
      .select({ id: agentWakeupRequests.id, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.idempotencyKey).toBe(idempotencyKey);
  });

  it("skips a zero-blocker blocked issue with a live recovery action", async () => {
    const { companyId, blockedIssueId } = await seedZeroBlockerBackstopFixture({
      withActiveRecoveryAction: true,
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.dependencyWakeZeroBlockerObserved).toBe(1);
    expect(result.dependencyWakeZeroBlockerActiveRecoverySkipped).toBe(1);
    expect(result.dependencyWakeZeroBlockerHealed).toBe(0);
    expect(result.dependencyWakesHealed).toBe(0);

    const wakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId));
    expect(wakes).toHaveLength(0);
  });

  it("heals a zero-blocker blocked issue whose recovery action exhausted its attempts", async () => {
    const { agentId, blockedIssueId } = await seedZeroBlockerBackstopFixture({
      withExhaustedRecoveryAction: true,
    });

    const result = await heartbeatService(db).reconcileIssueGraphLiveness();

    expect(result.dependencyWakeZeroBlockerObserved).toBe(1);
    expect(result.dependencyWakeZeroBlockerActiveRecoverySkipped).toBe(0);
    expect(result.dependencyWakeZeroBlockerHealed).toBe(1);
    expect(result.dependencyWakesHealed).toBe(1);
    expect(result.dependencyWakeIssueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({ reason: agentWakeupRequests.reason, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0] ?? null);
    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(`issue_blockers_resolved:${blockedIssueId}:zero_blocker`);
  });

  it("heals a multi-blocker dependent when only a completed wake for an earlier blocker exists", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const secondBlockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondBlockerIssueId,
      companyId,
      title: "Earlier completed blocker",
      status: "done",
      priority: "medium",
      issueNumber: 3,
      identifier: "R-MULTI-3",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: secondBlockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    // An earlier partial resolution left a `completed` per-edge wake. The bug was
    // that this stale wake suppressed the wake for the current ready state. The
    // level-triggered dedup keys on the full blocker set, so this completed wake
    // no longer strands the dependent.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: secondBlockerIssueId,
      },
      status: "completed",
      finishedAt: new Date(),
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${secondBlockerIssueId}`,
    });

    const readiness = await issueService(db).getDependencyReadiness(blockedIssueId);
    expect(readiness.isDependencyReady).toBe(true);

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);
    expect(result.existingWakeSkipped).toBe(0);

    const stateKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: readiness.blockerIssueIds,
    });
    const healedWake = await db
      .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, stateKey)))
      .then((rows) => rows[0] ?? null);
    expect(healedWake).not.toBeNull();
    expect(["queued", "claimed", "completed"]).toContain(healedWake?.status);

    // A second reconciliation pass finds the state-key wake and stays bounded:
    // it heals nothing more and never enqueues a second wake for the same state.
    const secondPass = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(secondPass.healed).toBe(0);

    const stateKeyWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, stateKey)));
    expect(stateKeyWakes).toHaveLength(1);
  });

  it("heals a blocked dependent after a terminal reset when a previous-cycle old-key wake exists", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const previousCycleWakeAt = new Date("2026-07-01T12:00:00.000Z");
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    await db
      .update(issues)
      .set({ blockedTransitionAt, updatedAt: blockedTransitionAt })
      .where(eq(issues.id, blockedIssueId));
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "completed",
      finishedAt: previousCycleWakeAt,
      requestedAt: previousCycleWakeAt,
      idempotencyKey: buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);
    expect(result.existingWakeSkipped).toBe(0);

    const cycleKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt,
    });
    const healedWake = await db
      .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, cycleKey)))
      .then((rows) => rows[0] ?? null);
    expect(healedWake).not.toBeNull();
    expect(["queued", "claimed", "completed"]).toContain(healedWake?.status);

    const secondPass = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(secondPass.healed).toBe(0);

    const cycleKeyWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, cycleKey)));
    expect(cycleKeyWakes).toHaveLength(1);
  });

  it("does not re-heal when a completed old-key wake is from the current blocked cycle", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    const sameCycleWakeAt = new Date("2026-08-01T12:00:01.000Z");
    await db
      .update(issues)
      .set({ blockedTransitionAt, updatedAt: blockedTransitionAt })
      .where(eq(issues.id, blockedIssueId));
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "completed",
      finishedAt: sameCycleWakeAt,
      requestedAt: sameCycleWakeAt,
      idempotencyKey: buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.existingWakeSkipped).toBe(1);
  });

  it("counts null dependency wake returns as deferred instead of enqueue failures", async () => {
    const { companyId, agentId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    await db
      .update(agents)
      .set({
        runtimeConfig: { heartbeat: { wakeOnDemand: false, maxConcurrentRuns: 1 } },
      })
      .where(eq(agents.id, agentId));

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.deferredOrFailed).toBe(1);
    expect(result.enqueueFailed).toBe(0);

    const skippedWake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)))
      .then((rows) => rows[0] ?? null);
    expect(skippedWake).toMatchObject({
      status: "skipped",
      reason: "heartbeat.wakeOnDemand.disabled",
    });
  });

  it("re-arms a resolved dependency wake when the prior wake completed outside the re-arm window", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const idempotencyKey = `issue_blockers_resolved:${blockedIssueId}:${blockerIssueId}`;
    const windowMs = 6 * 60 * 60 * 1000;
    const outsideWindow = new Date(Date.now() - windowMs - 60_000);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "completed",
      idempotencyKey,
      createdAt: outsideWindow,
      updatedAt: outsideWindow,
      finishedAt: outsideWindow,
    });

    const result = await recoveryServiceWithMocks().reconcileResolvedDependencyWakeBackstop({
      now: new Date(),
      rearmWindowMs: windowMs,
    });

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.reason, "issue_blockers_resolved"),
        ),
      );

    expect(result.healed).toBe(1);
    expect(result.existingWakeSkipped).toBe(0);
    expect(result.issueIds).toEqual([blockedIssueId]);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.status).toBe("completed");
  });

  it("skips re-arming when a completed wake exists within the re-arm window", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    // The fork's re-arm window is keyed on the level-triggered cycle key. A
    // COMPLETED wake under the legacy per-edge key only ever covers while it is
    // in flight (see wakeCoversIssueBlockersResolvedReadyState), so seeding the
    // legacy spelling here would skip the window logic this test is named for.
    const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt: null,
    });
    const windowMs = 6 * 60 * 60 * 1000;
    const withinWindow = new Date(Date.now() - 30 * 60 * 1000);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "completed",
      idempotencyKey,
      createdAt: withinWindow,
      updatedAt: withinWindow,
      finishedAt: withinWindow,
    });

    const result = await recoveryServiceWithMocks().reconcileResolvedDependencyWakeBackstop({
      now: new Date(),
      rearmWindowMs: windowMs,
    });

    expect(result.healed).toBe(0);
    expect(result.existingWakeSkipped).toBe(1);
    expect(result.issueIds).toEqual([]);

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.reason, "issue_blockers_resolved"),
        ),
      )
      .orderBy(agentWakeupRequests.requestedAt);

    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.status).toBe("completed");
  });

  it.each(["queued", "claimed", "deferred_issue_execution"] as const)(
    "skips re-arming when an in-flight wake (%s) exists regardless of window",
    async (inFlightStatus) => {
      const { companyId, agentId, blockedIssueId, blockerIssueId } =
        await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
      const idempotencyKey = `issue_blockers_resolved:${blockedIssueId}:${blockerIssueId}`;
      const farPast = new Date(Date.now() - 48 * 60 * 60 * 1000);

      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_blockers_resolved",
        payload: {
          issueId: blockedIssueId,
          resolvedBlockerIssueId: blockerIssueId,
          blockerIssueIds: [blockerIssueId],
        },
        status: inFlightStatus,
        idempotencyKey,
        createdAt: farPast,
        updatedAt: farPast,
      });

      const result = await recoveryServiceWithMocks().reconcileResolvedDependencyWakeBackstop({
        now: new Date(),
      });

      expect(result.healed).toBe(0);
      expect(result.existingWakeSkipped).toBe(1);

      const wakes = await db
        .select({
          status: agentWakeupRequests.status,
        })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.companyId, companyId),
            eq(agentWakeupRequests.reason, "issue_blockers_resolved"),
          ),
        );

      expect(wakes).toHaveLength(1);
      expect(wakes[0]?.status).toBe(inFlightStatus);
    },
  );

  it("enforces the re-arm cap and suppresses further wakes once consumed count reaches the limit", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const idempotencyKey = `issue_blockers_resolved:${blockedIssueId}:${blockerIssueId}`;
    const windowMs = 6 * 60 * 60 * 1000;
    const withinWindow = new Date(Date.now() - 30 * 60 * 1000);
    const maxCount = 3;

    for (let i = 0; i < maxCount; i++) {
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_blockers_resolved",
        payload: {
          issueId: blockedIssueId,
          resolvedBlockerIssueId: blockerIssueId,
          blockerIssueIds: [blockerIssueId],
        },
        status: "completed",
        idempotencyKey,
        createdAt: withinWindow,
        updatedAt: withinWindow,
        finishedAt: withinWindow,
      });
    }

    const svc = recoveryServiceWithMocks();
    const result = await svc.reconcileResolvedDependencyWakeBackstop({
      now: new Date(withinWindow.getTime() + windowMs + 1),
      rearmWindowMs: windowMs,
      rearmMaxCount: maxCount,
    });

    expect(result.healed).toBe(0);
    expect(result.reArmCapEscalated).toBe(1);
    expect(result.reArmCapSkipped).toBe(0);
    expect(result.issueIds).toEqual([]);

    const action = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, blockedIssueId))
      .then((rows) => rows[0]);
    expect(action).toMatchObject({
      companyId,
      sourceIssueId: blockedIssueId,
      kind: "blocked_without_blockers",
      ownerType: "board",
      cause: "dependency_wake_rearm_cap_exhausted",
      fingerprint: `drearm:${companyId}:${blockedIssueId}`,
    });

    const result2 =
      await svc.reconcileResolvedDependencyWakeBackstop({
        now: new Date(withinWindow.getTime() + windowMs + 1),
        rearmWindowMs: windowMs,
        rearmMaxCount: maxCount,
      });

    expect(result2.reArmCapEscalated).toBe(0);
    expect(result2.reArmCapSkipped).toBe(1);

    const actions2 = await db
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, blockedIssueId));
    expect(actions2).toHaveLength(1);

    const issue = await db.query.issues.findFirst({
      where: eq(issues.id, blockedIssueId),
    });
    expect(issue?.status).toBe("blocked");

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.reason, "issue_blockers_resolved"),
        ),
      );

    expect(wakes).toHaveLength(maxCount);
    expect(wakes.every((wake) => wake.status === "completed")).toBe(true);
  });

  it("logs activity for every cap-exhausted candidate in the same tick, not just the first", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const blockedIssueId2 = randomUUID();
    const blockerIssueId2 = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const now = new Date();

    await db.insert(issues).values([
      {
        id: blockedIssueId2,
        companyId,
        title: "Synthetic blocked dependent 2",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        issueNumber: 3,
        identifier: `${issuePrefix}-3`,
      },
      {
        id: blockerIssueId2,
        companyId,
        title: "Synthetic completed blocker 2",
        status: "done",
        priority: "medium",
        issueNumber: 4,
        identifier: `${issuePrefix}-4`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId2,
      relatedIssueId: blockedIssueId2,
      type: "blocks",
    });

await db.insert(agentWakeupRequests).values([
  {
    companyId,
    agentId,
    source: "automation",
    triggerDetail: "system",
    reason: "issue_blockers_resolved",
    payload: {
      issueId: blockedIssueId,
      resolvedBlockerIssueId: blockerIssueId,
      blockerIssueIds: [blockerIssueId],
    },
    status: "skipped",
    requestedAt: new Date(now.getTime() - 3_000),
    finishedAt: new Date(now.getTime() - 2_800),
    idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${blockerIssueId}`,
  },
  {
    companyId,
    agentId,
    source: "automation",
    triggerDetail: "system",
    reason: "issue_blockers_resolved",
    payload: {
      issueId: blockedIssueId,
      resolvedBlockerIssueId: blockerIssueId,
      blockerIssueIds: [blockerIssueId],
    },
    status: "skipped",
    requestedAt: new Date(now.getTime() - 2_000),
    finishedAt: new Date(now.getTime() - 1_800),
    idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${blockerIssueId}`,
  },
  {
    companyId,
    agentId,
    source: "automation",
    triggerDetail: "system",
    reason: "issue_blockers_resolved",
    payload: {
      issueId: blockedIssueId,
      resolvedBlockerIssueId: blockerIssueId,
      blockerIssueIds: [blockerIssueId],
    },
    status: "skipped",
    requestedAt: new Date(now.getTime() - 1_000),
    finishedAt: new Date(now.getTime() - 900),
    idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${blockerIssueId}`,
  },
  {
    companyId,
    agentId,
    source: "automation",
    triggerDetail: "system",
    reason: "issue_blockers_resolved",
    payload: {
      issueId: blockedIssueId2,
      resolvedBlockerIssueId: blockerIssueId2,
      blockerIssueIds: [blockerIssueId2],
    },
    status: "skipped",
    requestedAt: new Date(now.getTime() - 3_000),
    finishedAt: new Date(now.getTime() - 2_800),
    idempotencyKey: `issue_blockers_resolved:${blockedIssueId2}:${blockerIssueId2}`,
  },
  {
    companyId,
    agentId,
    source: "automation",
    triggerDetail: "system",
    reason: "issue_blockers_resolved",
    payload: {
      issueId: blockedIssueId2,
      resolvedBlockerIssueId: blockerIssueId2,
      blockerIssueIds: [blockerIssueId2],
    },
    status: "skipped",
    requestedAt: new Date(now.getTime() - 2_000),
    finishedAt: new Date(now.getTime() - 1_800),
    idempotencyKey: `issue_blockers_resolved:${blockedIssueId2}:${blockerIssueId2}`,
  },
  {
    companyId,
    agentId,
    source: "automation",
    triggerDetail: "system",
    reason: "issue_blockers_resolved",
    payload: {
      issueId: blockedIssueId2,
      resolvedBlockerIssueId: blockerIssueId2,
      blockerIssueIds: [blockerIssueId2],
    },
    status: "skipped",
    requestedAt: new Date(now.getTime() - 1_000),
    finishedAt: new Date(now.getTime() - 900),
    idempotencyKey: `issue_blockers_resolved:${blockedIssueId2}:${blockerIssueId2}`,
  },
]);

    const result = await recoveryService(db, { enqueueWakeup: vi.fn() }).reconcileResolvedDependencyWakeBackstop({
      now,
      rearmWindowMs: 10 * 60_000,
      rearmMaxCount: 2,
    });

    expect(result.reArmCapSkipped).toBe(2);

    const capLogs = await db
      .select({ entityId: activityLog.entityId })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.dependency_wake_rearm_cap_reached"),
        ),
      );

    expect(capLogs).toHaveLength(2);
    expect(capLogs.map((log) => log.entityId).sort()).toEqual(
      [blockedIssueId, blockedIssueId2].sort(),
    );
  });

  it("escalates every candidate that hits the re-arm cap within the same tick via recovery action", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const windowMs = 6 * 60 * 60 * 1000;
    const maxCount = 3;
    const withinWindow = new Date(Date.now() - 30 * 60 * 1000);
    const now = new Date(withinWindow.getTime() + windowMs + 1);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Priya",
      role: "engineer",
      status: "idle",
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    const blockedIssueIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const blockedId = randomUUID();
      const blockerId = randomUUID();
      blockedIssueIds.push(blockedId);
      await db.insert(issues).values([
        {
          id: blockedId,
          companyId,
          title: `Blocked dependent ${i}`,
          status: "blocked",
          priority: "medium",
          assigneeAgentId: agentId,
          issueNumber: i + 1,
          identifier: `${issuePrefix}-${i + 1}`,
        },
        {
          id: blockerId,
          companyId,
          title: `Completed blocker ${i}`,
          status: "done",
          priority: "medium",
          issueNumber: i + 10,
          identifier: `${issuePrefix}-${i + 10}`,
        },
      ]);
      await db.insert(issueRelations).values({
        companyId,
        issueId: blockerId,
        relatedIssueId: blockedId,
        type: "blocks",
      });
      const idempotencyKey = `issue_blockers_resolved:${blockedId}:${blockerId}`;
      for (let j = 0; j < maxCount; j++) {
        await db.insert(agentWakeupRequests).values({
          companyId,
          agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "issue_blockers_resolved",
          payload: {
            issueId: blockedId,
            resolvedBlockerIssueId: blockerId,
            blockerIssueIds: [blockerId],
          },
          status: "completed",
          idempotencyKey,
          createdAt: withinWindow,
          updatedAt: withinWindow,
          finishedAt: withinWindow,
        });
      }
    }

    const svc = recoveryServiceWithMocks();
    const result = await svc.reconcileResolvedDependencyWakeBackstop({
      now,
      rearmWindowMs: windowMs,
      rearmMaxCount: maxCount,
    });

    expect(result.healed).toBe(0);
    expect(result.reArmCapEscalated).toBe(3);
    expect(result.reArmCapSkipped).toBe(0);

    const actions = await db
      .select({ sourceIssueId: issueRecoveryActions.sourceIssueId })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.cause, "dependency_wake_rearm_cap_exhausted"));
    expect(actions).toHaveLength(3);
    const actionIssueIds = new Set(actions.map((a) => a.sourceIssueId));
    for (const blockedId of blockedIssueIds) {
      expect(actionIssueIds).toContain(blockedId);
    }

    const result2 = await svc.reconcileResolvedDependencyWakeBackstop({
      now,
      rearmWindowMs: windowMs,
      rearmMaxCount: maxCount,
    });
    expect(result2.reArmCapEscalated).toBe(0);
    expect(result2.reArmCapSkipped).toBe(3);
  });

  it("does not stamp the re-arm cap log timer when no candidates hit the cap, so the next cap-hit tick still stamps", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const idempotencyKey = `issue_blockers_resolved:${blockedIssueId}:${blockerIssueId}`;
    const windowMs = 6 * 60 * 60 * 1000;
    const withinWindow = new Date(Date.now() - 30 * 60 * 1000);
    const maxCount = 3;
    const capHitNow = new Date(withinWindow.getTime() + windowMs + 1);

    for (let i = 0; i < maxCount; i++) {
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_blockers_resolved",
        payload: {
          issueId: blockedIssueId,
          resolvedBlockerIssueId: blockerIssueId,
          blockerIssueIds: [blockerIssueId],
        },
        status: "completed",
        idempotencyKey,
        createdAt: withinWindow,
        updatedAt: withinWindow,
        finishedAt: withinWindow,
      });
    }

    const svc = recoveryServiceWithMocks();

    const capHitResult = await svc.reconcileResolvedDependencyWakeBackstop({
      now: capHitNow,
      rearmWindowMs: windowMs,
      rearmMaxCount: maxCount,
    });
    expect(capHitResult.reArmCapEscalated).toBe(1);

    const noCapNow = new Date(capHitNow.getTime() + 4 * 60_000);
    await db
      .delete(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, blockedIssueId));

    const noCapResult = await svc.reconcileResolvedDependencyWakeBackstop({
      now: noCapNow,
      rearmWindowMs: windowMs,
      rearmMaxCount: maxCount,
    });
    expect(noCapResult.reArmCapSkipped).toBe(0);
    expect(noCapResult.checked).toBe(0);

    await db
      .update(issues)
      .set({ status: "blocked" })
      .where(eq(issues.id, blockedIssueId));
    await db
      .delete(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));
    const capHitAgainNow = new Date(capHitNow.getTime() + 6 * 60_000);
    const outsideRearmWindow = new Date(capHitAgainNow.getTime() - windowMs - 1);
    for (let i = 0; i < maxCount; i++) {
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_blockers_resolved",
        payload: {
          issueId: blockedIssueId,
          resolvedBlockerIssueId: blockerIssueId,
          blockerIssueIds: [blockerIssueId],
        },
        status: "completed",
        idempotencyKey,
        createdAt: outsideRearmWindow,
        updatedAt: outsideRearmWindow,
        finishedAt: outsideRearmWindow,
      });
    }

    const capHitAgainResult = await svc.reconcileResolvedDependencyWakeBackstop({
      now: capHitAgainNow,
      rearmWindowMs: windowMs,
      rearmMaxCount: maxCount,
    });
    expect(capHitAgainResult.reArmCapEscalated).toBe(0);
    expect(capHitAgainResult.reArmCapSkipped).toBe(1);
  });
});
