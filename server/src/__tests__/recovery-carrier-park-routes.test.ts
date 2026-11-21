import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agentWakeupRequests, agents, companies, companyMemberships, completionContracts, createDb, heartbeatRuns,
  issueComments, issueRecoveryActions, issueRelations, issues, issueThreadInteractions, issueTreeHolds,
  nativeRunFinalizations, nativeRunResults, workAssessments, type Db, type EmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { parkRecoveryCarrierSchema } from "@paperclipai/shared";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueTreeControlRoutes } from "../routes/issue-tree-control.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { recoveryCarrierParkService } from "../services/recovery-carrier-park.js";
import { recoveryService } from "../services/recovery/service.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { truncateWithLockRetry } from "./helpers/truncate-with-lock-retry.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { commitNativeStatusDecision } from "../services/native-runtime/status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "../services/native-runtime/status-arbiter.js";

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

  async function fixture(existingCompanyId?: string): Promise<Fixture> {
    const companyId = existingCompanyId ?? randomUUID(), sourceId = randomUUID(), carrierId = randomUUID();
    const blockerId = randomUUID(), actionId = randomUUID(), decisionId = randomUUID(), agentId = randomUUID();
    if (!existingCompanyId) {
      await db.insert(companies).values({ id: companyId, name: "Park fixture", issuePrefix: `P${companyId.slice(0, 6)}` });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "park-operator", status: "active", membershipRole: "operator" });
    }
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

  async function parkRecords(f: Fixture) {
    return {
      holds: await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId, f.companyId)).orderBy(issueTreeHolds.id),
      audit: await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId)).orderBy(activityLog.id),
    };
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

  async function blockParkAdmission(f: Fixture) {
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
    try {
      const parkPid = await waitForBlockedPid(blockerPid);
      return { parkPid, acceptance, barrier, releaseBarrier };
    } catch (error) {
      releaseBarrier();
      await Promise.allSettled([barrier, acceptance]);
      throw error;
    }
  }

  async function protectWakeAdmission(f: Fixture) {
    const suffix = f.actionId.replaceAll("-", ""), counter = `park_wake_attempts_${suffix}`;
    await db.execute(sql.raw(`create sequence ${counter}`));
    await db.execute(sql`create or replace function reject_park_wake_insert() returns trigger language plpgsql as $$
      begin perform nextval(TG_ARGV[0]); raise exception 'parked carrier wake admitted'; end $$`);
    for (const table of ["agent_wakeup_requests", "heartbeat_runs"]) {
      await db.execute(sql.raw(`create trigger protect_${table}_${suffix} before insert on ${table}
        for each row when (new.company_id = '${f.companyId}') execute function reject_park_wake_insert('${counter}')`));
    }
    return async () => expect((await db.execute(sql.raw(`select is_called from ${counter}`)))[0].is_called).toBe(false);
  }

  async function deferredInteraction(f: Fixture) {
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId, companyId: f.companyId, issueId: f.carrierId,
      authorUserId: "park-operator", body: "Previously admitted board input",
    });
    const [finished] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      invocationSource: "assignment", contextSnapshot: { issueId: f.carrierId },
      finishedAt: new Date(),
    }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId: f.companyId, agentId: f.agentId, source: "automation",
      reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "park-operator",
      payload: { issueId: f.carrierId, commentId,
        _paperclipWakeContext: { issueId: f.carrierId, wakeReason: "issue_commented",
          source: "issue.comment", wakeCommentId: commentId } },
    }).returning();
    return { finished: finished!, wake: wake! };
  }

  it("rejects park admission while a verified carrier interaction is deferred", async () => {
    const f = await fixture();
    await db.update(issues).set({ assigneeAgentId: f.agentId, assigneeUserId: null }).where(eq(issues.id, f.carrierId));
    f.body.expectedAssigneeAgentId = f.agentId;
    f.body.expectedAssigneeUserId = null;
    await deferredInteraction(f);
    const before = await snapshot(f);
    const assertNoProtectedWrites = await protectSourceRows(f);

    expect((await park(f)).status).toBe(409);
    expect(await snapshot(f)).toEqual(before);
    expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId, f.companyId))).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toEqual([]);
    await assertNoProtectedWrites();
  });

  it("never promotes a previously deferred verified interaction through an active carrier park", async () => {
    const f = await fixture();
    await db.update(issues).set({ assigneeAgentId: f.agentId, assigneeUserId: null }).where(eq(issues.id, f.carrierId));
    f.body.expectedAssigneeAgentId = f.agentId;
    f.body.expectedAssigneeUserId = null;
    const parked = await park(f);
    expect(parked.status).toBe(201);
    // Simulate an already-admitted legacy queue; promotion must independently fence it.
    const { finished, wake } = await deferredInteraction(f);
    const before = await snapshot(f);
    const assertNoProtectedWrites = await protectSourceRows(f);
    const counter = `park_run_attempts_${f.actionId.replaceAll("-", "")}`;
    await db.execute(sql.raw(`create sequence ${counter}`));
    await db.execute(sql`create or replace function reject_park_run_insert() returns trigger language plpgsql as $$ begin perform nextval(TG_ARGV[0]); raise exception 'parked carrier run admitted'; end $$`);
    await db.execute(sql.raw(`create trigger protect_park_run_${f.actionId.replaceAll("-", "")} before insert on heartbeat_runs for each row when (new.company_id = '${f.companyId}') execute function reject_park_run_insert('${counter}')`));

    await heartbeatService(db).releaseIssueExecutionAndPromote(finished, { suppressImmediateRecovery: true });

    expect((await db.execute(sql.raw(`select is_called from ${counter}`)))[0].is_called).toBe(false);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toEqual([finished]);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id)))[0]).toMatchObject({
      status: "cancelled", runId: null,
    });
    expect(await db.select().from(issues).where(eq(issues.id, f.sourceId))).toEqual(before.source);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toEqual(before.actions);
    expect((await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.id, parked.body.hold.id)))[0]).toMatchObject({
      status: "active", recoveryCarrierPark: { recoveryActionId: f.actionId },
    });
    await assertNoProtectedWrites();
  });

  it.each(["park", "release"] as const)("enforces board authority at the direct %s service boundary", async operation => {
    const f = await fixture(), service = recoveryCarrierParkService(db);
    let holdId = "";
    if (operation === "release") {
      const response = await park(f);
      expect(response.status).toBe(201);
      holdId = response.body.hold.id;
    }
    const before = await snapshot(f), records = await parkRecords(f);
    const actor = { actorType: "agent" as const, actorId: f.agentId, boardApiKeyId: null, runId: null };
    const result = operation === "park"
      ? service.park(f.companyId, f.carrierId, parkRecoveryCarrierSchema.parse(f.body), actor)
      : service.release(f.companyId, f.carrierId, holdId, { recoveryActionId: f.actionId, reason: "Agent cannot release" }, actor);
    await expect(result).rejects.toMatchObject({ status: 403 });
    expect(await snapshot(f)).toEqual(before);
    expect(await parkRecords(f)).toEqual(records);
  });

  it("keeps the direct park service carrier lookup company-scoped", async () => {
    const f = await fixture(), other = await fixture();
    const before = await snapshot(f), otherBefore = await snapshot(other);
    await expect(recoveryCarrierParkService(db).park(other.companyId, f.carrierId,
      parkRecoveryCarrierSchema.parse(other.body),
      { actorType: "user", actorId: "park-operator", boardApiKeyId: null, runId: null },
    )).rejects.toMatchObject({ status: 404 });
    expect(await snapshot(f)).toEqual(before);
    expect(await snapshot(other)).toEqual(otherBefore);
    expect(await parkRecords(f)).toEqual({ holds: [], audit: [] });
    expect(await parkRecords(other)).toEqual({ holds: [], audit: [] });
  });

  it.each(["source monitor", "child monitor", "child checkout", "child execution"] as const)(
    "refuses %s without a live run or wake row", async shape => {
      const f = await fixture();
      if (shape === "source monitor") {
        await db.update(issues).set({ monitorNextCheckAt: new Date(Date.now() + 60_000) }).where(eq(issues.id, f.sourceId));
      } else {
        const childId = randomUUID();
        await db.insert(issues).values({ id: childId, companyId: f.companyId, parentId: f.carrierId,
          title: "Paused descendant", status: "blocked", assigneeUserId: "park-operator" });
        if (shape === "child monitor") {
          await db.update(issues).set({ monitorNextCheckAt: new Date(Date.now() + 60_000) }).where(eq(issues.id, childId));
        } else {
          const [terminal] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
            status: "succeeded", contextSnapshot: { issueId: childId } }).returning();
          await db.update(issues).set(shape === "child checkout"
            ? { checkoutRunId: terminal!.id } : { executionRunId: terminal!.id }).where(eq(issues.id, childId));
        }
      }
      const before = await snapshot(f);
      expect((await park(f)).status).toBe(409);
      expect(await snapshot(f)).toEqual(before);
      expect(await parkRecords(f)).toEqual({ holds: [], audit: [] });
    },
  );

  it.each(["ordinary pause", "different acceptance"])("does not convert an existing %s into new consent", async kind => {
    const f = await fixture();
    const existing = kind === "ordinary pause"
      ? await request(app(f.companyId)).post(`/api/issues/${f.carrierId}/tree-holds`).send({ mode: "pause", reason: "Existing ordinary pause" })
      : await park(f);
    expect(existing.status).toBe(201);
    const before = await snapshot(f), records = await parkRecords(f);
    expect((await park(f, { ...f.body, reason: "A different board disposition" })).status).toBe(409);
    expect(await snapshot(f)).toEqual(before);
    expect(await parkRecords(f)).toEqual(records);
  });

  it("rejects a typed release with a different action identity atomically", async () => {
    const f = await fixture(), response = await park(f);
    expect(response.status).toBe(201);
    const before = await snapshot(f), records = await parkRecords(f);
    const rejected = await request(app(f.companyId)).post(`/api/issues/${f.carrierId}/recovery-carrier-park/${response.body.hold.id}/release`)
      .send({ recoveryActionId: randomUUID(), reason: "Wrong action must not release" });
    expect(rejected.status).toBe(409);
    expect(await snapshot(f)).toEqual(before);
    expect(await parkRecords(f)).toEqual(records);
  });

  it("surfaces action timestamp drift without granting a run or retiring the hold", async () => {
    const f = await fixture(), response = await park(f);
    expect(response.status).toBe(201);
    // Fixture-only independent drift; the park/release implementation never writes this row.
    await db.update(issueRecoveryActions).set({ updatedAt: new Date("2026-01-02T00:00:00Z") }).where(eq(issueRecoveryActions.id, f.actionId));
    expect(await attention(f)).toMatchObject({ state: "needs_attention", unresolvedBlockerCount: 0,
      blockingTreeLive: false, carrierPark: { state: "stale", holdId: response.body.hold.id } });
    expect((await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.id, response.body.hold.id)))[0].status).toBe("active");
    expect(await heartbeatService(db).wakeup(f.agentId, { source: "automation", reason: "issue_comment_added",
      payload: { issueId: f.carrierId } })).toBeNull();
  });

  it("refuses the server-side subtree resume operation while a typed park is active", async () => {
    const f = await fixture();
    expect((await park(f)).status).toBe(201);
    const before = await snapshot(f), records = await parkRecords(f);
    const resume = await request(app(f.companyId)).post(`/api/issues/${f.carrierId}/tree-holds`)
      .send({ mode: "resume", metadata: { wakeAgents: true } });
    expect(resume.status).toBe(409);
    expect(await snapshot(f)).toEqual(before);
    expect(await parkRecords(f)).toEqual(records);
  });

  it("keeps a bare-source deferred queue outside the carrier execution scope", async () => {
    const f = await fixture();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", status: "deferred_issue_execution", payload: { issueId: f.sourceId } });
    const before = await snapshot(f);
    expect((await park(f)).status).toBe(201);
    expect(await snapshot(f)).toEqual(before);
  });

  it("suppresses an action-only wake without relying on a carrier issue id", async () => {
    const f = await fixture();
    expect((await park(f)).status).toBe(201);
    const before = await snapshot(f);
    const assertNoProtectedWrites = await protectSourceRows(f);
    const assertNoAdmission = await protectWakeAdmission(f);
    expect(await heartbeatService(db).wakeup(f.agentId, { source: "automation", reason: "recovery",
      payload: { recoveryActionId: f.actionId } })).toBeNull();
    expect(await snapshot(f)).toEqual(before);
    await assertNoAdmission();
    await assertNoProtectedWrites();
  });

  it("allows independent board resolution after release while another park remains protected", async () => {
    const f = await fixture(), control = await fixture(f.companyId);
    const protectedSource = await db.select().from(issues).where(eq(issues.id, f.sourceId));
    const protectedAction = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    const assertNoProtectedWrites = await protectSourceRows(f);
    expect((await park(f)).status).toBe(201);
    const parkedControl = await park(control);
    expect(parkedControl.status).toBe(201);
    const released = await request(app(control.companyId))
      .post(`/api/issues/${control.carrierId}/recovery-carrier-park/${parkedControl.body.hold.id}/release`)
      .send({ recoveryActionId: control.actionId, reason: "Release control before independent board resolution" });
    expect(released.status).toBe(200);
    const actions = issueRecoveryActionService(db);
    // Independent authority applies only to the released control, never the protected action.
    expect(await actions.resolveActiveForIssue({ companyId: control.companyId, sourceIssueId: control.sourceId,
      actionId: control.actionId, status: "resolved", outcome: "restored", boardResolution: true,
    })).toMatchObject({ id: control.actionId, status: "resolved", outcome: "restored" });
    expect(await actions.resolveActiveForIssue({ companyId: f.companyId, sourceIssueId: f.sourceId,
      actionId: f.actionId, status: "resolved", outcome: "restored", boardResolution: true,
    })).toBeNull();
    expect(await db.select().from(issues).where(eq(issues.id, f.sourceId))).toEqual(protectedSource);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId))).toEqual(protectedAction);
    await assertNoProtectedWrites();
  });

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
    await db.insert(issues).values({ id: dependentId, companyId: f.companyId, title: "Other dependent work", status: "blocked", assigneeUserId: "park-operator" });
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.sourceId, relatedIssueId: dependentId, type: "blocks" });
    const before = await snapshot(f);
    const assertNoProtectedWrites = await protectSourceRows(f);
    const { parkPid, acceptance, barrier, releaseBarrier } = await blockParkAdmission(f);
    const wakes: string[] = [];
    const recovery = recoveryService(db, { enqueueWakeup: async agentId => { wakes.push(agentId); return null; } });
    let sweep: ReturnType<typeof recovery.reconcileStrandedAssignedIssues> | undefined;
    try {
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

  it("serializes board resolution behind park admission's source lock", async () => {
    const f = await fixture(), before = await snapshot(f);
    const assertNoProtectedWrites = await protectSourceRows(f);
    const { parkPid, acceptance, barrier, releaseBarrier } = await blockParkAdmission(f);
    const actions = issueRecoveryActionService(db);
    let resolution: ReturnType<typeof actions.resolveActiveForIssue> | undefined;
    try {
      resolution = actions.resolveActiveForIssue({ companyId: f.companyId, sourceIssueId: f.sourceId,
        actionId: f.actionId, status: "resolved", outcome: "restored", boardResolution: true });
      await waitForBlockedPid(parkPid);
    } finally {
      releaseBarrier();
      await Promise.all([barrier, acceptance, resolution]);
    }
    expect((await acceptance).status).toBe(201);
    expect(await resolution).toBeNull();
    expect(await snapshot(f)).toEqual(before);
    await assertNoProtectedWrites();
  }, 30_000);

  it("rechecks carrier parking after a wake passes the early read but waits on the issue lock", async () => {
    const f = await fixture();
    await db.update(issues).set({ assigneeAgentId: f.agentId, assigneeUserId: null }).where(eq(issues.id, f.carrierId));
    f.body.expectedAssigneeAgentId = f.agentId;
    f.body.expectedAssigneeUserId = null;
    const before = await snapshot(f);
    const assertNoProtectedWrites = await protectSourceRows(f);
    const assertNoAdmission = await protectWakeAdmission(f);
    const { parkPid, acceptance, barrier, releaseBarrier } = await blockParkAdmission(f);
    const heartbeat = heartbeatService(db);
    let wake: ReturnType<typeof heartbeat.wakeup> | undefined;
    try {
      wake = heartbeat.wakeup(f.agentId, { source: "automation", reason: "issue_assigned", payload: { issueId: f.carrierId } });
      await waitForBlockedPid(parkPid);
    } finally {
      releaseBarrier();
      await Promise.all([barrier, acceptance, wake]);
    }
    expect((await acceptance).status).toBe(201);
    expect(await wake).toBeNull();
    expect(await snapshot(f)).toEqual(before);
    await assertNoAdmission();
    await assertNoProtectedWrites();
  }, 30_000);

  it("keeps automatic stale-lock cleanup from rewriting a parked action's source", async () => {
    const f = await fixture();
    const [terminal] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "succeeded", contextSnapshot: { issueId: f.sourceId } }).returning();
    await db.update(issues).set({ executionRunId: terminal!.id }).where(eq(issues.id, f.sourceId));
    const before = await snapshot(f);
    const assertNoProtectedWrites = await protectSourceRows(f);
    expect((await park(f)).status).toBe(201);
    await recoveryService(db, { enqueueWakeup: async () => { throw new Error("Park must not wake"); } }).sweepStaleIssueLocks();
    expect(await snapshot(f)).toEqual(before);
    await assertNoProtectedWrites();
  });

  it("rechecks monitor re-arm after a park commits while the exhaustion drain waits for the source lock", async () => {
    const f = await fixture();
    await db.update(issues).set({ assigneeAgentId: f.agentId, assigneeUserId: null }).where(eq(issues.id, f.sourceId));
    const before = await snapshot(f);
    const assertNoProtectedWrites = await protectSourceRows(f);
    const { parkPid, acceptance, barrier, releaseBarrier } = await blockParkAdmission(f);
    const recovery = recoveryService(db, { enqueueWakeup: async () => { throw new Error("Park must not wake"); } });
    let drain: ReturnType<typeof recovery.reconcileExhaustedRecoveryDrain> | undefined;
    try {
      drain = recovery.reconcileExhaustedRecoveryDrain({ companyId: f.companyId });
      await waitForBlockedPid(parkPid);
    } finally {
      releaseBarrier();
      await Promise.all([barrier, acceptance, drain]);
    }
    expect((await acceptance).status).toBe(201);
    expect(await snapshot(f)).toEqual(before);
    await assertNoProtectedWrites();
  }, 30_000);

  it("does not remint a legacy carrier hidden after park acceptance while exhaustion waits for the source", async () => {
    const f = await fixture();
    await db.update(issues).set({ status: "backlog", assigneeAgentId: f.agentId, assigneeUserId: null }).where(eq(issues.id, f.sourceId));
    const assertNoProtectedWrites = await protectSourceRows(f);
    const counter = `park_carrier_attempts_${f.actionId.replaceAll("-", "")}`;
    await db.execute(sql.raw(`create sequence ${counter}`));
    await db.execute(sql`create or replace function reject_park_carrier_insert() returns trigger language plpgsql as $$
      begin perform nextval(TG_ARGV[0]); raise exception 'parked carrier replacement admitted'; end $$`);
    await db.execute(sql.raw(`create trigger protect_park_carrier_${f.actionId.replaceAll("-", "")}
      before insert on issues for each row when (new.company_id = '${f.companyId}')
      execute function reject_park_carrier_insert('${counter}')`));
    const { parkPid, acceptance, barrier, releaseBarrier } = await blockParkAdmission(f);
    let releaseSource!: () => void;
    const sourceReleased = new Promise<void>(resolve => { releaseSource = resolve; });
    let markSourceReady!: () => void;
    const sourceReady = new Promise<void>(resolve => { markSourceReady = resolve; });
    // Queue a source handoff before the drain so a later carrier change cannot race its recheck.
    const handoff = db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.sourceId)).for("update");
      markSourceReady();
      await sourceReleased;
    });
    const recovery = recoveryService(db, { enqueueWakeup: async () => { throw new Error("Park must not wake"); } });
    let drain: ReturnType<typeof recovery.reconcileExhaustedRecoveryDrain> | undefined;
    let before: Awaited<ReturnType<typeof snapshot>> | undefined;
    try {
      const handoffPid = await waitForBlockedPid(parkPid);
      drain = recovery.reconcileExhaustedRecoveryDrain({ companyId: f.companyId });
      await waitForBlockedPid(handoffPid);
      releaseBarrier();
      await Promise.all([barrier, acceptance, sourceReady]);
      // Independent fixture drift makes acceptance stale; its manual hold must still fence remint.
      await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, f.carrierId));
      before = await snapshot(f);
    } finally {
      releaseBarrier();
      releaseSource();
      await Promise.all([barrier, acceptance, handoff, drain]);
    }
    expect((await acceptance).status).toBe(201);
    expect((await db.execute(sql.raw(`select is_called from ${counter}`)))[0].is_called).toBe(false);
    expect(await snapshot(f)).toEqual(before);
    expect((await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.id, (await acceptance).body.hold.id)))[0].status).toBe("active");
    await assertNoProtectedWrites();
  }, 45_000);

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
    expect(repeat.body).toEqual(release.body);
    expect(await db.select({ action: activityLog.action, entityId: activityLog.entityId, actorId: activityLog.actorId })
      .from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
        eq(activityLog.action, "issue.recovery_carrier_park_released")))).toEqual([
      { action: "issue.recovery_carrier_park_released", entityId: f.carrierId, actorId: "park-operator" },
    ]);
    expect(await snapshot(f)).toEqual(before);
    await assertNoProtectedWrites();
    expect(await attention(f)).toMatchObject({ state: "needs_attention" });
  }, 30_000);

  it.each(["blocked", "backlog"] as const)("keeps released %s source recovery stopped until independent board authority", async sourceStatus => {
    const f = await fixture();
    await db.update(issues).set({ status: sourceStatus, assigneeAgentId: f.agentId }).where(eq(issues.id, f.sourceId));
    // Release restores ordinary carrier attention; isolate that independent lane
    // without exempting released carriers from ordinary recovery in product code.
    const [carrier] = await db.update(issues).set({ status: "backlog" }).where(eq(issues.id, f.carrierId))
      .returning({ statusVersion: issues.statusVersion });
    f.body.expectedStatus = "backlog";
    f.body.expectedStatusVersion = carrier!.statusVersion;
    const parked = await park(f);
    expect(parked.status).toBe(201);
    expect((await request(app(f.companyId))
      .post(`/api/issues/${f.carrierId}/recovery-carrier-park/${parked.body.hold.id}/release`)
      .send({ recoveryActionId: f.actionId, reason: "Carrier release is not source repair authority" })).status).toBe(200);
    // Exercise both monitorable sources and the legacy missing-carrier successor path.
    if (sourceStatus === "backlog") await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, f.carrierId));
    const before = await snapshot(f);
    const assertNoProtectedWrites = await protectSourceRows(f);
    const assertNoAdmission = await protectWakeAdmission(f);
    for (let tick = 0; tick < 2; tick++) {
      const recovery = recoveryService(db, { enqueueWakeup: async () => { throw new Error("Released source must not wake"); } });
      await recovery.reconcileExhaustedRecoveryDrain({ companyId: f.companyId });
      await recovery.reconcileBlockedWithoutBlockers({ companyId: f.companyId });
    }
    await assertNoProtectedWrites();
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId: f.companyId, sourceIssueId: f.sourceId, cause: "different-failure", fingerprint: "different-failure",
      kind: "blocked_without_blockers", nextAction: "Automatic retry", supersedeOnIdentityChange: true,
    });
    expect(action.id).toBe(f.actionId);
    expect(await heartbeatService(db).wakeup(f.agentId, { source: "automation", reason: "recovery",
      payload: { recoveryActionId: f.actionId } })).toBeNull();
    expect(await snapshot(f)).toEqual(before);
    await assertNoProtectedWrites();
    await assertNoAdmission();
  });

  it("serializes action-only wake admission with a park that wins the carrier lock", async () => {
    const f = await fixture(), before = await snapshot(f);
    const assertNoProtectedWrites = await protectSourceRows(f);
    const assertNoAdmission = await protectWakeAdmission(f);
    const { parkPid, acceptance, barrier, releaseBarrier } = await blockParkAdmission(f);
    let settled = false;
    const wake = heartbeatService(db).wakeup(f.agentId, {
      source: "automation", reason: "recovery", payload: { recoveryActionId: f.actionId },
    }).then(run => { settled = true; return { run, error: null }; },
      error => { settled = true; return { run: null, error }; });
    try {
      // A broken queue reaches the tripwire; a correct queue waits behind admission.
      await expect.poll(async () => settled || (await db.execute(sql`select exists (
        select 1 from pg_stat_activity where datname = current_database()
        and ${parkPid} = any(pg_blocking_pids(pid))) as blocked`))[0].blocked,
      { timeout: 10_000 }).toBe(true);
    } finally {
      releaseBarrier();
      await Promise.all([barrier, acceptance, wake]);
    }
    expect((await acceptance).status).toBe(201);
    expect(await wake).toEqual({ run: null, error: null });
    expect(await snapshot(f)).toEqual(before);
    await assertNoAdmission();
    await assertNoProtectedWrites();
  }, 30_000);

  it.each(["issue_blockers_resolved", "issue_children_completed"])("does not replay a native %s intent suppressed during a park after release", async reason => {
    const f = await fixture();
    await db.update(issues).set({ assigneeAgentId: f.agentId, assigneeUserId: null }).where(eq(issues.id, f.carrierId));
    f.body.expectedAssigneeAgentId = f.agentId;
    f.body.expectedAssigneeUserId = null;
    const parked = await park(f);
    expect(parked.status).toBe(201);
    // Persist the real native committer outbox shape; dispatch uses the actual scheduler.
    const [intent] = await db.insert(agentWakeupRequests).values({
      companyId: f.companyId, agentId: f.agentId, source: "automation", triggerDetail: "system", reason,
      requestedByActorType: "system", requestedByActorId: "native-status-committer",
      idempotencyKey: `native-park:${randomUUID()}`, status: "queued",
      payload: { issueId: f.carrierId, taskId: f.carrierId, _paperclipWakeContext: {
        issueId: f.carrierId, taskId: f.carrierId, wakeReason: reason,
        source: "native_status_decision", statusDecisionSource: "native_status_decision",
      } },
    }).returning();
    const before = await snapshot(f);
    const assertNoProtectedWrites = await protectSourceRows(f);
    const assertNoAdmission = await protectWakeAdmission(f);
    await heartbeatService(db).dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    const [suppressed] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, intent!.id));
    expect((await request(app(f.companyId))
      .post(`/api/issues/${f.carrierId}/recovery-carrier-park/${parked.body.hold.id}/release`)
      .send({ recoveryActionId: f.actionId, reason: "Release must not replay suppressed native work" })).status).toBe(200);
    await heartbeatService(db).dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    const after = await snapshot(f);
    expect(suppressed.status).toBe("skipped");
    expect(suppressed.finishedAt).not.toBeNull();
    expect(after.wakes).toEqual([suppressed]);
    expect(after.source).toEqual(before.source);
    expect(after.actions).toEqual(before.actions);
    expect(after.cards).toEqual(before.cards);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toEqual([]);
    await assertNoAdmission();
    await assertNoProtectedWrites();
  });

  it.each(["dependency", "child"] as const)("persists native %s suppression before dispatch so release cannot revive it", async shape => {
    const f = await fixture(), completedIssueId = randomUUID(), runId = randomUUID(), contractId = randomUUID();
    const resultId = randomUUID(), assessmentId = randomUUID();
    await db.update(issues).set({ assigneeAgentId: f.agentId, assigneeUserId: null }).where(eq(issues.id, f.carrierId));
    f.body.expectedAssigneeAgentId = f.agentId;
    f.body.expectedAssigneeUserId = null;
    await db.insert(issues).values({ id: completedIssueId, companyId: f.companyId, title: "Late native finalization",
      status: "in_progress", assigneeAgentId: f.agentId, deliveryRequirement: "record_only",
      parentId: shape === "child" ? f.carrierId : null });
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: completedIssueId,
      revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "phase6-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "park-native", criteria: [] }, canonicalSha256: contractId,
      createdByActorType: "system", createdByActorId: "park-test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      status: "succeeded", runtimeMode: "native", nativeIssueId: completedIssueId,
      runtimeModeResolvedAt: new Date(), completionContractId: contractId, completionContractSha256: contractId,
      contextSnapshot: { issueId: completedIssueId } });
    await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: completedIssueId, runId,
      completionContractId: contractId, serverFingerprint: resultId, schemaStatus: "accepted",
      resultJson: { result: { summary: "Already assessed completed work" } }, canonicalSha256: resultId });
    await db.insert(workAssessments).values({ id: assessmentId, companyId: f.companyId, issueId: completedIssueId,
      runId, contractId, resultId, triggerKind: "native_result", triggerActorCompanyId: f.companyId,
      priorIssueStatus: "in_progress", priorStatusVersion: 0, policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      assessmentJson: {}, inputDigest: assessmentId });
    await db.insert(nativeRunFinalizations).values({ runId, companyId: f.companyId, issueId: completedIssueId,
      phase: "assessing", resultId, assessmentId });
    const parked = await park(f);
    expect(parked.status).toBe(201);
    if (shape === "dependency") await db.insert(issueRelations).values({
      companyId: f.companyId, issueId: completedIssueId, relatedIssueId: f.carrierId, type: "blocks",
    });
    const before = await snapshot(f), assertNoProtectedWrites = await protectSourceRows(f);
    await commitNativeStatusDecision({ db, companyId: f.companyId, issueId: completedIssueId, runId, assessmentId,
      priorStatus: "in_progress", priorStatusVersion: 0, priorDecisionId: null,
      decision: { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "done", toStatus: "done",
        reasonCode: "completion_contract_satisfied", unblockDescriptor: null, effects: [{ kind: "release_checkout" }] } });
    const [intent] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(intent).toMatchObject({ reason: shape === "child" ? "issue_children_completed" : "issue_blockers_resolved",
      status: "skipped", runId: null });
    expect(intent.finishedAt).not.toBeNull();
    const assertNoAdmission = await protectWakeAdmission(f);
    expect((await request(app(f.companyId))
      .post(`/api/issues/${f.carrierId}/recovery-carrier-park/${parked.body.hold.id}/release`)
      .send({ recoveryActionId: f.actionId, reason: "Do not dispatch work suppressed before release" })).status).toBe(200);
    await heartbeatService(db).dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    const after = await snapshot(f);
    expect(after.source).toEqual(before.source);
    expect(after.actions).toEqual(before.actions);
    expect(after.wakes).toEqual([intent]);
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)))
      .toEqual([{ id: runId }]);
    await assertNoAdmission();
    await assertNoProtectedWrites();
  });

  it("keeps ordinary all-done re-block rejected even with a descriptor", async () => {
    const f = await fixture();
    const response = await request(app(f.companyId)).patch(`/api/issues/${f.carrierId}`).send({ status: "blocked", blockedByIssueIds: [f.blockerId], unblockDescriptor: { owner: "board", action: "Review" } });
    expect(response.status).toBe(422);
    expect(response.body.details.reason).toBe("blocked_on_resolved_blockers");
  });
});
