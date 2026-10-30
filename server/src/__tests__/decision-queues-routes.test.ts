import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  budgetIncidents,
  budgetPolicies,
  companies,
  createDb,
  decisionQueueItems,
  decisionQueues,
  decisionTriage,
  decisionTriageEvents,
  decisions,
  heartbeatRuns,
  invites,
  issueApprovals,
  issueRecoveryActions,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
  joinRequests,
  projects,
} from "@paperclipai/db";
import { ATTENTION_SOURCE_KINDS, type AttentionItem, type AttentionSourceKind } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { decisionQueueRoutes } from "../routes/decision-queues.js";
import type { AuthorizationActor } from "../services/authorization.js";
import { canReadDecisionSource, decisionQueueService } from "../services/decision-queues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres decision queue tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("decision queue routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-queues-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(decisionTriageEvents);
    await db.delete(decisionQueueItems);
    await db.delete(decisionTriage);
    await db.delete(decisionQueues);
    await db.delete(issueApprovals);
    await db.delete(issueRecoveryActions);
    await db.delete(decisions);
    await db.delete(budgetIncidents);
    await db.delete(budgetPolicies);
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issueWorkProducts);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const interactionId = randomUUID();
    const approvalId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Decision Queue Co",
      issuePrefix: "DQC",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Prioritizer",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "DQC-1",
      title: "Review the rollout",
      status: "in_review",
      assigneeAgentId: agentId,
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      payload: { version: 1, questions: [] } as never,
    });
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: {},
    });
    return { companyId, agentId, issueId, interactionId, approvalId };
  }

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", decisionQueueRoutes(db));
    testApp.use(errorHandler);
    return testApp;
  }

  function boardActor(companyId: string, userId = "board-user"): AuthorizationActor {
    return {
      type: "board",
      source: "local_implicit",
      userId,
      companyIds: [companyId],
      isInstanceAdmin: false,
    };
  }

  function agentActor(companyId: string, agentId: string, runId: string | null = null): AuthorizationActor {
    return {
      type: "agent",
      source: "agent_key",
      companyId,
      agentId,
      keyId: null,
      keyScope: { kind: "standard" },
      runId,
    };
  }

  function agentJwtActor(companyId: string, agentId: string, runId: string): AuthorizationActor {
    return {
      ...agentActor(companyId, agentId, runId),
      source: "agent_jwt",
    };
  }

  it("creates idempotently, patches, lists by updated time, and audits queue mutations", async () => {
    const { companyId } = await seed();
    const board = boardActor(companyId);
    const first = await request(app(board)).post(`/api/companies/${companyId}/decision-queues`).send({
      key: "launches",
      title: "Launches",
      description: "Ship decisions",
    }).expect(201);
    const repeated = await request(app(board)).post(`/api/companies/${companyId}/decision-queues`).send({
      key: "launches",
      title: "Ignored duplicate title",
    }).expect(200);

    expect(repeated.body.id).toBe(first.body.id);
    expect(repeated.body.title).toBe("Launches");
    expect(repeated.body.itemCount).toBe(0);

    const patched = await request(app(board))
      .patch(`/api/companies/${companyId}/decision-queues/launches`)
      .send({ title: "Launch desk", retentionDays: 45 })
      .expect(200);
    expect(patched.body).toMatchObject({ title: "Launch desk", retentionDays: 45 });

    await request(app(board)).post(`/api/companies/${companyId}/decision-queues`).send({
      key: "older",
      title: "Older",
    }).expect(201);
    const listed = await request(app(board)).get(`/api/companies/${companyId}/decision-queues`).expect(200);
    expect(listed.body.map((queue: { key: string }) => queue.key)).toEqual(["older", "launches"]);
    const seedRules = await request(app(board))
      .get(`/api/companies/${companyId}/decision-queue-seed-rules`)
      .expect(200);
    expect(seedRules.body.map((seed: { key: string }) => seed.key)).toEqual(["prs", "plans", "questions"]);

    const events = await db.select().from(decisionTriageEvents)
      .where(eq(decisionTriageEvents.queueId, first.body.id));
    expect(events.map((event) => event.action)).toEqual(["queue.created", "queue.updated"]);
    expect(events.every((event) => event.actorUserId === "board-user")).toBe(true);
  });

  it("adds and removes three attention source kinds and hides board-only membership from agents", async () => {
    const { companyId, agentId, issueId, interactionId, approvalId } = await seed();
    const board = boardActor(companyId);
    await request(app(board)).post(`/api/companies/${companyId}/decision-queues`).send({
      key: "triage",
      title: "Triage",
    }).expect(201);

    for (const source of [
      { sourceKind: "approval", sourceId: approvalId },
      { sourceKind: "issue_thread_interaction", sourceId: interactionId },
      { sourceKind: "review", sourceId: issueId },
    ]) {
      await request(app(board))
        .post(`/api/companies/${companyId}/decision-queues/triage/items`)
        .send(source)
        .expect(201);
    }

    const items = await request(app(board))
      .get(`/api/companies/${companyId}/decision-queues/triage/items`)
      .expect(200);
    expect(items.body).toHaveLength(3);
    const repeated = await request(app(board)).post(`/api/companies/${companyId}/decision-queues`).send({
      key: "triage",
      title: "Ignored duplicate title",
    }).expect(200);
    expect(repeated.body.itemCount).toBe(3);

    const agentList = await request(app(agentActor(companyId, agentId)))
      .get(`/api/companies/${companyId}/decision-queues`)
      .expect(200);
    expect(agentList.body[0].itemCount).toBe(2);
    const agentItems = await request(app(agentActor(companyId, agentId)))
      .get(`/api/companies/${companyId}/decision-queues/triage/items`)
      .expect(200);
    expect(agentItems.body.map((item: { sourceKind: string }) => item.sourceKind).sort()).toEqual([
      "issue_thread_interaction",
      "review",
    ]);
    await request(app(agentActor(companyId, agentId)))
      .delete(`/api/companies/${companyId}/decision-queues/triage/items/approval/${approvalId}`)
      .expect(404);

    await request(app(board))
      .delete(`/api/companies/${companyId}/decision-queues/triage/items/review/${issueId}`)
      .send({ reason: "Handled in the release review" })
      .expect(200);
    expect(await db.select().from(decisionQueueItems).where(and(
      eq(decisionQueueItems.companyId, companyId),
      eq(decisionQueueItems.sourceKind, "review"),
    ))).toHaveLength(0);
    const removalAudit = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.action, "decision_queue_item.removed"),
    )).then((rows) => rows[0]);
    expect(removalAudit?.details).toMatchObject({
      sourceKind: "review",
      sourceId: issueId,
      reason: "Handled in the release review",
    });
    const removalEvent = await db.select().from(decisionTriageEvents).where(and(
      eq(decisionTriageEvents.companyId, companyId),
      eq(decisionTriageEvents.sourceKind, "review"),
      eq(decisionTriageEvents.sourceId, issueId),
      eq(decisionTriageEvents.action, "queue_item.removed"),
    )).then((rows) => rows[0]);
    expect(removalEvent?.details).toEqual({ reason: "Handled in the release review" });

    await db.delete(approvals).where(eq(approvals.id, approvalId));
    await request(app(board))
      .delete(`/api/companies/${companyId}/decision-queues/triage/items/approval/${approvalId}`)
      .expect(200);
    expect(await db.select().from(decisionQueueItems).where(and(
      eq(decisionQueueItems.companyId, companyId),
      eq(decisionQueueItems.sourceKind, "approval"),
    ))).toHaveLength(0);
  });

  it("keeps list query count flat and matches source-by-source visibility", async () => {
    const { companyId, agentId, issueId, approvalId } = await seed();
    const [heartbeatRun] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { executionPolicy: {} },
    }).returning();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId, companyId, name: "Second", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other Co", issuePrefix: "OTH" });
    const [first, second] = await db.insert(decisionQueues).values([
      { companyId, key: "one", title: "One", createdByType: "system" },
      { companyId, key: "two", title: "Two", createdByType: "system" },
    ]).returning();
    const actorCases: AuthorizationActor[] = [
      boardActor(companyId),
      agentJwtActor(companyId, agentId, heartbeatRun.id),
      { type: "board", source: "session", userId: "unaffiliated", companyIds: [], isInstanceAdmin: false },
    ];
    const countedDb = { count: 0, heartbeatRunSelects: 0 };
    const instrumented = new Proxy(db, {
      get(target, key) {
        if (key === "select") return (...args: Parameters<typeof db.select>) => {
          countedDb.count++;
          const selection = args[0] as Record<string, unknown> | undefined;
          if (selection && "contextSnapshot" in selection && "agentId" in selection) {
            countedDb.heartbeatRunSelects++;
          }
          return target.select(...args);
        };
        if (key === "execute") return (...args: Parameters<typeof db.execute>) => {
          countedDb.count++;
          return target.execute(...args);
        };
        return Reflect.get(target, key);
      },
    });
    const service = decisionQueueService(instrumented);
    const measures = new Map<string, number>();
    for (const size of [2, 32]) {
      const newIssues = Array.from({ length: size - 1 }, (_, index) => ({
        id: randomUUID(), companyId, identifier: `DQC-${size}-${index}`, title: `Decision ${index}`, status: "todo" as const,
      }));
      await db.insert(issues).values(newIssues);
      const sourceIds = [issueId, ...newIssues.map((issue) => issue.id)];
      const otherSources = [
        { sourceKind: "approval" as const, sourceId: approvalId },
        { sourceKind: "agent_error_alert" as const, sourceId: agentId },
        { sourceKind: "agent_error_alert" as const, sourceId: otherAgentId },
      ];
      await db.insert(decisionQueueItems).values([
        ...sourceIds.map((sourceId) => ({ companyId, queueId: first.id, sourceKind: "review" as const, sourceId, addedByType: "system" as const })),
        ...otherSources.map((source) => ({ companyId, queueId: second.id, ...source, addedByType: "system" as const })),
        { companyId, queueId: second.id, sourceKind: "review", sourceId: randomUUID(), addedByType: "system" },
      ]);
      for (const actor of actorCases) {
        countedDb.count = 0;
        countedDb.heartbeatRunSelects = 0;
        const expected = await Promise.all(sourceIds.map((id) =>
          canReadDecisionSource(instrumented, actor, companyId, "review", id)));
        const oldQueryCount = countedDb.count;
        if (actor.type === "board" && actor.source === "local_implicit") {
          expect(oldQueryCount).toBeGreaterThan(size);
        }
        const otherExpected: string[] = [];
        for (const source of otherSources) {
          if (await canReadDecisionSource(db, actor, companyId, source.sourceKind, source.sourceId)) {
            otherExpected.push(source.sourceId);
          }
        }
        countedDb.count = 0;
        countedDb.heartbeatRunSelects = 0;
        const listed = await service.list(companyId, actor);
        const queryCount = countedDb.count;
        if (actor.type === "agent") expect(countedDb.heartbeatRunSelects).toBeLessThanOrEqual(1);
        expect(listed.find((queue) => queue.key === "one")?.itemCount).toBe(expected.filter(Boolean).length);
        expect(listed.find((queue) => queue.key === "two")?.itemCount).toBe(otherExpected.length);
        const actorName = actor.type === "agent" ? "agent" : actor.source === "local_implicit" ? "board" : "restricted";
        if (measures.has(actorName)) expect(queryCount).toBe(measures.get(actorName));
        else measures.set(actorName, queryCount);
        countedDb.count = 0;
        const visible = await service.listItems(companyId, "one", actor);
        expect(visible.map((item) => item.sourceId).sort()).toEqual(sourceIds.filter((_, index) => expected[index]).sort());
        expect(countedDb.count).toBeLessThanOrEqual(queryCount + 1);
        expect((await service.listItems(companyId, "two", actor)).map((item) => item.sourceId).sort())
          .toEqual(otherExpected.sort());
      }
      await db.delete(decisionQueueItems);
    }
    expect(measures.size).toBe(3);
  });

  it("respects issue policy boundaries, hidden sources, and other-company sources", async () => {
    const { companyId, agentId } = await seed();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other Co", issuePrefix: "OTH" });
    const allowedId = randomUUID();
    const deniedId = randomUUID();
    const hiddenId = randomUUID();
    const foreignId = randomUUID();
    await db.insert(issues).values([
      { id: allowedId, companyId, identifier: "DQC-2", title: "Inside", status: "todo",
        executionPolicy: { authorizationPolicy: { trustBoundary: { mode: "low_trust_review", issueIds: [allowedId] } } } },
      { id: deniedId, companyId, identifier: "DQC-3", title: "Outside", status: "todo",
        executionPolicy: { authorizationPolicy: { trustBoundary: { mode: "low_trust_review", issueIds: [allowedId] } } } },
      { id: hiddenId, companyId, identifier: "DQC-4", title: "Hidden", status: "todo", hiddenAt: new Date() },
      { id: foreignId, companyId: otherCompanyId, identifier: "OTH-1", title: "Foreign", status: "todo" },
    ]);
    const [queue] = await db.insert(decisionQueues).values({
      companyId, key: "policy", title: "Policy", createdByType: "system",
    }).returning();
    const ids = [allowedId, deniedId, hiddenId, foreignId];
    await db.insert(decisionQueueItems).values(ids.map((sourceId) => ({
      companyId, queueId: queue.id, sourceKind: "review" as const, sourceId, addedByType: "system" as const,
    })));
    for (const actor of [boardActor(companyId), agentActor(companyId, agentId)]) {
      const expected: string[] = [];
      for (const id of ids) {
        if (await canReadDecisionSource(db, actor, companyId, "review", id)) expected.push(id);
      }
      const service = decisionQueueService(db);
      expect((await service.listItems(companyId, "policy", actor)).map((item) => item.sourceId).sort())
        .toEqual(expected.sort());
      expect((await service.list(companyId, actor))[0]?.itemCount).toBe(expected.length);
    }
  });

  it("SUP-21344: retains a same-company recovery_rate_alert sidecar for board actors only when the breach is live", async () => {
    const { companyId, agentId } = await seed();
    // Live breach: the week containing 2026-07-06 (a Monday) carries 3 recovery
    // actions against 10 heartbeat runs (30% > 2% threshold). The report window
    // (current week + 7 prior weeks) is anchored at `now`, not at the fixture
    // date, so seed it dynamically relative to the most recent completed week:
    // 21 days ago is always inside the trailing 8-week window and in a week
    // that has fully elapsed.
    const breachDate = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
    const breachRuns = await Promise.all(
      Array.from({ length: 10 }, async (_, index) =>
        db.insert(heartbeatRuns).values({
          companyId,
          agentId,
          status: "failed",
          contextSnapshot: {},
          createdAt: new Date(breachDate.getTime() + index * 1000),
        }).returning(),
      ),
    );
    for (let index = 0; index < 3; index += 1) {
      const breachIssueId = randomUUID();
      await db.insert(issues).values({
        id: breachIssueId,
        companyId,
        identifier: `DQC-B${index + 1}`,
        title: `Breached week source ${index + 1}`,
        status: "todo",
      });
      await db.insert(issueRecoveryActions).values({
        companyId,
        sourceIssueId: breachIssueId,
        kind: "missing_disposition",
        cause: "review_path_lost",
        fingerprint: randomUUID(),
        nextAction: "Inspect",
        createdAt: new Date(breachDate.getTime() + 60_000 + index * 1000),
      });
    }
    expect(breachRuns).toHaveLength(10);
    const alertWeekStart = new Date(breachDate);
    alertWeekStart.setUTCDate(alertWeekStart.getUTCDate() - ((alertWeekStart.getUTCDay() + 6) % 7));
    const alertKey = `recovery_rate_alert:${companyId}:${alertWeekStart.toISOString().slice(0, 10)}`;
    // A same-company key naming a week with no live breach must not be retained.
    const clearedAlertKey = `recovery_rate_alert:${companyId}:2020-01-06`;
    const foreignAlertKey = `recovery_rate_alert:${randomUUID()}:2026-07-06`;
    const [queue] = await db.insert(decisionQueues).values({
      companyId, key: "alerts", title: "Alerts", createdByType: "system",
    }).returning();
    await db.insert(decisionQueueItems).values([
      { companyId, queueId: queue!.id, sourceKind: "recovery_rate_alert" as const, sourceId: alertKey, addedByType: "system" as const },
      { companyId, queueId: queue!.id, sourceKind: "recovery_rate_alert" as const, sourceId: clearedAlertKey, addedByType: "system" as const },
      { companyId, queueId: queue!.id, sourceKind: "recovery_rate_alert" as const, sourceId: foreignAlertKey, addedByType: "system" as const },
    ]);
    const service = decisionQueueService(db);
    expect(await canReadDecisionSource(db, boardActor(companyId), companyId, "recovery_rate_alert", alertKey)).toBe(true);
    expect(await canReadDecisionSource(db, boardActor(companyId), companyId, "recovery_rate_alert", clearedAlertKey)).toBe(false);
    expect(await canReadDecisionSource(db, boardActor(companyId), companyId, "recovery_rate_alert", foreignAlertKey)).toBe(false);
    expect(await canReadDecisionSource(db, agentActor(companyId, agentId), companyId, "recovery_rate_alert", alertKey)).toBe(false);
    expect((await service.listItems(companyId, "alerts", boardActor(companyId))).map((item) => item.sourceId))
      .toEqual([alertKey]);
    expect((await service.listItems(companyId, "alerts", agentActor(companyId, agentId))).map((item) => item.sourceId))
      .toEqual([]);
    expect((await service.list(companyId, boardActor(companyId)))[0]?.itemCount).toBe(1);
  });

  it("matches canonical source visibility when the issue points to a foreign project", async () => {
    const { companyId, agentId, issueId, interactionId, approvalId } = await seed();
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Foreign Project Co", issuePrefix: "FPC" });
    const [foreignProject] = await db.insert(projects).values({
      companyId: otherCompanyId, name: "Foreign project",
    }).returning();
    await db.update(issues).set({ projectId: foreignProject!.id }).where(eq(issues.id, issueId));
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId });

    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "failed", contextSnapshot: { issueId },
    }).returning();
    const [decision] = await db.insert(decisions).values({
      companyId, originAgentId: agentId, originIssueId: issueId, originRunId: run!.id,
      title: "Foreign issue decision", body: "Check access", options: [],
      expiresAt: new Date("2030-01-01T00:00:00.000Z"), signedSpec: "test", targetSnapshots: {},
    }).returning();
    const [recovery] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId: issueId, kind: "missing_disposition",
      cause: "review_path_lost", fingerprint: randomUUID(), nextAction: "Inspect",
    }).returning();
    const [invite] = await db.insert(invites).values({
      companyId, tokenHash: randomUUID(), expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    }).returning();
    const [join] = await db.insert(joinRequests).values({
      companyId, inviteId: invite!.id, requestType: "human", requestIp: "127.0.0.1",
    }).returning();
    const [policy] = await db.insert(budgetPolicies).values({
      companyId, scopeType: "company", scopeId: companyId, windowKind: "monthly",
    }).returning();
    const [incident] = await db.insert(budgetIncidents).values({
      companyId, policyId: policy!.id, scopeType: "company", scopeId: companyId,
      metric: "billed_cents", windowKind: "monthly",
      windowStart: new Date("2026-10-01T00:00:00.000Z"),
      windowEnd: new Date("2026-11-01T00:00:00.000Z"),
      thresholdType: "warning", amountLimit: 100, amountObserved: 100,
    }).returning();
    const sourceIds: Record<AttentionSourceKind, string> = {
      approval: approvalId,
      decision: decision!.id,
      issue_thread_interaction: interactionId,
      join_request: join!.id,
      recovery_action: recovery!.id,
      productivity_review: issueId,
      blocker_attention: issueId,
      review: issueId,
      failed_run: run!.id,
      budget_alert: incident!.id,
      agent_error_alert: agentId,
      // Synthetic alert key naming a foreign company: canReadDecisionSource
      // scopes the key by company, so it is non-existent for the seeded actor.
      recovery_rate_alert: "recovery_rate_alert:nonexistent",
    };
    const [queue] = await db.insert(decisionQueues).values({
      companyId, key: "foreign-project", title: "Foreign project", createdByType: "system",
    }).returning();
    // SUP-21344: this test uses "recovery_rate_alert:nonexistent" (a malformed
    // key with no live artifact) specifically to assert that non-live keys are
    // hidden; no breach needs to be seeded for that expectation.
    await db.insert(decisionQueueItems).values(ATTENTION_SOURCE_KINDS.map((sourceKind) => ({
      companyId, queueId: queue!.id, sourceKind, sourceId: sourceIds[sourceKind], addedByType: "system" as const,
    })));

    const actor = agentActor(companyId, agentId);
    for (const sourceKind of ATTENTION_SOURCE_KINDS) {
      expect(await canReadDecisionSource(db, actor, companyId, sourceKind, sourceIds[sourceKind]))
        .toBe(sourceKind === "agent_error_alert");
    }
    const service = decisionQueueService(db);
    const visible = (await service.listItems(companyId, "foreign-project", actor))
      .map((item) => ({ sourceKind: item.sourceKind, sourceId: item.sourceId }));
    expect(visible).toEqual([{ sourceKind: "agent_error_alert", sourceId: agentId }]);
    expect((await service.list(companyId, actor))[0]?.itemCount).toBe(1);
    const response = await request(app(actor))
      .get(`/api/companies/${companyId}/decision-queues/foreign-project/items`)
      .expect(200);
    expect(response.body.map((item: { sourceKind: string; sourceId: string }) => ({
      sourceKind: item.sourceKind, sourceId: item.sourceId,
    }))).toEqual(visible);
  });

  it("matches concrete issue and agent authorization for standard and low-trust actors", async () => {
    const { companyId, agentId, issueId } = await seed();
    const otherIssueId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId, companyId, name: "Unrelated", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values({
      id: otherIssueId, companyId, identifier: "DQC-2", title: "Outside", status: "todo",
    });
    await db.update(agents).set({ permissions: {
      trustPreset: "low_trust_review",
      authorizationPolicy: {
        trustPreset: "low_trust_review",
        trustBoundary: { mode: "low_trust_review", companyId, issueIds: [issueId], allowedAgentIds: [agentId] },
      },
    } }).where(eq(agents.id, agentId));
    const [queue] = await db.insert(decisionQueues).values({
      companyId, key: "low-trust", title: "Low trust", createdByType: "system",
    }).returning();
    const sources = [
      { sourceKind: "review" as const, sourceId: issueId },
      { sourceKind: "review" as const, sourceId: otherIssueId },
      { sourceKind: "agent_error_alert" as const, sourceId: agentId },
      { sourceKind: "agent_error_alert" as const, sourceId: otherAgentId },
    ];
    await db.insert(decisionQueueItems).values(sources.map((source) => ({
      companyId, queueId: queue.id, ...source, addedByType: "system" as const,
    })));
    const service = decisionQueueService(db);
    const standardActor = agentActor(companyId, otherAgentId);
    const lowTrustActor = agentActor(companyId, agentId);
    for (const actor of [standardActor, lowTrustActor]) {
      const expected: string[] = [];
      for (const source of sources) {
        if (await canReadDecisionSource(db, actor, companyId, source.sourceKind, source.sourceId)) {
          expected.push(source.sourceId);
        }
      }
      expect(expected.sort()).toEqual((actor === standardActor
        ? [issueId, otherIssueId, agentId, otherAgentId]
        : [issueId, agentId]).sort());
      expect((await service.listItems(companyId, "low-trust", actor)).map((item) => item.sourceId).sort())
        .toEqual(expected);
      expect((await service.list(companyId, actor))[0]?.itemCount).toBe(expected.length);
    }
    await request(app(lowTrustActor)).get(`/api/companies/${companyId}/decision-queues`).expect(403);
  });

  it("keeps failed-run owner and linked-issue visibility distinct", async () => {
    const { companyId, agentId, issueId } = await seed();
    const [ownerRun, linkedRun] = await db.insert(heartbeatRuns).values([
      { companyId, agentId, status: "failed", contextSnapshot: { issueId: 42 } },
      { companyId, agentId, status: "failed", contextSnapshot: { issueId } },
    ]).returning();
    const [queue] = await db.insert(decisionQueues).values({
      companyId, key: "runs", title: "Runs", createdByType: "system",
    }).returning();
    await db.insert(decisionQueueItems).values([ownerRun.id, linkedRun.id].map((sourceId) => ({
      companyId, queueId: queue.id, sourceKind: "failed_run" as const, sourceId, addedByType: "system" as const,
    })));
    for (const actor of [boardActor(companyId), agentActor(companyId, agentId)]) {
      const expected: string[] = [];
      for (const id of [ownerRun.id, linkedRun.id]) {
        if (await canReadDecisionSource(db, actor, companyId, "failed_run", id)) expected.push(id);
      }
      const service = decisionQueueService(db);
      expect((await service.listItems(companyId, "runs", actor)).map((item) => item.sourceId).sort())
        .toEqual(expected.sort());
    }
  });

  it("does not let malformed failed-run issue IDs break a queue list", async () => {
    const { companyId, agentId, issueId } = await seed();
    const runs = await db.insert(heartbeatRuns).values([
      { companyId, agentId, status: "failed", contextSnapshot: { issueId } },
      { companyId, agentId, status: "failed", contextSnapshot: { issueId: "not-a-uuid" } },
      { companyId, agentId, status: "failed", contextSnapshot: { taskId: "also-not-a-uuid" } },
    ]).returning();
    const [queue] = await db.insert(decisionQueues).values({
      companyId, key: "malformed-runs", title: "Malformed runs", createdByType: "system",
    }).returning();
    await db.insert(decisionQueueItems).values(runs.map(({ id }) => ({
      companyId, queueId: queue.id, sourceKind: "failed_run" as const, sourceId: id, addedByType: "system" as const,
    })));
    for (const actor of [boardActor(companyId), agentActor(companyId, agentId)]) {
      const listed = await request(app(actor)).get(`/api/companies/${companyId}/decision-queues`).expect(200);
      expect(listed.body.find((item: { key: string }) => item.key === "malformed-runs")?.itemCount).toBe(1);
      const items = await request(app(actor)).get(`/api/companies/${companyId}/decision-queues/malformed-runs/items`).expect(200);
      expect(items.body.map((item: { sourceId: string }) => item.sourceId)).toEqual([runs[0]!.id]);
    }
  });

  it("materializes data-backed starter queues from plan, question, and pull-request signals", async () => {
    const { companyId, issueId, interactionId } = await seed();
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      title: "PR 42",
      status: "open",
    });

    function attentionItem(input: {
      sourceKind: AttentionItem["sourceKind"];
      sourceId: string;
      subjectKind: AttentionItem["subject"]["kind"];
      metadata?: Record<string, unknown>;
      issueId?: string;
    }): AttentionItem {
      return {
        id: `${input.sourceKind}:${input.sourceId}`,
        companyId,
        sourceKind: input.sourceKind,
        subject: {
          kind: input.subjectKind,
          id: input.sourceId,
          companyId,
          title: "Seed candidate",
          identifier: null,
          status: "pending",
          href: null,
          metadata: input.metadata,
        },
        whyNow: "test",
        decisionVerbs: [],
        inlineResolvable: true,
        entryRule: "test",
        exitRule: "test",
        dedupKey: `${input.sourceKind}:${input.sourceId}`,
        dismissalKey: `${input.sourceKind}:${input.sourceId}`,
        dismissal: null,
        severity: "medium",
        rank: 1,
        activityAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        relatedIssue: input.issueId ? {
          kind: "issue",
          id: input.issueId,
          companyId,
          title: "Issue",
          identifier: "DQC-1",
          status: "in_review",
          href: null,
        } : null,
        project: null,
        workspace: null,
        detail: null,
        trainingExampleId: null,
      };
    }

    const planId = randomUUID();
    const candidates = [
      attentionItem({ sourceKind: "review", sourceId: issueId, subjectKind: "issue", issueId }),
      attentionItem({
        sourceKind: "issue_thread_interaction",
        sourceId: planId,
        subjectKind: "interaction",
        metadata: { kind: "request_confirmation", isPlanTarget: true, issueId },
        issueId,
      }),
      attentionItem({
        sourceKind: "issue_thread_interaction",
        sourceId: interactionId,
        subjectKind: "interaction",
        metadata: { kind: "ask_user_questions", issueId },
        issueId,
      }),
    ];
    await decisionQueueService(db).materializeSeededQueues(companyId, candidates);

    const queues = await db.select().from(decisionQueues).where(eq(decisionQueues.companyId, companyId));
    expect(queues.map((queue) => queue.key).sort()).toEqual(["plans", "prs", "questions"]);
    expect(queues.every((queue) => queue.seedRulesEnabled && queue.seedRules.length === 1)).toBe(true);
    const seededItems = await db.select({ queueId: decisionQueueItems.queueId })
      .from(decisionQueueItems)
      .where(eq(decisionQueueItems.companyId, companyId));
    expect(seededItems).toHaveLength(5);
    const prQueue = queues.find((queue) => queue.key === "prs")!;
    expect(seededItems.filter((item) => item.queueId === prQueue.id)).toHaveLength(3);

    const firstEvents = await db.select().from(decisionTriageEvents)
      .where(eq(decisionTriageEvents.companyId, companyId));
    const firstActivity = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const firstUpdatedAt = new Map(queues.map((queue) => [queue.key, queue.updatedAt.toISOString()]));
    await decisionQueueService(db).materializeSeededQueues(companyId, candidates);
    const unchangedQueues = await db.select().from(decisionQueues).where(eq(decisionQueues.companyId, companyId));
    expect(unchangedQueues.every((queue) => queue.updatedAt.toISOString() === firstUpdatedAt.get(queue.key))).toBe(true);
    expect(await db.select().from(decisionTriageEvents).where(eq(decisionTriageEvents.companyId, companyId)))
      .toHaveLength(firstEvents.length);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)))
      .toHaveLength(firstActivity.length);

    const questionsQueue = queues.find((queue) => queue.key === "questions")!;
    await db.update(decisionQueues).set({ seedRulesEnabled: false }).where(eq(decisionQueues.id, questionsQueue.id));
    await decisionQueueService(db).materializeSeededQueues(companyId, [attentionItem({
      sourceKind: "issue_thread_interaction",
      sourceId: randomUUID(),
      subjectKind: "interaction",
      metadata: { kind: "ask_user_questions", issueId },
      issueId,
    })]);
    expect(await db.select().from(decisionQueueItems).where(eq(decisionQueueItems.queueId, questionsQueue.id)))
      .toHaveLength(1);
  });

  it("records agent decide-by, preserves override history, and exposes the board override attribution", async () => {
    const { companyId, agentId, issueId } = await seed();
    const agent = agentActor(companyId, agentId);
    const board = boardActor(companyId, "override-user");

    const agentSet = await request(app(agent))
      .put(`/api/companies/${companyId}/decision-triage/review/${issueId}`)
      .send({ decideBy: "today", snoozedUntil: "2026-08-03T12:00:00.000Z" })
      .expect(200);
    expect(agentSet.body).toMatchObject({
      decideBy: "today",
      setByType: "agent",
      setByAgentId: agentId,
      version: 1,
    });

    const overridden = await request(app(board))
      .put(`/api/companies/${companyId}/decision-triage/review/${issueId}`)
      .send({ decideBy: "2026-08-08", snoozedUntil: null })
      .expect(200);
    expect(overridden.body).toMatchObject({
      decideBy: "2026-08-08",
      setByType: "user",
      setByUserId: "override-user",
      version: 2,
    });

    const events = await db.select().from(decisionTriageEvents).where(and(
      eq(decisionTriageEvents.companyId, companyId),
      eq(decisionTriageEvents.sourceKind, "review"),
      eq(decisionTriageEvents.sourceId, issueId),
    ));
    expect(events).toHaveLength(2);
    expect(events[0]?.actorAgentId).toBe(agentId);
    expect(events[1]?.actorUserId).toBe("override-user");
    expect(events[1]?.details).toMatchObject({ previousDecideBy: "today", decideBy: "2026-08-08" });

    const current = await db.select().from(decisionTriage).where(eq(decisionTriage.sourceId, issueId));
    expect(current[0]?.setByUserId).toBe("override-user");
  });

  it("serializes concurrent partial triage updates without losing state or reusing a version", async () => {
    const { companyId, issueId } = await seed();
    const board = boardActor(companyId);
    const [decideByResult, snoozeResult] = await Promise.all([
      request(app(board))
        .put(`/api/companies/${companyId}/decision-triage/review/${issueId}`)
        .send({ decideBy: "today" }),
      request(app(board))
        .put(`/api/companies/${companyId}/decision-triage/review/${issueId}`)
        .send({ snoozedUntil: "2026-08-03T12:00:00.000Z" }),
    ]);

    expect(decideByResult.status).toBe(200);
    expect(snoozeResult.status).toBe(200);
    expect([decideByResult.body.version, snoozeResult.body.version].sort()).toEqual([1, 2]);

    const current = await request(app(board))
      .get(`/api/companies/${companyId}/decision-triage/review/${issueId}`)
      .expect(200);
    expect(current.body).toMatchObject({
      decideBy: "today",
      snoozedUntil: "2026-08-03T12:00:00.000Z",
      version: 2,
    });
    const events = await db.select().from(decisionTriageEvents).where(and(
      eq(decisionTriageEvents.companyId, companyId),
      eq(decisionTriageEvents.sourceKind, "review"),
      eq(decisionTriageEvents.sourceId, issueId),
    ));
    expect(events.map((event) => event.details.version).sort()).toEqual([1, 2]);
  });

  it("rejects task-bridge JWTs and returns the same 404 for missing and unauthorized sources", async () => {
    const { companyId, agentId, approvalId } = await seed();
    const bridge = {
      ...agentActor(companyId, agentId),
      source: "agent_jwt",
      keyId: randomUUID(),
      keyScope: { kind: "task_bridge", parentIssueId: randomUUID() },
    };
    await request(app(bridge)).post(`/api/companies/${companyId}/decision-queues`).send({
      key: "blocked",
      title: "Blocked",
    }).expect(403);
    const skillTest = {
      ...agentActor(companyId, agentId),
      source: "agent_jwt",
      keyScope: { kind: "skill_test", issueId: randomUUID() },
    };
    await request(app(skillTest)).post(`/api/companies/${companyId}/decision-queues`).send({
      key: "skill-test-blocked",
      title: "Skill test blocked",
    }).expect(403);

    await request(app(boardActor(companyId))).post(`/api/companies/${companyId}/decision-queues`).send({
      key: "secure",
      title: "Secure",
    }).expect(201);
    const standardAgent = app(agentActor(companyId, agentId));
    const unauthorized = await request(standardAgent)
      .post(`/api/companies/${companyId}/decision-queues/secure/items`)
      .send({ sourceKind: "approval", sourceId: approvalId })
      .expect(404);
    const missing = await request(standardAgent)
      .post(`/api/companies/${companyId}/decision-queues/secure/items`)
      .send({ sourceKind: "approval", sourceId: randomUUID() })
      .expect(404);
    expect(unauthorized.body).toEqual(missing.body);
  });
});
