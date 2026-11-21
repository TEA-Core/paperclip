import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";

interface Fixture {
  companyId: string; sourceId: string; carrierId: string; blockerId: string;
  actionId: string; decisionId: string; agentId: string;
  body: {
    sourceIssueId: string; recoveryActionId: string; decisionInteractionId: string;
    expectedStatus: string; expectedStatusVersion: number;
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
        expectedActionUpdatedAt: old.toISOString(), expectedDecisionUpdatedAt: old.toISOString(),
        expectedBlockers: [{ id: blockerId, status: "done", statusVersion: 0 }],
        reason: "Intentionally unresolved; manual board release only" } };
  }
  const park = (f: Fixture, body = f.body, client = app(f.companyId)) => request(client).post(`/api/issues/${f.carrierId}/recovery-carrier-park`).send(body);
  async function snapshot(f: Fixture) {
    return {
      source: await db.select().from(issues).where(eq(issues.id, f.sourceId)),
      actions: await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId)),
      cards: await db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, f.companyId)),
      wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)),
    };
  }
  async function attention(f: Fixture) {
    const response = await request(app(f.companyId)).get(`/api/issues/${f.carrierId}`);
    expect(response.status).toBe(200);
    return response.body.blockerAttention;
  }

  it("accepts an exact board park without a source/action write or fake liveness, and repeats idempotently", async () => {
    const f = await fixture(), before = await snapshot(f);
    // Even an UPDATE that restores the same values is forbidden. The trigger is
    // company-fixture scoped and disappears with this dedicated database.
    await db.execute(sql`create or replace function reject_park_source_write() returns trigger language plpgsql as $$ begin raise exception 'protected park row written'; end $$`);
    await db.execute(sql.raw(`create trigger protect_action_${f.actionId.replaceAll("-", "")} before update or delete on issue_recovery_actions for each row when (old.id = '${f.actionId}') execute function reject_park_source_write()`));
    await db.execute(sql.raw(`create trigger protect_source_${f.sourceId.replaceAll("-", "")} before update or delete on issues for each row when (old.id = '${f.sourceId}') execute function reject_park_source_write()`));
    const response = await park(f);
    expect(response.status).toBe(201);
    expect(response.body.hold).toMatchObject({ mode: "pause", status: "active", releasePolicy: { strategy: "manual" }, recoveryCarrierPark: { recoveryActionId: f.actionId, sourceIssueId: f.sourceId, decisionInteractionId: f.decisionId } });
    const repeated = await park(f);
    expect(repeated.status).toBe(200);
    expect(repeated.body.hold.id).toBe(response.body.hold.id);
    expect(await snapshot(f)).toEqual(before);
    expect(await attention(f)).toMatchObject({ state: "none", unresolvedBlockerCount: 0, blockingTreeLive: false, carrierPark: { state: "accepted", recoveryActionId: f.actionId } });
    const receipts = await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId));
    expect(receipts.filter(row => row.action === "issue.recovery_carrier_parked")).toHaveLength(1);
  });

  it("does not infer acceptance from exhaustion or a rejected decision", async () => {
    const f = await fixture();
    expect(await attention(f)).toMatchObject({ state: "needs_attention" });
    expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId, f.companyId))).toEqual([]);
  });

  it.each(["agent", "cross-company", "decision", "action", "run", "queued", "blocker", "owner"])("rejects %s without partial state", async mode => {
    const f = await fixture();
    let body = f.body, client = app(f.companyId);
    if (mode === "agent") client = app(f.companyId, f.agentId);
    if (mode === "cross-company") client = app(randomUUID());
    if (mode === "decision") body = { ...body, expectedDecisionUpdatedAt: new Date(0).toISOString() };
    if (mode === "action") body = { ...body, recoveryActionId: randomUUID() };
    if (mode === "blocker") body = { ...body, expectedBlockers: [] };
    if (mode === "owner") await db.update(issues).set({ assigneeAgentId: f.agentId, assigneeUserId: null, statusVersion: 1 }).where(eq(issues.id, f.carrierId));
    if (mode === "run") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: f.carrierId } });
    if (mode === "queued") await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "assignment", status: "queued", payload: { issueId: f.carrierId } });
    const before = await snapshot(f);
    const response = await park(f, body, client);
    expect(response.status).toBe(mode === "agent" || mode === "cross-company" ? 403 : 409);
    expect(await snapshot(f)).toEqual(before);
    expect(await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.companyId, f.companyId))).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.companyId))).toEqual([]);
  });

  it("survives sweeps, ticks, comments and service restart without successors, then releases without source repair", async () => {
    const f = await fixture();
    const response = await park(f);
    expect(response.status).toBe(201);
    const before = await snapshot(f);
    for (let tick = 0; tick < 3; tick++) {
      const recovery = recoveryService(db, { enqueueWakeup: async () => { throw new Error("Park must not wake"); } }); // restart: no in-memory acceptance
      await recovery.reconcileBlockedWithoutBlockers();
      await recovery.reconcileExhaustedRecoveryDrain({ companyId: f.companyId });
      await recovery.reconcileStaleRecoveryActionWakes();
      await recovery.reconcileStrandedAssignedIssues();
    }
    const comment = await request(app(f.companyId)).post(`/api/issues/${f.carrierId}/comments`).send({ body: "Unrelated update" });
    expect(comment.status).toBe(409); // existing manual-pause admission remains authoritative
    const changedIdentity = await issueRecoveryActionService(db).upsertSourceScoped({ companyId: f.companyId, sourceIssueId: f.sourceId,
      cause: "new-failure", fingerprint: "new-fingerprint", kind: "blocked_without_blockers", nextAction: "Retry", supersedeOnIdentityChange: true });
    expect(changedIdentity.id).toBe(f.actionId);
    expect(await snapshot(f)).toEqual(before);
    const release = await request(app(f.companyId)).post(`/api/issues/${f.carrierId}/recovery-carrier-park/${response.body.hold.id}/release`)
      .send({ recoveryActionId: f.actionId, reason: "Board releases this disposition; no repair authorized" });
    expect(release.status).toBe(200);
    expect(release.body.status).toBe("released");
    const repeat = await request(app(f.companyId)).post(`/api/issues/${f.carrierId}/recovery-carrier-park/${response.body.hold.id}/release`)
      .send({ recoveryActionId: f.actionId, reason: "Board releases this disposition; no repair authorized" });
    expect(repeat.status).toBe(200);
    expect(await snapshot(f)).toEqual(before);
    expect(await attention(f)).toMatchObject({ state: "needs_attention" });
  }, 30_000);

  it("keeps ordinary all-done re-block rejected even with a descriptor", async () => {
    const f = await fixture();
    const response = await request(app(f.companyId)).patch(`/api/issues/${f.carrierId}`).send({ status: "blocked", blockedByIssueIds: [f.blockerId], unblockDescriptor: { owner: "board", action: "Review" } });
    expect(response.status).toBe(422);
    expect(response.body.details.reason).toBe("blocked_on_resolved_blockers");
  });
});
