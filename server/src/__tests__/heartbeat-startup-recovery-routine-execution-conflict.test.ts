import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { logger } from "../middleware/logger.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine-execution claim-conflict tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// SUP-17429: startup heartbeat recovery can kill the server on boot. The
// `claimQueuedRun` "Fix A lazy locking" step stamps `issues.execution_run_id`
// for the newly running run. The partial unique index
// `issues_open_routine_execution_uq` allows only ONE open execution per
// (company, origin_kind='routine_execution', origin_id, origin_fingerprint).
// When a sibling routine-execution issue already holds that slot, the lazy-lock
// update violates the index; the uncaught unique-violation propagates out of
// resumeQueuedRuns on the boot path and takes the whole server down.
//
// These tests seed that exact collision and assert the claim is skipped
// (run stays queued, lock never stamped) while a genuine non-unique write
// failure on the lazy-lock still surfaces.
describeEmbeddedPostgres("heartbeat startup recovery vs open routine execution slot", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-routine-exec-claim-conflict-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  function isHeartbeatRunDependentFkError(error: unknown) {
    const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
    return (
      message.includes("heartbeat_run_events_run_id_heartbeat_runs_id_fk") ||
      message.includes("activity_log_run_id_heartbeat_runs_id_fk")
    );
  }

  async function deleteHeartbeatRunsWithDependents() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(heartbeatRunEvents);
      await db.delete(activityLog);
      try {
        await db.delete(heartbeatRuns);
        return;
      } catch (error) {
        if (!isHeartbeatRunDependentFkError(error) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await deleteHeartbeatRunsWithDependents();
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(companyId: string, agentId: string) {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Routine Runner",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      },
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });
  }

  // Two routine-execution issues sharing the same origin. `open` already holds
  // an open execution (executionRunId set, status open) so it occupies the
  // partial index slot. `candidate` has no execution yet but a queued run for
  // the same agent; claiming that run would stamp executionRunId and collide.
  async function seedConflictingRoutineExecution() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const routineOriginId = randomUUID();
    const openIssueId = randomUUID();
    const candidateIssueId = randomUUID();
    const openRunId = randomUUID();
    const candidateRunId = randomUUID();
    const openWakeupId = randomUUID();
    const candidateWakeupId = randomUUID();

    await seedCompanyAndAgent(companyId, agentId);

    // The open execution row must exist before the open issue references it as
    // its executionRunId (issues.execution_run_id -> heartbeat_runs.id FK).
    await db.insert(agentWakeupRequests).values({
      id: openWakeupId,
      companyId,
      agentId,
      source: "assignment",
      status: "claimed",
    });

    await db.insert(heartbeatRuns).values({
      id: openRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId: openWakeupId,
      startedAt: new Date(),
      contextSnapshot: { issueId: openIssueId, wakeReason: "issue_assigned" },
    });

    await db.insert(issues).values({
      id: openIssueId,
      companyId,
      title: "Routine execution already open",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      originKind: "routine_execution",
      originId: routineOriginId,
      originFingerprint: "default",
      executionRunId: openRunId,
      executionAgentNameKey: "routine-runner",
      executionLockedAt: new Date(),
    });

    await db.insert(issues).values({
      id: candidateIssueId,
      companyId,
      title: "Conflicting routine execution candidate",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      originKind: "routine_execution",
      originId: routineOriginId,
      originFingerprint: "default",
    });

    await db.insert(agentWakeupRequests).values({
      id: candidateWakeupId,
      companyId,
      agentId,
      source: "assignment",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: candidateRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: candidateWakeupId,
      contextSnapshot: { issueId: candidateIssueId, wakeReason: "issue_assigned" },
    });

    return {
      companyId,
      agentId,
      routineOriginId,
      openIssueId,
      candidateIssueId,
      openRunId,
      candidateRunId,
      candidateWakeupId,
    };
  }

  // A single non-routine (manual origin) issue with a queued run. Because the
  // issue's origin_kind is not 'routine_execution', the open-slot guard does
  // not apply, so the claim proceeds all the way to the lazy-lock write —
  // which is exactly the write we want to fault in the next test.
  async function seedPlainQueuedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await seedCompanyAndAgent(companyId, agentId);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Plain queued run",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    return { companyId, agentId, issueId, runId, wakeupRequestId };
  }

  // Faults ONLY the lazy-lock write (`db.update(issues)`) with a generic,
  // non-unique error, passing every other db operation through untouched. This
  // proves the lazy-lock guard catches only `issues_open_routine_execution_uq`
  // and still lets a genuine write failure surface instead of being swallowed.
  function withFailingLazyLockUpdate(realDb: typeof db) {
    const origUpdate = (realDb as unknown as { update: (t: unknown) => unknown }).update.bind(realDb);
    return new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop === "update") {
          return (table: unknown) => {
            if (table === issues) {
              return {
                set: () => ({
                  where: () =>
                    Promise.reject(new Error("simulated lazy-lock write failure")),
                }),
              };
            }
            return origUpdate(table);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  it("skips the conflicting routine-execution candidate and leaves the run queued", async () => {
    const { candidateIssueId, candidateRunId, openIssueId, openRunId } =
      await seedConflictingRoutineExecution();
    const heartbeat = heartbeatService(db);

    // On unmodified code this rejects with the
    // issues_open_routine_execution_uq unique violation (the crash that killed
    // the boot). With the fix it resolves: the conflicting candidate is
    // skipped, so the run is never claimed and its lock is never stamped.
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger as never);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const candidateRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, candidateRunId))
      .then((rows) => rows[0] ?? null);
    expect(candidateRun?.status).toBe("queued");

    const candidateIssue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, candidateIssueId))
      .then((rows) => rows[0] ?? null);
    expect(candidateIssue?.executionRunId).toBeNull();

    const openIssue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, openIssueId))
      .then((rows) => rows[0] ?? null);
    expect(openIssue?.executionRunId).toBe(openRunId);

    // AC2: the skip is reported with a log line naming the conflicting issue
    // and the sibling that already holds the slot.
    const conflictLog = warnSpy.mock.calls.find((call) =>
      call.some(
        (arg) =>
          typeof arg === "string" &&
          arg.includes("issues_open_routine_execution_uq"),
      ),
    );
    expect(conflictLog).toBeDefined();
    const conflictFields = conflictLog?.find(
      (arg) => typeof arg === "object" && arg !== null,
    );
    expect(conflictFields).toMatchObject({
      issueId: candidateIssueId,
      siblingIssueId: openIssueId,
      siblingExecutionRunId: openRunId,
    });
  }, 20_000);

  it("still surfaces a non-unique-violation write failure on the lazy-lock", async () => {
    await seedPlainQueuedRun();
    const heartbeat = heartbeatService(withFailingLazyLockUpdate(db));

    // The plain (non-routine) candidate is not skipped by the open-slot guard,
    // so the claim reaches the lazy-lock write. That write is faulted with a
    // generic error; the guard must rethrow it (not treat it as the routine
    // unique hit), so resumeQueuedRuns rejects.
    await expect(heartbeat.resumeQueuedRuns()).rejects.toThrow(
      "simulated lazy-lock write failure",
    );
  }, 20_000);

  it("detects an open sibling holding the routine-execution slot", async () => {
    const { companyId, routineOriginId, openIssueId, candidateIssueId } =
      await seedConflictingRoutineExecution();

    const openSibling = await db
      .select({ id: issues.id, executionRunId: issues.executionRunId })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "routine_execution"),
          eq(issues.originId, routineOriginId),
          eq(issues.originFingerprint, "default"),
          ne(issues.id, candidateIssueId),
          isNotNull(issues.executionRunId),
          isNull(issues.hiddenAt),
          inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
        ),
      )
      .then((rows) => rows[0] ?? null);

    expect(openSibling?.id).toBe(openIssueId);
    expect(openSibling?.executionRunId).not.toBeNull();
  }, 20_000);
});
