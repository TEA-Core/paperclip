import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.ts";
import {
  LIVE_RUN_CAP_ROUTER_SIGNAL_SOURCE,
  LIVE_RUN_CAP_SIGNAL_STALE_MS,
  clearLiveRunCapSignal,
  invalidateLiveRunCapSettingCache,
  liveRunCapAdmission,
  setLiveRunCapSignal,
} from "../services/live-run-cap.js";

// SUP-24563. Every started run blocks in the adapter until the test releases
// it, so a started run stays `running` and counts toward the cap exactly like
// a live session. Rows seeded directly as `running` stand in for live load.
const runGates = vi.hoisted(() => ({
  byRun: new Map<string, { promise: Promise<void>; release: () => void }>(),
  // Teardown opens every gate, including gates of runs a settle starts later.
  open: false,
}));
const gateFor = vi.hoisted(() => (runId: string) => {
  let gate = runGates.byRun.get(runId);
  if (!gate) {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    gate = { promise, release };
    if (runGates.open) release();
    runGates.byRun.set(runId, gate);
  }
  return gate;
});
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (context: { runId: string }) => {
    await gateFor(context.runId).promise;
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Live-run cap test run.",
      provider: "test",
      model: "test-model",
    };
  }),
);

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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres live-run cap tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type RunClass = "human_board" | "review_recovery" | "general";

