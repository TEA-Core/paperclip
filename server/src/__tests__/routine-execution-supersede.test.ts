import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issueReadStates,
  issueThreadInteractions,
  issues,
  projectWorkspaces,
  projects,
  routineRuns,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { routineService, supersedeOpenRoutineExecutionSiblings } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine supersede tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// SUP-13699: when a routine_execution issue reaches terminal `done`, the
// still-open earlier runs of the same routine are retired as `cancelled` with
// a supersede note naming the superseding issue.

describeEmbeddedPostgres("routine execution supersede on terminal done", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-supersede-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueThreadInteractions);
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(routineRuns);
    await db.delete(routines);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const defaultResponsibleUserId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routines",
      status: "in_progress",
    });

    const svc = routineService(db, { runtimeEnv: process.env });
    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Nightly sweep",
        description: "Nightly sweep routine",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );
    const routine2 = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "Other sweep",
        description: "Unrelated routine",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      {},
    );

    return { companyId, agentId, projectId, issuePrefix, routine, routine2, issueSvc: issueService(db) };
  }

  async function seedRun(input: {
    companyId: string;
    routineId: string;
    status?: string;
    triggeredAt?: Date;
    linkedIssueId?: string;
  }) {
    const [run] = await db
      .insert(routineRuns)
      .values({
        companyId: input.companyId,
        routineId: input.routineId,
        triggerId: null,
        source: "schedule",
        status: input.status ?? "issue_created",
        triggeredAt: input.triggeredAt ?? new Date(),
        linkedIssueId: input.linkedIssueId ?? null,
      })
      .returning();
    return run;
  }

  async function seedRoutineIssue(input: {
    companyId: string;
    projectId: string;
    agentId: string;
    routineId: string;
    identifier: string;
    status: string;
    createdAt: Date;
    originRunId?: string | null;
    executionRunId?: string;
  }) {
    const [issue] = await db
      .insert(issues)
      .values({
        companyId: input.companyId,
        projectId: input.projectId,
        title: "Nightly sweep",
        description: "Routine execution",
        status: input.status,
        priority: "medium",
        assigneeAgentId: input.agentId,
        originKind: "routine_execution",
        originId: input.routineId,
        originRunId: input.originRunId ?? null,
        identifier: input.identifier,
        executionRunId: input.executionRunId ?? null,
        executionLockedAt: input.executionRunId ? input.createdAt : null,
        blockedTransitionAt: input.status === "blocked" ? input.createdAt : null,
        completedAt: input.status === "done" ? input.createdAt : null,
        cancelledAt: input.status === "cancelled" ? input.createdAt : null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      })
      .returning();
    return issue;
  }

  it("cancels earlier open runs of the same routine when a later run reaches done", async () => {
    const { companyId, agentId, projectId, routine, routine2, issueSvc } = await seedCompany();
    const t0 = new Date("2026-08-20T00:00:00.000Z");
    const t1 = new Date("2026-08-21T00:00:00.000Z");
    const t2 = new Date("2026-08-22T00:00:00.000Z");

    // A: the stranded run — blocked, no live execution run (execution_run_id null),
    // so the open-routine-execution uniqueness index does not even see it.
    const runA = await seedRun({ companyId, routineId: routine.id, triggeredAt: t0 });
    const issueA = await seedRoutineIssue({
      companyId,
      projectId,
      agentId,
      routineId: routine.id,
      identifier: "SWP-A",
      status: "blocked",
      createdAt: t0,
      originRunId: runA.id,
    });
    await db
      .update(routineRuns)
      .set({ linkedIssueId: issueA.id })
      .where(eq(routineRuns.id, runA.id));

    // B: the later run — in progress with a live execution run.
    const liveRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: liveRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {},
      startedAt: t1,
    });
    const runB = await seedRun({ companyId, routineId: routine.id, triggeredAt: t1 });
    const issueB = await seedRoutineIssue({
      companyId,
      projectId,
      agentId,
      routineId: routine.id,
      identifier: "SWP-B",
      status: "in_progress",
      createdAt: t1,
      originRunId: runB.id,
      executionRunId: liveRunId,
    });
    await db
      .update(routineRuns)
      .set({ linkedIssueId: issueB.id })
      .where(eq(routineRuns.id, runB.id));

    // C: an unrelated blocked non-routine issue from the same period.
    const issueC = await db
      .insert(issues)
      .values({
        companyId,
        projectId,
        title: "Manual blocker",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        identifier: "MAN-C",
        createdAt: t0,
        updatedAt: t0,
      })
      .returning()
      .then((rows) => rows[0]);

    // D: an earlier open run of a DIFFERENT routine.
    const issueD = await seedRoutineIssue({
      companyId,
      projectId,
      agentId,
      routineId: routine2.id,
      identifier: "OTH-D",
      status: "in_progress",
      createdAt: t0,
    });

    // E: an open run of the same routine created AFTER B — not earlier, so not
    // eligible.
    const issueE = await seedRoutineIssue({
      companyId,
      projectId,
      agentId,
      routineId: routine.id,
      identifier: "SWP-E",
      status: "in_progress",
      createdAt: t2,
    });

    await issueSvc.update(issueB.id, { status: "done", actorUserId: "user-1" });

    const [rowA] = await db.select().from(issues).where(eq(issues.id, issueA.id));
    const [rowB] = await db.select().from(issues).where(eq(issues.id, issueB.id));
    const [rowC] = await db.select().from(issues).where(eq(issues.id, issueC.id));
    const [rowD] = await db.select().from(issues).where(eq(issues.id, issueD.id));
    const [rowE] = await db.select().from(issues).where(eq(issues.id, issueE.id));

    // A is retired with a supersede note naming B.
    expect(rowA.status).toBe("cancelled");
    expect(rowA.cancelledAt).toBeInstanceOf(Date);
    expect(rowA.executionRunId).toBeNull();
    expect(rowA.executionLockedAt).toBeNull();
    expect(rowA.monitorNextCheckAt).toBeNull();
    expect(rowA.unblockDescriptor).toBeNull();
    const commentsA = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueA.id));
    expect(commentsA).toHaveLength(1);
    expect(commentsA[0]?.authorType).toBe("system");
    expect(commentsA[0]?.body).toContain("SWP-B");
    expect(commentsA[0]?.body).toContain("Superseded");

    // B itself is done, untouched otherwise.
    expect(rowB.status).toBe("done");

    // The unrelated blocked manual issue is untouched.
    expect(rowC.status).toBe("blocked");
    const commentsC = await db.select().from(issueComments).where(eq(issueComments.issueId, issueC.id));
    expect(commentsC).toHaveLength(0);

    // The different routine's open run is untouched.
    expect(rowD.status).toBe("in_progress");
    const commentsD = await db.select().from(issueComments).where(eq(issueComments.issueId, issueD.id));
    expect(commentsD).toHaveLength(0);

    // The later-created open run is not earlier, so it stays.
    expect(rowE.status).toBe("in_progress");

    // The stranded run's routine_run ledger entry is finalized as failed.
    const [runARow] = await db.select().from(routineRuns).where(eq(routineRuns.id, runA.id));
    expect(runARow.status).toBe("failed");
    expect(runARow.failureReason).toContain("SWP-B");
    expect(runARow.completedAt).toBeInstanceOf(Date);

    // An audit row was written for the retirement.
    const auditRows = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueA.id), eq(activityLog.action, "issue.routine_execution_superseded")));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.details).toMatchObject({
      identifier: "SWP-A",
      previousStatus: "blocked",
      supersededByIssueId: issueB.id,
      supersededByIdentifier: "SWP-B",
    });
  });

  it("leaves terminal earlier siblings untouched", async () => {
    const { companyId, agentId, projectId, routine, issueSvc } = await seedCompany();
    const t0 = new Date("2026-08-19T00:00:00.000Z");
    const t1 = new Date("2026-08-20T00:00:00.000Z");
    const t2 = new Date("2026-08-21T00:00:00.000Z");

    const doneEarlier = await seedRoutineIssue({
      companyId,
      projectId,
      agentId,
      routineId: routine.id,
      identifier: "SWP-OLD-DONE",
      status: "done",
      createdAt: t0,
    });
    const cancelledEarlier = await seedRoutineIssue({
      companyId,
      projectId,
      agentId,
      routineId: routine.id,
      identifier: "SWP-OLD-CANCELLED",
      status: "cancelled",
      createdAt: t1,
    });

    const liveRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: liveRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {},
      startedAt: t2,
    });
    const later = await seedRoutineIssue({
      companyId,
      projectId,
      agentId,
      routineId: routine.id,
      identifier: "SWP-LATER",
      status: "in_progress",
      createdAt: t2,
      executionRunId: liveRunId,
    });

    await issueSvc.update(later.id, { status: "done", actorUserId: "user-1" });

    const [rowDone] = await db.select().from(issues).where(eq(issues.id, doneEarlier.id));
    const [rowCancelled] = await db.select().from(issues).where(eq(issues.id, cancelledEarlier.id));
    expect(rowDone.status).toBe("done");
    expect(rowCancelled.status).toBe("cancelled");

    const comments = await db
      .select()
      .from(issueComments)
      .where(
        eq(issueComments.issueId, doneEarlier.id),
      );
    expect(comments).toHaveLength(0);
    const commentsCancelled = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, cancelledEarlier.id));
    expect(commentsCancelled).toHaveLength(0);

    const auditRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.routine_execution_superseded"));
    expect(auditRows).toHaveLength(0);
  });

  it("does not supersede when the later run is cancelled instead of done", async () => {
    const { companyId, agentId, projectId, routine, issueSvc } = await seedCompany();
    const t0 = new Date("2026-08-20T00:00:00.000Z");
    const t1 = new Date("2026-08-21T00:00:00.000Z");

    const earlier = await seedRoutineIssue({
      companyId,
      projectId,
      agentId,
      routineId: routine.id,
      identifier: "SWP-A",
      status: "blocked",
      createdAt: t0,
    });
    const later = await seedRoutineIssue({
      companyId,
      projectId,
      agentId,
      routineId: routine.id,
      identifier: "SWP-B",
      status: "in_progress",
      createdAt: t1,
    });

    await issueSvc.update(later.id, { status: "cancelled", actorUserId: "user-1" });

    const [rowA] = await db.select().from(issues).where(eq(issues.id, earlier.id));
    expect(rowA.status).toBe("blocked");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, earlier.id));
    expect(comments).toHaveLength(0);
  });

  it("is idempotent: a second sweep and a second later run post no duplicate writes", async () => {
    const { companyId, agentId, projectId, routine, issueSvc } = await seedCompany();
    const t0 = new Date("2026-08-19T00:00:00.000Z");
    const t1 = new Date("2026-08-20T00:00:00.000Z");
    const t2 = new Date("2026-08-21T00:00:00.000Z");

    const earlier = await seedRoutineIssue({
      companyId,
      projectId,
      agentId,
      routineId: routine.id,
      identifier: "SWP-A",
      status: "blocked",
      createdAt: t0,
    });
    const liveRunId1 = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: liveRunId1,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {},
      startedAt: t1,
    });
    const later1 = await seedRoutineIssue({
      companyId,
      projectId,
      agentId,
      routineId: routine.id,
      identifier: "SWP-B1",
      status: "in_progress",
      createdAt: t1,
      executionRunId: liveRunId1,
    });
    const later2 = await seedRoutineIssue({
      companyId,
      projectId,
      agentId,
      routineId: routine.id,
      identifier: "SWP-B2",
      status: "in_progress",
      createdAt: t2,
    });

    // First sweep: B1 reaches done and retires A.
    await issueSvc.update(later1.id, { status: "done", actorUserId: "user-1" });
    const [afterFirst] = await db.select().from(issues).where(eq(issues.id, earlier.id));
    expect(afterFirst.status).toBe("cancelled");

    // Second sweep over the same superseding issue: nothing left to retire
    // (A is already cancelled; B2 is created after B1, so not earlier).
    const directSecond = await supersedeOpenRoutineExecutionSiblings(
      db,
      {
        id: later1.id,
        companyId,
        originKind: "routine_execution",
        originId: routine.id,
        identifier: "SWP-B1",
        createdAt: t1,
      },
    );
    expect(directSecond).toEqual([]);

    // A second later run also reaching done finds no open siblings.
    await issueSvc.update(later2.id, { status: "done", actorUserId: "user-1" });

    const [final] = await db.select().from(issues).where(eq(issues.id, earlier.id));
    expect(final.status).toBe("cancelled");
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, earlier.id));
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("SWP-B1");
    const auditRows = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, earlier.id), eq(activityLog.action, "issue.routine_execution_superseded")));
    expect(auditRows).toHaveLength(1);
  });

  it("ignores non-routine superseding issues", async () => {
    const { companyId, agentId, projectId, routine } = await seedCompany();
    const t0 = new Date("2026-08-20T00:00:00.000Z");

    const earlier = await seedRoutineIssue({
      companyId,
      projectId,
      agentId,
      routineId: routine.id,
      identifier: "SWP-A",
      status: "blocked",
      createdAt: t0,
    });

    const result = await supersedeOpenRoutineExecutionSiblings(db, {
      id: randomUUID(),
      companyId,
      originKind: "manual",
      originId: null,
      identifier: "MAN-X",
      createdAt: new Date("2026-08-21T00:00:00.000Z"),
    });
    expect(result).toEqual([]);

    const [row] = await db.select().from(issues).where(eq(issues.id, earlier.id));
    expect(row.status).toBe("blocked");
  });
});
