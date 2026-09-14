import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY,
  executionWorkspaceService,
  metadataHasReopenPendingConsumption,
  readExecutionWorkspaceLifecycleGeneration,
  type ReopenClosedIsolatedExecutionWorkspaceResult,
} from "../services/execution-workspaces.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres closed-workspace checkout-boundary tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// SUP-16162 (redo) regression for the `terminal-close-after-checkout-before-reopen`
// signature. The checkout route may rebuild a closed isolated workspace only while
// the persisted checkout state that authorized it is still live at the reopen
// boundary. These cases exercise the real advisory-locked reopen transaction against
// an embedded Postgres, not `getById` mock sequencing, so they prove the invariant a
// mock test cannot: a terminal close that commits before the reopen leaves the
// workspace row closed with no active/pending fence.
describeEmbeddedPostgres("checkout reopen boundary is atomic with the persisted issue status", () => {
  let db!: ReturnType<typeof createDb>;
  let db2!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-closed-checkout-");
    db = createDb(tempDb.connectionString);
    // A second, independent pool. A terminal close driven on db2 runs on a
    // different physical connection than the reopen (which runs on db), so the
    // two contend on the issue row lock the way two server processes would.
    db2 = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await db2.$client.end();
    await tempDb?.cleanup();
  });

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  // Poll until `probe` returns a truthy value, or throw after `timeoutMs`.
  async function until(probe: () => boolean | Promise<boolean>, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await probe()) return;
      if (Date.now() >= deadline) throw new Error("until: timed out waiting for condition");
      await sleep(10);
    }
  }

  async function makeExistingDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-closed-checkout-cwd-"));
    tempDirs.push(dir);
    return dir;
  }

  async function seedCompanyProject() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `PAP-${companyId.slice(0, 8)}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Closed checkout boundary project",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      cwd: "/tmp/paperclip-closed-checkout-project",
      isPrimary: true,
    });
    return { companyId, projectId, projectWorkspaceId };
  }

  // Seed one closed isolated project_primary row so the rebuild only checks that the
  // directory exists, with no git operation.
  async function seedClosedWorkspace(input: {
    companyId: string;
    projectId: string;
    projectWorkspaceId: string;
    cwd: string;
    generation?: number;
  }) {
    const workspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId: input.companyId,
      projectId: input.projectId,
      projectWorkspaceId: input.projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "project_primary",
      name: "closed-checkout-workspace",
      status: "archived",
      providerType: "local_fs",
      cwd: input.cwd,
      closedAt: new Date(),
      cleanupReason: "issue_terminal",
      cleanupEligibleAt: new Date(),
      metadata: {
        [EXECUTION_WORKSPACE_LIFECYCLE_GENERATION_METADATA_KEY]: input.generation ?? 1,
      },
    });
    return workspaceId;
  }

  async function seedIssue(input: {
    companyId: string;
    projectId: string;
    workspaceId: string;
    status: string;
    issueNumber: number;
  }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      projectId: input.projectId,
      identifier: `PAP-${input.issueNumber}`,
      issueNumber: input.issueNumber,
      title: "Checkout boundary issue",
      status: input.status,
      priority: "medium",
      executionWorkspaceId: input.workspaceId,
    });
    return issueId;
  }

  async function readWorkspace(id: string) {
    return db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, id))
      .then((rows) => rows[0] ?? null);
  }

  it("reopens a live card atomically (the requireLiveIssue flag keeps the normal path green)", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd, generation: 3 });
    // Live at the boundary: the checkout write persisted, so the card is in_progress.
    const issueId = await seedIssue({ companyId, projectId, workspaceId, status: "in_progress", issueNumber: 4200 });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "agent" },
      requireLiveIssue: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reopened).toBe(true);

    const row = await readWorkspace(workspaceId);
    expect(row?.status).toBe("active");
    expect(row?.closedAt).toBeNull();
    expect(metadataHasReopenPendingConsumption(row?.metadata as Record<string, unknown> | null)).toBe(true);
    expect(readExecutionWorkspaceLifecycleGeneration(row?.metadata as Record<string, unknown> | null)).toBe(4);
  });

  it("refuses to rebuild when a terminal close commits after the checkout write but before the reopen", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd, generation: 3 });
    // After the checkout write the card is live (in_progress) — the persisted
    // checkout state that authorizes the reopen.
    const issueId = await seedIssue({ companyId, projectId, workspaceId, status: "in_progress", issueNumber: 4201 });

    // The concurrent close commits to the real persistence boundary. A pre-reopen
    // observation would have seen in_progress; by the time the reopen runs, the
    // card is terminal. This is the exact interleaving the route-level read could
    // not guard against.
    await db
      .update(issues)
      .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(issues.id, issueId));

    let rebuildEntered = false;
    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "agent" },
      requireLiveIssue: true,
      rebuildBarrier: async () => {
        rebuildEntered = true;
      },
    });

    // The service refused at the atomic boundary, before any rebuild.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("issue_not_live");
    // The rebuild seam was never reached: the row-lock read observed the committed
    // terminal status and refused before the rebuild was scheduled.
    expect(rebuildEntered).toBe(false);

    // The persisted row is unchanged: still terminal/closed, no active status, and
    // no reopen-pending fence left for the terminal reaper to skip forever.
    const row = await readWorkspace(workspaceId);
    expect(row?.status).toBe("archived");
    expect(row?.closedAt).not.toBeNull();
    expect(row?.cleanupReason).toBe("issue_terminal");
    expect(metadataHasReopenPendingConsumption(row?.metadata as Record<string, unknown> | null)).toBe(false);

    // The card is still terminal; the reopen did not re-open it or republish it.
    const issueRow = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issueRow?.status).toBe("done");
  });

  it("still reopens a terminal card when the caller does not require a live issue (comment/update path preserved)", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd, generation: 3 });
    // The comment/update routes reopen a workspace precisely so a terminal card
    // can be moved back to live by the route mutation that follows. Without the
    // requireLiveIssue flag the boundary check is off, so a terminal card still
    // reopens.
    const issueId = await seedIssue({ companyId, projectId, workspaceId, status: "done", issueNumber: 4202 });

    const svc = executionWorkspaceService(db);
    const result = await svc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: issueId, companyId, projectId },
      actor: { agentId: null, actorType: "user" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reopened).toBe(true);

    const row = await readWorkspace(workspaceId);
    expect(row?.status).toBe("active");
    expect(metadataHasReopenPendingConsumption(row?.metadata as Record<string, unknown> | null)).toBe(true);
  });

  it("blocks a concurrent terminal close on the issue row lock held across the reopen boundary (two-connection race)", async () => {
    const { companyId, projectId, projectWorkspaceId } = await seedCompanyProject();
    const cwd = await makeExistingDir();
    const workspaceId = await seedClosedWorkspace({ companyId, projectId, projectWorkspaceId, cwd, generation: 3 });
    // Live at the boundary: the checkout write persisted, so the card is in_progress.
    const issueId = await seedIssue({ companyId, projectId, workspaceId, status: "in_progress", issueNumber: 4203 });

    let reachedSeam = false;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    let reopenResult!: ReopenClosedIsolatedExecutionWorkspaceResult;
    let reopenError: unknown = null;
    // Kick off the checkout reopen on pool db WITHOUT awaiting it. It takes the
    // workspace advisory lock, does the FOR SHARE read of the issue row, and pauses
    // at the rebuild barrier — still inside its open transaction, still holding the
    // issue row lock that a terminal close must wait on.
    const reopenPromise = (async () => {
      try {
        reopenResult = await executionWorkspaceService(db).reopenClosedIsolatedExecutionWorkspaceForIssue({
          workspaceId,
          issue: { id: issueId, companyId, projectId },
          actor: { agentId: null, actorType: "agent" },
          requireLiveIssue: true,
          rebuildBarrier: async () => {
            reachedSeam = true;
            await gate;
          },
        });
      } catch (error) {
        reopenError = error;
      }
    })();

    // Prove the reopen reached the seam, i.e. the issue row lock is actually held.
    await until(() => reachedSeam);

    // Drive the terminal close on an independent connection, the way the close
    // path does. While the reopen holds the FOR SHARE row lock, this exclusive
    // write must block waiting for the reopen's transaction to end.
    const closePromise = db2
      .update(issues)
      .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
      .where(eq(issues.id, issueId));

    // Bounded wait. This is the assertion a plain read (the row-lock mutant)
    // cannot satisfy: with the lock the close has not settled yet; without it the
    // close commits immediately and this races to `true`.
    const closeSettled = await Promise.race([
      closePromise.then(
        () => true,
        () => true,
      ),
      sleep(400).then(() => false),
    ]);
    expect(closeSettled, "terminal close must block while the reopen holds the issue row lock").toBe(false);

    // Release the barrier. The reopen publishes the active row and commits,
    // releasing the row lock; the close then unblocks and commits.
    releaseGate();
    await reopenPromise;
    expect(reopenError, `reopen threw: ${String(reopenError)}`).toBeNull();
    expect(reopenResult.ok).toBe(true);
    if (!reopenResult.ok) return;
    expect(reopenResult.reopened).toBe(true);
    await closePromise;

    // Final persisted state is coherent: the card is terminal (the close won in
    // wall-clock time but committed after the boundary), and the workspace is the
    // ordinary active-then-closed outcome — an active row with no stale closedAt,
    // a single generation bump, and the reopen fence the terminal sweep owns.
    const row = await readWorkspace(workspaceId);
    expect(row?.status).toBe("active");
    expect(row?.closedAt).toBeNull();
    expect(metadataHasReopenPendingConsumption(row?.metadata as Record<string, unknown> | null)).toBe(true);
    expect(readExecutionWorkspaceLifecycleGeneration(row?.metadata as Record<string, unknown> | null)).toBe(4);

    const issueRow = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0] ?? null);
    expect(issueRow?.status).toBe("done");
  });
});
