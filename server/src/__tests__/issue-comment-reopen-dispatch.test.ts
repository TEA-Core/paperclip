import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
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
    summary: "repro run",
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

type ScenarioOpts = {
  label: string;
  initialStatus: "todo" | "done";
  flipToTodo: boolean;
  reviewPolicy?: boolean;
  lingeringRunStatus?: "queued" | "scheduled_retry" | "running" | "succeeded";
};

describeEmbeddedPostgres("issue comment reopen dispatch (SUP-15065) — scenario matrix", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-comment-reopen-dispatch-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    runningProcesses.clear();
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(issues);
        await db.delete(environmentLeases);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedScenario(opts: ScenarioOpts) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const priorRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "support-QAE",
      role: "support",
      status: "idle",
      adapterType: "opencode_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const executionPolicy = opts.reviewPolicy
      ? {
          mode: "normal",
          commentRequired: true,
          stages: [
            {
              id: randomUUID(),
              type: "review",
              participants: [{ id: agentId, type: "agent", userId: null, agentId }],
              approvalsNeeded: 1,
            },
          ],
        }
      : undefined;

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Repro ${opts.label}`,
      status: opts.initialStatus,
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      ...(executionPolicy ? { executionPolicy } : {}),
    });

    // Prior terminal run that completed the (done) card.
    await db.insert(heartbeatRuns).values({
      id: priorRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      responsibleUserId: "responsible-user",
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      finishedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    // A lingering non-terminal run (if requested) — models a run still holding the execution lock.
    if (opts.lingeringRunStatus) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: opts.lingeringRunStatus,
        responsibleUserId: "responsible-user",
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
        startedAt: opts.lingeringRunStatus === "succeeded" ? new Date(Date.now() - 30 * 60 * 1000) : null,
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      });
    }

    // Mirror the route reopen mutation: done -> todo, executionState nulled.
    if (opts.flipToTodo) {
      await db
        .update(issues)
        .set({ status: "todo", executionState: null, updatedAt: new Date() })
        .where(eq(issues.id, issueId));
    }

    return { companyId, agentId, issueId };
  }

  function reopenWake(agentId: string, issueId: string, reason: "issue_reopened_via_comment" | "issue_commented") {
    const commentId = randomUUID();
    const isReopen = reason === "issue_reopened_via_comment";
    return heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason,
      payload: {
        issueId,
        commentId,
        ...(isReopen ? { reopenedFrom: "done" } : {}),
        mutation: "comment",
      },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        commentId,
        wakeCommentId: commentId,
        source: isReopen ? "issue.comment.reopen" : "issue.comment",
        wakeReason: reason,
        ...(isReopen ? { reopenedFrom: "done" } : {}),
      },
    });
  }

  it("a comment-triggered reopen on a done card enqueues a heartbeat_runs row for the assignee", async () => {
    const { companyId, agentId, issueId } = await seedScenario({
      label: "done_to_todo_reopen",
      initialStatus: "done",
      flipToTodo: true,
    });

    // A clean done->todo reopen (idle assignee, resolvable responsible user) must
    // dispatch a run — the exact dispatch guarantee the SUP-14989 card was missing.
    const wake = await reopenWake(agentId, issueId, "issue_reopened_via_comment");
    expect(
      wake,
      "a clean done->todo reopen must dispatch a run, not be skipped/deferred (null)",
    ).toBeTruthy();

    const runs = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        agentId: heartbeatRuns.agentId,
      })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)))
      .orderBy(desc(heartbeatRuns.createdAt));

    // A fresh non-terminal run must exist for the reopened card (the seeded prior
    // run was `succeeded`).
    const dispatched = runs.filter((run) =>
      ["queued", "running", "scheduled_retry"].includes(run.status),
    );
    expect(dispatched.length, "a non-terminal heartbeat_runs row must exist for the reopen").toBeGreaterThanOrEqual(1);
    expect(wake && "id" in wake ? wake.id : null).toBe(dispatched[0]?.id);
  });
});
