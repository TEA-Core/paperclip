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
  issues,
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

  it("acceptance #1: a scheduling_suppressed skip is a deferral (skipped_deferrable, no finishedAt)", async () => {
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
      status: "skipped_deferrable",
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
    expect(rows[0].status).toBe("skipped_deferrable");
    expect(rows[0].coalescedCount).toBeGreaterThanOrEqual(1);
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
});

describeEmbeddedPostgres("recovery deferred-wake replay sweep (SUP-15552)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("deferred-wake-sweep-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
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
      status: "skipped_deferrable",
      payload: { issueId, source: "assignment" },
    });
  }

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

    // The deferrable row is now the terminal replayed audit marker.
    const row = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .then((rows) => rows[0]);
    expect(row.status).toBe("skipped_deferrable_replayed");
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

    // Row is untouched, still deferrable, so a later sweep can still pick it up.
    const row = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.agentId, agentId), eq(agentWakeupRequests.reason, "heartbeat.scheduling_suppressed")))
      .then((rows) => rows[0]);
    expect(row.status).toBe("skipped_deferrable");
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
