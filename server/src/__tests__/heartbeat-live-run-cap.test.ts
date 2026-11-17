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
  let createdAtCursor = Date.parse("2026-11-17T10:00:00.000Z");

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
      reason?: string;
      contextWakeReason?: string;
      issueStatus?: "todo" | "in_review";
      issueOriginKind?: string;
    } = {},
  ) {
    const createdAt = new Date((createdAtCursor += 60_000));
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `${runClass} work`,
      status: wake.issueStatus ?? "todo",
      assigneeAgentId: agentId,
      originKind: wake.issueOriginKind ?? (runClass === "review_recovery" ? "stranded_issue_recovery" : "manual"),
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
      requestedByActorId: requestedByActorType === "user" ? "board-user" : requestedByActorType === "agent" ? agentId : null,
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

  it("(c) admits human/board, then review/recovery, then the oldest general run, and keeps 2 slots from general work", async () => {
    await seedCompany();
    await setCap(10);
    await seedLiveRuns(9);
    // Created oldest first: general A, general B, review C, human D.
    const generalA = await seedQueuedRun(await seedAgent("A"), "general");
    const generalB = await seedQueuedRun(await seedAgent("B"), "general");
    const reviewC = await seedQueuedRun(await seedAgent("C"), "review_recovery");
    const humanD = await seedQueuedRun(await seedAgent("D"), "human_board");
    const order = { generalA, generalB, reviewC, humanD };

    // One slot (live 9 of 10): the newest run goes first because it is human/board.
    await heartbeat.resumeQueuedRuns();
    expect(await statusesOf(order)).toEqual({ generalA: "queued", generalB: "queued", reviewC: "queued", humanD: "running" });

    // Next slot: review/recovery.
    await finishLiveRuns(1);
    await heartbeat.resumeQueuedRuns();
    expect(await statusesOf(order)).toEqual({ generalA: "queued", generalB: "queued", reviewC: "running", humanD: "running" });

    // Live 8 = 10 - 2 reserved: general work still waits.
    await finishLiveRuns(2);
    await heartbeat.resumeQueuedRuns();
    expect(await statusesOf(order)).toEqual({ generalA: "queued", generalB: "queued", reviewC: "running", humanD: "running" });

    // Live 7: one general slot, and it goes to the oldest general run.
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

  it.each([
    { label: "an issue that is in_review", wake: { requestedByActorType: "agent", issueStatus: "in_review" } },
    { label: "a recovery-origin issue", wake: { requestedByActorType: "agent", issueOriginKind: "stranded_issue_recovery" } },
    { label: "a server recovery wake", wake: { requestedByActorType: "system", reason: "source_scoped_recovery_action" } },
  ] as const)("(i) genuine review or recovery work on $label still starts in a reserved slot", async ({ wake }) => {
    const olderGeneral = await seedReservedSlotsFree();
    const genuine = await seedQueuedRun(await seedAgent("Reviewer"), "general", wake);

    await heartbeat.resumeQueuedRuns();

    expect(await statusesOf({ olderGeneral, genuine })).toEqual({ olderGeneral: "queued", genuine: "running" });
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

  it("(i) an agent's wake bound to another agent's in_review issue never runs in a reserved slot", async () => {
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

    // The payload binds the run to the in_review issue, so it is ordered as
    // review work; the claim then refuses it because the issue is not its own.
    const forged = await heartbeat.wakeup(intruder, {
      ...routeWake({ type: "agent", agentId: intruder }, "execution_review_requested"),
      payload: { issueId },
    });
    expect(forged).not.toBeNull();
    await heartbeat.resumeQueuedRuns();

    expect(mockAdapterExecute.mock.calls.some(([context]) => context?.runId === forged!.id)).toBe(false);
    expect(await heartbeat.getRun(forged!.id)).toMatchObject({ status: "cancelled", errorCode: "issue_assignee_changed" });
    expect(await statusOf(olderGeneral)).toBe("queued");
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
