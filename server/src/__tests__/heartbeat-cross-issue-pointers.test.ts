import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issuePlanDecompositions,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";
import { executionWorkspaceService } from "../services/execution-workspaces.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres cross-issue pointer tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;

async function resetDatabase(db: Db) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await db.delete(issuePlanDecompositions);
      await db.delete(issueDocuments);
      await db.delete(documentRevisions);
      await db.delete(documents);
      await db.delete(agentTaskSessions);
      await db.delete(environmentLeases);
      await db.delete(workspaceOperations);
      await db.delete(activityLog);
      await db.delete(heartbeatRunEvents);
      await db.delete(issueComments);
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      await db.delete(issues);
      await db.delete(projectWorkspaces);
      await db.delete(projects);
      await db.delete(agents);
      await db.delete(executionWorkspaces);
      await db.delete(environments);
      await db.delete(companySkills);
      await db.delete(companies);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

/**
 * The invariant under test: a card's execution pointers may only name a run
 * whose own context issue is that same card.
 *
 * The production defect (SUP-16052) stamped SUP-16046's `executionRunId` and
 * `checkoutRunId` with a run whose context issue was SUP-16044. Both cards
 * were assigned to the same agent, and the foreign run left each card in a
 * permanent false "mid-run" state.
 */
async function assertPointersScopedToOwnIssue(
  db: Db,
  issuesUnderTest: Array<{ id: string; identifier: string }>,
) {
  const wanted = new Set(issuesUnderTest.map((i) => i.id));
  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      executionRunId: issues.executionRunId,
      checkoutRunId: issues.checkoutRunId,
    })
    .from(issues)
    .then((all) => all.filter((row) => wanted.has(row.id)));

  const runIds = [
    ...new Set(
      rows
        .flatMap((row) => [row.executionRunId, row.checkoutRunId])
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const runContexts = new Map<string, string | null>();
  for (const runId of runIds) {
    const run = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((r) => r[0] ?? null);
    const context = (run?.contextSnapshot ?? {}) as Record<string, unknown>;
    runContexts.set(runId, typeof context.issueId === "string" ? context.issueId : null);
  }

  for (const row of rows) {
    for (const [column, runId] of [
      ["executionRunId", row.executionRunId],
      ["checkoutRunId", row.checkoutRunId],
    ] as const) {
      if (!runId) continue;
      const ownIssueId = runContexts.get(runId) ?? null;
      expect(
        ownIssueId,
        `${row.identifier}.${column} (${runId}) must be scoped to ${row.identifier}, but its context issue is ${ownIssueId}`,
      ).toBe(row.id);
    }
  }
}

describeEmbeddedPostgres("heartbeat cross-issue execution pointers", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-issue-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await resetDatabase(db);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  }, 60_000);

  it(
    "refuses to stamp a card's pointers with a run whose context names a different issue",
    async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueAId = randomUUID();
      const issueBId = randomUUID();
      const runId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Acme",
        issuePrefix: "PAP",
        status: "active",
        defaultResponsibleUserId: "responsible-user",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "SharedCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      for (const [issueId, identifier] of [
        [issueAId, "Card A"],
        [issueBId, "Card B"],
      ] as const) {
        await db.insert(issues).values({
          id: issueId,
          companyId,
          title: identifier,
          status: "in_progress",
          assigneeAgentId: agentId,
          identifier,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      // The acting run belongs to Card A.
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId: issueAId, taskId: issueAId },
        responsibleUserId: "responsible-user",
      });

      const svc = issueService(db);

      // Checking out Card B with Card A's run must be refused: it would stamp
      // both of Card B's pointers with a foreign run.
      await expect(
        svc.checkout(issueBId, agentId, ["in_progress"], runId),
      ).rejects.toThrow();

      const cardB = await db
        .select({
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
          status: issues.status,
        })
        .from(issues)
        .where(eq(issues.id, issueBId))
        .then((rows) => rows[0]);
      expect(cardB.checkoutRunId).toBeNull();
      expect(cardB.executionRunId).toBeNull();

      // The matching checkout still succeeds and stamps Card A with its own run.
      await svc.checkout(issueAId, agentId, ["in_progress"], runId);
      const cardA = await db
        .select({
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, issueAId))
        .then((rows) => rows[0]);
      expect(cardA.checkoutRunId).toBe(runId);
      expect(cardA.executionRunId).toBe(runId);

      await assertPointersScopedToOwnIssue(db, [
        { id: issueAId, identifier: "Card A" },
        { id: issueBId, identifier: "Card B" },
      ]);
    },
    60_000,
  );

  it(
    "two sibling cards with clean pointers do not report each other as their workspace occupant",
    async () => {
      const companyId = randomUUID();
      const projectId = randomUUID();
      const projectWorkspaceId = randomUUID();
      const agentId = randomUUID();
      const issueAId = randomUUID();
      const issueBId = randomUUID();
      const workspaceAId = randomUUID();
      const workspaceBId = randomUUID();
      const runAId = randomUUID();
      const runBId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Acme",
        issuePrefix: "PAP",
        status: "active",
        defaultResponsibleUserId: "responsible-user",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Shared",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Primary",
        cwd: "/tmp/paperclip-cross-issue-occupancy",
        isPrimary: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "SharedCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      // Insert in dependency order: issues.execution_workspace_id references
      // execution_workspaces, whose source_issue_id references issues, and the
      // issue pointer columns reference heartbeat_runs. Create the bare issue
      // rows, then workspaces, then runs, then bind the pointers.
      for (const [issueId, identifier] of [
        [issueAId, "Card A"],
        [issueBId, "Card B"],
      ] as const) {
        await db.insert(issues).values({
          id: issueId,
          companyId,
          projectId,
          projectWorkspaceId,
          title: identifier,
          status: "in_progress",
          assigneeAgentId: agentId,
          identifier,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      for (const [workspaceId, sourceIssueId] of [
        [workspaceAId, issueAId],
        [workspaceBId, issueBId],
      ] as const) {
        await db.insert(executionWorkspaces).values({
          id: workspaceId,
          companyId,
          projectId,
          projectWorkspaceId,
          sourceIssueId,
          mode: "isolated_workspace",
          strategyType: "git_worktree",
          name: `workspace-${sourceIssueId.slice(0, 8)}`,
          status: "active",
          providerType: "local_fs",
          metadata: {},
        });
      }
      for (const [runId, issueId] of [
        [runAId, issueAId],
        [runBId, issueBId],
      ] as const) {
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId,
          agentId,
          status: "queued",
          contextSnapshot: { issueId, taskId: issueId },
          responsibleUserId: "responsible-user",
        });
      }
      for (const [issueId, workspaceId, runId] of [
        [issueAId, workspaceAId, runAId],
        [issueBId, workspaceBId, runBId],
      ] as const) {
        await db
          .update(issues)
          .set({
            executionWorkspaceId: workspaceId,
            executionRunId: runId,
            checkoutRunId: runId,
          })
          .where(eq(issues.id, issueId));
      }

      const svc = executionWorkspaceService(db);
      // Each card looks at its own isolated workspace. The only bound issue is
      // itself (excluded), so no occupant may be reported.
      const occupantA = await svc.findActiveRunOccupyingWorkspace({
        companyId,
        executionWorkspaceId: workspaceAId,
        excludingIssueId: issueAId,
        excludingRunId: runAId,
      });
      expect(occupantA).toBeNull();
      const occupantB = await svc.findActiveRunOccupyingWorkspace({
        companyId,
        executionWorkspaceId: workspaceBId,
        excludingIssueId: issueBId,
        excludingRunId: runBId,
      });
      expect(occupantB).toBeNull();

      await assertPointersScopedToOwnIssue(db, [
        { id: issueAId, identifier: "Card A" },
        { id: issueBId, identifier: "Card B" },
      ]);
    },
    60_000,
  );

  it(
    "two sibling cards contending for one workspace: the later-created run defers, at most one does",
    async () => {
      const companyId = randomUUID();
      const projectId = randomUUID();
      const projectWorkspaceId = randomUUID();
      const agentId = randomUUID();
      const issueAId = randomUUID();
      const issueBId = randomUUID();
      const workspaceId = randomUUID();
      const runAId = randomUUID();
      const runBId = randomUUID();
      const runACreatedAt = new Date("2026-09-13T06:24:54.788Z");
      const runBCreatedAt = new Date("2026-09-13T06:24:54.790Z");

      await db.insert(companies).values({
        id: companyId,
        name: "Acme",
        issuePrefix: "PAP",
        status: "active",
        defaultResponsibleUserId: "responsible-user",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Shared",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Primary",
        cwd: "/tmp/paperclip-cross-issue-contention",
        isPrimary: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "SharedCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      for (const [issueId, identifier] of [
        [issueAId, "Card A"],
        [issueBId, "Card B"],
      ] as const) {
        await db.insert(issues).values({
          id: issueId,
          companyId,
          projectId,
          projectWorkspaceId,
          title: identifier,
          status: "in_progress",
          assigneeAgentId: agentId,
          identifier,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      await db.insert(executionWorkspaces).values({
        id: workspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        sourceIssueId: issueAId,
        mode: "shared_workspace",
        strategyType: "git_worktree",
        name: "shared-workspace",
        status: "active",
        providerType: "local_fs",
        metadata: {},
      });
      for (const [runId, issueId, createdAt] of [
        [runAId, issueAId, runACreatedAt],
        [runBId, issueBId, runBCreatedAt],
      ] as const) {
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId,
          agentId,
          status: "queued",
          contextSnapshot: { issueId, taskId: issueId, executionWorkspaceId: workspaceId },
          responsibleUserId: "responsible-user",
          createdAt,
          updatedAt: createdAt,
        });
      }
      for (const [issueId, runId] of [
        [issueAId, runAId],
        [issueBId, runBId],
      ] as const) {
        await db
          .update(issues)
          .set({
            executionWorkspaceId: workspaceId,
            executionRunId: runId,
            checkoutRunId: runId,
          })
          .where(eq(issues.id, issueId));
      }

      const svc = executionWorkspaceService(db);
      // Card B's run was created later, so it yields to Card A's earlier run.
      const occupantForB = await svc.findActiveRunOccupyingWorkspace({
        companyId,
        executionWorkspaceId: workspaceId,
        excludingIssueId: issueBId,
        excludingRunId: runBId,
        contenderRunCreatedAt: runBCreatedAt,
      });
      expect(occupantForB?.runId).toBe(runAId);
      // Card A got in line first, so it must not see Card B as an occupant and
      // must not defer too (the production defect: both deferred forever).
      const occupantForA = await svc.findActiveRunOccupyingWorkspace({
        companyId,
        executionWorkspaceId: workspaceId,
        excludingIssueId: issueAId,
        excludingRunId: runAId,
        contenderRunCreatedAt: runACreatedAt,
      });
      expect(occupantForA).toBeNull();

      const deferring = [occupantForA, occupantForB].filter((row) => row !== null);
      expect(deferring).toHaveLength(1);
    },
    60_000,
  );

  it(
    "a run cannot adopt a stale pointer pointing at another issue's run",
    async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueAId = randomUUID();
      const issueBId = randomUUID();
      const foreignRunId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Acme",
        issuePrefix: "PAP",
        status: "active",
        defaultResponsibleUserId: "responsible-user",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "SharedCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      for (const [issueId, identifier] of [
        [issueAId, "Card A"],
        [issueBId, "Card B"],
      ] as const) {
        await db.insert(issues).values({
          id: issueId,
          companyId,
          title: identifier,
          status: "todo",
          assigneeAgentId: agentId,
          identifier,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      // Card A's run, in a terminal state, so the "stale adoption" branch would
      // otherwise try to adopt it onto Card B.
      await db.insert(heartbeatRuns).values({
        id: foreignRunId,
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: { issueId: issueAId, taskId: issueAId },
        responsibleUserId: "responsible-user",
      });

      const svc = issueService(db);
      // Seed Card B with a stale pointer to Card A's terminal run — exactly the
      // contaminated state the guard must stop from being reinforced.
      await db
        .update(issues)
        .set({ executionRunId: foreignRunId, checkoutRunId: foreignRunId })
        .where(and(eq(issues.id, issueBId), eq(issues.companyId, companyId)));

      await expect(
        svc.checkout(issueBId, agentId, ["todo"], foreignRunId),
      ).rejects.toThrow();

      const cardB = await db
        .select({
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, issueBId))
        .then((rows) => rows[0]);
      expect(cardB.checkoutRunId).toBeNull();
      expect(cardB.executionRunId).toBeNull();
    },
    60_000,
  );

  it(
    "assertCheckoutOwner refuses to adopt a foreign run onto an unowned card",
    async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueAId = randomUUID();
      const issueBId = randomUUID();
      const foreignRunId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Acme",
        issuePrefix: "PAP",
        status: "active",
        defaultResponsibleUserId: "responsible-user",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "SharedCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      for (const [issueId, identifier] of [
        [issueAId, "Card A"],
        [issueBId, "Card B"],
      ] as const) {
        await db.insert(issues).values({
          id: issueId,
          companyId,
          title: identifier,
          status: "in_progress",
          assigneeAgentId: agentId,
          identifier,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      await db.insert(heartbeatRuns).values({
        id: foreignRunId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId: issueAId, taskId: issueAId },
        responsibleUserId: "responsible-user",
      });

      const svc = issueService(db);

      // This is the production write path: every agent write calls
      // assertCheckoutOwner, which adopts an unowned card for the acting run.
      // Card B is unowned, so before the guard the foreign run (Card A's) was
      // adopted and B's pointers were stamped with it.
      await expect(
        svc.assertCheckoutOwner(issueBId, agentId, foreignRunId),
      ).rejects.toThrow();

      const cardB = await db
        .select({
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, issueBId))
        .then((rows) => rows[0]);
      expect(cardB.checkoutRunId).toBeNull();
      expect(cardB.executionRunId).toBeNull();

      // The same run still owns the card it was actually launched for.
      const ownership = await svc.assertCheckoutOwner(issueAId, agentId, foreignRunId);
      expect(ownership.checkoutRunId).toBe(foreignRunId);
      expect(ownership.executionRunId).toBe(foreignRunId);

      await assertPointersScopedToOwnIssue(db, [
        { id: issueAId, identifier: "Card A" },
        { id: issueBId, identifier: "Card B" },
      ]);
    },
    60_000,
  );

  it(
    "assertCheckoutOwner refuses to stale-adopt a foreign run and preserves a live retry's execution pointer",
    async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const issueAId = randomUUID();
      const issueBId = randomUUID();
      const staleRunId = randomUUID();
      const retryRunId = randomUUID();
      const foreignRunId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: "Acme",
        issuePrefix: "PAP",
        status: "active",
        defaultResponsibleUserId: "responsible-user",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "SharedCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      for (const [issueId, identifier] of [
        [issueAId, "Card A"],
        [issueBId, "Card B"],
      ] as const) {
        await db.insert(issues).values({
          id: issueId,
          companyId,
          title: identifier,
          status: "in_progress",
          assigneeAgentId: agentId,
          identifier,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      // Card B in the retry shape: checkout pinned at the terminal run that
      // finalization has not yet released, execution already handed to a live
      // retry run. Card A's run is the foreign actor.
      await db.insert(heartbeatRuns).values({
        id: staleRunId,
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: { issueId: issueBId, taskId: issueBId },
        responsibleUserId: "responsible-user",
      });
      await db.insert(heartbeatRuns).values({
        id: retryRunId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId: issueBId, taskId: issueBId },
        responsibleUserId: "responsible-user",
      });
      await db.insert(heartbeatRuns).values({
        id: foreignRunId,
        companyId,
        agentId,
        status: "running",
        contextSnapshot: { issueId: issueAId, taskId: issueAId },
        responsibleUserId: "responsible-user",
      });
      await db
        .update(issues)
        .set({ checkoutRunId: staleRunId, executionRunId: retryRunId })
        .where(eq(issues.id, issueBId));

      const svc = issueService(db);

      // The stale-adoption branch would otherwise overwrite both of Card B's
      // pointers with Card A's run, clobbering the live retry's execution lock.
      await expect(
        svc.assertCheckoutOwner(issueBId, agentId, foreignRunId),
      ).rejects.toThrow();

      const cardB = await db
        .select({
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, issueBId))
        .then((rows) => rows[0]);
      expect(cardB.checkoutRunId).toBe(staleRunId);
      expect(cardB.executionRunId).toBe(retryRunId);
    },
    60_000,
  );
});
