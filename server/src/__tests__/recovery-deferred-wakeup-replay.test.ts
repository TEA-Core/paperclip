import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  heartbeatService,
  isDeferrableWakeSkipReason,
  wakeSkipClassForReason,
  WAKE_SKIP_CLASSIFICATION,
} from "../services/heartbeat.js";
import { recoveryService } from "../services/recovery/service.js";
import { dispatchQuiesce } from "../services/dispatch-quiesce.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres deferred-wake replay tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("wake skip classification (SUP-15552 / D1 of SUP-15551)", () => {
  it("classifies instance-level conditions as deferrable and work/agent conditions as terminal", () => {
    expect(isDeferrableWakeSkipReason("heartbeat.scheduling_suppressed")).toBe(true);
    expect(isDeferrableWakeSkipReason("heartbeat.worktree_execution_cutoff")).toBe(true);
    expect(isDeferrableWakeSkipReason("budget.blocked")).toBe(true);

    for (const reason of [
      "agent.not_invokable",
      "heartbeat.disabled",
      "heartbeat.wakeOnDemand.disabled",
      "company.inactive",
      "issue_tree_hold_active",
      "heartbeat.timer.all_work_leased",
      "heartbeat.timer.no_actionable_work",
    ] as const) {
      expect(isDeferrableWakeSkipReason(reason)).toBe(false);
      expect(wakeSkipClassForReason(reason)).toBe("terminal");
    }

    // Every deferrable reason is classified (acceptance #4 exhaustiveness).
    expect(Object.values(WAKE_SKIP_CLASSIFICATION).filter((c) => c === "deferrable")).toHaveLength(3);
    // An unknown / unclassified reason is NOT treated as deferrable (fails safe to
    // terminal), so a missing classification cannot silently strand a wake as a
    // forever-deferrable row.
    expect(wakeSkipClassForReason("some.future.reason")).toBeNull();
    expect(isDeferrableWakeSkipReason("some.future.reason")).toBe(false);
  });
});