describeEmbeddedPostgres("SUP-24563 global live-run cap admission", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let paperclipHome: string | null = null;
  let companyId = "";
  let loadAgentId = "";
  // Seeded runs are created a minute apart, starting 20 minutes back, so no
  // seeded run is old enough to age into a higher admission rank by accident.
  let createdAtCursor = 0;

  beforeAll(async () => {
    paperclipHome = await mkdtemp(join(tmpdir(), "heartbeat-live-run-cap-home-"));
    vi.stubEnv("PAPERCLIP_HOME", paperclipHome);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-live-run-cap-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await setCap(null);
    clearLiveRunCapSignal(LIVE_RUN_CAP_ROUTER_SIGNAL_SOURCE);
    runGates.open = true;
    for (const gate of runGates.byRun.values()) gate.release();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.status, "queued"));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(and(eq(heartbeatRuns.status, "running"), sql`${heartbeatRuns.contextSnapshot} ->> 'seededLoad' = 'true'`));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    liveRunCapAdmission.clearWaiters();
    runGates.byRun.clear();
    runGates.open = false;
    mockAdapterExecute.mockClear();
    await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
    if (paperclipHome) await rm(paperclipHome, { recursive: true, force: true });
  });

  async function setCap(liveRunCap: number | null) {
    await instanceSettingsService(db).updateGeneral({ liveRunCap });
    invalidateLiveRunCapSettingCache();
  }

  async function seedCompany() {
    companyId = randomUUID();
    createdAtCursor = Date.now() - 20 * 60_000;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    loadAgentId = await seedAgent("Load", { maxConcurrentRuns: 50 });
  }

  async function seedAgent(
    name: string,
    opts: { adapterType?: string; maxConcurrentRuns?: number; workDelivery?: string } = {},
  ) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: opts.adapterType ?? "codex_local",
      adapterConfig: {},
      permissions: {},
      runtimeConfig: {
        heartbeat: { wakeOnDemand: true, maxConcurrentRuns: opts.maxConcurrentRuns ?? 5 },
        ...(opts.workDelivery ? { workDelivery: opts.workDelivery } : {}),
      },
    });
    return id;
  }

  /** `count` live runs that occupy the cap and are not driven by an executor. */
  async function seedLiveRuns(count: number, agentId = loadAgentId) {
    if (count === 0) return [];
    const rows = await db.insert(heartbeatRuns).values(
      Array.from({ length: count }, () => ({
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        startedAt: new Date(),
        contextSnapshot: { seededLoad: "true" },
      })),
    ).returning();
    return rows.map((row) => row.id);
  }

  /** A seeded live run ends on its own. */
  async function finishLiveRuns(count: number) {
    const rows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.status, "running"), sql`${heartbeatRuns.contextSnapshot} ->> 'seededLoad' = 'true'`))
      .orderBy(asc(heartbeatRuns.createdAt))
      .limit(count);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(inArray(heartbeatRuns.id, rows.map((row) => row.id)));
  }

  async function seedQueuedRun(
    agentId: string,
    runClass: RunClass = "general",
    wake: {
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string;
      reason?: string;
      contextWakeReason?: string;
      issueStatus?: "todo" | "in_review";
      issueOriginKind?: string;
      issueExecutionState?: Record<string, unknown>;
      createdAt?: Date;
    } = {},
  ) {
    const createdAt = wake.createdAt ?? new Date((createdAtCursor += 60_000));
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `${runClass} work`,
      status: wake.issueStatus ?? "todo",
      assigneeAgentId: agentId,
      originKind: wake.issueOriginKind ?? (runClass === "review_recovery" ? "stranded_issue_recovery" : "manual"),
      ...(wake.issueExecutionState ? { executionState: wake.issueExecutionState } : {}),
    });
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    const requestedByActorType = wake.requestedByActorType ?? (runClass === "human_board" ? "user" : "system");
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: wake.reason ?? "issue_assigned",
      payload: { issueId },
      status: "queued",
      requestedByActorType,
      requestedByActorId: wake.requestedByActorId ??
        (requestedByActorType === "user" ? "board-user" : requestedByActorType === "agent" ? agentId : null),
      createdAt,
      requestedAt: createdAt,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: wake.contextWakeReason ?? wake.reason ?? "issue_assigned" },
      createdAt,
      updatedAt: createdAt,
    });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeupRequestId));
    return runId;
  }

  async function statusOf(runId: string) {
    return (await heartbeat.getRun(runId))?.status;
  }

  async function statusesOf(runIds: Record<string, string>) {
    return Object.fromEntries(
      await Promise.all(Object.entries(runIds).map(async ([name, id]) => [name, await statusOf(id)] as const)),
    );
  }

  async function snapshotRows(runIds: string[]) {
    return db.select().from(heartbeatRuns).where(inArray(heartbeatRuns.id, runIds)).orderBy(asc(heartbeatRuns.id));
  }

  // ─── (a) admission only ───────────────────────────────────────────────────

  it("(a) lowering the cap below the live count starts nothing and never touches a running run", async () => {
    await seedCompany();
    await setCap(15);
    const live = await seedLiveRuns(14);
    const human = await seedQueuedRun(await seedAgent("Human"), "human_board");
    const review = await seedQueuedRun(await seedAgent("Reviewer"), "review_recovery");
    const general = await seedQueuedRun(await seedAgent("Coder"), "general");
    const before = await snapshotRows(live);

    await instanceSettingsService(db).updateGeneral({ liveRunCap: 10 });
    await heartbeat.applyLiveRunCapSettingChange();
    await heartbeat.resumeQueuedRuns();

    expect(await statusesOf({ human, review, general })).toEqual({ human: "queued", review: "queued", general: "queued" });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    // Every live run is byte-for-byte what it was: status, pid, lease, timestamps.
    expect(await snapshotRows(live)).toEqual(before);

    // 14 -> 10 live: still at the cap, still zero starts.
    await finishLiveRuns(4);
    await heartbeat.resumeQueuedRuns();
    expect(mockAdapterExecute).not.toHaveBeenCalled();

    // The fifth finish (live 9 < 10) admits exactly one run: human/board first.
    await finishLiveRuns(1);
    await heartbeat.resumeQueuedRuns();
    expect(await statusesOf({ human, review, general })).toEqual({ human: "running", review: "queued", general: "queued" });
    expect(await heartbeat.getLiveRunCapStatus()).toMatchObject({
      enabled: true,
      setting: 10,
      effectiveCap: 10,
      generalCap: 8,
      liveRuns: 10,
      queuedRuns: 2,
      waitingOnCap: 2,
    });
  });

  // ─── (b) raising re-drives at once ────────────────────────────────────────

  it.each([15, null])("(b) raising the cap to %s starts the waiting queue without a scheduler tick", async (raised) => {
    await seedCompany();
    await setCap(10);
    await seedLiveRuns(10);
    const queued = [
      await seedQueuedRun(await seedAgent("A"), "general"),
      await seedQueuedRun(await seedAgent("B"), "general"),
      await seedQueuedRun(await seedAgent("C"), "general"),
    ];
    await heartbeat.resumeQueuedRuns();
    for (const runId of queued) expect(await statusOf(runId)).toBe("queued");

    await instanceSettingsService(db).updateGeneral({ liveRunCap: raised });
    await heartbeat.applyLiveRunCapSettingChange();

    for (const runId of queued) expect(await statusOf(runId)).toBe("running");
  });

  // ─── (c) order and reserve ────────────────────────────────────────────────

  it("(c) admits human/board, then review/recovery, then the oldest general run; priority runs hold the 2 reserved slots", async () => {
    await seedCompany();
    await setCap(10);
    await seedLiveRuns(9);
    // Created oldest first: general A, general B, review C, human D.
    const generalA = await seedQueuedRun(await seedAgent("A"), "general");
    const generalB = await seedQueuedRun(await seedAgent("B"), "general");
    const reviewC = await seedQueuedRun(await seedAgent("C"), "review_recovery");
    const humanD = await seedQueuedRun(await seedAgent("D"), "human_board");
    const order = { generalA, generalB, reviewC, humanD };

    // One slot (live 9 of 10), a reserved one: the newest run goes first because it is human/board.
    await heartbeat.resumeQueuedRuns();
    expect(await statusesOf(order)).toEqual({ generalA: "queued", generalB: "queued", reviewC: "queued", humanD: "running" });

    // Next slot, the second reserved one: review/recovery.
    await finishLiveRuns(1);
    await heartbeat.resumeQueuedRuns();
    expect(await statusesOf(order)).toEqual({ generalA: "queued", generalB: "queued", reviewC: "running", humanD: "running" });

    // The human and review runs hold the reserve, so the next freed slot is a
    // general slot, and it goes to the oldest general run.
    await finishLiveRuns(1);
    await heartbeat.resumeQueuedRuns();
    expect(await statusesOf(order)).toEqual({ generalA: "running", generalB: "queued", reviewC: "running", humanD: "running" });

    await finishLiveRuns(1);
    await heartbeat.resumeQueuedRuns();
    expect(await statusesOf(order)).toEqual({ generalA: "running", generalB: "running", reviewC: "running", humanD: "running" });
  });

  it("(c) general work cannot use the 2 reserved slots; human/board and review/recovery work can", async () => {
    await seedCompany();
    await setCap(10);
    await seedLiveRuns(8);
    const general = await seedQueuedRun(await seedAgent("A"), "general");

    // Two slots are free, but both are reserved: general work waits alone.
    await heartbeat.resumeQueuedRuns();
    expect(await statusOf(general)).toBe("queued");

    const review = await seedQueuedRun(await seedAgent("B"), "review_recovery");
    const human = await seedQueuedRun(await seedAgent("C"), "human_board");
    await heartbeat.resumeQueuedRuns();

    expect(await statusesOf({ general, review, human })).toEqual({ general: "queued", review: "running", human: "running" });
  });

  // ─── (i) the reserved class comes only from server-recorded facts ──────────

  /**
   * The options `POST /agents/:id/wakeup` builds (routes/agents.ts): the actor
   * type and id come from the authenticated actor; the reason is the caller's
   * free string.
   */
  function routeWake(actor: { type: "agent"; agentId: string } | { type: "board"; userId: string }, reason: string) {
    return {
      ...(actor.type === "board" ? { manualUserWake: true } : {}),
      source: "on_demand" as const,
      triggerDetail: "manual" as const,
      reason,
      requestedByActorType: actor.type === "agent" ? ("agent" as const) : ("user" as const),
      requestedByActorId: actor.type === "agent" ? actor.agentId : actor.userId,
      contextSnapshot: {
        triggeredBy: actor.type,
        actorId: actor.type === "agent" ? actor.agentId : actor.userId,
      },
    };
  }

  /** Cap 10 with 8 live: the general slots are full and the 2 reserved slots are free. */
  async function seedReservedSlotsFree() {
    await seedCompany();
    await setCap(10);
    await seedLiveRuns(8);
    return seedQueuedRun(await seedAgent("OlderGeneral"), "general");
  }

  it.each([
    { label: "an agent waking itself", cross: false },
    { label: "an agent waking another agent", cross: true },
  ])("(i) $label with a review reason does not take a reserved slot ahead of an older general run", async ({ cross }) => {
    const olderGeneral = await seedReservedSlotsFree();
    const target = await seedAgent("Target");
    const requester = cross ? await seedAgent("Requester") : target;

    const forged = await heartbeat.wakeup(target, routeWake({ type: "agent", agentId: requester }, "execution_review_requested"));
    expect(forged).not.toBeNull();
    await heartbeat.resumeQueuedRuns();
    expect(await statusesOf({ olderGeneral, forged: forged!.id })).toEqual({ olderGeneral: "queued", forged: "queued" });

    // One general slot frees: it goes to the older general run, not the forged one.
    await finishLiveRuns(1);
    await heartbeat.resumeQueuedRuns();
    expect(await statusesOf({ olderGeneral, forged: forged!.id })).toEqual({ olderGeneral: "running", forged: "queued" });
  });

  it("(i) a board user's wake with the same reason still starts in a reserved slot", async () => {
    const olderGeneral = await seedReservedSlotsFree();
    const target = await seedAgent("Target");

    const boardWake = await heartbeat.wakeup(target, routeWake({ type: "board", userId: "board-user" }, "execution_review_requested"));
    expect(boardWake).not.toBeNull();
    await heartbeat.resumeQueuedRuns();

    expect(await statusesOf({ olderGeneral, boardWake: boardWake!.id })).toEqual({ olderGeneral: "queued", boardWake: "running" });
  });

  /**
   * A review stage as the execution policy seats it: `executorAgentId`
   * delivered its work, and its delivery seated `participantAgentId`.
   */
  function pendingReviewStage(participantAgentId: string, executorAgentId: string) {
    return {
      status: "pending",
      currentStageId: randomUUID(),
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: participantAgentId },
      returnAssignee: { type: "agent", agentId: executorAgentId },
      deliveryAuthor: { type: "agent", agentId: executorAgentId },
      participantSeat: {
        participant: { type: "agent", agentId: participantAgentId, userId: null },
        seatedBy: { type: "agent", agentId: executorAgentId, userId: null },
      },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    };
  }

  it("(i) genuine review work on a pending review stage the run's agent is the participant of starts in a reserved slot", async () => {
    const olderGeneral = await seedReservedSlotsFree();
    const executor = await seedAgent("Executor");
    const reviewer = await seedAgent("Reviewer");
    // The executor's submission wakes the reviewer: the wake row names the
    // executor (an agent) and the reason is free text; the stage is the fact.
    const genuine = await seedQueuedRun(reviewer, "general", {
      requestedByActorType: "agent",
      requestedByActorId: executor,
      reason: "execution_review_requested",
      issueStatus: "in_review",
      issueExecutionState: pendingReviewStage(reviewer, executor),
    });

    await heartbeat.resumeQueuedRuns();

    expect(await statusesOf({ olderGeneral, genuine })).toEqual({ olderGeneral: "queued", genuine: "running" });
  });

  it("(i) genuine recovery work on a recovery-origin issue starts in a reserved slot", async () => {
    const olderGeneral = await seedReservedSlotsFree();
    const genuine = await seedQueuedRun(await seedAgent("Recoverer"), "general", {
      requestedByActorType: "agent",
      issueOriginKind: "stranded_issue_recovery",
    });

    await heartbeat.resumeQueuedRuns();

    expect(await statusesOf({ olderGeneral, genuine })).toEqual({ olderGeneral: "queued", genuine: "running" });
  });

  /** The run did not take a reserved slot, and the older general run gets the next general slot first. */
  async function expectGeneralBehindOlderRun(olderGeneral: string, candidate: string) {
    await heartbeat.resumeQueuedRuns();
    expect(await statusesOf({ olderGeneral, candidate })).toEqual({ olderGeneral: "queued", candidate: "queued" });
    await finishLiveRuns(1);
    await heartbeat.resumeQueuedRuns();
    expect(await statusesOf({ olderGeneral, candidate })).toEqual({ olderGeneral: "running", candidate: "queued" });
  }

  it("(i) a pending review stage of another agent does not lift the run's class", async () => {
    const olderGeneral = await seedReservedSlotsFree();
    const executor = await seedAgent("Executor");
    const bystander = await seedAgent("Bystander");
    const candidate = await seedQueuedRun(bystander, "general", {
      requestedByActorType: "agent",
      issueStatus: "in_review",
      issueExecutionState: pendingReviewStage(await seedAgent("RealReviewer"), executor),
    });

    await expectGeneralBehindOlderRun(olderGeneral, candidate);
  });

  it("(i) a server wake with a review or recovery reason on an ordinary issue is general: the reason is never read", async () => {
    const olderGeneral = await seedReservedSlotsFree();
    const candidate = await seedQueuedRun(await seedAgent("Owner"), "general", {
      requestedByActorType: "system",
      reason: "source_scoped_recovery_action",
      contextWakeReason: "source_scoped_recovery_action",
    });

    await expectGeneralBehindOlderRun(olderGeneral, candidate);
  });

  it("(i) a review reason merged into the run context by a coalesced wake does not change the run's class", async () => {
    const olderGeneral = await seedReservedSlotsFree();
    // The run's own wake request is an ordinary server retry; only the merged
    // context carries the review reason (coalescing spreads the incoming wake
    // over the run's context).
    const merged = await seedQueuedRun(await seedAgent("Merged"), "general", {
      requestedByActorType: "system",
      reason: "transient_failure_retry",
      contextWakeReason: "execution_review_requested",
    });

    await heartbeat.resumeQueuedRuns();
    expect(await statusesOf({ olderGeneral, merged })).toEqual({ olderGeneral: "queued", merged: "queued" });

    await finishLiveRuns(1);
    await heartbeat.resumeQueuedRuns();
    expect(await statusesOf({ olderGeneral, merged })).toEqual({ olderGeneral: "running", merged: "queued" });
  });

  it("(i) an agent's wake bound to another agent's in_review issue never runs ahead of an older general run", async () => {
    const olderGeneral = await seedReservedSlotsFree();
    const owner = await seedAgent("Owner");
    const intruder = await seedAgent("Intruder");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Someone else's review",
      status: "in_review",
      assigneeAgentId: owner,
    });

    const forged = await heartbeat.wakeup(intruder, {
      ...routeWake({ type: "agent", agentId: intruder }, "execution_review_requested"),
      payload: { issueId },
    });
    expect(forged).not.toBeNull();
    await heartbeat.resumeQueuedRuns();
    expect(await statusOf(olderGeneral)).toBe("queued");

    await finishLiveRuns(1);
    await heartbeat.resumeQueuedRuns();
    expect(await statusOf(olderGeneral)).toBe("running");
    expect(mockAdapterExecute.mock.calls.some(([context]) => context?.runId === forged!.id)).toBe(false);
  });

  // ─── (j) round 2: in_review status a caller can set confers nothing ──────

  /** A card as `POST /companies/:id/issues` creates it for an agent caller: `in_review`, manual origin, no review stage. */
  async function createInReviewCardAsAgent(creatorAgentId: string, assigneeAgentId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Self-made review card",
      status: "in_review",
      assigneeAgentId,
      createdByAgentId: creatorAgentId,
      originKind: "manual",
    });
    return issueId;
  }

  it("(j) an agent's own card created in_review does not move its self-wake into a reserved slot", async () => {
    const olderGeneral = await seedReservedSlotsFree();
    const agent = await seedAgent("SelfReviewer");
    const issueId = await createInReviewCardAsAgent(agent, agent);

    const forged = await heartbeat.wakeup(agent, {
      ...routeWake({ type: "agent", agentId: agent }, "issue_assigned"),
      payload: { issueId },
    });
    expect(forged).not.toBeNull();

    await expectGeneralBehindOlderRun(olderGeneral, forged!.id);
  });

  it("(j) an in_review card another agent created for this agent, plus a comment wake, does not take a reserved slot", async () => {
    const olderGeneral = await seedReservedSlotsFree();
    const creator = await seedAgent("Creator");
    const target = await seedAgent("Target");
    const issueId = await createInReviewCardAsAgent(creator, target);

    // The comment wake an agent's comment raises for the assignee.
    const forged = await heartbeat.wakeup(target, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId },
      requestedByActorType: "agent",
      requestedByActorId: creator,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented", source: "issue.comment" },
    });
    expect(forged).not.toBeNull();

    await expectGeneralBehindOlderRun(olderGeneral, forged!.id);
  });

  // ─── (k) round 2: a plugin's chosen reason confers nothing ───────────────

  const pluginId = "6f0f3c1e-4c1a-4d2b-9a55-2f4a3b1c9d10";
  const pluginKey = "example.plugin";

  it.each([
    {
      label: "issues.requestWakeup with execution_review_requested",
      build: (issueId: string) => ({
        source: "assignment" as const,
        triggerDetail: "system" as const,
        reason: "execution_review_requested",
        payload: { issueId, mutation: "plugin_wakeup", pluginId, pluginKey, contextSource: "plugin.issue.requestWakeup" },
        requestedByActorType: "system" as const,
        requestedByActorId: pluginId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "execution_review_requested",
          source: "plugin.issue.requestWakeup",
          pluginId,
          pluginKey,
        },
      }),
    },
    {
      label: "agents.invoke with source_scoped_recovery_action",
      build: () => ({
        source: "automation" as const,
        triggerDetail: "system" as const,
        reason: "source_scoped_recovery_action",
        payload: { prompt: "do the thing" },
        contextSnapshot: {
          wakeReason: "source_scoped_recovery_action",
          paperclipAgentMessage: { text: "do the thing", source: "plugin_invoke", pluginKey },
        },
        requestedByActorType: "system" as const,
        requestedByActorId: pluginId,
      }),
    },
    {
      label: "agentSessions.sendMessage with native_completion_review",
      build: () => ({
        source: "automation" as const,
        triggerDetail: "system" as const,
        reason: "native_completion_review",
        payload: { prompt: "continue" },
        contextSnapshot: {
          taskKey: `plugin:${pluginKey}:session:session-1`,
          wakeReason: "native_completion_review",
          wakeSource: "automation",
          wakeTriggerDetail: "system",
          paperclipAgentMessage: { text: "continue", source: "plugin_session", pluginKey, sessionId: "session-1" },
        },
        requestedByActorType: "system" as const,
        requestedByActorId: pluginId,
      }),
    },
  ])("(k) a plugin wake ($label) does not take a reserved slot", async ({ build }) => {
    const olderGeneral = await seedReservedSlotsFree();
    const target = await seedAgent("PluginTarget");
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Plugin card", status: "todo", assigneeAgentId: target });

    const forged = await heartbeat.wakeup(target, build(issueId));
    expect(forged).not.toBeNull();

    await expectGeneralBehindOlderRun(olderGeneral, forged!.id);
  });

  // ─── (l) round 2: every claim of a queued run passes the cap ─────────────

  it("(l) a direct claim through executeRun (self-declared workspace preparation) does not start a queued run past a full cap", async () => {
    await seedCompany();
    await setCap(1);
    await seedLiveRuns(1);
    const queued = await seedQueuedRun(await seedAgent("Direct"), "human_board");

    await heartbeat.prepareWorkspaceForSelfDeclaredRun(queued);

    expect(await statusOf(queued)).toBe("queued");
    expect(await heartbeat.getLiveRunCapStatus()).toMatchObject({ liveRuns: 1 });
  });

  // ─── (m) round 2: a corrupt stored setting fails closed ──────────────────

  it("(m) a corrupt stored liveRunCap fails closed to the ceiling and keeps the other general settings", async () => {
    await seedCompany();
    await instanceSettingsService(db).updateGeneral({ censorUsernameInLogs: true });
    const [row] = await db.select().from(instanceSettings).limit(1);
    await db.update(instanceSettings)
      .set({ general: { ...(row!.general ?? {}), liveRunCap: "not-a-number" } })
      .where(eq(instanceSettings.id, row!.id));
    invalidateLiveRunCapSettingCache();

    expect(await instanceSettingsService(db).getGeneral()).toMatchObject({ liveRunCap: 15, censorUsernameInLogs: true });

    await seedLiveRuns(15);
    const queued = await seedQueuedRun(await seedAgent("Waiting"), "human_board");
    await heartbeat.resumeQueuedRuns();
    expect(await statusOf(queued)).toBe("queued");
  });

  // ─── (n) round 2: aging and within-agent order ───────────────────────────

  it("(n) a general run waiting longer than the aging window starts ahead of a newer review flood", async () => {
    await seedCompany();
    await setCap(10);
    await seedLiveRuns(7);
    // 7 live: one general slot and the 2 reserved slots are free.
    const aged = await seedQueuedRun(await seedAgent("Aged"), "general", { createdAt: new Date(Date.now() - 40 * 60_000) });
    const flood = [
      await seedQueuedRun(await seedAgent("R1"), "review_recovery"),
      await seedQueuedRun(await seedAgent("R2"), "review_recovery"),
      await seedQueuedRun(await seedAgent("R3"), "review_recovery"),
    ];

    await heartbeat.resumeQueuedRuns();

    expect(await statusOf(aged)).toBe("running");
    expect((await Promise.all(flood.map(statusOf))).filter((status) => status === "running")).toHaveLength(2);
  });

  it("(n) an aged general waiter does not hold review work out of a free reserved slot it cannot use itself", async () => {
    await seedCompany();
    await setCap(10);
    await seedLiveRuns(9);
    // 9 live: the general slots are full and one reserved slot is free.
    const aged = await seedQueuedRun(await seedAgent("Aged"), "general", { createdAt: new Date(Date.now() - 40 * 60_000) });
    const review = await seedQueuedRun(await seedAgent("Reviewer"), "review_recovery");

    await heartbeat.resumeQueuedRuns();

    expect(await statusesOf({ aged, review })).toEqual({ aged: "queued", review: "running" });
  });

  it.each(["human_board", "review_recovery"] as const)(
    "(n) an agent at one slot starts its newer %s run before its own older general run when only reserved slots are free",
    async (priorityClass) => {
      await seedCompany();
      await setCap(10);
      await seedLiveRuns(8);
      const agent = await seedAgent("OneSlot", { maxConcurrentRuns: 1 });
      const olderGeneral = await seedQueuedRun(agent, "general");
      const priority = await seedQueuedRun(agent, priorityClass);

      await heartbeat.resumeQueuedRuns();

      expect(await statusesOf({ olderGeneral, priority })).toEqual({ olderGeneral: "queued", priority: "running" });
    },
  );

  // ─── (o) round 2: admissions still claiming count toward the cap ─────────

  it("(o) two agents racing for the last general slot start exactly one run while the first claim is still committing", async () => {
    await seedCompany();
    await setCap(10);
    await seedLiveRuns(7);
    const first = await seedAgent("RaceA");
    const second = await seedAgent("RaceB");
    // Hold every queued -> running claim for 400 ms so the second admission
    // is decided while the first claim is not yet visible as a running row.
    await db.execute(sql`CREATE OR REPLACE FUNCTION test_slow_live_run_claim() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(0.4);
        RETURN NEW;
      END;
    $$`);
    await db.execute(sql`CREATE TRIGGER test_slow_live_run_claim
      BEFORE UPDATE OF status ON heartbeat_runs FOR EACH ROW
      WHEN (NEW.status = 'running' AND OLD.status = 'queued')
      EXECUTE FUNCTION test_slow_live_run_claim()`);
    let runs: Array<{ id: string } | null>;
    try {
      // Each wake queues its run and admits it at once: two admissions race.
      runs = await Promise.all([
        heartbeat.wakeup(first, routeWake({ type: "agent", agentId: first }, "race")),
        heartbeat.wakeup(second, routeWake({ type: "agent", agentId: second }, "race")),
      ]);
    } finally {
      await db.execute(sql`DROP TRIGGER IF EXISTS test_slow_live_run_claim ON heartbeat_runs`);
      await db.execute(sql`DROP FUNCTION IF EXISTS test_slow_live_run_claim()`);
    }
    expect(runs.every(Boolean)).toBe(true);
    const [firstRun, secondRun] = runs.map((run) => run!.id);

    const statuses = await Promise.all([firstRun, secondRun].map(statusOf));
    expect(statuses.filter((status) => status === "running")).toHaveLength(1);
    expect(await heartbeat.getLiveRunCapStatus()).toMatchObject({ liveRuns: 8 });
  });

  it("(o) a waiter whose run left the queue no longer holds a place in line", async () => {
    await seedCompany();
    await setCap(10);
    await seedLiveRuns(8);
    const staleAgent = await seedAgent("Stale");
    const staleRun = await seedQueuedRun(staleAgent);
    // The older run waits on the cap and is recorded as a cap-waiter.
    await heartbeat.resumeQueuedRuns();
    expect(liveRunCapAdmission.listWaiters().map((waiter) => waiter.runId)).toEqual([staleRun]);

    // Its run leaves the queue outside admission (an operator cancel), and a
    // general slot frees. A newer run of another agent takes it.
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, staleRun));
    await finishLiveRuns(1);
    const newerAgent = await seedAgent("Newer");
    const newer = await heartbeat.wakeup(newerAgent, routeWake({ type: "agent", agentId: newerAgent }, "newer"));
    expect(newer).not.toBeNull();

    expect(await statusOf(newer!.id)).toBe("running");
  });

  it("(o) an admission refused at the lock deadline leaves its run queued, out of line, and ends the agent's pass", async () => {
    await seedCompany();
    await setCap(10);
    await seedLiveRuns(8);
    const agent = await seedAgent("StuckRead");
    const first = await seedQueuedRun(agent);
    const second = await seedQueuedRun(agent);
    // The first count-and-reserve overruns the lock deadline (a stuck read).
    const admit = vi.spyOn(liveRunCapAdmission, "admit").mockResolvedValueOnce({ admitted: false, timedOut: true });

    await heartbeat.resumeQueuedRuns();

    expect(await statusesOf({ first, second })).toEqual({ first: "queued", second: "queued" });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(liveRunCapAdmission.listWaiters()).toEqual([]);
  });

  // ─── (p) round 3: a review stage takes a reserved slot only when another
  // principal seated it on another principal's delivery ───────────────────────

  /**
   * An issue assigned to `authorAgentId` under `policy`, moved to `in_review`
   * by `actorAgentId` through the execution-policy engine (the transition the
   * PATCH route applies), with the engine's patch written to the row.
   */
  async function deliverThroughEngine(input: {
    authorAgentId: string;
    actorAgentId: string;
    policy: Record<string, unknown>;
  }) {
    const policy = normalizeIssueExecutionPolicy(input.policy)!;
    const transition = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: input.authorAgentId,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: null,
      },
      policy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { agentId: input.actorAgentId },
      commentBody: "Delivered.",
    });
    const patch = transition.patch as {
      status?: string;
      assigneeAgentId?: string | null;
      executionState?: Record<string, unknown> | null;
    };
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Delivered work",
      status: patch.status ?? "in_review",
      assigneeAgentId: patch.assigneeAgentId ?? input.authorAgentId,
      createdByAgentId: input.authorAgentId,
      originKind: "manual",
      executionPolicy: policy as unknown as Record<string, unknown>,
      executionState: patch.executionState ?? null,
    });
    return issueId;
  }

  /** The wake a delivery raises for the seated participant, requested by `requesterAgentId`. */
  async function wakeOnIssue(agentId: string, issueId: string, requesterAgentId: string) {
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "execution_review_requested",
      payload: { issueId },
      requestedByActorType: "agent",
      requestedByActorId: requesterAgentId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "execution_review_requested" },
    });
    expect(run).not.toBeNull();
    return run!.id;
  }

  it.each(["review", "approval"] as const)(
    "(p) an agent's own %s stage on its own delivery: the engine refuses it, and such a stage never takes a reserved slot",
    async (stageType) => {
      const olderGeneral = await seedReservedSlotsFree();
      const agent = await seedAgent("SelfSeated");
      const namedReturn = await seedAgent("NamedReturn");
      await expect(deliverThroughEngine({
        authorAgentId: agent,
        actorAgentId: agent,
        policy: {
          returnAssigneeAgentId: namedReturn,
          stages: [{ type: stageType, participants: [{ type: "agent", agentId: agent }] }],
        },
      })).rejects.toThrow(/delivery author/);

      // The shape such a delivery left before the engine refused it: the
      // author seated on its own delivery by its own transition.
      const candidate = await seedQueuedRun(agent, "general", {
        requestedByActorType: "agent",
        issueStatus: "in_review",
        issueExecutionState: {
          ...pendingReviewStage(agent, agent),
          currentStageType: stageType,
          returnAssignee: { type: "agent", agentId: namedReturn },
        },
      });
      await expectGeneralBehindOlderRun(olderGeneral, candidate);
    },
  );

  it("(p) an agent that seats itself as the reviewer of another agent's delivery does not take a reserved slot", async () => {
    const olderGeneral = await seedReservedSlotsFree();
    const author = await seedAgent("Author");
    const selfSeater = await seedAgent("SelfSeater");
    // The self-seater names itself on the author's card and moves the card to
    // in_review itself (a manager or watchdog grant lets it write the card).
    const issueId = await deliverThroughEngine({
      authorAgentId: author,
      actorAgentId: selfSeater,
      policy: { stages: [{ type: "review", participants: [{ type: "agent", agentId: selfSeater }] }] },
    });

    await expectGeneralBehindOlderRun(olderGeneral, await wakeOnIssue(selfSeater, issueId, selfSeater));
  });

  it("(p) another agent's own delivery seats this agent as its reviewer, and the review run starts in a reserved slot", async () => {
    const olderGeneral = await seedReservedSlotsFree();
    const author = await seedAgent("Author");
    const reviewer = await seedAgent("Reviewer");
    const issueId = await deliverThroughEngine({
      authorAgentId: author,
      actorAgentId: author,
      policy: { stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewer }] }] },
    });

    const genuine = await wakeOnIssue(reviewer, issueId, author);
    await heartbeat.resumeQueuedRuns();

    expect(await statusesOf({ olderGeneral, genuine })).toEqual({ olderGeneral: "queued", genuine: "running" });
  });

  it("(p) a human comment a plugin relayed (as the plugin host wakes the assignee) takes no reserved slot", async () => {
    const olderGeneral = await seedReservedSlotsFree();
    const target = await seedAgent("RelayTarget");
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat card", status: "todo", assigneeAgentId: target });
    const commentId = randomUUID();
    // The wake plugin-host-services createComment raises for an actorUserId comment.
    const relayed = await heartbeat.wakeup(target, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId, mutation: "comment", pluginId, pluginKey },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        sourceCommentId: commentId,
        wakeReason: "issue_commented",
        source: `plugin:${pluginKey}`,
      },
    });
    expect(relayed).not.toBeNull();

    await expectGeneralBehindOlderRun(olderGeneral, relayed!.id);
  });

  // ─── (q) round 3: priority work beyond the reserve cannot hold general work ─

  /** `count` live review/recovery runs (bound to recovery-origin issues). */
  async function seedLiveReviewRuns(count: number) {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Live recovery work",
        status: "in_progress",
        assigneeAgentId: loadAgentId,
        originKind: "stranded_issue_recovery",
      });
      const [row] = await db.insert(heartbeatRuns).values({
        companyId,
        agentId: loadAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        startedAt: new Date(),
        contextSnapshot: { issueId, seededLoad: "true" },
      }).returning();
      ids.push(row!.id);
    }
    return ids;
  }

  async function finishRuns(runIds: string[]) {
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(inArray(heartbeatRuns.id, runIds));
  }

  it("(q) a review stream at or above the general cap does not hold an aged general run: it starts at the next freed general slot", async () => {
    await seedCompany();
    await setCap(10);
    const liveGeneral = await seedLiveRuns(8);
    const liveReview = await seedLiveReviewRuns(2);
    // 10 live: 8 general and 2 review runs in the reserve.
    const aged = await seedQueuedRun(await seedAgent("Aged"), "general", { createdAt: new Date(Date.now() - 40 * 60_000) });
    const stream = [
      await seedQueuedRun(await seedAgent("R1"), "review_recovery"),
      await seedQueuedRun(await seedAgent("R2"), "review_recovery"),
      await seedQueuedRun(await seedAgent("R3"), "review_recovery"),
    ];
    const runningStream = async () => (await Promise.all(stream.map(statusOf))).filter((status) => status === "running").length;

    // A review run ends: the reserve slot it frees goes to review work.
    await finishRuns(liveReview.slice(0, 1));
    await heartbeat.resumeQueuedRuns();
    expect(await statusOf(aged)).toBe("queued");
    expect(await runningStream()).toBe(1);

    // A general run ends: that slot is a general slot, and the aged run is
    // first in line for it, ahead of the newer review stream.
    await finishRuns(liveGeneral.slice(0, 1));
    await heartbeat.resumeQueuedRuns();
    expect(await statusOf(aged)).toBe("running");
    expect(await runningStream()).toBe(1);
  });

  // ─── (m) round 3: a corrupt settings blob fails closed ──────────────────

  it.each([
    { label: "a string", general: "garbage" },
    { label: "an array", general: [15] },
  ])("(m) a corrupt general settings blob ($label) fails closed to the ceiling instead of turning the cap off", async ({ general }) => {
    await seedCompany();
    await instanceSettingsService(db).updateGeneral({ censorUsernameInLogs: true });
    const [row] = await db.select().from(instanceSettings).limit(1);
    await db.update(instanceSettings)
      .set({ general: general as never })
      .where(eq(instanceSettings.id, row!.id));
    invalidateLiveRunCapSettingCache();

    expect((await instanceSettingsService(db).getGeneral()).liveRunCap).toBe(15);

    await seedLiveRuns(15);
    const queued = await seedQueuedRun(await seedAgent("Waiting"), "human_board");
    await heartbeat.resumeQueuedRuns();
    expect(await statusOf(queued)).toBe("queued");
  });

  // ─── (f) round 3: RA M16, a waiter never outlives its agent's evaluation ─

  it("(f) a waiting agent that can no longer start (paused) drops its place in line at its next evaluation", async () => {
    await seedCompany();
    await setCap(10);
    await seedLiveRuns(8);
    const paused = await seedAgent("Paused");
    const older = await seedQueuedRun(paused);
    await heartbeat.resumeQueuedRuns();
    expect(liveRunCapAdmission.listWaiters().map((waiter) => waiter.runId)).toEqual([older]);

    // The agent is paused: its run stays queued, its next evaluation defers nothing.
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, paused));
    await heartbeat.resumeQueuedRuns();
    expect(liveRunCapAdmission.listWaiters()).toEqual([]);
    expect(await statusOf(older)).toBe("queued");

    // A general slot frees: a newer run of another agent takes it.
    await finishLiveRuns(1);
    const newerAgent = await seedAgent("Newer");
    const newer = await heartbeat.wakeup(newerAgent, routeWake({ type: "agent", agentId: newerAgent }, "newer"));
    expect(newer).not.toBeNull();
    expect(await statusOf(newer!.id)).toBe("running");
  });

  // ─── (r) round 4: an agent's own writes never reach the reserved lane ─────

  /**
   * An agent's own card with an external-service monitor that has already
   * timed out, as an agent writes it (the route stamps `scheduledBy:
   * "assignee"` for an agent, `"board"` for a board user).
   */
  async function seedTimedOutMonitorCard(agentId: string, scheduledBy: "assignee" | "board") {
    const issueId = randomUUID();
    const dueAt = new Date(Date.now() - 60_000);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Waiting on a deploy",
      status: "in_progress",
      assigneeAgentId: agentId,
      createdByAgentId: scheduledBy === "assignee" ? agentId : null,
      originKind: "manual",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor: {
          nextCheckAt: dueAt.toISOString(),
          timeoutAt: new Date(Date.now() - 30_000).toISOString(),
          recoveryPolicy: "create_recovery_issue",
          scheduledBy,
          notes: "Check the deploy",
        },
      },
      monitorNextCheckAt: dueAt,
      monitorScheduledBy: scheduledBy,
    });
    return issueId;
  }

  async function recoveryCardsFor(sourceIssueId: string) {
    return db.select({ id: issues.id }).from(issues).where(and(
      eq(issues.originKind, "stranded_issue_recovery"),
      eq(issues.originId, sourceIssueId),
    ));
  }

  async function runsOf(agentId: string) {
    return db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
  }

  it("(r) F1: an agent's own monitor (create_recovery_issue, then check-now) mints no recovery card, and its run stays in the general lane", async () => {
    const olderGeneral = await seedReservedSlotsFree();
    const agent = await seedAgent("SelfMonitor");
    const sourceId = await seedTimedOutMonitorCard(agent, "assignee");

    // POST /issues/:id/monitor/check-now as the assignee agent.
    await heartbeat.triggerIssueMonitor(sourceId, { actorType: "agent", actorId: agent, agentId: agent });
    await heartbeat.resumeQueuedRuns();

    expect(await recoveryCardsFor(sourceId)).toEqual([]);
    expect(await statusOf(olderGeneral)).toBe("queued");
    expect((await runsOf(agent)).filter((run) => run.status === "running")).toEqual([]);

    // The next general slot goes to the older general run.
    await finishLiveRuns(1);
    await heartbeat.resumeQueuedRuns();
    expect(await statusOf(olderGeneral)).toBe("running");
    expect((await runsOf(agent)).filter((run) => run.status === "running")).toEqual([]);
  });

  it("(r) F1: the scheduled sweep of an agent-scheduled monitor mints no recovery card either", async () => {
    const olderGeneral = await seedReservedSlotsFree();
    const agent = await seedAgent("SelfMonitorSweep");
    const sourceId = await seedTimedOutMonitorCard(agent, "assignee");

    await heartbeat.tickTimers(new Date());
    await heartbeat.resumeQueuedRuns();

    expect(await recoveryCardsFor(sourceId)).toEqual([]);
    expect(await statusOf(olderGeneral)).toBe("queued");
    expect((await runsOf(agent)).filter((run) => run.status === "running")).toEqual([]);
  });

  it("(r) F1 control: a board-scheduled monitor's scheduled sweep still mints the recovery card, and that recovery run takes a reserved slot", async () => {
    const olderGeneral = await seedReservedSlotsFree();
    const agent = await seedAgent("BoardMonitor");
    const sourceId = await seedTimedOutMonitorCard(agent, "board");

    await heartbeat.tickTimers(new Date());
    await heartbeat.resumeQueuedRuns();

    const cards = await recoveryCardsFor(sourceId);
    expect(cards).toHaveLength(1);
    expect(await statusOf(olderGeneral)).toBe("queued");
    const running = (await runsOf(agent)).filter((run) => run.status === "running");
    expect(running).toHaveLength(1);
  });

  it("(r) F2: a reviewer that moves an unassigned, rewritten card back into review itself does not keep the seat another agent gave it", async () => {
    const olderGeneral = await seedReservedSlotsFree();
    const author = await seedAgent("EarlierAuthor");
    const reviewer = await seedAgent("Rewriter");
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewer }] }],
    })!;
    // A genuine earlier round: the author's delivery seated the reviewer.
    const heldState = {
      ...pendingReviewStage(reviewer, author),
      currentStageId: policy.stages[0]!.id,
    };
    // The reviewer unassigned and rewrote the card, then moves it back into
    // review itself: the engine re-seats the reviewer with the reviewer as actor.
    const transition = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: null,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: heldState,
      },
      policy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { agentId: reviewer },
    });
    const patch = transition.patch as { status?: string; executionState?: Record<string, unknown> };
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Rewritten work",
      status: patch.status ?? "in_review",
      assigneeAgentId: reviewer,
      originKind: "manual",
      executionPolicy: policy as unknown as Record<string, unknown>,
      executionState: patch.executionState ?? null,
    });

    await expectGeneralBehindOlderRun(olderGeneral, await wakeOnIssue(reviewer, issueId, reviewer));
  });

  it("(s) N2: a second agent's delivery on an unassigned card does not seat the first agent in the reserved lane for its own earlier work", async () => {
    const olderGeneral = await seedReservedSlotsFree();
    const reviewer = await seedAgent("FirstAgent");
    const second = await seedAgent("SecondAgent");
    const author = await seedAgent("EarlierAuthor");
    const policy = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewer }] }],
    })!;
    // An earlier genuine round: the author's delivery seated the reviewer.
    const heldState = {
      ...pendingReviewStage(reviewer, author),
      currentStageId: policy.stages[0]!.id,
    };
    // The card is unassigned; a second agent (not the delivery author) moves
    // it back into review. The engine seats the reviewer with the second agent
    // as the seating actor, while the delivery author stays the earlier author.
    const transition = applyIssueExecutionPolicyTransition({
      issue: {
        status: "in_progress",
        assigneeAgentId: null,
        assigneeUserId: null,
        executionPolicy: policy,
        executionState: heldState,
      },
      policy,
      requestedStatus: "in_review",
      requestedAssigneePatch: {},
      actor: { agentId: second },
    });
    const patch = transition.patch as { status?: string; executionState?: Record<string, unknown> };
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "First agent's work, second agent's delivery",
      status: patch.status ?? "in_review",
      assigneeAgentId: reviewer,
      originKind: "manual",
      executionPolicy: policy as unknown as Record<string, unknown>,
      executionState: patch.executionState ?? null,
    });

    await expectGeneralBehindOlderRun(olderGeneral, await wakeOnIssue(reviewer, issueId, reviewer));
  });

  // ─── (d) router input ─────────────────────────────────────────────────────

  it("(d) a router sample of 1 cannot pin the fleet below the floor of 6", async () => {
    await seedCompany();
    await setCap(15);
    setLiveRunCapSignal({ source: LIVE_RUN_CAP_ROUTER_SIGNAL_SOURCE, cap: 1, observedAtMs: Date.now() });
    await seedLiveRuns(2);
    const queued = await Promise.all(["A", "B", "C", "D"].map(async (name) => seedQueuedRun(await seedAgent(name))));

    await heartbeat.resumeQueuedRuns();

    // Floor 6 = 4 general + 2 reserved: 2 live + 2 starts fill the general slots.
    const statuses = await Promise.all(queued.map(statusOf));
    expect(statuses.filter((status) => status === "running")).toHaveLength(2);
    expect(statuses.filter((status) => status === "queued")).toHaveLength(2);
    expect(await heartbeat.getLiveRunCapStatus()).toMatchObject({
      effectiveCap: 6,
      generalCap: 4,
      router: { cap: 1, fresh: true },
      liveRuns: 4,
    });
  });

  it.each([
    ["stale", Date.now() - LIVE_RUN_CAP_SIGNAL_STALE_MS - 5_000],
    ["missing (router unreachable)", null],
  ])("(d) a %s router sample falls back to the setting, never 1 or 0", async (_label, observedAtMs) => {
    await seedCompany();
    await setCap(15);
    if (observedAtMs !== null) {
      setLiveRunCapSignal({ source: LIVE_RUN_CAP_ROUTER_SIGNAL_SOURCE, cap: 1, observedAtMs });
    }
    await seedLiveRuns(2);
    const queued = await Promise.all(["A", "B", "C", "D", "E", "F"].map(async (name) => seedQueuedRun(await seedAgent(name))));

    await heartbeat.resumeQueuedRuns();

    for (const runId of queued) expect(await statusOf(runId)).toBe("running");
    expect(await heartbeat.getLiveRunCapStatus()).toMatchObject({ effectiveCap: 15, generalCap: 13, liveRuns: 8 });
  });

  // ─── (e) external agent sessions ──────────────────────────────────────────

  it.each([
    { label: "process adapter", adapterType: "process" },
    { label: "http adapter", adapterType: "http" },
    { label: "hermes_gateway adapter", adapterType: "hermes_gateway" },
    { label: "openclaw_gateway adapter", adapterType: "openclaw_gateway" },
    { label: "declared external pull seat", adapterType: "codex_local", workDelivery: "external_pull" },
  ])("(e) runs of a $label neither count toward the cap nor wait on it", async ({ adapterType, workDelivery }) => {
    await seedCompany();
    await setCap(10);
    await seedLiveRuns(9);
    const external = await seedAgent("External", { adapterType, workDelivery, maxConcurrentRuns: 20 });
    await seedLiveRuns(6, external);
    const externalQueued = await seedQueuedRun(external, "general");
    const human = await seedQueuedRun(await seedAgent("Human"), "human_board");

    await heartbeat.resumeQueuedRuns();

    // The external run starts with the cap full for general work, and its 6
    // live runs leave the last slot to the counted human run.
    expect(await statusesOf({ externalQueued, human })).toEqual({ externalQueued: "running", human: "running" });
    expect(await heartbeat.getLiveRunCapStatus()).toMatchObject({ liveRuns: 10, queuedRuns: 0 });
  });

  // ─── (f) no new starvation ────────────────────────────────────────────────

  it("(f) a run ending hands its slot to the oldest waiting run of another agent, without a tick and without claim churn", async () => {
    await seedCompany();
    await setCap(10);
    await seedLiveRuns(7);
    const agentA = await seedAgent("A");
    const agentB = await seedAgent("B");
    const runningB = await seedQueuedRun(agentB, "general");
    const waitingA = await seedQueuedRun(agentA, "general");
    const waitingB = await seedQueuedRun(agentB, "general");
    const [waitingBSeeded] = await snapshotRows([waitingB]);

    // B's first run takes the last general slot; A and B both have per-agent
    // slots left, and their runs wait on the global cap.
    await heartbeat.resumeQueuedRuns();
    expect(await statusesOf({ runningB, waitingA, waitingB })).toEqual({ runningB: "running", waitingA: "queued", waitingB: "queued" });
    expect(await heartbeat.getLiveRunCapStatus()).toMatchObject({ liveRuns: 8, waitingOnCap: 2 });

    // B's run ends. Its settle re-drives B first, but A's run has waited longer.
    gateFor(runningB).release();
    await vi.waitFor(async () => expect(await statusOf(waitingA)).toBe("running"), { timeout: 10_000 });
    expect(await statusOf(runningB)).toBe("succeeded");

    // A full tick confirms the order held: B's later run still waits, and its
    // row was never claimed and released (no write at all).
    await heartbeat.resumeQueuedRuns();
    const [waitingBNow] = await snapshotRows([waitingB]);
    expect(waitingBNow).toEqual(waitingBSeeded);
  });

  it("(f) an agent at its own per-agent limit does not hold a place in line", async () => {
    await seedCompany();
    await setCap(10);
    const busy = await seedAgent("Busy", { maxConcurrentRuns: 1 });
    await seedLiveRuns(1, busy);
    const busyQueued = [await seedQueuedRun(busy), await seedQueuedRun(busy), await seedQueuedRun(busy)];
    await seedLiveRuns(6);
    const other = await seedQueuedRun(await seedAgent("Other"));

    await heartbeat.resumeQueuedRuns();

    expect(await statusOf(other)).toBe("running");
    for (const runId of busyQueued) expect(await statusOf(runId)).toBe("queued");
    expect(await heartbeat.getLiveRunCapStatus()).toMatchObject({ waitingOnCap: 0 });
  });

  // ─── (g) off is today's behaviour ─────────────────────────────────────────

  it("(g) with the cap off, admission is today's: no global ceiling and the cap path is never consulted", async () => {
    await seedCompany();
    await setCap(null);
    const withLock = vi.spyOn(liveRunCapAdmission, "withLock");
    await seedLiveRuns(16);
    const queued = await Promise.all(["A", "B", "C"].map(async (name) => seedQueuedRun(await seedAgent(name))));

    await heartbeat.resumeQueuedRuns();

    for (const runId of queued) expect(await statusOf(runId)).toBe("running");
    expect(withLock).not.toHaveBeenCalled();
    expect(liveRunCapAdmission.waiterCount()).toBe(0);
    expect(await heartbeat.getLiveRunCapStatus()).toMatchObject({ enabled: false, effectiveCap: null, waitingOnCap: 0 });
  });
});
