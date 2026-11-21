import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agentWakeupRequests, agents, companies, companyMemberships, createDb, heartbeatRuns,
  issueRecoveryActions, issueRelations, issues, issueThreadInteractions, issueTreeHolds,
  type Db, type EmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueTreeControlRoutes } from "../routes/issue-tree-control.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { recoveryService } from "../services/recovery/service.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { truncateWithLockRetry } from "./helpers/truncate-with-lock-retry.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";

interface Fixture {
  companyId: string; sourceId: string; carrierId: string; blockerId: string;
  actionId: string; decisionId: string; agentId: string;
  body: {
    sourceIssueId: string; recoveryActionId: string; decisionInteractionId: string;
    expectedStatus: string; expectedStatusVersion: number;
    expectedAssigneeAgentId: string | null; expectedAssigneeUserId: string | null;
    expectedActionUpdatedAt: string; expectedDecisionUpdatedAt: string;
    expectedBlockers: Array<{ id: string; status: string; statusVersion: number }>;
    reason: string;
  };
}

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Carrier park PostgreSQL tests unavailable: ${support.reason}`);

describePostgres("board accepted recovery carrier park (real routes)", () => {
  let db: Db;
  let postgres: EmbeddedPostgresTestDatabase;
  let storageRoot: string;
  let storage: StorageService;
  beforeAll(async () => {
    postgres = await startEmbeddedPostgresTestDatabase("paperclip-carrier-park-");
    db = createDb(postgres.connectionString);
    storageRoot = await mkdtemp(path.join(tmpdir(), "paperclip-carrier-storage-"));
    storage = createStorageService(createLocalDiskStorageProvider(storageRoot));
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end();
    await postgres?.cleanup();
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });
  afterEach(async () => {
    // A released fixture must not become work for the next fixture's global sweep.
    await truncateWithLockRetry(db, "TRUNCATE TABLE companies CASCADE");
  });

  function app(companyId: string, agentId?: string) {
    const result = express();
    result.use(express.json());
    result.use((req, _res, next) => {
      req.actor = agentId
        ? { type: "agent", source: "agent_key", companyId, agentId }
        : { type: "board", source: "session", userId: "park-operator", companyIds: [companyId],
            memberships: [{ companyId, status: "active", membershipRole: "operator" }], isInstanceAdmin: false };
      next();
    });
    result.use("/api", issueTreeControlRoutes(db));
    result.use("/api", issueRoutes(db, storage, {}));
    result.use(errorHandler);
    return result;
  }

  async function fixture(): Promise<Fixture> {
    const companyId = randomUUID(), sourceId = randomUUID(), carrierId = randomUUID();
    const blockerId = randomUUID(), actionId = randomUUID(), decisionId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Park fixture", issuePrefix: `P${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "park-operator", status: "active", membershipRole: "operator" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture owner", role: "engineer", adapterType: "process", status: "idle" });
    const old = new Date("2026-01-01T00:00:00Z");
    await db.insert(issues).values([
      { id: sourceId, companyId, title: "Unrepaired source", status: "blocked", updatedAt: old },
      { id: carrierId, companyId, title: "Recovery carrier", status: "blocked", assigneeUserId: "park-operator", originKind: "stranded_issue_recovery", originId: sourceId, updatedAt: old },
      { id: blockerId, companyId, title: "Historical repair", status: "done", updatedAt: old },
    ]);
    await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: carrierId, type: "blocks" });
    await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: sourceId, recoveryIssueId: carrierId,
      kind: "blocked_without_blockers", status: "escalated", outcome: "exhausted", ownerType: "board",
      cause: "blocked_without_blockers", fingerprint: "original-failure", nextAction: "Board decision required", attemptCount: 5, maxAttempts: 5, updatedAt: old });
    await db.insert(issueThreadInteractions).values({ id: decisionId, companyId, issueId: carrierId, kind: "request_confirmation",
      status: "rejected", payload: { version: 1, prompt: "Repair and close?" },
      resolvedByUserId: "park-operator", resolvedAt: old, updatedAt: old });
    const [carrier] = await db.select().from(issues).where(eq(issues.id, carrierId));
    return { companyId, sourceId, carrierId, blockerId, actionId, decisionId, agentId,
      body: { sourceIssueId: sourceId, recoveryActionId: actionId, decisionInteractionId: decisionId,
        expectedStatus: "blocked", expectedStatusVersion: carrier.statusVersion,
        expectedAssigneeAgentId: null, expectedAssigneeUserId: "park-operator",
        expectedActionUpdatedAt: old.toISOString(), expectedDecisionUpdatedAt: old.toISOString(),
        expectedBlockers: [{ id: blockerId, status: "done", statusVersion: 0 }],
        reason: "Intentionally unresolved; manual board release only" } };
  }
  const park = (f: Fixture, body = f.body, client = app(f.companyId)) => request(client).post(`/api/issues/${f.carrierId}/recovery-carrier-park`).send(body);
  async function snapshot(f: Fixture) {
    return {
      source: await db.select().from(issues).where(eq(issues.id, f.sourceId)),
      actions: await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId)),
      cards: await db.select().from(issues).where(eq(issues.companyId, f.companyId)).orderBy(issues.id),
      wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)),
    };
  }
  async function attention(f: Fixture) {
    const response = await request(app(f.companyId)).get(`/api/issues/${f.carrierId}`);
    expect(response.status).toBe(200);
    return response.body.blockerAttention;
  }

  async function protectSourceRows(f: Fixture) {
    // Sequences survive transaction rollback, including a sweep's caught error.
    const counter = `park_write_attempts_${f.actionId.replaceAll("-", "")}`;
    await db.execute(sql.raw(`create sequence ${counter}`));
    await db.execute(sql`create or replace function reject_park_source_write() returns trigger language plpgsql as $$ begin perform nextval(TG_ARGV[0]); raise exception 'protected park row written'; end $$`);
    await db.execute(sql.raw(`create trigger protect_action_${f.actionId.replaceAll("-", "")} before update or delete on issue_recovery_actions for each row when (old.id = '${f.actionId}') execute function reject_park_source_write('${counter}')`));
    await db.execute(sql.raw(`create trigger protect_source_${f.sourceId.replaceAll("-", "")} before update or delete on issues for each row when (old.id = '${f.sourceId}') execute function reject_park_source_write('${counter}')`));
    return async () => expect((await db.execute(sql.raw(`select is_called from ${counter}`)))[0].is_called).toBe(false);
  }

  async function waitForBlockedPid(blockerPid: number) {
    let blockedPid: number | null = null;
    // Await an observed PostgreSQL lock dependency, not a guessed sleep.
    await expect.poll(async () => {
      const [row] = await db.execute(sql`select pid from pg_stat_activity
        where datname = current_database() and ${blockerPid} = any(pg_blocking_pids(pid))`);
      blockedPid = row ? Number(row.pid) : null;
      return blockedPid;
    }, { timeout: 10_000 }).not.toBeNull();
    return blockedPid!;
  }

  it("accepts an exact board park without a source/action write or fake liveness, and repeats idempotently", async () => {
    const f = await fixture(), before = await snapshot(f);
    const assertNoProtectedWrites = await protectSourceRows(f);
    const response = await park(f);
    expect(response.status).toBe(201);
    expect(response.body.hold).toMatchObject({ mode: "pause", status: "active", releasePolicy: { strategy: "manual" }, recoveryCarrierPark: { recoveryActionId: f.actionId, sourceIssueId: f.sourceId, decisionInteractionId: f.decisionId } });
    const repeated = await park(f);
    expect(repeated.status).toBe(200);
    expect(repeated.body.hold.id).toBe(response.body.hold.id);
    expect(await snapshot(f)).toEqual(before);
    expect(await attention(f)).toMatchObject({ state: "none", unresolvedBlockerCount: 0, blockingTreeLive: false, carrierPark: { state: "accepted", recoveryActionId: f.actionId } });
    expect(await issueRecoveryActionService(db).resolveActiveForIssue({
      companyId: f.companyId, sourceIssueId: f.sourceId, actionId: f.actionId,
      status: "resolved", outcome: "restored", boardResolution: true,
    })).toBeNull();
    expect(await snapshot(f)).toEqual(before);
    await assertNoProtectedWrites();
    const receipts = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
    expect(receipts.filter(row => row.action === "issue.recovery_carrier_parked")).toHaveLength(1);
  });

  it("does not infer acceptance from exhaustion or a rejected decision", async () => {
    const f = await fixture();
    expect(await attention(f)).toMatchObject({ state: "needs_attention" });
    expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId, f.companyId))).toEqual([]);
  });

  it("serializes concurrent acceptance into one hold and one audited board decision", async () => {
    const f = await fixture(), before = await snapshot(f);
    const responses = await Promise.all([park(f), park(f)]);
    expect(responses.map(row => row.status).sort()).toEqual([200, 201]);
    expect(responses[0].body.hold.id).toBe(responses[1].body.hold.id);
    expect(await snapshot(f)).toEqual(before);
    const receipts = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
    expect(receipts.filter(row => row.action === "issue.recovery_carrier_parked")).toHaveLength(1);
  });

  it("does not assign or wake a source when a park commits before the orphan sweep acquires its row lock", async () => {
    const f = await fixture();
    await db.update(agents).set({ capabilities: "Implements repository changes" }).where(eq(agents.id, f.agentId));
    await db.update(issues).set({ createdByAgentId: f.agentId }).where(eq(issues.id, f.sourceId));
    const dependentId = randomUUID();
    await db.insert(issues).values({ id: dependentId, companyId: f.companyId, title: "Other dependent work", status: "todo" });
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.sourceId, relatedIssueId: dependentId, type: "blocks" });
    const before = await snapshot(f);
    const assertNoProtectedWrites = await protectSourceRows(f);
    const barrierKey = Number.parseInt(f.companyId.slice(0, 8), 16);
    await db.execute(sql`create or replace function wait_for_park_barrier() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(TG_ARGV[0]::bigint); return new; end $$`);
    await db.execute(sql.raw(`create trigger park_barrier_${f.carrierId.replaceAll("-", "")}
      before insert on issue_tree_holds for each row when (new.root_issue_id = '${f.carrierId}')
      execute function wait_for_park_barrier('${barrierKey}')`));
    // This test project targets a pre-ES2024 Promise library.
    let releaseBarrier!: () => void;
    const released = new Promise<void>(resolve => { releaseBarrier = resolve; });
    let markReady!: (pid: number) => void;
    const ready = new Promise<number>(resolve => { markReady = resolve; });
    const barrier = db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(${barrierKey}::bigint)`);
      const [row] = await tx.execute(sql`select pg_backend_pid() as pid`);
      markReady(Number(row.pid));
      await released;
    });
    const blockerPid = await ready;
    const acceptance = park(f).then(response => response);
    const wakes: string[] = [];
    const recovery = recoveryService(db, { enqueueWakeup: async agentId => { wakes.push(agentId); return null; } });
    let sweep: ReturnType<typeof recovery.reconcileStrandedAssignedIssues> | undefined;
    try {
      const parkPid = await waitForBlockedPid(blockerPid);
      sweep = recovery.reconcileStrandedAssignedIssues();
      await waitForBlockedPid(parkPid);
    } finally {
      releaseBarrier();
      await Promise.all([barrier, acceptance, sweep]);
    }
    expect((await acceptance).status).toBe(201);
    await assertNoProtectedWrites();
    expect(await snapshot(f)).toEqual(before);
    expect(wakes).toEqual([]);
  }, 30_000);

  it("requires attention when a stale park's changed blocker is otherwise covered", async () => {
    const f = await fixture();
    expect((await park(f)).status).toBe(201);
    await db.update(issues).set({ status: "in_progress", statusVersion: 1, assigneeUserId: "park-operator" }).where(eq(issues.id, f.blockerId));
    expect(await attention(f)).toMatchObject({
      state: "needs_attention", reason: "attention_required", unresolvedBlockerCount: 1, blockingTreeLive: true,
      carrierPark: { state: "stale", recoveryActionId: f.actionId },
    });
  });

  it("keeps the typed park visible and replay idempotent after a later ordinary pause at the same root", async () => {
    const f = await fixture();
    const accepted = await park(f);
    expect(accepted.status).toBe(201);
    const ordinary = await request(app(f.companyId)).post(`/api/issues/${f.carrierId}/tree-holds`)
      .send({ mode: "pause", reason: "Separate ordinary pause", releasePolicy: { strategy: "manual" } });
    expect(ordinary.status).toBe(201);
    // Give the later fixture hold a distinct timestamp even on a coarse host clock.
    await db.update(issueTreeHolds).set({ createdAt: new Date(Date.parse(accepted.body.hold.createdAt) + 1) }).where(eq(issueTreeHolds.id, ordinary.body.hold.id));
    const state = await request(app(f.companyId)).get(`/api/issues/${f.carrierId}/tree-control/state`);
    expect(state.body.activePauseHold).toMatchObject({ holdId: accepted.body.hold.id, recoveryCarrierPark: { recoveryActionId: f.actionId } });
    const replay = await park(f);
    expect(replay.status).toBe(200);
    expect(replay.body.hold.id).toBe(accepted.body.hold.id);
  });

  it("rolls back the hold when the audit write fails", async () => {
    const f = await fixture(), before = await snapshot(f);
    await db.execute(sql`create or replace function reject_park_audit() returns trigger language plpgsql as $$ begin raise exception 'audit refused'; end $$`);
    await db.execute(sql.raw(`create trigger protect_audit_${f.companyId.replaceAll("-", "")} before insert on activity_log for each row when (new.company_id = '${f.companyId}' and new.action = 'issue.recovery_carrier_parked') execute function reject_park_audit()`));
    expect((await park(f)).status).toBe(500);
    expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId, f.companyId))).toEqual([]);
    expect(await snapshot(f)).toEqual(before);
  });

  it("invalidates stale ownership visibly but retains the manual execution hold", async () => {
    const f = await fixture();
    const response = await park(f);
    expect(response.status).toBe(201);
    await db.update(issues).set({ assigneeUserId: "another-operator" }).where(eq(issues.id, f.carrierId));
    expect(await attention(f)).toMatchObject({ state: "needs_attention", carrierPark: { state: "stale" } });
    const state = await request(app(f.companyId)).get(`/api/issues/${f.carrierId}/tree-control/state`);
    expect(state.body.activePauseHold.holdId).toBe(response.body.hold.id);
    expect((await park(f)).status).toBe(409);
  });

  it.each(["agent", "cross-company", "decision", "action", "run", "scheduled", "queued", "blocker", "owner"])("rejects %s without partial state", async mode => {
    const f = await fixture();
    let body = f.body, client = app(f.companyId);
    if (mode === "agent") client = app(f.companyId, f.agentId);
    if (mode === "cross-company") client = app(randomUUID());
    if (mode === "decision") body = { ...body, expectedDecisionUpdatedAt: new Date(0).toISOString() };
    if (mode === "action") body = { ...body, recoveryActionId: randomUUID() };
    if (mode === "blocker") body = { ...body, expectedBlockers: [] };
    if (mode === "owner") await db.update(issues).set({ assigneeAgentId: f.agentId, assigneeUserId: null, statusVersion: 1 }).where(eq(issues.id, f.carrierId));
    if (mode === "run") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: f.carrierId } });
    if (mode === "scheduled") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "assignment", status: "scheduled_retry", nativeIssueId: f.carrierId });
    if (mode === "queued") await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "assignment", status: "queued", payload: { issueId: f.carrierId } });
    const before = await snapshot(f);
    const response = await park(f, body, client);
    expect(response.status).toBe(mode === "agent" ? 403 : mode === "cross-company" ? 404 : 409);
    expect(await snapshot(f)).toEqual(before);
    expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId, f.companyId))).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toEqual([]);
  });

  it.each(["board", "agent"])("survives sweeps, ticks, comments and service restart with %s ownership, then releases without source repair", async owner => {
    const f = await fixture();
    if (owner === "agent") {
      await db.update(issues).set({ assigneeAgentId: f.agentId, assigneeUserId: null }).where(eq(issues.id, f.carrierId));
      f.body.expectedAssigneeAgentId = f.agentId;
      f.body.expectedAssigneeUserId = null;
    }
    const assertNoProtectedWrites = await protectSourceRows(f);
    const response = await park(f);
    expect(response.status).toBe(201);
    const before = await snapshot(f);
    for (let tick = 0; tick < 3; tick++) {
      const recovery = recoveryService(db, { enqueueWakeup: async () => { throw new Error("Park must not wake"); } }); // restart: no in-memory acceptance
      await recovery.reconcileBlockedWithoutBlockers();
      await recovery.reconcileExhaustedRecoveryDrain({ companyId: f.companyId });
      await recovery.reconcileStaleRecoveryActionWakes();
      await recovery.reconcileStrandedAssignedIssues();
      const heartbeat = heartbeatService(db);
      expect(await heartbeat.wakeup(f.agentId, { source: "automation", reason: "recovery", payload: { issueId: f.sourceId, recoveryActionId: f.actionId } })).toBeNull();
      expect(await heartbeat.wakeup(f.agentId, { source: "automation", reason: "issue_comment_added", payload: { issueId: f.carrierId } })).toBeNull();
      await heartbeat.tickTimers(new Date(Date.now() + tick * 60_000));
    }
    const comment = await request(app(f.companyId)).post(`/api/issues/${f.carrierId}/comments`).send({ body: "Unrelated update" });
    expect(comment.status).toBe(409); // existing manual-pause admission remains authoritative
    const changedIdentity = await issueRecoveryActionService(db).upsertSourceScoped({ companyId: f.companyId, sourceIssueId: f.sourceId,
      cause: "new-failure", fingerprint: "new-fingerprint", kind: "blocked_without_blockers", nextAction: "Retry", supersedeOnIdentityChange: true });
    expect(changedIdentity.id).toBe(f.actionId);
    expect(await snapshot(f)).toEqual(before);
    const genericRelease = await request(app(f.companyId)).post(`/api/issues/${f.carrierId}/tree-holds/${response.body.hold.id}/release`)
      .send({ metadata: { wakeAgents: true } });
    expect(genericRelease.status).toBe(409);
    const release = await request(app(f.companyId)).post(`/api/issues/${f.carrierId}/recovery-carrier-park/${response.body.hold.id}/release`)
      .send({ recoveryActionId: f.actionId, reason: "Board releases this disposition; no repair authorized" });
    expect(release.status).toBe(200);
    expect(release.body.status).toBe("released");
    const repeat = await request(app(f.companyId)).post(`/api/issues/${f.carrierId}/recovery-carrier-park/${response.body.hold.id}/release`)
      .send({ recoveryActionId: f.actionId, reason: "Board releases this disposition; no repair authorized" });
    expect(repeat.status).toBe(200);
    expect(await snapshot(f)).toEqual(before);
    await assertNoProtectedWrites();
    expect(await attention(f)).toMatchObject({ state: "needs_attention" });
  }, 30_000);

  it("keeps ordinary all-done re-block rejected even with a descriptor", async () => {
    const f = await fixture();
    const response = await request(app(f.companyId)).patch(`/api/issues/${f.carrierId}`).send({ status: "blocked", blockedByIssueIds: [f.blockerId], unblockDescriptor: { owner: "board", action: "Review" } });
    expect(response.status).toBe(422);
    expect(response.body.details.reason).toBe("blocked_on_resolved_blockers");
  });
});
