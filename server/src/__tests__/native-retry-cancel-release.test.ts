import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

// Fold 2c / native retry cancel. Upstream #13075 (35fdc0c66) lets cancelRun stop a failed native
// run whose durable retry is still pending. With D9 deferred, that cancellation reaches the fork's
// in-file release. The release must not answer the cancellation with a generic
// issue_continuation_needed replacement run. Upstream's native-safe-replacement test pins this
// only on a fixture with no responsible user, where the unfixed release threw 422 before inserting
// anything. This file pins the production shape too: the company has a default responsible user,
// so the unfixed release queued and dispatched the replacement run.
const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("cancelling a pending native retry", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-native-retry-cancel-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  it.each([
    ["a company default responsible user", "responsible-user"],
    ["no responsible user", null],
  ])("releases the task without a replacement run when there is %s", async (_label, responsibleUserId) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Native retry cancel",
      issuePrefix: `N${companyId.slice(0, 6)}`,
      defaultResponsibleUserId: responsibleUserId,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Executor",
      role: "engineer",
      adapterType: "paperclip_runner",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Native retry fixture",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      nativeIssueId: issueId,
      runtimeMode: "native",
      status: "failed",
      contextSnapshot: { issueId },
      responsibleUserId,
      runnerProfileJson: {
        recoveryEventInventoryVersion: 1,
        nativeExecutionInput: { provider: { kind: "codex" }, workspace: { cwd: tmpdir() } },
      },
    });
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId,
      phase: "retryable_failure",
      attempt: 1,
      nextAttemptAt: new Date(Date.now() + 30_000),
      failureCode: "native_provider_terminal_failed",
      failureDetail: { originalFailureCode: "fixture_checkpoint_unusable" },
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));

    const heartbeat = heartbeatService(db);
    expect(await heartbeat.cancelRun(runId)).toMatchObject({ status: "cancelled" });

    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    expect(coordinator).toMatchObject({ phase: "terminal_failure", nextAttemptAt: null, failureCode: "native_retry_cancelled" });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs.map((run) => ({ id: run.id, status: run.status }))).toEqual([{ id: runId, status: "cancelled" }]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
    const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(task).toMatchObject({ status: "in_progress", assigneeAgentId: agentId, executionRunId: null });
  });
});
