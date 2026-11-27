import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

// The stranded sweep's last read before it enqueues runs after its live-path
// guard. This hook lets a test put a live run into that window, which is the
// race SUP-24883 came from: an occupancy successor inserted after the guard.
const pauseHoldRace = vi.hoisted(() => ({
  beforeCheck: null as null | ((issueId: string) => Promise<void>),
}));

vi.mock("../services/recovery/pause-hold-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/recovery/pause-hold-guard.js")>();
  return {
    ...actual,
    isAutomaticRecoverySuppressedByPauseHold: async (
      ...args: Parameters<typeof actual.isAutomaticRecoverySuppressedByPauseHold>
    ) => {
      const hook = pauseHoldRace.beforeCheck;
      if (hook) {
        pauseHoldRace.beforeCheck = null;
        await hook(args[2]);
      }
      return actual.isAutomaticRecoverySuppressedByPauseHold(...args);
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres retry-lineage self-reference tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

describeEmbeddedPostgres("stranded recovery never makes a run its own retry predecessor", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-retry-lineage-self-reference-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    pauseHoldRace.beforeCheck = null;
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedInProgressIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const prefix = `RL${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Retry Lineage Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
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
      title: "Continue after a lost execution path",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    return { companyId, agentId, issueId };
  }

  async function readRun(runId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
  }

  it("leaves the lineage alone when the continuation wake coalesces into its own source run", async () => {
    const { companyId, agentId, issueId } = await seedInProgressIssue();
    const sourceRunId = randomUUID();
    const finishedAt = new Date(Date.now() - 30 * 60 * 1000);
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "succeeded",
      runtimeMode: "native",
      livenessState: "advanced",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      startedAt: new Date(finishedAt.getTime() - 60_000),
      finishedAt,
      createdAt: new Date(finishedAt.getTime() - 60_000),
      updatedAt: finishedAt,
    });
    // enqueueWakeup coalesces into an existing run instead of creating one; here
    // the run it hands back is the very run the recovery names as predecessor.
    const enqueueWakeup = vi.fn(async (_agentId: string, opts?: { payload?: Record<string, unknown> | null }) =>
      opts?.payload?.retryOfRunId === sourceRunId ? readRun(sourceRunId) : null,
    );
    const recovery = recoveryService(db, { enqueueWakeup });

    await recovery.reconcileStrandedAssignedIssues();

    expect(enqueueWakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        reason: "issue_continuation_needed",
        payload: expect.objectContaining({ retryOfRunId: sourceRunId }),
      }),
    );
    expect((await readRun(sourceRunId)).retryOfRunId).toBeNull();
  });

  it("stands down when a live run for the issue appears after the live-path guard", async () => {
    const { companyId, agentId, issueId } = await seedInProgressIssue();
    let lateRun: HeartbeatRun | null = null;
    pauseHoldRace.beforeCheck = async (checkedIssueId) => {
      if (checkedIssueId !== issueId) return;
      // An occupancy successor lands between the guard and the sweep's re-read.
      [lateRun] = await db
        .insert(heartbeatRuns)
        .values({
          companyId,
          agentId,
          invocationSource: "automation",
          triggerDetail: "system",
          status: "scheduled_retry",
          scheduledRetryAt: new Date(Date.now() + 5 * 60 * 1000),
          scheduledRetryAttempt: 1,
          scheduledRetryReason: "execution_workspace_occupied",
          contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_commented" },
        })
        .returning();
    };
    const enqueueWakeup = vi.fn(async () => lateRun);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(lateRun).not.toBeNull();
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(result).toMatchObject({ continuationRequeued: 0, skipped: 1 });
    expect((await readRun(lateRun!.id)).retryOfRunId).toBeNull();
  });
});
