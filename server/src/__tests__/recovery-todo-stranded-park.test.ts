import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { recoveryService } from "../services/recovery/service.ts";
import {
  TODO_STRANDED_ACTION,
  TODO_STRANDED_THRESHOLD_MS,
  buildTodoStrandedDetails,
  evaluateTodoStranded,
  type TodoStrandedDisjuncts,
} from "../services/issue-continuation-path.js";
import { buildTodoStrandedParkNotice } from "../services/recovery/stranded-notice.js";

// loadConfig() in recovery/service.ts validates bind mode eagerly.
process.env.PAPERCLIP_BIND = "loopback";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres todo-stranded-park tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const ALL_FALSE_GUARDS: TodoStrandedDisjuncts = {
  leased: false,
  activeRun: false,
  monitorNextCheckAtInFuture: false,
  liveWake: false,
  boardRecoveryAction: false,
};

const NOTICE_MARKER = "no wake or run";
const DAY_MS = 24 * 60 * 60 * 1000;

const TRUNCATE_ALL_SQL = `
  TRUNCATE TABLE
    "activity_log",
    "document_revisions",
    "documents",
    "execution_workspaces",
    "heartbeat_run_events",
    "heartbeat_runs",
    "issue_comments",
    "issue_documents",
    "issue_relations",
    "issue_recovery_actions",
    "issue_thread_interactions",
    "issues",
    "agent_wakeup_requests",
    "agent_runtime_state",
    "agents",
    "instance_settings",
    "companies",
    "project_workspaces",
    "projects"
  RESTART IDENTITY CASCADE
 `;

// ADR-093 D2 (SUP-15553) — the pure `todo`-arm predicate. A `todo` card is
// stranded only when no live-path guard holds AND its last contact predates the
// threshold window. Every guard is a distinct flag so each negative is testable
// in isolation (acceptance AC1/AC2/AC6).
describe("evaluateTodoStranded (ADR-093 D2 predicate)", () => {
  const NOW = new Date("2026-09-09T12:00:00.000Z");
  const stale = new Date(NOW.getTime() - DAY_MS); // 24h ago -> outside the 2h window

  function evidence(overrides: Partial<Parameters<typeof evaluateTodoStranded>[0]> = {}) {
    return {
      leased: false,
      activeRun: false,
      monitorNextCheckAtInFuture: false,
      liveWake: false,
      boardRecoveryAction: false,
      lastContactAt: stale,
      ...overrides,
    };
  }

  it("detects a stranded assigned todo card when no guard holds and the window elapsed (AC1)", () => {
    const result = evaluateTodoStranded(evidence(), { now: NOW });
    expect(result.stranded).toBe(true);
    expect(result.disjuncts).toEqual(ALL_FALSE_GUARDS);
    expect(result.elapsedMs).toBe(DAY_MS);
    expect(result.lastContactAt?.toISOString()).toBe(stale.toISOString());
  });

  it("is not stranded when the card is leased (AC2a)", () => {
    expect(evaluateTodoStranded(evidence({ leased: true }), { now: NOW }).stranded).toBe(false);
  });

  it("is not stranded when an active run holds the card (AC2b)", () => {
    expect(evaluateTodoStranded(evidence({ activeRun: true }), { now: NOW }).stranded).toBe(false);
  });

  it("is not stranded when a future monitor check is armed (AC2c)", () => {
    expect(
      evaluateTodoStranded(evidence({ monitorNextCheckAtInFuture: true }), { now: NOW }).stranded,
    ).toBe(false);
  });

  it("is not stranded when a wake is live — queued, claimed or deferred (AC2d)", () => {
    expect(evaluateTodoStranded(evidence({ liveWake: true }), { now: NOW }).stranded).toBe(false);
  });

  it("is not stranded when a board recovery action owns it (AC2e)", () => {
    expect(
      evaluateTodoStranded(evidence({ boardRecoveryAction: true }), { now: NOW }).stranded,
    ).toBe(false);
  });

  it("is not stranded inside the threshold window (grace)", () => {
    const result = evaluateTodoStranded(
      evidence({ lastContactAt: new Date(NOW.getTime() - TODO_STRANDED_THRESHOLD_MS + 1000) }),
      { now: NOW },
    );
    expect(result.stranded).toBe(false);
  });

  it("is not stranded with no last-contact anchor to measure against", () => {
    expect(evaluateTodoStranded(evidence({ lastContactAt: null }), { now: NOW }).stranded).toBe(false);
  });
});

