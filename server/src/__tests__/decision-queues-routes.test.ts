import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  decisionQueueItems,
  decisionQueues,
  decisionTriage,
  decisionTriageEvents,
  heartbeatRuns,
  issueThreadInteractions,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import type { AttentionItem } from "@paperclipai/shared";
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
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issueWorkProducts);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
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
