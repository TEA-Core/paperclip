import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.ts";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres external-pull recovery routing tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// A process-adapter agent that declares `external_pull` work delivery runs
// outside Paperclip and pulls its own queue. Its parked cards are not stranded:
// the stillborn-backlog sweep, the stranded-assigned sweep and the
// exhausted-recovery drain (which mints `stranded_issue_recovery` cards) must
// leave them with their owner and never route them up the manager ladder to
// the company's CTO/CEO. An ordinary invoked agent keeps today's recovery.
describeEmbeddedPostgres("recovery sweeps leave external-pull assignees' cards with their owner", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-external-pull-routing-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql`truncate table companies cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type Fleet = {
    companyId: string;
    ctoId: string;
    ceoId: string;
    externalAgentId: string;
    coderId: string;
  };

  async function seedFleet(): Promise<Fleet> {
    const companyId = randomUUID();
    const ctoId = randomUUID();
    const ceoId = randomUUID();
    const externalAgentId = randomUUID();
    const coderId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ceoId,
        companyId,
        name: "exec-CEO",
        role: "ceo",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: ctoId,
        companyId,
        name: "exec-CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        reportsTo: ceoId,
      },
    ]);
    await db.insert(agents).values([
      {
        id: externalAgentId,
        companyId,
        name: "firstmate-primary",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: "/bin/echo" },
        runtimeConfig: { workDelivery: "external_pull" },
        permissions: {},
        reportsTo: ceoId,
      },
      {
        id: coderId,
        companyId,
        name: "coder-invoked",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        reportsTo: ctoId,
      },
    ]);
    return { companyId, ctoId, ceoId, externalAgentId, coderId };
  }

  function makeSweep() {
    const enqueueWakeup = vi.fn(async () => null);
    return { svc: recoveryService(db, { enqueueWakeup }), enqueueWakeup };
  }

  function wokenAgentIds(enqueueWakeup: ReturnType<typeof vi.fn>) {
    return enqueueWakeup.mock.calls.map((call) => call[0] as string);
  }

  async function issueRow(issueId: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    return row ?? null;
  }

  async function recoveryActionRows(issueId: string) {
    return db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
  }

  async function recoveryChildren(issueId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.originKind, "stranded_issue_recovery"), eq(issues.originId, issueId)));
  }

  async function wakeRowsFor(agentIds: string[]) {
    return db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.agentId, agentIds));
  }

  async function setAgentStatus(agentId: string, status: "paused" | "terminated") {
    await db.update(agents).set({ status }).where(eq(agents.id, agentId));
  }

  async function expectNotReassigned(fleet: Fleet, issueId: string) {
    const issue = await issueRow(issueId);
    expect(issue?.assigneeAgentId).toBe(fleet.externalAgentId);
    expect(issue?.checkoutRunId ?? null).toBeNull();
    expect(await recoveryChildren(issueId)).toHaveLength(0);
    expect(await wakeRowsFor([fleet.ctoId, fleet.ceoId, fleet.coderId])).toHaveLength(0);
  }

  async function expectLeftWithOwner(fleet: Fleet, issueId: string, expected: { status: string }) {
    const issue = await issueRow(issueId);
    expect(issue?.status).toBe(expected.status);
    expect(issue?.assigneeAgentId).toBe(fleet.externalAgentId);
    expect(issue?.checkoutRunId ?? null).toBeNull();
    expect(await recoveryChildren(issueId)).toHaveLength(0);
    expect(await wakeRowsFor([fleet.ctoId, fleet.ceoId])).toHaveLength(0);
  }

  // --- stillborn_assigned_backlog -----------------------------------------

  async function seedBacklogCard(companyId: string, assigneeAgentId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Parked backlog card",
      status: "backlog",
      priority: "high",
      assigneeAgentId,
      createdAt: new Date(Date.now() - 120_000),
    });
    return issueId;
  }

  it("stillborn backlog: does not block or re-home a parked card of an external-pull assignee", async () => {
    const fleet = await seedFleet();
    const issueId = await seedBacklogCard(fleet.companyId, fleet.externalAgentId);
    const { svc, enqueueWakeup } = makeSweep();

    const result = await svc.reconcileStillbornAssignedBacklog();

    expect(result.reported).toBe(0);
    expect(result.issueIds).toEqual([]);
    await expectLeftWithOwner(fleet, issueId, { status: "backlog" });
    expect(await recoveryActionRows(issueId)).toHaveLength(0);
    expect(wokenAgentIds(enqueueWakeup)).not.toContain(fleet.ctoId);
    expect(wokenAgentIds(enqueueWakeup)).not.toContain(fleet.ceoId);
  });

  it.each(["paused", "terminated"] as const)(
    "stillborn backlog: surfaces a %s external-pull assignee's card to the board without re-homing it",
    async (status) => {
      const fleet = await seedFleet();
      await setAgentStatus(fleet.externalAgentId, status);
      const issueId = await seedBacklogCard(fleet.companyId, fleet.externalAgentId);
      const { svc, enqueueWakeup } = makeSweep();

      const result = await svc.reconcileStillbornAssignedBacklog();

      expect(result.reported).toBe(1);
      expect(result.issueIds).toEqual([issueId]);
      expect((await issueRow(issueId))?.status).toBe("blocked");
      await expectNotReassigned(fleet, issueId);
      const actions = await recoveryActionRows(issueId);
      expect(actions).toHaveLength(1);
      expect(actions[0].cause).toBe("stillborn_assigned_backlog");
      expect(actions[0].ownerType).toBe("board");
      expect(actions[0].ownerAgentId).toBeNull();
      expect(enqueueWakeup).not.toHaveBeenCalled();
    },
  );

  it("stillborn backlog: still escalates a parked card of an ordinary invoked agent", async () => {
    const fleet = await seedFleet();
    const issueId = await seedBacklogCard(fleet.companyId, fleet.coderId);
    const { svc } = makeSweep();

    const result = await svc.reconcileStillbornAssignedBacklog();

    expect(result.reported).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
    const issue = await issueRow(issueId);
    expect(issue?.status).toBe("blocked");
    // Today's routing: the manager ladder re-homes the card to the CTO.
    expect(issue?.assigneeAgentId).toBe(fleet.ctoId);
    const actions = await recoveryActionRows(issueId);
    expect(actions).toHaveLength(1);
    expect(actions[0].cause).toBe("stillborn_assigned_backlog");
  });

  // --- stranded_assigned_issue --------------------------------------------

  async function seedStrandedCard(companyId: string, assigneeAgentId: string) {
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const finishedAt = new Date("2026-03-19T00:05:00.000Z");
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId: assigneeAgentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "failed",
      runId,
      claimedAt: new Date("2026-03-19T00:00:00.000Z"),
      finishedAt,
      error: "Budget exceeded; refusing to dispatch.",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: assigneeAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      finishedAt,
      updatedAt: finishedAt,
      errorCode: "budget_blocked",
      error: "Budget exceeded; refusing to dispatch.",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Parked in-progress card",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
      checkoutRunId: runId,
      executionRunId: null,
      responsibleUserId: "responsible-user",
      startedAt: new Date("2026-03-19T00:00:00.000Z"),
      updatedAt: finishedAt,
    });
    return { issueId, runId };
  }

  it("stranded assigned issue: does not block or re-home a card of an external-pull assignee", async () => {
    const fleet = await seedFleet();
    const { issueId } = await seedStrandedCard(fleet.companyId, fleet.externalAgentId);
    const { svc, enqueueWakeup } = makeSweep();

    const result = await svc.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(0);
    expect(result.issueIds).not.toContain(issueId);
    const issue = await issueRow(issueId);
    expect(issue?.status).toBe("in_progress");
    expect(issue?.assigneeAgentId).toBe(fleet.externalAgentId);
    expect(await recoveryActionRows(issueId)).toHaveLength(0);
    expect(await recoveryChildren(issueId)).toHaveLength(0);
    expect(await wakeRowsFor([fleet.ctoId, fleet.ceoId])).toHaveLength(0);
    expect(wokenAgentIds(enqueueWakeup)).not.toContain(fleet.ctoId);
    expect(wokenAgentIds(enqueueWakeup)).not.toContain(fleet.ceoId);
  });

  it.each(["paused", "terminated"] as const)(
    "stranded assigned issue: surfaces a %s external-pull assignee's card to the board without re-homing it",
    async (status) => {
      const fleet = await seedFleet();
      await setAgentStatus(fleet.externalAgentId, status);
      const { issueId } = await seedStrandedCard(fleet.companyId, fleet.externalAgentId);
      await db.update(issues).set({ checkoutRunId: null }).where(eq(issues.id, issueId));
      const { svc, enqueueWakeup } = makeSweep();

      const result = await svc.reconcileStrandedAssignedIssues();

      expect(result.noLivePathOwnerUnavailable).toBe(1);
      expect(result.issueIds).toEqual([issueId]);
      expect((await issueRow(issueId))?.status).toBe("in_progress");
      await expectNotReassigned(fleet, issueId);
      const actions = await recoveryActionRows(issueId);
      expect(actions).toHaveLength(1);
      expect(actions[0].kind).toBe("no_live_path_owner_unavailable");
      expect(actions[0].ownerType).toBe("board");
      expect(actions[0].ownerAgentId).toBeNull();
      expect(enqueueWakeup).not.toHaveBeenCalled();
    },
  );

  it("stranded assigned issue: still escalates a card of an ordinary invoked agent", async () => {
    const fleet = await seedFleet();
    const { issueId } = await seedStrandedCard(fleet.companyId, fleet.coderId);
    const { svc } = makeSweep();

    const result = await svc.reconcileStrandedAssignedIssues();

    expect(result.escalated).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
    const issue = await issueRow(issueId);
    expect(issue?.status).toBe("blocked");
    const actions = await recoveryActionRows(issueId);
    expect(actions).toHaveLength(1);
    expect(actions[0].kind).toBe("stranded_assigned_issue");
  });

  // --- stranded_issue_recovery (exhausted-recovery drain) -----------------

  function exhaustedMonitorExecutionState(attemptCount: number) {
    return {
      status: "idle",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: null,
      deliveryAuthor: null,
      reviewRequest: null,
      completedStageIds: [],
      skippedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      monitor: {
        status: "triggered",
        nextCheckAt: null,
        lastTriggeredAt: "2026-11-01T12:08:00.000Z",
        attemptCount,
        notes: null,
        scheduledBy: "assignee",
        kind: null,
        serviceName: null,
        externalRef: null,
        timeoutAt: null,
        maxAttempts: 3,
        recoveryPolicy: null,
        clearedAt: null,
        clearReason: null,
      },
    };
  }

  async function seedExhaustedBlockedCard(companyId: string, assigneeAgentId: string) {
    const issueId = randomUUID();
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Blocked behind an exhausted recovery action",
      status: "blocked",
      priority: "high",
      assigneeAgentId,
      // The assignee's own monitor already spent its bounds, so the drain
      // cannot arm a board monitor and falls back to a recovery card.
      monitorAttemptCount: 10,
      monitorScheduledBy: "assignee",
      executionState: exhaustedMonitorExecutionState(10),
      updatedAt: old,
    });
    await db.insert(issueRecoveryActions).values({
      id: randomUUID(),
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      status: "escalated",
      ownerType: "board",
      previousOwnerAgentId: assigneeAgentId,
      cause: "stillborn_assigned_backlog",
      fingerprint: `stillborn:${issueId}`,
      attemptCount: 5,
      maxAttempts: 5,
      nextAction: "Rule on the parked card.",
      outcome: "exhausted",
      evidence: { identifier: null },
      lastAttemptAt: old,
    });
    return issueId;
  }

  it("stranded issue recovery: does not mint a CTO/CEO-owned recovery card for an external-pull assignee", async () => {
    const fleet = await seedFleet();
    const issueId = await seedExhaustedBlockedCard(fleet.companyId, fleet.externalAgentId);
    const { svc, enqueueWakeup } = makeSweep();

    const result = await svc.reconcileExhaustedRecoveryDrain({ companyId: fleet.companyId });

    expect(result.recoveryIssueMinted).toBe(0);
    await expectLeftWithOwner(fleet, issueId, { status: "blocked" });
    const [action] = await recoveryActionRows(issueId);
    expect(action.recoveryIssueId).toBeNull();
    expect(wokenAgentIds(enqueueWakeup)).not.toContain(fleet.ctoId);
    expect(wokenAgentIds(enqueueWakeup)).not.toContain(fleet.ceoId);
  });

  it.each(["paused", "terminated"] as const)(
    "stranded issue recovery: leaves a %s external-pull assignee's card on its board action without re-homing it",
    async (status) => {
      const fleet = await seedFleet();
      await setAgentStatus(fleet.externalAgentId, status);
      const issueId = await seedExhaustedBlockedCard(fleet.companyId, fleet.externalAgentId);
      const { svc, enqueueWakeup } = makeSweep();

      const result = await svc.reconcileExhaustedRecoveryDrain({ companyId: fleet.companyId });

      expect(result.recoveryIssueMinted).toBe(0);
      expect((await issueRow(issueId))?.status).toBe("blocked");
      await expectNotReassigned(fleet, issueId);
      const [action] = await recoveryActionRows(issueId);
      expect(action.ownerType).toBe("board");
      expect(action.status).toBe("escalated");
      expect(action.recoveryIssueId).toBeNull();
      expect(enqueueWakeup).not.toHaveBeenCalled();
    },
  );

  it("stranded issue recovery: still mints a recovery card for an ordinary invoked agent", async () => {
    const fleet = await seedFleet();
    const issueId = await seedExhaustedBlockedCard(fleet.companyId, fleet.coderId);
    const { svc } = makeSweep();

    const result = await svc.reconcileExhaustedRecoveryDrain({ companyId: fleet.companyId });

    expect(result.recoveryIssueMinted).toBe(1);
    const children = await recoveryChildren(issueId);
    expect(children).toHaveLength(1);
    expect(children[0].assigneeAgentId).toBe(fleet.ctoId);
    const [action] = await recoveryActionRows(issueId);
    expect(action.recoveryIssueId).toBe(children[0].id);
  });
});
