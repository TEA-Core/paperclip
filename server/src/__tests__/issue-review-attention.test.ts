import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import {
  classifyIssueGraphLiveness,
  classifyIssueReviewPaths,
} from "../services/recovery/issue-graph-liveness.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review attention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue review attention", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-review-attention-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Review Attention Co",
      issuePrefix: "RVA",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Review Agent",
      role: "engineer",
      status: "idle",
    });
    return { companyId, agentId };
  }

  async function insertReview(input: {
    companyId: string;
    agentId: string;
    identifier: string;
    assigneeUserId?: string | null;
    executionState?: Record<string, unknown> | null;
    monitorNextCheckAt?: Date | null;
    executionPolicy?: Record<string, unknown> | null;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      identifier: input.identifier,
      title: input.identifier,
      status: "in_review",
      priority: "medium",
      assigneeAgentId: input.assigneeUserId ? null : input.agentId,
      assigneeUserId: input.assigneeUserId ?? null,
      executionState: input.executionState ?? null,
      monitorNextCheckAt: input.monitorNextCheckAt ?? null,
      executionPolicy: input.executionPolicy ?? null,
    });
    return id;
  }

  it("surfaces a pathless agent-owned review as stalled and a queued recovery as covered", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await insertReview({ companyId, agentId, identifier: "RVA-1" });

    let row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
    expect(row?.reviewAttention).toMatchObject({
      state: "stalled",
      paths: [],
    });
    expect(row?.reviewAttention?.reason).toContain("no participant, interaction, approval");

    const recoveryIdempotencyKey = `issue_review_path_lost:${issueId}:fingerprint`;
    const recoveryWake = {
      companyId,
      agentId,
      source: "automation",
      reason: "issue_review_path_lost",
      status: "queued",
      payload: { issueId },
      idempotencyKey: recoveryIdempotencyKey,
    };
    await db.insert(agentWakeupRequests).values(recoveryWake);
    await expect(db.insert(agentWakeupRequests).values(recoveryWake)).rejects.toMatchObject({
      cause: {
        code: "23505",
        constraint_name: "agent_wakeup_requests_review_path_recovery_idempotency_uq",
      },
    });

    row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
    expect(row?.reviewAttention).toMatchObject({
      state: "covered",
      paths: [expect.objectContaining({ kind: "queued_wake", responder: "Review Agent" })],
    });
  });

  it("reports every healthy review path as covered", async () => {
    const { companyId, agentId } = await seed();
    const interactionIssueId = await insertReview({ companyId, agentId, identifier: "RVA-2" });
    const humanOnlyInteractionIssueId = await insertReview({ companyId, agentId, identifier: "RVA-2H" });
    const approvalIssueId = await insertReview({ companyId, agentId, identifier: "RVA-3" });
    const monitorIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-4",
      monitorNextCheckAt: new Date(Date.now() + 60_000),
      executionPolicy: { monitor: { maxAttempts: 3 } },
    });
    const humanIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-5",
      assigneeUserId: "board-user",
    });
    const participantIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-6",
      // Armed within the participant grace window (SUP-15565) so a live
      // invokable participant is still a maintained execution_participant path.
      executionState: {
        status: "pending",
        currentParticipant: { type: "agent", agentId },
        pendingSince: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      },
    });
    const activeRunIssueId = await insertReview({ companyId, agentId, identifier: "RVA-7" });
    const recoveryIssueId = await insertReview({ companyId, agentId, identifier: "RVA-8" });

    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: interactionIssueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: { version: 1, prompt: "Approve?" },
    });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: humanOnlyInteractionIssueId,
      kind: "request_confirmation",
      status: "pending",
      continuationPolicy: "wake_assignee",
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      resolverPolicyProvenance: "explicit",
      effectiveResolverPolicySource: "requested",
      payload: { version: 1, prompt: "Human review?" },
    });
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { title: "Review" },
    });
    await db.insert(issueApprovals).values({ companyId, issueId: approvalIssueId, approvalId });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: activeRunIssueId },
    });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: recoveryIssueId,
      kind: "missing_disposition",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      cause: "review_path_lost",
      fingerprint: "review-path",
      evidence: {},
      nextAction: "Restore review path",
    });

    const rows = await svc.list(companyId, { status: "in_review" });
    const byId = new Map(rows.map((row) => [row.id, row.reviewAttention]));
    const expectedKinds = new Map([
      [interactionIssueId, "interaction"],
      [humanOnlyInteractionIssueId, "interaction"],
      [approvalIssueId, "approval"],
      [monitorIssueId, "monitor"],
      [humanIssueId, "human_reviewer"],
      [participantIssueId, "execution_participant"],
      [activeRunIssueId, "active_run"],
      [recoveryIssueId, "recovery"],
    ]);

    for (const [issueId, kind] of expectedKinds) {
      expect(byId.get(issueId), kind).toMatchObject({
        state: "covered",
        paths: expect.arrayContaining([expect.objectContaining({ kind })]),
      });
    }
    expect(byId.get(interactionIssueId)?.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "interaction", responder: "Review Agent" }),
    ]));
    expect(byId.get(humanOnlyInteractionIssueId)?.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "interaction", responder: "Board" }),
    ]));
  });

  it("classifies an escalated human hold as stalled without loosening healthy reviews", async () => {
    const { companyId, agentId } = await seed();
    // Escalated hold: the card is parked on a human (assigneeUserId set, agent
    // assignee cleared) and that same human is the pending
    // executionState.currentParticipant, with the agent preserved as the return
    // assignee. Both user-shaped review paths resolve to the hold user, so none
    // of them is a maintained action path -> the hold is `stalled` (SUP-14806).
    const holdUserId = "esc-hold-user";
    const escalatedHoldIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-ESC-1",
      assigneeUserId: holdUserId,
      executionState: {
        status: "pending",
        currentParticipant: { type: "user", userId: holdUserId },
        returnAssignee: { type: "agent", agentId },
      },
    });
    // Regression: a live agent participant is a maintained path -> stays covered.
    const agentParticipantIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-ESC-2",
      // Armed within the participant grace window (SUP-15565): a live
      // invokable participant still maintains the card.
      executionState: {
        status: "pending",
        currentParticipant: { type: "agent", agentId },
        pendingSince: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      },
    });

    const rows = await svc.list(companyId, { status: "in_review" });
    const byId = new Map(rows.map((row) => [row.id, row.reviewAttention]));
    expect(byId.get(escalatedHoldIssueId)).toMatchObject({
      state: "stalled",
      paths: [],
    });
    expect(byId.get(agentParticipantIssueId)).toMatchObject({
      state: "covered",
      paths: [expect.objectContaining({ kind: "execution_participant" })],
    });
  });

  it("does not let a transiently skipped recovery consume its fingerprint", async () => {
    const { companyId, agentId } = await seed();
    const idempotencyKey = `issue_review_path_lost:${randomUUID()}:fingerprint`;
    const baseWake = {
      companyId,
      agentId,
      source: "automation",
      reason: "issue_review_path_lost",
      payload: {},
      idempotencyKey,
    };

    await db.insert(agentWakeupRequests).values({
      ...baseWake,
      status: "skipped",
      finishedAt: new Date(),
    });

    await expect(db.insert(agentWakeupRequests).values({
      ...baseWake,
      status: "queued",
    })).resolves.toBeDefined();
  });

  it("does not score a dead review stage covered on stale undelivered wakes (SUP-15369)", async () => {
    const { companyId, agentId } = await seed();
    // The review participant is a dead (paused) agent, so it is not a live
    // execution_participant path — mirroring SUP-15248's stuck review stage.
    const deadAgentId = randomUUID();
    await db.insert(agents).values({
      id: deadAgentId,
      companyId,
      name: "Dead Reviewer",
      role: "engineer",
      status: "paused",
    });

    const deadParticipantState = {
      status: "pending",
      currentStageType: "review",
      currentStageIndex: 0,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      reviewRequest: null,
      changesRequestedCount: 0,
      currentParticipant: { type: "agent", agentId: deadAgentId },
    };

    const staleIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-STALE-1",
      executionState: deadParticipantState,
    });

    // The exact SUP-15248 shape: nine undelivered review re-arm wakes, all older
    // than the participant re-arm deferral window (30 min) and never delivered.
    // Production re-arms use reason `execution_review_requested` with
    // payload.rearm=true (recovery/service.ts PENDING_REVIEW_REARM_REASON), so the
    // fixture mirrors that instead of the pre-fix test-only reason.
    const staleAgeMs = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 9; i += 1) {
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId: deadAgentId,
        source: "automation",
        reason: "execution_review_requested",
        status: "queued",
        payload: { issueId: staleIssueId, mutation: "update", rearm: true },
        requestedAt: new Date(Date.now() - staleAgeMs - i * 60_000),
      });
    }

    // The 3/3 exhausted re-arm budget: the three re-arm attempts the platform
    // already made reached a terminal status (completed/failed/timed_out).
    // Terminal wakes are not `queued_wake` maintained paths — the attention fetch
    // only reads queued/deferred/claimed rows — so their presence proves the
    // exhausted-budget state is still not counted as covered.
    const consumedRearmStatuses: string[] = ["completed", "failed", "timed_out"];
    for (let i = 0; i < consumedRearmStatuses.length; i += 1) {
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId: deadAgentId,
        source: "automation",
        reason: "execution_review_requested",
        status: consumedRearmStatuses[i],
        payload: { issueId: staleIssueId, mutation: "update", rearm: true },
        requestedAt: new Date(Date.now() - (i + 1) * 5 * 60 * 1000),
        finishedAt: new Date(Date.now() - i * 5 * 60 * 1000),
      });
    }

    // The real production 3/3 shape: when the re-arm budget is exhausted, the
    // platform upserts a `pending_review_rearm_cap_exhausted` recovery action
    // (ownerType: board) on the review issue (recovery/service.ts). That action is
    // the terminal "re-arming stopped, escalate to board" marker — NOT a maintained
    // action path — so it must not keep the card `covered`. Seed it to prove the
    // exhausted undecided review still scores stalled even with the marker present.
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: staleIssueId,
      kind: "pending_review_rearm_cap_exhausted",
      status: "active",
      ownerType: "board",
      previousOwnerAgentId: deadAgentId,
      cause: "pending_review_rearm_cap_exhausted",
      fingerprint: `prr:${companyId}:${staleIssueId}`,
      evidence: { identifier: "RVA-STALE-1", reArmCount: 3, reArmMax: 3, reArmWindowMs: 30 * 60 * 1000 },
      nextAction: "This issue's pending review was re-armed repeatedly without a decision. Review and take action.",
    });

    let row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === staleIssueId);
    expect(row?.reviewAttention?.state).not.toBe("covered");
    expect(row?.reviewAttention).toMatchObject({ state: "stalled", paths: [] });

    // Control: a fresh queued re-arm wake (within the deferral window) is still a
    // maintained path -> covered.
    const freshIssueId = await insertReview({
      companyId,
      agentId,
      identifier: "RVA-STALE-2",
      executionState: deadParticipantState,
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: deadAgentId,
      source: "automation",
      reason: "execution_review_requested",
      status: "queued",
      payload: { issueId: freshIssueId, mutation: "update", rearm: true },
      requestedAt: new Date(),
    });
    row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === freshIssueId);
    expect(row?.reviewAttention).toMatchObject({
      state: "covered",
      paths: [expect.objectContaining({ kind: "queued_wake" })],
    });
  });

  describe("execution_participant freshness gate (SUP-15565)", () => {
    // A live, invokable review participant who has never been woken for this
    // card must stop keeping the card `covered` indefinitely. The gate bounds
    // the execution_participant path by the stage-arm grace window; past it,
    // only a card-scoped live path (active run / non-stale queued wake on THIS
    // card) keeps the card covered.

    const pastGraceIso = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const withinGraceIso = () => new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const pendingAgentState = (agentId: string, pendingSince: string) => ({
      status: "pending",
      currentParticipant: { type: "agent", agentId },
      pendingSince,
    });

    it("stalls a card whose live participant is past the grace with no card-scoped path", async () => {
      const { companyId, agentId } = await seed();
      const issueId = await insertReview({
        companyId,
        agentId,
        identifier: "RVA-FRESH-1",
        executionState: pendingAgentState(agentId, pastGraceIso()),
      });

      const row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
      expect(row?.reviewAttention).toMatchObject({ state: "stalled", paths: [] });
    });

    it("keeps a card covered via execution_participant when the stage armed within the grace", async () => {
      const { companyId, agentId } = await seed();
      const issueId = await insertReview({
        companyId,
        agentId,
        identifier: "RVA-FRESH-2",
        executionState: pendingAgentState(agentId, withinGraceIso()),
      });

      const row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
      expect(row?.reviewAttention).toMatchObject({
        state: "covered",
        paths: [expect.objectContaining({ kind: "execution_participant" })],
      });
    });

    it("stalls a card when its participant is past the grace but only busy on another card", async () => {
      const { companyId, agentId } = await seed();
      const cardIssueId = await insertReview({
        companyId,
        agentId,
        identifier: "RVA-FRESH-3",
        executionState: pendingAgentState(agentId, pastGraceIso()),
      });
      // The participant's only live activity is a run on a different in_review
      // card; that run is not scoped to this card, so it does not maintain it.
      const otherIssueId = await insertReview({ companyId, agentId, identifier: "RVA-FRESH-3B" });
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId: otherIssueId },
      });

      const row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === cardIssueId);
      expect(row?.reviewAttention).toMatchObject({ state: "stalled", paths: [] });
    });

    it("keeps a card covered via queued_wake when the participant is past the grace but has a fresh card-scoped wake", async () => {
      const { companyId, agentId } = await seed();
      const issueId = await insertReview({
        companyId,
        agentId,
        identifier: "RVA-FRESH-4",
        executionState: pendingAgentState(agentId, pastGraceIso()),
      });
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "automation",
        reason: "execution_review_requested",
        status: "queued",
        payload: { issueId, mutation: "update", rearm: true },
        requestedAt: new Date(),
      });

      const row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
      expect(row?.reviewAttention).toMatchObject({
        state: "covered",
        paths: expect.arrayContaining([expect.objectContaining({ kind: "queued_wake" })]),
      });
    });

    it("does not count a same-card active run owned by another agent as the participant's card-scoped live path", async () => {
      const { companyId, agentId } = await seed();
      const otherAgentId = randomUUID();
      await db.insert(agents).values({
        id: otherAgentId,
        companyId,
        name: "Other Agent",
        role: "engineer",
        status: "idle",
      });
      const issueId = await insertReview({
        companyId,
        agentId,
        identifier: "RVA-FRESH-5",
        executionState: pendingAgentState(agentId, pastGraceIso()),
      });
      // Another agent is actively running ON THIS CARD: a live path for the
      // card, but not a maintained action path for the participant.
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId: otherAgentId,
        status: "running",
        contextSnapshot: { issueId },
      });

      const row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
      const kinds = (row?.reviewAttention?.paths ?? []).map((path) => path.kind);
      expect(kinds).not.toContain("execution_participant");
      expect(kinds).toContain("active_run");
    });

    it("treats a legacy stage without pendingSince as stale even when updatedAt was just bumped by an unrelated update", async () => {
      const { companyId, agentId } = await seed();
      const issueId = await insertReview({
        companyId,
        agentId,
        identifier: "RVA-FRESH-6",
        executionState: {
          status: "pending",
          currentParticipant: { type: "agent", agentId },
        },
      });
      await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issueId));

      const row = (await svc.list(companyId, { status: "in_review" })).find((issue) => issue.id === issueId);
      const kinds = (row?.reviewAttention?.paths ?? []).map((path) => path.kind);
      expect(kinds).not.toContain("execution_participant");
    });
  });

  // SUP-15713: the wire projection (svc.list -> listIssueReviewAttentionMap)
  // previously gated its input to status === "in_review", so the SUP-15696 shape
  // — an in_progress card whose stage-decision write was rejected while the
  // stage stayed pending with an invokable currentParticipant — reported
  // reviewAttention: none on the actual API path even though the pure
  // classifier had been widened. These tests assert the service projection, not
  // the pure classifier, so acceptance #1 is pinned at the wire.
  describe("review liveness status gate service projection (SUP-15713)", () => {
    const twoHourAgoIso = () => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const fiveMinAgoIso = () => new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const pendingReviewStage = (participantAgentId: string, pendingSince: string) => ({
      status: "pending",
      currentStageType: "review",
      currentStageIndex: 0,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: "changes_requested",
      changesRequestedCount: 1,
      currentParticipant: { type: "agent", agentId: participantAgentId },
      pendingSince,
    });

    async function seedCompanyWithTwoAgents() {
      const companyId = randomUUID();
      const leadId = randomUUID();
      const participantId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Review Attention Co",
        issuePrefix: "RVA",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: leadId,
        companyId,
        name: "Lead Agent",
        role: "engineer",
        status: "idle",
      });
      await db.insert(agents).values({
        id: participantId,
        companyId,
        name: "Support CR",
        role: "engineer",
        status: "idle",
      });
      return { companyId, leadId, participantId };
    }

    async function insertActiveCard(input: {
      companyId: string;
      status: string;
      identifier: string;
      assigneeAgentId: string | null;
      executionState: Record<string, unknown> | null;
    }) {
      const id = randomUUID();
      await db.insert(issues).values({
        id,
        companyId: input.companyId,
        identifier: input.identifier,
        title: input.identifier,
        status: input.status,
        priority: "medium",
        assigneeAgentId: input.assigneeAgentId,
        assigneeUserId: null,
        executionState: input.executionState,
      });
      return id;
    }

    it("produces a non-none stalled reviewAttention for an in_progress card with a stale pending review stage", async () => {
      const { companyId, leadId, participantId } = await seedCompanyWithTwoAgents();
      const issueId = await insertActiveCard({
        companyId,
        status: "in_progress",
        identifier: "SUP-15696-REPRO",
        assigneeAgentId: leadId,
        executionState: pendingReviewStage(participantId, twoHourAgoIso()),
      });

      const row = (await svc.list(companyId, { status: "in_progress" })).find((issue) => issue.id === issueId);
      // Before the gate widened this was {state: "none", paths: [], reason: null}.
      expect(row?.reviewAttention?.state).toBe("stalled");
      expect(row?.reviewAttention?.paths).toEqual([]);
      // The finding names the participant that is awaiting the decision.
      expect(row?.reviewAttention?.reason).toContain("Support CR");
    });

    it("reports a fresh in_progress review participant as a maintained execution_participant path", async () => {
      const { companyId, leadId, participantId } = await seedCompanyWithTwoAgents();
      const issueId = await insertActiveCard({
        companyId,
        status: "in_progress",
        identifier: "SUP-15713-FRESH",
        assigneeAgentId: leadId,
        executionState: pendingReviewStage(participantId, fiveMinAgoIso()),
      });

      const row = (await svc.list(companyId, { status: "in_progress" })).find((issue) => issue.id === issueId);
      expect(row?.reviewAttention).toMatchObject({
        state: "covered",
        paths: [expect.objectContaining({ kind: "execution_participant" })],
      });
    });

    it("still reports none for a done or cancelled card carrying a stale pending executionState", async () => {
      const { companyId, leadId, participantId } = await seedCompanyWithTwoAgents();
      for (const status of ["done", "cancelled"]) {
        const issueId = await insertActiveCard({
          companyId,
          status,
          identifier: `SUP-15713-TERM-${status}`,
          assigneeAgentId: leadId,
          executionState: pendingReviewStage(participantId, twoHourAgoIso()),
        });
        const row = (await svc.list(companyId, { status })).find((issue) => issue.id === issueId);
        expect(row?.reviewAttention, status).toEqual({ state: "none", paths: [], reason: null });
      }
    });
  });
});