describe("buildTodoStrandedDetails / buildTodoStrandedParkNotice (ADR-093 D2 observability)", () => {
  it("emits a stable detail payload naming the guards and the window", () => {
    const last = new Date("2026-09-07T12:00:00.000Z");
    const details = buildTodoStrandedDetails({
      issueId: "issue-1",
      disjuncts: ALL_FALSE_GUARDS,
      lastContactAt: last,
      elapsedMs: DAY_MS,
    });
    expect(details).toEqual({
      issueId: "issue-1",
      reason: "todo_without_live_continuation",
      status: "todo",
      disjuncts: ALL_FALSE_GUARDS,
      lastContactAt: last.toISOString(),
      elapsedMs: DAY_MS,
      thresholdMs: TODO_STRANDED_THRESHOLD_MS,
      adr: "ADR-093-D2",
    });
    expect(TODO_STRANDED_ACTION).toBe("issue.todo_stranded_no_continuation");
  });

  it("names the unblock owner and a concrete next action", () => {
    const notice = buildTodoStrandedParkNotice({
      identifier: "SUP-9",
      assignee: { id: "agent-1", name: "Coder" },
    });
    expect(notice.body).toContain("SUP-9");
    expect(notice.body).toContain(NOTICE_MARKER);
    expect(notice.presentation).toMatchObject({ kind: "system_notice", tone: "danger" });
    expect(JSON.stringify(notice.metadata.sections)).toContain("agent-1");
  });
});