describeEmbeddedPostgres("heartbeat write path records deferrable vs terminal skips", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("deferred-wake-write-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    dispatchQuiesce.release();
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

  async function seedActiveAgent(overrides: { heartbeatEnabled?: boolean } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Deferrable Co",
      status: "active",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Deferrable Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: overrides.heartbeatEnabled ?? true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function readSkips(agentId: string) {
    return db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        finishedAt: agentWakeupRequests.finishedAt,
        coalescedCount: agentWakeupRequests.coalescedCount,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows);
  }

  it("acceptance #1: a scheduling_suppressed skip is a deferral (status stays skipped, no finishedAt)", async () => {
    const { agentId } = await seedActiveAgent();
    const issueId = randomUUID();

    dispatchQuiesce.engage({ reason: "test-quiesce", ttlMs: 60_000 });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      requestedByActorType: "system",
      requestedByActorId: "deferred_wake_test",
    });
    expect(run).toBeNull();

    const rows = await readSkips(agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "skipped",
      reason: "heartbeat.scheduling_suppressed",
    });
    expect(rows[0].finishedAt).toBeNull();
    expect(rows[0].payload).toMatchObject({ issueId });
  });

  it("acceptance #1 (boundedness): repeat deferrable skips of the same reason coalesce onto one pending row", async () => {
    const { agentId } = await seedActiveAgent();
    const issueId = randomUUID();

    dispatchQuiesce.engage({ reason: "test-quiesce", ttlMs: 60_000 });

    const heartbeat = heartbeatService(db);
    for (let i = 0; i < 3; i += 1) {
      await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        requestedByActorType: "system",
        requestedByActorId: "deferred_wake_test",
      });
    }

    const rows = await readSkips(agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].finishedAt).toBeNull();
    expect(rows[0].coalescedCount).toBeGreaterThanOrEqual(1);
  });

  it("(boundedness) repeat GENERIC deferrable skips coalesce too, and never merge into an issue-bound one", async () => {
    const { agentId } = await seedActiveAgent();
    const issueId = randomUUID();

    dispatchQuiesce.engage({ reason: "test-quiesce", ttlMs: 60_000 });

    const heartbeat = heartbeatService(db);
    // Three generic wakes (no payload.issueId) — a suppressed timer tick.
    for (let i = 0; i < 3; i += 1) {
      await heartbeat.wakeup(agentId, {
        source: "timer",
        triggerDetail: "system",
        requestedByActorType: "system",
        requestedByActorId: "deferred_wake_test",
      });
    }
    // …plus one for a specific card. A generic wake carries no card payload, so
    // it must not be absorbed into the card's row (or vice versa): they are
    // different signals and the sweep re-drives each on its own.
    await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      requestedByActorType: "system",
      requestedByActorId: "deferred_wake_test",
    });

    const rows = await readSkips(agentId);
    expect(rows).toHaveLength(2);
    const generic = rows.find((r) => !(r.payload as { issueId?: string } | null)?.issueId);
    const bound = rows.find((r) => (r.payload as { issueId?: string } | null)?.issueId === issueId);
    expect(generic).toBeDefined();
    expect(bound).toBeDefined();
    expect(generic!.finishedAt).toBeNull();
    expect(generic!.coalescedCount).toBeGreaterThanOrEqual(1);
    expect(bound!.finishedAt).toBeNull();
  });

  it("acceptance #5: a terminal skip (heartbeat.disabled) stays skipped with finishedAt set", async () => {
    const { agentId } = await seedActiveAgent({ heartbeatEnabled: false });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(agentId, {
      source: "timer",
      triggerDetail: "system",
      requestedByActorType: "system",
      requestedByActorId: "deferred_wake_test",
    });
    expect(run).toBeNull();

    const rows = await readSkips(agentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "skipped",
      reason: "heartbeat.disabled",
    });
    expect(rows[0].finishedAt).not.toBeNull();
  });

  // Regression: recording the deferral as a DISTINCT status value (e.g.
  // `skipped_deferrable`) silently changes the meaning of three partial unique
  // indexes on agent_wakeup_requests whose predicates exclude `'skipped'`
  // precisely so that a skipped wake can be retried under the same idempotency
  // key. Under a distinct status the deferred row satisfies the predicate,
  // takes the idempotency slot, and the legitimate retry raises 23505 — the
  // fix for a lost wake would itself lose wakes.
  it("a deferrable skip does not consume the retry slot of a keyed wake (partial unique indexes)", async () => {
    const { companyId, agentId } = await seedActiveAgent();
    const issueId = randomUUID();

    dispatchQuiesce.engage({ reason: "test-quiesce", ttlMs: 60_000 });

    const heartbeat = heartbeatService(db);
    for (const idempotencyKey of [
      `question-response:${randomUUID()}`,
      `issue_review_path_lost:${randomUUID()}`,
      `issue_disposition_repair:${randomUUID()}`,
    ]) {
      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId },
        idempotencyKey,
        requestedByActorType: "system",
        requestedByActorId: "deferred_wake_test",
      });
      expect(run).toBeNull();

      // The retry path re-enqueues under the SAME key. It must not collide
      // with the deferred row.
      await expect(
        db.insert(agentWakeupRequests).values({
          id: randomUUID(),
          companyId,
          agentId,
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          status: "queued",
          idempotencyKey,
          payload: { issueId },
        }),
      ).resolves.toBeDefined();
    }
  });

  // Regression: coalescing is a payload-destroying operation. A wake carrying an
  // idempotency key is a distinct durable signal (a question-response
  // continuation, a review-path recovery) whose payload IS the delivery.
  // Merging it into an unrelated generic wake for the same card discards that
  // payload and key outright.
  it("coalescing never merges wakes that carry different idempotency keys", async () => {
    const { agentId } = await seedActiveAgent();
    const issueId = randomUUID();
    const deliveryKey = `question-response:${randomUUID()}`;
    const interactionId = randomUUID();

    dispatchQuiesce.engage({ reason: "test-quiesce", ttlMs: 60_000 });
    const heartbeat = heartbeatService(db);

    // A generic assignment wake for the card lands first and is deferred.
    await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "update" },
      requestedByActorType: "system",
      requestedByActorId: "deferred_wake_test",
    });

    // Then the question-response continuation wake for the SAME card arrives.
    await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, interactionId, mutation: "interaction" },
      idempotencyKey: deliveryKey,
      requestedByActorType: "system",
      requestedByActorId: "deferred_wake_test",
    });

    const rows = await db
      .select({
        idempotencyKey: agentWakeupRequests.idempotencyKey,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));

    // Two distinct deferred rows — the delivery was not swallowed.
    expect(rows).toHaveLength(2);
    const delivery = rows.find((r) => r.idempotencyKey === deliveryKey);
    expect(delivery).toBeDefined();
    expect(delivery!.payload).toMatchObject({ issueId, interactionId });
  });
});