// SUP-15713: review liveness was gated on `status === "in_review"`, so a card
// whose stage-decision write was rejected (returned to active work, e.g.
// in_progress) while the stage stayed `pending` with an invokable
// `currentParticipant` was invisible to every liveness path and to
// `reviewAttention`. These pure-function tests pin the widened gate: admit a
// card that is in review OR carrying a live pending stage decision, while
// still excluding terminal statuses and preserving blocker-chain precedence.
describe("review liveness status widening (SUP-15713)", () => {
  const companyId = "co-sup-15713";
  const graceMs = 30 * 60 * 1000;

  function agent(overrides: Record<string, unknown> = {}) {
    return {
      id: "exec-cto",
      companyId,
      name: "exec-CTO",
      role: "cto",
      title: null,
      status: "idle",
      reportsTo: null,
      ...overrides,
    };
  }

  const cto = agent();
  const supportCR = agent({
    id: "support-cr",
    name: "support-CR",
    role: "engineer",
    reportsTo: "exec-cto",
  });

  function pendingReviewState(participantAgentId: string, pendingSince: string) {
    return {
      status: "pending",
      currentStageType: "review",
      currentStageIndex: 0,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      changesRequestedCount: 1,
      currentParticipant: { type: "agent", agentId: participantAgentId },
      pendingSince,
    };
  }

  function card(overrides: Record<string, unknown> = {}) {
    return {
      id: "card-sup-15696",
      companyId,
      identifier: "SUP-15696",
      title: "Review liveness strand",
      status: "in_progress",
      assigneeAgentId: "exec-cto",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      // Stage armed 2h ago (past the 30m grace) with a live invokable
      // participant and no card-scoped wake/run — the exact SUP-15696 shape.
      executionState: pendingReviewState("support-cr", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()),
      ...overrides,
    };
  }

  it("produces a liveness finding for an in_progress card with a stale pending review stage", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [card()],
      relations: [],
      agents: [supportCR, cto],
      participantGraceMs: graceMs,
      now: new Date(),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueId: "card-sup-15696",
      state: "in_review_without_action_path",
      recommendedOwnerAgentId: "exec-cto",
      incidentKey: `harness_liveness:${companyId}:card-sup-15696:in_review_without_action_path:card-sup-15696`,
    });
    // The finding names the participant that is awaiting the decision.
    expect(findings[0].reason).toContain("support-CR");
  });

  it("reports a fresh in_progress review participant as a maintained execution_participant path", () => {
    const issue = card({
      executionState: pendingReviewState("support-cr", new Date(Date.now() - 5 * 60 * 1000).toISOString()),
    });
    const paths = classifyIssueReviewPaths(
      { issues: [issue], relations: [], agents: [supportCR, cto], participantGraceMs: graceMs, now: new Date() },
      issue,
    );
    expect(paths).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "execution_participant", agentId: "support-cr" })]),
    );
  });

  it("does not produce a review finding when a blocked card still has an unresolved first-class blocker", () => {
    const findings = classifyIssueGraphLiveness({
      issues: [
        card({ status: "blocked" }),
        {
          id: "blocker-sup-15713",
          companyId,
          identifier: "BLK-1",
          title: "First-class blocker",
          status: "todo",
          assigneeAgentId: null,
          assigneeUserId: null,
          executionState: null,
        },
      ],
      relations: [{ companyId, blockerIssueId: "blocker-sup-15713", blockedIssueId: "card-sup-15696" }],
      agents: [supportCR, cto],
      participantGraceMs: graceMs,
      now: new Date(),
    });

    // The blocker chain still owns the card: exactly one finding, and it is a
    // blocked finding — not a review finding.
    expect(findings).toHaveLength(1);
    expect(findings[0].state).toBe("blocked_by_unassigned_issue");
  });

  it("produces no finding for done or cancelled cards carrying a stale pending executionState", () => {
    for (const status of ["done", "cancelled"]) {
      const findings = classifyIssueGraphLiveness({
        issues: [card({ status })],
        relations: [],
        agents: [supportCR, cto],
        participantGraceMs: graceMs,
        now: new Date(),
      });
      expect(findings, status).toEqual([]);
    }
  });
});

