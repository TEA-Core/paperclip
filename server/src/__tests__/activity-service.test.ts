import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { activityService } from "../services/activity.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type ActivityService = ReturnType<typeof activityService>;
type IssueRun = Awaited<ReturnType<ActivityService["runsForIssue"]>>[number];

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres activity service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForIssueRun(
  service: ActivityService,
  companyId: string,
  issueId: string,
  predicate: (run: IssueRun) => boolean,
) {
  const deadline = Date.now() + 2_000;
  let latestRuns: IssueRun[] = [];
  while (Date.now() < deadline) {
    latestRuns = await service.runsForIssue(companyId, issueId);
    const run = latestRuns.find(predicate);
    if (run) return { run, runs: latestRuns };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for issue run. Latest run count: ${latestRuns.length}`);
}

describeEmbeddedPostgres("activity service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("limits company activity lists", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "test.oldest",
        entityType: "company",
        entityId: companyId,
        createdAt: new Date("2026-04-21T10:00:00.000Z"),
      },
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "test.middle",
        entityType: "company",
        entityId: companyId,
        createdAt: new Date("2026-04-21T11:00:00.000Z"),
      },
      {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "test.newest",
        entityType: "company",
        entityId: companyId,
        createdAt: new Date("2026-04-21T12:00:00.000Z"),
      },
    ]);

    const result = await activityService(db).list({ companyId, limit: 2 });

    expect(result.map((event) => event.action)).toEqual(["test.newest", "test.middle"]);
  });

  it("filters company activity lists by action, actorType, and inclusive from/to windows", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const t10 = new Date("2026-04-21T10:00:00.000Z");
    const t11 = new Date("2026-04-21T11:00:00.000Z");
    const t12 = new Date("2026-04-21T12:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
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
      title: "Guard census target",
      description: "Issue receiving done-transition-guard activity rows.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(activityLog).values([
      {
        companyId,
        actorType: "system",
        actorId: "done-transition-guard",
        agentId: null,
        action: "issue.done_transition_guard_skipped",
        entityType: "issue",
        entityId: issueId,
        createdAt: t10,
      },
      {
        companyId,
        actorType: "system",
        actorId: "done-transition-guard",
        agentId: null,
        action: "issue.done_transition_guard_skipped",
        entityType: "issue",
        entityId: issueId,
        createdAt: t11,
      },
      {
        companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        action: "issue.status_changed",
        entityType: "issue",
        entityId: issueId,
        createdAt: t12,
      },
    ]);

    const service = activityService(db);

    const unfiltered = await service.list({ companyId });
    expect(unfiltered.map((event) => event.action)).toEqual([
      "issue.status_changed",
      "issue.done_transition_guard_skipped",
      "issue.done_transition_guard_skipped",
    ]);
    expect(Object.keys(unfiltered[0] ?? {}).sort()).toEqual(
      [
        "id",
        "companyId",
        "actorType",
        "actorId",
        "action",
        "entityType",
        "entityId",
        "agentId",
        "runId",
        "responsibleUserId",
        "details",
        "createdAt",
      ].sort(),
    );
    expect(unfiltered[0]).toMatchObject({
      companyId,
      entityType: "issue",
      entityId: issueId,
      createdAt: t12,
    });

    const guardActions = await service.list({
      companyId,
      action: ["issue.done_transition_guard_skipped"],
    });
    expect(guardActions).toHaveLength(2);
    for (const event of guardActions) {
      expect(event.action).toBe("issue.done_transition_guard_skipped");
    }

    const otherAction = await service.list({
      companyId,
      action: ["issue.status_changed"],
    });
    expect(otherAction.map((event) => event.action)).toEqual(["issue.status_changed"]);

    const allActions = await service.list({
      companyId,
      action: ["issue.done_transition_guard_skipped", "issue.status_changed"],
    });
    expect(allActions.map((event) => event.action)).toEqual([
      "issue.status_changed",
      "issue.done_transition_guard_skipped",
      "issue.done_transition_guard_skipped",
    ]);

    const windowed = await service.list({ companyId, from: t10, to: t12 });
    expect(windowed.map((event) => event.action)).toEqual([
      "issue.status_changed",
      "issue.done_transition_guard_skipped",
      "issue.done_transition_guard_skipped",
    ]);
    const halfOpenWindow = await service.list({ companyId, from: t11, to: t12 });
    expect(halfOpenWindow.map((event) => event.createdAt)).toEqual([t12, t11]);
    const emptyWindow = await service.list({
      companyId,
      from: new Date("2026-04-21T12:00:01.000Z"),
      to: new Date("2026-04-21T12:00:10.000Z"),
    });
    expect(emptyWindow).toEqual([]);

    const systemRows = await service.list({ companyId, actorType: "system" });
    expect(systemRows).toHaveLength(2);
    for (const event of systemRows) {
      expect(event).toMatchObject({
        actorType: "system",
        actorId: "done-transition-guard",
        agentId: null,
      });
    }

    const agentRows = await service.list({
      companyId,
      entityType: "issue",
      entityId: issueId,
      agentId,
    });
    expect(agentRows.map((event) => event.action)).toEqual(["issue.status_changed"]);

    const composed = await service.list({
      companyId,
      action: ["issue.done_transition_guard_skipped"],
      entityType: "issue",
      entityId: issueId,
      from: t10,
    });
    expect(composed.map((event) => event.action)).toEqual([
      "issue.done_transition_guard_skipped",
      "issue.done_transition_guard_skipped",
    ]);
  });

  it("returns compact usage and result summaries for issue runs", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      contextSnapshot: { issueId },
      usageJson: {
        inputTokens: 11,
        output_tokens: 7,
        cache_read_input_tokens: 3,
        billingType: "metered",
        costUsd: 0.42,
        enormousBlob: "x".repeat(256_000),
      },
      resultJson: {
        billing_type: "metered",
        total_cost_usd: 0.42,
        stopReason: "timeout",
        effectiveTimeoutSec: 30,
        timeoutFired: true,
        summary: "done",
        nestedHuge: { payload: "y".repeat(256_000) },
      },
      livenessState: "advanced",
      livenessReason: "Run produced concrete action evidence: 1 issue comment(s)",
      continuationAttempt: 2,
      lastUsefulActionAt: new Date("2026-04-18T19:59:00.000Z"),
      nextAction: "Review the completed output.",
    });

    const runs = await activityService(db).runsForIssue(companyId, issueId);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId,
      agentId,
      invocationSource: "assignment",
    });
    expect(runs[0]?.usageJson).toEqual({
      inputTokens: 11,
      input_tokens: 11,
      outputTokens: 7,
      output_tokens: 7,
      cachedInputTokens: 3,
      cached_input_tokens: 3,
      cache_read_input_tokens: 3,
      billingType: "metered",
      billing_type: "metered",
      costUsd: 0.42,
      cost_usd: 0.42,
      total_cost_usd: 0.42,
    });
    expect(runs[0]?.resultJson).toEqual({
      billingType: "metered",
      billing_type: "metered",
      costUsd: 0.42,
      cost_usd: 0.42,
      total_cost_usd: 0.42,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutFired: true,
    });
    expect(runs[0]).toMatchObject({
      livenessState: "advanced",
      livenessReason: "Run produced concrete action evidence: 1 issue comment(s)",
      continuationAttempt: 2,
      lastUsefulActionAt: new Date("2026-04-18T19:59:00.000Z"),
      nextAction: "Review the completed output.",
    });
    expect(runs[0]).not.toHaveProperty("contextSnapshot");
  });

  it("backfills missing liveness for completed issue runs before returning the ledger", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const completedAt = new Date("2026-04-18T20:04:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
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
      title: "Fix run ledger",
      description: "Make the run ledger answer whether a run advanced.",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      completedAt,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date("2026-04-18T20:00:00.000Z"),
      finishedAt: completedAt,
      contextSnapshot: { issueId },
      resultJson: {
        summary: "Finished the implementation.",
      },
      livenessState: null,
      livenessReason: null,
      lastUsefulActionAt: null,
      nextAction: null,
    });

    await db.insert(issueComments).values({
      companyId,
      issueId,
      authorAgentId: agentId,
      createdByRunId: runId,
      body: "Done",
      createdAt: completedAt,
    });

    const service = activityService(db);
    const { run, runs } = await waitForIssueRun(
      service,
      companyId,
      issueId,
      (entry) => entry.runId === runId && entry.livenessState === "completed",
    );

    expect(runs).toHaveLength(1);
    expect(run).toMatchObject({
      runId,
      livenessState: "completed",
      livenessReason: "Issue is done",
      continuationAttempt: 0,
      lastUsefulActionAt: completedAt,
    });

    const [persisted] = await db.select().from(heartbeatRuns);
    expect(persisted).toMatchObject({
      id: runId,
      livenessState: "completed",
      livenessReason: "Issue is done",
      continuationAttempt: 0,
      lastUsefulActionAt: completedAt,
    });
  });

  it("does not backfill document evidence from a different run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const otherRunId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const createdAt = new Date("2026-04-18T20:08:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
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
      title: "Fix run ledger",
      description: "Make the run ledger answer whether a run advanced.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(heartbeatRuns).values([
      {
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-04-18T20:00:00.000Z"),
        finishedAt: new Date("2026-04-18T20:02:00.000Z"),
        contextSnapshot: { issueId },
        resultJson: {
          summary: "Next steps:\n- inspect files",
        },
        livenessState: null,
        livenessReason: null,
      },
      {
        id: otherRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        startedAt: new Date("2026-04-18T20:05:00.000Z"),
        finishedAt: createdAt,
        contextSnapshot: { issueId },
        resultJson: {
          summary: "Updated the plan document.",
        },
        livenessState: "advanced",
        livenessReason: "Run produced concrete action evidence: 1 document revision(s)",
      },
    ]);

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Plan",
      format: "markdown",
      latestBody: "# Plan\n\n- Inspect files",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: agentId,
      updatedByAgentId: agentId,
      createdAt,
      updatedAt: createdAt,
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Plan",
      format: "markdown",
      body: "# Plan\n\n- Inspect files",
      createdByAgentId: agentId,
      createdByRunId: otherRunId,
      createdAt,
    });

    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: "plan",
      createdAt,
      updatedAt: createdAt,
    });

    const service = activityService(db);
    const { run: backfilledRun } = await waitForIssueRun(
      service,
      companyId,
      issueId,
      (entry) => entry.runId === runId && entry.livenessState === "plan_only",
    );

    expect(backfilledRun).toMatchObject({
      runId,
      livenessState: "plan_only",
      livenessReason: "Run described runnable future work without concrete action evidence",
      lastUsefulActionAt: null,
    });
  });

  it("does not treat continuation summary revisions as concrete backfill evidence", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const createdAt = new Date("2026-04-18T20:12:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
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
      title: "Fix run ledger",
      description: "Make the run ledger answer whether a run advanced.",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      startedAt: new Date("2026-04-18T20:10:00.000Z"),
      finishedAt: createdAt,
      contextSnapshot: { issueId },
      resultJson: {
        summary: "Next steps:\n- inspect files",
      },
      livenessState: null,
      livenessReason: null,
    });

    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Continuation Summary",
      format: "markdown",
      latestBody: "# Continuation Summary",
      latestRevisionId: revisionId,
      latestRevisionNumber: 1,
      createdByAgentId: agentId,
      updatedByAgentId: agentId,
      createdAt,
      updatedAt: createdAt,
    });

    await db.insert(documentRevisions).values({
      id: revisionId,
      companyId,
      documentId,
      revisionNumber: 1,
      title: "Continuation Summary",
      format: "markdown",
      body: "# Continuation Summary",
      createdByAgentId: agentId,
      createdByRunId: runId,
      createdAt,
    });

    await db.insert(issueDocuments).values({
      companyId,
      issueId,
      documentId,
      key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      createdAt,
      updatedAt: createdAt,
    });

    const service = activityService(db);
    const { run: backfilledRun } = await waitForIssueRun(
      service,
      companyId,
      issueId,
      (entry) => entry.runId === runId && entry.livenessState === "plan_only",
    );

    expect(backfilledRun).toMatchObject({
      runId,
      livenessState: "plan_only",
      livenessReason: "Run described runnable future work without concrete action evidence",
      lastUsefulActionAt: null,
    });
  });
});