describeEmbeddedPostgres("recovery deferred-wake replay sweep (SUP-15552)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("deferred-wake-sweep-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    dispatchQuiesce.release();
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCard(status: "in_progress" | "todo" | "done" = "in_progress") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Sweep Co",
      status: "active",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Sweep Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Sweep card",
      status,
      assigneeAgentId: agentId,
    });
    return { companyId, agentId, issueId };
  }

  async function seedDeferrableWake(companyId: string, agentId: string, issueId: string) {
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "heartbeat.scheduling_suppressed",
      // A deferral is `skipped` with NO finishedAt — deliberately the same
      // status value a terminal skip uses, so the idempotency indexes that
      // exclude 'skipped' keep treating it as retryable.
      status: "skipped",
      finishedAt: null,
      payload: { issueId, source: "assignment" },
    });
  }

  async function seedTerminalSkip(companyId: string, agentId: string, issueId: string, reason: string) {
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "timer",
      triggerDetail: "system",
      reason,
      status: "skipped",
      finishedAt: new Date(),
      payload: { issueId, source: "assignment" },
    });
  }

  it("acceptance #2: a terminal skip is never re-driven (agent.not_invokable + heartbeat.timer.no_actionable_work)", async () => {
    const { companyId, agentId, issueId } = await seedCard();
    await seedTerminalSkip(companyId, agentId, issueId, "agent.not_invokable");
    await seedTerminalSkip(companyId, agentId, issueId, "heartbeat.timer.no_actionable_work");

    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    const recovery = recoveryService(db, {
      enqueueWakeup,
      resolveSchedulingSuppression: vi.fn().mockResolvedValue({ suppressed: false, reason: null }),
    });

    const result = await recovery.reconcileDeferredWakeupReplay();

    // The sweep only re-drives rows whose reason is deferrable AND which are
    // unfinished; terminal skips are finished, so they are invisible to it.
    expect(result.reDriven).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    const statuses = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows.map((r) => r.status).sort());
    expect(statuses).toEqual(["skipped", "skipped"]);
    const terminalFinished = await db
      .select({ finishedAt: agentWakeupRequests.finishedAt })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows.map((r) => r.finishedAt));
    expect(terminalFinished.every((f) => f !== null)).toBe(true);
  });

  it("acceptance #2: when the suppression clears, the sweep re-drives the original payload", async () => {
    const { companyId, agentId, issueId } = await seedCard();
    await seedDeferrableWake(companyId, agentId, issueId);

    const fakeRun = { id: randomUUID(), agentId } as unknown as typeof heartbeatRuns.$inferSelect;
    const enqueueWakeup = vi.fn().mockResolvedValue(fakeRun);
    const recovery = recoveryService(db, {
      enqueueWakeup,
      resolveSchedulingSuppression: vi.fn().mockResolvedValue({ suppressed: false, reason: null }),
    });

    const result = await recovery.reconcileDeferredWakeupReplay();

    expect(result.reDriven).toBe(1);
    expect(result.issueIds).toContain(issueId);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    const [enqAgentId, enqOpts] = enqueueWakeup.mock.calls[0] as [string, { payload?: Record<string, unknown> }];
    expect(enqAgentId).toBe(agentId);
    expect(enqOpts.payload).toMatchObject({ issueId });

    // The deferred row is retired by stamping finishedAt. Status stays
    // `skipped`, so it still occupies no idempotency-key slot.
    const row = await db
      .select({ status: agentWakeupRequests.status, finishedAt: agentWakeupRequests.finishedAt })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0]);
    expect(row.status).toBe("skipped");
    expect(row.finishedAt).not.toBeNull();
  });

  it("acceptance #1 + #5 (end-to-end): todo-card assignment wake, suppressed → clear → re-driven carrying the original payload.issueId", async () => {
    const { agentId, issueId } = await seedCard("todo");

    // 1) enqueue → skip: while the instance is quiesced, the REAL heartbeat write
    //    path records a deferrable skip carrying the card's id (not a seeded row).
    dispatchQuiesce.engage({ reason: "test-quiesce", ttlMs: 60_000 });
    const heartbeat = heartbeatService(db);
    const skippedRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      requestedByActorType: "system",
      requestedByActorId: "deferred_wake_e2e",
    });
    expect(skippedRun).toBeNull();
    const pending = await db
      .select({ status: agentWakeupRequests.status, finishedAt: agentWakeupRequests.finishedAt, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0]);
    expect(pending.status).toBe("skipped");
    expect(pending.finishedAt).toBeNull();
    expect(pending.payload).toMatchObject({ issueId });

    // 2) clear: the suppression lifts.
    dispatchQuiesce.release();

    // 3) re-drive: the sweep re-enqueues the wake, carrying the original issue id.
    const enqueueWakeup = vi.fn().mockResolvedValue({ id: randomUUID(), agentId } as never);
    const recovery = recoveryService(db, {
      enqueueWakeup,
      resolveSchedulingSuppression: vi.fn().mockResolvedValue({ suppressed: false, reason: null }),
    });
    const result = await recovery.reconcileDeferredWakeupReplay();

    expect(result.reDriven).toBe(1);
    expect(result.issueIds).toContain(issueId);
    const [, opts] = enqueueWakeup.mock.calls[0] as [string, { payload?: Record<string, unknown> }];
    expect(opts.payload).toMatchObject({ issueId });

    const row = await db
      .select({ status: agentWakeupRequests.status, finishedAt: agentWakeupRequests.finishedAt })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0]);
    expect(row.status).toBe("skipped");
    expect(row.finishedAt).not.toBeNull();
  });

  // Regression (review round 1, `deferred-wake-replay-drops-generic-wake`): the
  // first cut of the sweep `continue`d on any candidate whose payload had no
  // `issueId`, so a generic timer/on-demand wake deferred by the suppression was
  // left `finishedAt IS NULL` forever — never re-driven and never retired. That
  // is the very defect this card exists to fix, reproduced one case over: the
  // ruling classifies a skip by its REASON, not by whether the wake named a card.
  it("a GENERIC (no-issueId) deferrable skip is re-driven once the suppression clears", async () => {
    const { companyId, agentId } = await seedCard();
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "timer",
      triggerDetail: "system",
      reason: "heartbeat.scheduling_suppressed",
      status: "skipped",
      finishedAt: null,
      payload: { source: "timer" },
    });

    const enqueueWakeup = vi.fn().mockResolvedValue({ id: randomUUID(), agentId } as never);
    const recovery = recoveryService(db, {
      enqueueWakeup,
      resolveSchedulingSuppression: vi.fn().mockResolvedValue({ suppressed: false, reason: null }),
    });

    const result = await recovery.reconcileDeferredWakeupReplay();

    expect(result.reDriven).toBe(1);
    expect(result.genericReDriven).toBe(1);
    // No card was named, so nothing is reported under issueIds.
    expect(result.issueIds).toEqual([]);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    const [enqAgentId, enqOpts] = enqueueWakeup.mock.calls[0] as [
      string,
      { payload?: Record<string, unknown> | null; source?: string },
    ];
    expect(enqAgentId).toBe(agentId);
    // The ORIGINAL nullable payload and source are carried through unchanged.
    expect(enqOpts.source).toBe("timer");
    expect(enqOpts.payload).toMatchObject({ source: "timer" });
    expect((enqOpts.payload as { issueId?: string } | null)?.issueId).toBeUndefined();

    // …and the row is retired, so a second sweep does not drive it again.
    const row = await db
      .select({ status: agentWakeupRequests.status, finishedAt: agentWakeupRequests.finishedAt })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0]);
    expect(row.status).toBe("skipped");
    expect(row.finishedAt).not.toBeNull();

    const second = await recovery.reconcileDeferredWakeupReplay();
    expect(second.reDriven).toBe(0);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("a generic deferrable skip is re-driven end-to-end through the real heartbeat write path", async () => {
    const { agentId } = await seedCard();

    // enqueue → skip: a suppressed on-demand wake that names no card.
    dispatchQuiesce.engage({ reason: "test-quiesce", ttlMs: 60_000 });
    const heartbeat = heartbeatService(db);
    const skipped = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "ping",
      requestedByActorType: "system",
      requestedByActorId: "generic_wake_e2e",
    });
    expect(skipped).toBeNull();

    const pending = await db
      .select({ status: agentWakeupRequests.status, finishedAt: agentWakeupRequests.finishedAt, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0]);
    expect(pending.status).toBe("skipped");
    expect(pending.finishedAt).toBeNull();
    expect((pending.payload as { issueId?: string } | null)?.issueId).toBeUndefined();

    // clear → re-drive.
    dispatchQuiesce.release();
    const enqueueWakeup = vi.fn().mockResolvedValue({ id: randomUUID(), agentId } as never);
    const recovery = recoveryService(db, {
      enqueueWakeup,
      resolveSchedulingSuppression: vi.fn().mockResolvedValue({ suppressed: false, reason: null }),
    });

    const result = await recovery.reconcileDeferredWakeupReplay();

    expect(result.reDriven).toBe(1);
    expect(result.genericReDriven).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    const [, opts] = enqueueWakeup.mock.calls[0] as [string, { source?: string; triggerDetail?: string }];
    expect(opts.source).toBe("on_demand");
    expect(opts.triggerDetail).toBe("ping");
  });

  it("a generic deferrable skip is re-driven alongside an issue-bound one, not instead of it", async () => {
    const { companyId, agentId, issueId } = await seedCard();
    await seedDeferrableWake(companyId, agentId, issueId);
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "on_demand",
      triggerDetail: "ping",
      reason: "heartbeat.scheduling_suppressed",
      status: "skipped",
      finishedAt: null,
      payload: {},
    });

    const enqueueWakeup = vi.fn().mockResolvedValue({ id: randomUUID(), agentId } as never);
    const recovery = recoveryService(db, {
      enqueueWakeup,
      resolveSchedulingSuppression: vi.fn().mockResolvedValue({ suppressed: false, reason: null }),
    });

    const result = await recovery.reconcileDeferredWakeupReplay();

    expect(result.reDriven).toBe(2);
    expect(result.genericReDriven).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
    expect(enqueueWakeup).toHaveBeenCalledTimes(2);
    const finished = await db
      .select({ finishedAt: agentWakeupRequests.finishedAt })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows.map((r) => r.finishedAt));
    expect(finished.every((f) => f !== null)).toBe(true);
  });

  it("a terminal-reason generic skip is still never re-driven", async () => {
    const { companyId, agentId } = await seedCard();
    for (const reason of ["agent.not_invokable", "heartbeat.timer.no_actionable_work"]) {
      await db.insert(agentWakeupRequests).values({
        id: randomUUID(),
        companyId,
        agentId,
        source: "timer",
        triggerDetail: "system",
        reason,
        status: "skipped",
        finishedAt: new Date(),
        payload: {},
      });
    }

    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    const recovery = recoveryService(db, {
      enqueueWakeup,
      resolveSchedulingSuppression: vi.fn().mockResolvedValue({ suppressed: false, reason: null }),
    });

    const result = await recovery.reconcileDeferredWakeupReplay();

    expect(result.checked).toBe(0);
    expect(result.reDriven).toBe(0);
    expect(result.genericReDriven).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("acceptance #3: re-drive is idempotent — a second sweep does not drive the same wake again", async () => {
    const { companyId, agentId, issueId } = await seedCard();
    await seedDeferrableWake(companyId, agentId, issueId);

    const fakeRun = { id: randomUUID(), agentId } as unknown as typeof heartbeatRuns.$inferSelect;
    const enqueueWakeup = vi.fn().mockResolvedValue(fakeRun);
    const recovery = recoveryService(db, {
      enqueueWakeup,
      resolveSchedulingSuppression: vi.fn().mockResolvedValue({ suppressed: false, reason: null }),
    });

    const first = await recovery.reconcileDeferredWakeupReplay();
    const second = await recovery.reconcileDeferredWakeupReplay();

    expect(first.reDriven).toBe(1);
    expect(second.reDriven).toBe(0);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("acceptance #3: a card that already has a queued wake is not double-driven", async () => {
    const { companyId, agentId, issueId } = await seedCard();
    await seedDeferrableWake(companyId, agentId, issueId);
    // A separate queued wake already owns this card.
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      status: "queued",
      payload: { issueId },
    });

    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    const recovery = recoveryService(db, {
      enqueueWakeup,
      resolveSchedulingSuppression: vi.fn().mockResolvedValue({ suppressed: false, reason: null }),
    });

    const result = await recovery.reconcileDeferredWakeupReplay();

    expect(result.reDriven).toBe(0);
    expect(result.livePathSkipped).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("acceptance #3: a card already claimed (a live heartbeat run) is not re-driven", async () => {
    const { companyId, agentId, issueId } = await seedCard();
    await seedDeferrableWake(companyId, agentId, issueId);
    // The card is already claimed: a live (running) run exists for it, so
    // hasActiveExecutionPath is true and the sweep must not drive a second one.
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId },
    });

    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    const recovery = recoveryService(db, {
      enqueueWakeup,
      resolveSchedulingSuppression: vi.fn().mockResolvedValue({ suppressed: false, reason: null }),
    });

    const result = await recovery.reconcileDeferredWakeupReplay();

    expect(result.reDriven).toBe(0);
    expect(result.livePathSkipped).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not re-drive while the instance is still suppressed", async () => {
    const { companyId, agentId, issueId } = await seedCard();
    await seedDeferrableWake(companyId, agentId, issueId);

    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    const recovery = recoveryService(db, {
      enqueueWakeup,
      resolveSchedulingSuppression: vi.fn().mockResolvedValue({ suppressed: true, reason: "dispatch_quiesced" }),
    });

    const result = await recovery.reconcileDeferredWakeupReplay();

    expect(result.reDriven).toBe(0);
    expect(result.suppressedSkipped).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    // Row is untouched, still deferrable (unfinished), so a later sweep can
    // still pick it up.
    const row = await db
      .select({ status: agentWakeupRequests.status, finishedAt: agentWakeupRequests.finishedAt })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, "heartbeat.scheduling_suppressed")))
      .then((rows) => rows[0]);
    expect(row.status).toBe("skipped");
    expect(row.finishedAt).toBeNull();
  });

  // Regression (review round 2, `Finding signature:
  // deferrable-worktree-cutoff-remains-terminal`): `heartbeat.worktree_execution_cutoff`
  // is classified DEFERRABLE, but the resolved-issue path inside the
  // execution-lock transaction still hand-rolled its own insert with
  // `finishedAt: new Date()`. That row is invisible to this sweep (which
  // selects `status = 'skipped' AND finished_at IS NULL`), so an issue-bound
  // wake hitting the worktree cutoff was destroyed exactly as the original
  // defect destroyed the scheduling-suppressed one. Against the parent commit
  // the `finishedAt` assertion below fails.
  //
  // This drives the REAL heartbeat write path (not a seeded row) with the
  // worktree cutoff armed, past the projectId-resolution branch — so it lands
  // on the transaction-side site, which is the live one for an issue-bound wake.
  it("regression: a wake for a card behind the armed worktree cutoff defers, holds while armed, and re-drives when the cutoff lifts", async () => {
    const { companyId, agentId, issueId } = await seedCard("todo");

    // Card sits behind the cutoff, so the worktree-execution cutoff suppresses it.
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    await db
      .update(issues)
      .set({ createdAt: new Date(cutoff.getTime() - 60 * 60 * 1000) })
      .where(eq(issues.id, issueId));

    // A real project so the wake carries a projectId in its context snapshot:
    // with projectId already known, enqueueWakeup skips the projectId-resolution
    // lookup (and its own cutoff check) and reaches the transaction-side path.
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Cutoff project" });
    await db.update(issues).set({ projectId }).where(eq(issues.id, issueId));

    const instanceId = "sup15552-worktree-instance";
    await db.delete(instanceSettings);
    await db.insert(instanceSettings).values({
      id: randomUUID(),
      singletonKey: "default",
      general: {},
      experimental: {
        enableWorktreeRunExecution: true,
        worktreeRunExecutionActivatedAt: cutoff.toISOString(),
        worktreeRunExecutionActivationInstanceId: instanceId,
      },
    });

    const heartbeat = heartbeatService(db, {
      runtimeEnv: {
        PAPERCLIP_IN_WORKTREE: "1",
        PAPERCLIP_INSTANCE_ID: instanceId,
      },
    });
    const skippedRun = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { projectId },
      requestedByActorType: "system",
      requestedByActorId: "deferred_wake_cutoff_test",
    });
    expect(skippedRun).toBeNull();

    const rows = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        finishedAt: agentWakeupRequests.finishedAt,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("heartbeat.worktree_execution_cutoff");
    expect(rows[0].status).toBe("skipped");
    // The regression assertion: deferred, not destroyed.
    expect(rows[0].finishedAt).toBeNull();
    expect(rows[0].payload).toMatchObject({ issueId });
    expect((rows[0].payload as { heartbeatSkip?: Record<string, unknown> }).heartbeatSkip)
      .toMatchObject({ reason: "worktree_execution_cutoff", issueId, cutoff: cutoff.toISOString() });

    const enqueueWakeup = vi.fn().mockResolvedValue({ id: randomUUID(), agentId } as never);
    const recovery = recoveryService(db, {
      enqueueWakeup,
      resolveSchedulingSuppression: vi.fn().mockResolvedValue({ suppressed: false, reason: null }),
    });

    // Cutoff still armed: the suppression that skipped this wake has NOT
    // lifted, so the wake is held pending rather than claimed and re-skipped.
    const held = await recovery.reconcileDeferredWakeupReplay({ issueCreatedAtGte: cutoff });
    expect(held.reDriven).toBe(0);
    expect(held.cutoffHeldSkipped).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    const stillPending = await db
      .select({ finishedAt: agentWakeupRequests.finishedAt })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((r) => r[0]);
    expect(stillPending.finishedAt).toBeNull();

    // Cutoff lifts: the wake is re-driven carrying the ORIGINAL payload.issueId.
    const result = await recovery.reconcileDeferredWakeupReplay({ issueCreatedAtGte: null });
    expect(result.reDriven).toBe(1);
    expect(result.issueIds).toContain(issueId);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    const [enqAgentId, enqOpts] = enqueueWakeup.mock.calls[0] as [
      string,
      { payload?: Record<string, unknown> | null },
    ];
    expect(enqAgentId).toBe(agentId);
    expect(enqOpts.payload).toMatchObject({ issueId });

    // Retired, so a second sweep does not drive it again (acceptance #3).
    const second = await recovery.reconcileDeferredWakeupReplay({ issueCreatedAtGte: null });
    expect(second.reDriven).toBe(0);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  // The worktree-cutoff sites resolve the issue themselves and record it under
  // `heartbeatSkip.issueId`, so a wake whose caller passed the card only in the
  // context snapshot has a deferred row that names the card there and nowhere
  // else. Deriving the candidate's issue id from `payload.issueId` alone would
  // treat it as generic: no open-issue check, no live-path check, and no cutoff
  // hold — so it would be re-driven straight back into the still-armed cutoff,
  // once per sweep. Same drift-between-two-derivations as the round-2 finding.
  it("treats a cutoff skip that names its card only under heartbeatSkip as issue-bound", async () => {
    const { companyId, agentId, issueId } = await seedCard("todo");
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    await db
      .update(issues)
      .set({ createdAt: new Date(cutoff.getTime() - 60 * 60 * 1000) })
      .where(eq(issues.id, issueId));

    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "heartbeat.worktree_execution_cutoff",
      status: "skipped",
      finishedAt: null,
      // No top-level issueId — the card is named only by the skip detail.
      payload: {
        heartbeatSkip: {
          reason: "worktree_execution_cutoff",
          cutoff: cutoff.toISOString(),
          issueId,
        },
      },
    });

    const enqueueWakeup = vi.fn().mockResolvedValue({ id: randomUUID(), agentId } as never);
    const recovery = recoveryService(db, {
      enqueueWakeup,
      resolveSchedulingSuppression: vi.fn().mockResolvedValue({ suppressed: false, reason: null }),
    });

    const held = await recovery.reconcileDeferredWakeupReplay({ issueCreatedAtGte: cutoff });
    expect(held.reDriven).toBe(0);
    expect(held.genericReDriven).toBe(0);
    expect(held.cutoffHeldSkipped).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    // Cutoff lifts: now it is re-driven, and reported against its card.
    const result = await recovery.reconcileDeferredWakeupReplay({ issueCreatedAtGte: null });
    expect(result.reDriven).toBe(1);
    expect(result.genericReDriven).toBe(0);
    expect(result.issueIds).toContain(issueId);
  });

  it("does not re-drive a deferrable skip whose card has since been closed", async () => {
    const { companyId, agentId, issueId } = await seedCard("done");
    await seedDeferrableWake(companyId, agentId, issueId);

    const enqueueWakeup = vi.fn().mockResolvedValue(null);
    const recovery = recoveryService(db, {
      enqueueWakeup,
      resolveSchedulingSuppression: vi.fn().mockResolvedValue({ suppressed: false, reason: null }),
    });

    const result = await recovery.reconcileDeferredWakeupReplay();

    expect(result.reDriven).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });
});

