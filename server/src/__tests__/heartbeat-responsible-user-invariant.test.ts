import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Responsible-user invariant test run.",
    provider: "test",
    model: "test-model",
  })),
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

async function waitForRun(db: ReturnType<typeof createDb>, runId: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
}

async function cleanupSafely(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let hadError = false;
    for (const fn of [
      () => db.delete(activityLog),
      () => db.delete(issueComments),
      () => db.delete(heartbeatRunEvents),
      () => db.delete(heartbeatRuns),
      () => db.delete(agentWakeupRequests),
      () => db.delete(agentRuntimeState),
    ]) {
      try { await fn(); } catch { hadError = true; }
    }
    try { await db.delete(issues); } catch (e) { hadError = true; }
    try { await db.delete(agents); } catch (e) { hadError = true; }
    try { await db.delete(companySkills); } catch { hadError = true; }
    try { await db.delete(companyMemberships); } catch { hadError = true; }
    try { await db.delete(companies); } catch { hadError = true; }
    if (!hadError) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForSettledState(
  db: ReturnType<typeof createDb>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let settled = 0;
  let lastMaxUpdated: string | null = null;
  while (Date.now() < deadline) {
    const active = await db
      .select()
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.status, ["queued", "running"]))
      .then((rows) => rows.length);
    if (active > 0) {
      settled = 0;
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    const maxUpdated = await db
      .select({ max: sql<string>`greatest(max(${heartbeatRuns.updatedAt}), max(${heartbeatRunEvents.createdAt}))` })
      .from(heartbeatRuns)
      .leftJoin(heartbeatRunEvents, eq(heartbeatRuns.id, heartbeatRunEvents.runId))
      .then((rows) => rows[0]?.max ?? null);
    if (maxUpdated !== lastMaxUpdated) {
      lastMaxUpdated = maxUpdated;
      settled = 0;
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    settled += 1;
    if (settled >= 6) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

describeEmbeddedPostgres("heartbeat responsible-user invariant", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-responsible-user-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await waitForSettledState(db, 8_000);
    await cleanupSafely(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 60_000);

  async function seedCompany() {
    const companyId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: ownerUserId,
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
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    return { companyId, ownerUserId, agentId };
  }

  it("uses the issue responsible user for comment, mention, and dependency wakes", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueResponsibleUserId = `issue-owner-${randomUUID()}`;
    const commenterUserId = `commenter-${randomUUID()}`;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue-owned work",
      status: "todo",
      assigneeAgentId: agentId,
      responsibleUserId: issueResponsibleUserId,
    });

    for (const wakeReason of ["issue_commented", "issue_comment_mentioned", "issue_blockers_resolved"]) {
      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: wakeReason,
        payload: { issueId, commentId: randomUUID() },
        requestedByActorType: "user",
        requestedByActorId: commenterUserId,
        contextSnapshot: { issueId, taskId: issueId, wakeReason },
      });
      expect(run).not.toBeNull();
      const completed = await waitForRun(db, run!.id);
      expect(completed?.responsibleUserId).toBe(issueResponsibleUserId);
    }
  });

  it("uses the triggering user for manual UI/API runs", async () => {
    const { agentId } = await seedCompany();
    const triggeringUserId = `manual-${randomUUID()}`;
    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: triggeringUserId,
    });

    expect(run).not.toBeNull();
    const completed = await waitForRun(db, run!.id);
    expect(completed?.responsibleUserId).toBe(triggeringUserId);
  });

  it("falls back to the company default for system-originated runs without an issue", async () => {
    const { agentId, ownerUserId } = await seedCompany();
    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "productivity_review",
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: { wakeReason: "productivity_review" },
    });

    expect(run).not.toBeNull();
    const completed = await waitForRun(db, run!.id);
    expect(completed?.responsibleUserId).toBe(ownerUserId);
  });

  it("does not use an issue creator as an implicit responsible user for automated issue runs", async () => {
    const { companyId, agentId, ownerUserId } = await seedCompany();
    const creatorUserId = `creator-${randomUUID()}`;
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Creator is not credential owner",
      status: "todo",
      assigneeAgentId: agentId,
      createdByUserId: creatorUserId,
    });

    const run = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      requestedByActorType: "user",
      requestedByActorId: `commenter-${randomUUID()}`,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
    });
    expect(run).not.toBeNull();
    const completed = await waitForRun(db, run!.id);
    expect(completed?.responsibleUserId).toBe(ownerUserId);
    expect(completed?.responsibleUserId).not.toBe(creatorUserId);
  });

  it("fails automated issue dispatch instead of falling back to the issue creator when no default exists", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Creator-only",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Creator-only issue",
      status: "todo",
      assigneeAgentId: agentId,
      createdByUserId: `creator-${randomUUID()}`,
    });

    await expect(heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      requestedByActorType: "user",
      requestedByActorId: `commenter-${randomUUID()}`,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "responsible_user_unresolved" },
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    expect(runs).toHaveLength(0);
  });

  it("fails dispatch before creating a run when no responsible user can be resolved", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Ownerless",
      issuePrefix: `O${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });

    await expect(heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      requestedByActorType: "system",
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "responsible_user_unresolved" },
    });

    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
    expect(runs).toHaveLength(0);
  });
});