describeEmbeddedPostgres("recovery reconcileTodoStrandedCards", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-todo-stranded-park-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.execute(sql.raw(TRUNCATE_ALL_SQL));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function recovery() {
    return recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
  }

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
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
    return { companyId, agentId };
  }

  async function seedTodoCard(input: {
    companyId: string;
    agentId: string | null;
    lastContactMsAgo?: number;
    monitorNextCheckAtMsFromNow?: number;
    executionRunId?: string | null;
  }): Promise<string> {
    const issueId = randomUUID();
    const now = Date.now();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Assigned todo card",
      status: "todo",
      priority: "high",
      assigneeAgentId: input.agentId,
      assigneeUserId: null,
      executionRunId: input.executionRunId ?? null,
      updatedAt: new Date(now - (input.lastContactMsAgo ?? 3 * 60 * 60 * 1000)),
      monitorNextCheckAt:
        input.monitorNextCheckAtMsFromNow != null
          ? new Date(now + input.monitorNextCheckAtMsFromNow)
          : null,
    });
    return issueId;
  }

  async function readIssue(issueId: string) {
    const rows = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId));
    return rows[0] ?? null;
  }

  async function countActivity(action: string, issueId: string) {
    const rows = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, issueId),
          eq(activityLog.action, action),
        ),
      );
    return rows.length;
  }

  async function countNotices(issueId: string) {
    const rows = await db
      .select({ id: issueComments.id, body: issueComments.body })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
    return rows.filter((row) => (row.body ?? "").includes(NOTICE_MARKER)).length;
  }

  it("parks a stranded assigned todo card to blocked exactly once, with one activity row (AC1/AC4/AC5)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedTodoCard({ companyId, agentId });
    const svc = recovery();

    const first = await svc.reconcileTodoStrandedCards({ now: new Date() });
    expect(first.parked).toBe(1);
    expect(first.livePathSkipped).toBe(0);
    expect(first.thresholdSkipped).toBe(0);
    expect(first.issueIds).toEqual([issueId]);

    expect((await readIssue(issueId))?.status).toBe("blocked");
    expect(await countActivity(TODO_STRANDED_ACTION, issueId)).toBe(1);
    expect(await countNotices(issueId)).toBe(1);

    // Re-run: the card is now blocked, so it is no longer a `todo` candidate.
    const second = await svc.reconcileTodoStrandedCards({ now: new Date() });
    expect(second.parked).toBe(0);
    expect(await countActivity(TODO_STRANDED_ACTION, issueId)).toBe(1);
    expect(await countNotices(issueId)).toBe(1);
  });

  it("never parks an unassigned todo card (AC3)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedTodoCard({ companyId, agentId: null });
    const svc = recovery();

    const result = await svc.reconcileTodoStrandedCards({ now: new Date() });
    expect(result.checked).toBe(0);
    expect(result.parked).toBe(0);
    expect((await readIssue(issueId))?.status).toBe("todo");
  });

  it("does not park before the threshold window elapses (grace)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedTodoCard({ companyId, agentId, lastContactMsAgo: 10 * 60 * 1000 });
    const svc = recovery();

    const result = await svc.reconcileTodoStrandedCards({ now: new Date() });
    expect(result.parked).toBe(0);
    expect(result.thresholdSkipped).toBe(1);
    expect((await readIssue(issueId))?.status).toBe("todo");
  });

  it("does not park a card with a live (running) execution path (AC2b)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedTodoCard({ companyId, agentId });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    });
    const svc = recovery();

    const result = await svc.reconcileTodoStrandedCards({ now: new Date() });
    expect(result.parked).toBe(0);
    expect(result.livePathSkipped).toBe(1);
    expect((await readIssue(issueId))?.status).toBe("todo");
  });

  it("does not park a card held by a live execution lease (AC2a)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const runId = randomUUID();
    // The run must exist before the issue points at it (FK), so seed it first.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "manual",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assigned todo card",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      assigneeUserId: null,
      executionRunId: runId,
      updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      monitorNextCheckAt: null,
    });
    const svc = recovery();

    const result = await svc.reconcileTodoStrandedCards({ now: new Date() });
    expect(result.parked).toBe(0);
    expect(result.leasedSkipped).toBe(1);
    expect((await readIssue(issueId))?.status).toBe("todo");
  });

  it("does not park a card with a queued wake (AC2d)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedTodoCard({ companyId, agentId });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId },
      status: "queued",
    });
    const svc = recovery();

    const result = await svc.reconcileTodoStrandedCards({ now: new Date() });
    expect(result.parked).toBe(0);
    expect(result.livePathSkipped).toBe(1);
    expect((await readIssue(issueId))?.status).toBe("todo");
  });

  // SUP-15574 regression. `claimed` is the wake lifecycle's in-flight delivery
  // state: `runId` is assigned and the wake has not finished. It is neither
  // `queued` (so the old queued-only disjunct missed it) nor an active run when
  // the run crashed/was killed (so `hasActiveExecutionPath` missed it too) —
  // which parked a live card. Both the card and the wake are aged past the
  // window here so the ONLY thing standing between this card and a park is the
  // wake-status set: with `queued`-only the card parks; with the shared live set
  // it does not.
  it("does not park a card with a claimed (in-flight) wake (AC2d — SUP-15574)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedTodoCard({ companyId, agentId, lastContactMsAgo: DAY_MS });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId },
      status: "claimed",
      runId: randomUUID(),
      claimedAt: new Date(Date.now() - DAY_MS),
      createdAt: new Date(Date.now() - DAY_MS),
    });
    const svc = recovery();

    const result = await svc.reconcileTodoStrandedCards({ now: new Date() });
    expect(result.parked).toBe(0);
    expect(result.livePathSkipped).toBe(1);
    expect((await readIssue(issueId))?.status).toBe("todo");
  });

  // Same shared status set, third member. `deferred_issue_execution` is also
  // covered by `hasActiveExecutionPath`; asserting it here pins the whole
  // `SUCCESSFUL_RUN_HANDOFF_LIVE_WAKE_STATUSES` set to the todo arm so a future
  // edit cannot drop a member without a red test.
  it("does not park a card with a deferred_issue_execution wake (AC2d — SUP-15574)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedTodoCard({ companyId, agentId, lastContactMsAgo: DAY_MS });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId },
      status: "deferred_issue_execution",
      createdAt: new Date(Date.now() - DAY_MS),
    });
    const svc = recovery();

    const result = await svc.reconcileTodoStrandedCards({ now: new Date() });
    expect(result.parked).toBe(0);
    expect(result.livePathSkipped).toBe(1);
    expect((await readIssue(issueId))?.status).toBe("todo");
  });

  it("does not park a card owned by a board recovery action (AC2e)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedTodoCard({ companyId, agentId });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "board",
      cause: "stranded_assigned_issue",
      fingerprint: `todo-stranded:${companyId}:${issueId}`,
      evidence: {},
      nextAction: "Board decision required",
    });
    const svc = recovery();

    const result = await svc.reconcileTodoStrandedCards({ now: new Date() });
    expect(result.parked).toBe(0);
    expect(result.alreadyActionedSkipped).toBe(1);
    expect((await readIssue(issueId))?.status).toBe("todo");
  });

  it("detects the SUP-15460 replay: a stale skipped wake, no run, 24h elapsed (AC6 regression)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = await seedTodoCard({ companyId, agentId, lastContactMsAgo: DAY_MS });
    // The wake was skipped (never ran) 24h ago; nothing since. Not queued, not
    // deferred — so it is not a live path, only a (stale) contact anchor.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId },
      status: "skipped",
      createdAt: new Date(Date.now() - DAY_MS),
      finishedAt: new Date(Date.now() - DAY_MS),
      error: "Cancelled because the assignee was unavailable",
    });
    const svc = recovery();

    const result = await svc.reconcileTodoStrandedCards({ now: new Date() });
    expect(result.parked).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
    expect((await readIssue(issueId))?.status).toBe("blocked");
    expect(await countActivity(TODO_STRANDED_ACTION, issueId)).toBe(1);
  });
});