// Acceptance #6: the blast-radius query. The live numbers must be produced by
// running this against the production database (see the close comment); this
// test pins the QUERY itself against the real migrated schema on seeded data,
// so the SQL pasted into the close comment is known to be correct rather than
// hand-written and unverified.
describeEmbeddedPostgres("blast radius query for deferrable skips (SUP-15552 acceptance #6)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("deferred-wake-blast-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // Kept verbatim in the close comment.
  const REASON_TALLY_SQL = `
SELECT reason, count(*) AS skipped_count
FROM agent_wakeup_requests
WHERE status = 'skipped'
  AND reason IN (
    'heartbeat.scheduling_suppressed',
    'heartbeat.worktree_execution_cutoff',
    'budget.blocked'
  )
GROUP BY reason
ORDER BY skipped_count DESC`;

  const STRANDED_OPEN_SQL = `
WITH latest_wake AS (
  SELECT DISTINCT ON (w.payload ->> 'issueId')
         w.payload ->> 'issueId' AS issue_id,
         w.reason,
         w.status
  FROM agent_wakeup_requests w
  WHERE w.payload ->> 'issueId' IS NOT NULL
  ORDER BY w.payload ->> 'issueId', w.requested_at DESC, w.id DESC
)
SELECT lw.reason, count(*) AS stranded_open_issues
FROM latest_wake lw
JOIN issues i ON i.id = lw.issue_id::uuid
WHERE lw.status = 'skipped'
  AND lw.reason IN (
    'heartbeat.scheduling_suppressed',
    'heartbeat.worktree_execution_cutoff',
    'budget.blocked'
  )
  AND i.status NOT IN ('done', 'cancelled')
GROUP BY lw.reason
ORDER BY stranded_open_issues DESC`;

  it("tallies deferrable skips per reason and counts still-open cards stranded by one", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Blast Co",
      status: "active",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Blast Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });

    const openIssueId = randomUUID();
    const closedIssueId = randomUUID();
    const recoveredIssueId = randomUUID();
    await db.insert(issues).values([
      { id: openIssueId, companyId, title: "stranded + open", status: "todo", assigneeAgentId: agentId },
      { id: closedIssueId, companyId, title: "stranded but closed", status: "done", assigneeAgentId: agentId },
      { id: recoveredIssueId, companyId, title: "skipped then re-woken", status: "in_progress", assigneeAgentId: agentId },
    ]);

    const wake = (issueId: string, reason: string, status: string, requestedAt: Date) => ({
      id: randomUUID(),
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason,
      status,
      payload: { issueId },
      requestedAt,
    });

    await db.insert(agentWakeupRequests).values([
      // Open card whose most recent wake is a deferrable skip — the stranded shape.
      wake(openIssueId, "heartbeat.scheduling_suppressed", "skipped", new Date("2026-09-08T21:54:39Z")),
      // Same reason, but the card is closed — counted in the tally, not stranded.
      wake(closedIssueId, "heartbeat.scheduling_suppressed", "skipped", new Date("2026-09-08T21:00:00Z")),
      // A different deferrable reason, on a card that was later re-woken by
      // another path: it is in the tally but is NOT stranded, because the
      // deferrable skip is not its most recent wake.
      wake(recoveredIssueId, "budget.blocked", "skipped", new Date("2026-09-07T10:00:00Z")),
      wake(recoveredIssueId, "issue_assigned", "completed", new Date("2026-09-07T11:00:00Z")),
      // A terminal skip is not a deferrable skip and appears in neither result.
      wake(randomUUID(), "heartbeat.timer.no_actionable_work", "skipped", new Date("2026-09-07T12:00:00Z")),
    ]);

    const tally = await db.execute(sql.raw(REASON_TALLY_SQL));
    expect([...tally].map((r) => ({ reason: r.reason, count: Number(r.skipped_count) }))).toEqual([
      { reason: "heartbeat.scheduling_suppressed", count: 2 },
      { reason: "budget.blocked", count: 1 },
    ]);

    const stranded = await db.execute(sql.raw(STRANDED_OPEN_SQL));
    // Only the open card whose LATEST wake is a deferrable skip.
    expect([...stranded].map((r) => ({ reason: r.reason, count: Number(r.stranded_open_issues) }))).toEqual([
      { reason: "heartbeat.scheduling_suppressed", count: 1 },
    ]);
  });
});
