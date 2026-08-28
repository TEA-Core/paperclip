import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  approvalComments,
  approvals,
  assets,
  companies,
  createDb,
  decisionArchiveNotificationOutbox,
  decisionBundles,
  decisionQueueItems,
  decisionQueues,
  decisionRetention,
  decisionTriage,
  decisionTriageEvents,
  decisions,
  goals,
  heartbeatRuns,
  invites,
  issueThreadInteractions,
  issueWatchdogs,
  issues,
  joinRequests,
  projects,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent remove decision/watchdog tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service remove with decision/watchdog/ownership rows (SUP-14085)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-remove-decisions-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(decisionQueueItems);
    await db.delete(decisionQueues);
    await db.delete(decisionTriageEvents);
    await db.delete(decisionTriage);
    await db.delete(decisionRetention);
    await db.delete(decisions);
    await db.delete(decisionBundles);
    await db.delete(decisionArchiveNotificationOutbox);
    await db.delete(issueWatchdogs);
    await db.delete(issueThreadInteractions);
    await db.delete(approvalComments);
    await db.delete(approvals);
    await db.delete(joinRequests);
    await db.delete(invites);
    await db.delete(assets);
    await db.delete(goals);
    await db.delete(projects);
    await db.delete(routines);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("deletes an agent owning decision/watchdog/ownership rows with the right per-table policy", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Disposable Decider",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "Watched issue" });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "succeeded",
      finishedAt: new Date("2026-08-28T00:01:00.000Z"),
    });

    const [queue] = await db
      .insert(decisionQueues)
      .values({
        companyId,
        key: "lane-key",
        title: "Lane",
        createdByType: "agent",
        createdByAgentId: agentId,
        createdByRunId: runId,
      })
      .returning();
    await db.insert(decisionQueueItems).values({
      companyId,
      queueId: queue.id,
      sourceKind: "issue",
      sourceId: issueId,
      addedByType: "agent",
      addedByAgentId: agentId,
      addedByRunId: runId,
    });
    await db.insert(decisionTriage).values({
      companyId,
      sourceKind: "issue",
      sourceId: issueId,
      setByType: "agent",
      setByAgentId: agentId,
      setByRunId: runId,
    });
    await db.insert(decisionTriageEvents).values({
      companyId,
      sourceKind: "issue",
      sourceId: issueId,
      action: "snooze",
      actorType: "agent",
      actorAgentId: agentId,
      actorRunId: runId,
    });
    await db.insert(decisionRetention).values({
      companyId,
      sourceKind: "issue",
      sourceId: issueId,
      sourceActivityAt: new Date("2026-08-28T00:01:00.000Z"),
      archivedAt: new Date("2026-08-28T00:02:00.000Z"),
      archivedByType: "agent",
      archivedByAgentId: agentId,
      archivedByRunId: runId,
    });
    await db.insert(decisionBundles).values({
      companyId,
      title: "Bundle",
      summary: "Bundle summary",
      originAgentId: agentId,
      originIssueId: issueId,
      originRunId: runId,
    });
    const [decision] = await db
      .insert(decisions)
      .values({
        companyId,
        originAgentId: agentId,
        originIssueId: issueId,
        originRunId: runId,
        title: "Decision",
        body: "Decision body",
        options: [],
        expiresAt: new Date("2026-09-28T00:00:00.000Z"),
        signedSpec: "spec",
        targetSnapshots: {},
      })
      .returning();
    await db.insert(decisionArchiveNotificationOutbox).values({
      companyId,
      sourceKind: "issue",
      sourceId: issueId,
      originAgentId: agentId,
      originIssueId: issueId,
      archiveVersion: 0,
    });
    await db.insert(issueWatchdogs).values({
      companyId,
      issueId,
      watchdogAgentId: agentId,
    });
    const [goal] = await db.insert(goals).values({ companyId, title: "Goal", ownerAgentId: agentId }).returning();
    const [project] = await db.insert(projects).values({ companyId, name: "Proj", leadAgentId: agentId }).returning();
    const [routine] = await db.insert(routines).values({ companyId, title: "Routine", assigneeAgentId: agentId }).returning();
    const [invite] = await db
      .insert(invites)
      .values({ companyId, tokenHash: "hash-1", expiresAt: new Date("2026-09-28T00:00:00.000Z") })
      .returning();
    await db.insert(joinRequests).values({
      inviteId: invite.id,
      companyId,
      requestType: "agent",
      requestIp: "10.0.0.1",
      createdAgentId: agentId,
    });
    const [approval] = await db
      .insert(approvals)
      .values({ companyId, type: "hire_agent", requestedByAgentId: agentId, payload: {} })
      .returning();
    await db.insert(approvalComments).values({
      companyId,
      approvalId: approval.id,
      authorAgentId: agentId,
      body: "Comment",
    });
    await db.insert(assets).values({
      companyId,
      provider: "s3",
      objectKey: `assets/${companyId}/f.bin`,
      contentType: "application/octet-stream",
      byteSize: 1,
      sha256: "sha-1",
      createdByAgentId: agentId,
    });
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId,
      kind: "request_confirmation",
      payload: {},
      createdByAgentId: agentId,
      resolvedByAgentId: agentId,
    });

    const removed = await agentService(db).remove(agentId);
    expect(removed).toMatchObject({ id: agentId });

    const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agentRow).toBeUndefined();
    const [runRow] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(runRow).toBeUndefined();

    // Cascade: agent-owned rows are deleted with the agent/run.
    const [decisionRow] = await db.select().from(decisions).where(eq(decisions.id, decision.id));
    expect(decisionRow).toBeUndefined();
    const watchdogRows = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.companyId, companyId));
    expect(watchdogRows).toEqual([]);
    const bundleRows = await db.select().from(decisionBundles).where(eq(decisionBundles.companyId, companyId));
    expect(bundleRows).toEqual([]);
    const outboxRows = await db
      .select()
      .from(decisionArchiveNotificationOutbox)
      .where(eq(decisionArchiveNotificationOutbox.companyId, companyId));
    expect(outboxRows).toEqual([]);

    // Set null: history rows survive, attribution is gone, actor type is system.
    const [queueRow] = await db.select().from(decisionQueues).where(eq(decisionQueues.id, queue.id));
    expect(queueRow).toMatchObject({
      id: queue.id,
      createdByType: "system",
      createdByAgentId: null,
      createdByRunId: null,
    });
    const itemRows = await db
      .select()
      .from(decisionQueueItems)
      .where(eq(decisionQueueItems.companyId, companyId));
    expect(itemRows).toHaveLength(1);
    expect(itemRows[0]).toMatchObject({ addedByType: "system", addedByAgentId: null, addedByRunId: null });
    const triageRows = await db.select().from(decisionTriage).where(eq(decisionTriage.companyId, companyId));
    expect(triageRows).toEqual([]);
    const eventRows = await db
      .select()
      .from(decisionTriageEvents)
      .where(eq(decisionTriageEvents.companyId, companyId));
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]).toMatchObject({ actorType: "system", actorAgentId: null, actorRunId: null });
    const retentionRows = await db
      .select()
      .from(decisionRetention)
      .where(eq(decisionRetention.companyId, companyId));
    expect(retentionRows).toHaveLength(1);
    expect(retentionRows[0]).toMatchObject({ archivedByType: "system", archivedByAgentId: null, archivedByRunId: null });

    // Ownership/attribution FKs detach without deleting the row.
    const [goalRow] = await db.select().from(goals).where(eq(goals.id, goal.id));
    expect(goalRow).toMatchObject({ id: goal.id, ownerAgentId: null });
    const [projectRow] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(projectRow).toMatchObject({ id: project.id, leadAgentId: null });
    const [routineRow] = await db.select().from(routines).where(eq(routines.id, routine.id));
    expect(routineRow).toMatchObject({ id: routine.id, assigneeAgentId: null });
    const joinRow = await db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.companyId, companyId));
    expect(joinRow[0]).toMatchObject({ createdAgentId: null });
    const [approvalRow] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(approvalRow).toMatchObject({ id: approval.id, requestedByAgentId: null });
    const commentRows = await db.select().from(approvalComments).where(eq(approvalComments.companyId, companyId));
    expect(commentRows).toHaveLength(1);
    expect(commentRows[0]).toMatchObject({ authorAgentId: null });
    const assetRows = await db.select().from(assets).where(eq(assets.companyId, companyId));
    expect(assetRows).toHaveLength(1);
    expect(assetRows[0]).toMatchObject({ createdByAgentId: null });
    const interactionRows = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.companyId, companyId));
    expect(interactionRows).toHaveLength(1);
    expect(interactionRows[0]).toMatchObject({ createdByAgentId: null, resolvedByAgentId: null });
  });
});
