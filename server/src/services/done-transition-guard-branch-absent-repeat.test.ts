import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";

// Only the network, credential and git boundaries are stubbed. The database,
// the guard, the stranded-summary reaper and the repeat cap are real.
vi.mock("./github-fetch.js", () => ({
  ghFetch: vi.fn(),
  gitHubApiBase: () => "https://api.github.com",
}));

const mockResolveGitHubToken = vi.hoisted(() => vi.fn());
vi.mock("./github-credential.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-credential.js")>()),
  resolveGitHubToken: mockResolveGitHubToken,
}));

const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { spawnFromExecFile } = await import("../__tests__/helpers/spawn-from-exec-file.js");
  return { ...actual, execFile: mockExecFile, spawn: spawnFromExecFile(mockExecFile) };
});

import { ghFetch } from "./github-fetch.js";
import { writeGuardSkippedAuditLog } from "./done-transition-guard.js";
import {
  reapStrandedSummaryGenerationIssues,
  SUMMARIZER_AGENT_ID,
} from "./execution-control-reconciliation.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const SKIPPED = "issue.done_transition_guard_skipped";
const SKIP_REPEATED = "issue.done_transition_guard_skip_repeated";
const BRANCH_A = "SUP-9001-first-absent-branch";
const BRANCH_B = "SUP-9001-second-absent-branch";

// SUP-24557 (SUP-24216): a card whose execution branch is absent from the
// remote, and whose worktree still carries issue-attributable commits, is
// refused by the done-transition guard on every 15 s stranded-summary tick,
// and each refusal wrote one `issue.done_transition_guard_skipped` row.
describeEmbeddedPostgres("SUP-24557 repeated branch_absent_on_remote guard-skip rows", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let projectId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("branch-absent-repeat-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Branch Absent Repeat",
      issuePrefix: `B${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: SUMMARIZER_AGENT_ID,
      companyId,
      name: "Summarizer",
      adapterType: "claude_local",
      status: "idle",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Branch Absent Repeat" });
  }, 30_000);

  beforeEach(() => {
    mockResolveGitHubToken.mockReset();
    mockResolveGitHubToken.mockResolvedValue({ token: "test-token", scope: "company", secretName: "GITHUB_TOKEN" });
    // The worktree carries one issue-attributable commit, five ahead of base.
    mockExecFile.mockReset();
    mockExecFile.mockImplementation(
      (_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
        cb(null, args.includes("--grep") ? "1" : "5");
      },
    );
    vi.mocked(ghFetch).mockReset();
    vi.mocked(ghFetch).mockImplementation(async (url: string) => {
      if (url.includes("/compare/") || url.includes("/git/ref/heads/")) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      if (url.includes("/search/issues")) {
        return new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
  });

  afterEach(async () => {
    await db.delete(activityLog).where(eq(activityLog.companyId, companyId));
    await db.delete(issues).where(eq(issues.companyId, companyId));
    await db.delete(executionWorkspaces).where(eq(executionWorkspaces.companyId, companyId));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** A Summarizer-assigned card, outside the settle window, whose workspace names `branch`. */
  async function seedStrandedCard(branch: string) {
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      sourceIssueId: null,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "branch-absent",
      status: "active",
      cwd: "/tmp/branch-absent",
      providerType: "git_worktree",
      providerRef: "/tmp/branch-absent",
      repoUrl: "https://github.com/TEA-Core/paperclip",
      baseRef: "fold/base",
      branchName: branch,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      executionWorkspaceId: workspaceId,
      identifier: "SUP-9001",
      title: "Absent branch card",
      status: "in_progress",
      assigneeAgentId: SUMMARIZER_AGENT_ID,
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });
    return { issueId, workspaceId };
  }

  const setBranch = (workspaceId: string, branch: string) =>
    db.update(executionWorkspaces).set({ branchName: branch }).where(eq(executionWorkspaces.id, workspaceId));

  const rows = (issueId: string, action: string) =>
    db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, action)));

  const bySignature = (found: Array<{ details: unknown }>, signature: string) =>
    found.filter((row) => (row.details as { repeatSignature?: string }).repeatSignature === signature);

  const statusOf = (issueId: string) =>
    db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((found) => found[0]?.status);

  const tickReaper = async () => {
    expect(await reapStrandedSummaryGenerationIssues(db)).toEqual({ scanned: 1, terminalized: 0 });
  };

  it("caps ten sweep ticks on one absent branch at three skip rows and one escalation row, and refuses on every tick", async () => {
    const { issueId } = await seedStrandedCard(BRANCH_A);

    for (let tick = 0; tick < 10; tick++) await tickReaper();

    expect(await statusOf(issueId)).toBe("in_progress");
    const skipped = await rows(issueId, SKIPPED);
    expect(skipped).toHaveLength(3);
    for (const row of skipped) {
      expect(row.details).toMatchObject({ reason: "branch_absent_on_remote", branch: BRANCH_A });
    }
    const escalations = await rows(issueId, SKIP_REPEATED);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      actorType: "system",
      actorId: "system:execution-control-reconciliation",
      runId: null,
      details: expect.objectContaining({
        reason: "branch_absent_on_remote",
        branch: BRANCH_A,
        repeatSignature: `refused:branch_absent_on_remote:${BRANCH_A}`,
        refusalCount: 4,
        repeatLimit: 3,
        windowSeconds: 3600,
      }),
    });
  });

  it("keeps two absent branches on one issue in separate signatures, replayed interleaved", async () => {
    const { issueId, workspaceId } = await seedStrandedCard(BRANCH_A);

    for (let round = 0; round < 6; round++) {
      await setBranch(workspaceId, BRANCH_A);
      await tickReaper();
      await setBranch(workspaceId, BRANCH_B);
      await tickReaper();
    }

    const skipped = await rows(issueId, SKIPPED);
    const escalations = await rows(issueId, SKIP_REPEATED);
    for (const branch of [BRANCH_A, BRANCH_B]) {
      const signature = `refused:branch_absent_on_remote:${branch}`;
      expect(bySignature(skipped, signature)).toHaveLength(3);
      const own = bySignature(escalations, signature);
      expect(own).toHaveLength(1);
      expect(own[0]!.details).toMatchObject({ branch });
    }
    expect(skipped).toHaveLength(6);
    expect(escalations).toHaveLength(2);
  });

  // The fail-open `skipReason: branch_absent_on_remote:<branch>` row is written
  // by the close route (`recordGuardSkipDisposition`) with these details.
  const failOpenDetails = (branch: string, tail?: string) => ({
    reason: `Branch ${branch} is absent from the remote; transition allowed`,
    skipReason: tail ? `branch_absent_on_remote:${branch}; ${tail}` : `branch_absent_on_remote:${branch}`,
    branch: null,
    defaultRef: null,
    owner: null,
    repo: null,
    decisionCarried: false,
    source: "done_transition_guard",
  });
  const issueRef = (issueId: string) => ({ id: issueId, companyId, identifier: "SUP-9001" });

  it("caps the fail-open skipReason row per branch, ignoring the per-tick pr-skip tail", async () => {
    const { issueId } = await seedStrandedCard(BRANCH_A);
    const issue = issueRef(issueId);

    for (let tick = 0; tick < 12; tick++) {
      const branch = tick % 2 === 0 ? BRANCH_A : BRANCH_B;
      await writeGuardSkippedAuditLog(db, issue, failOpenDetails(branch, tick % 4 < 2 ? `live_pr_discovery_failed:${tick}` : undefined));
    }

    const skipped = await rows(issueId, SKIPPED);
    const escalations = await rows(issueId, SKIP_REPEATED);
    for (const branch of [BRANCH_A, BRANCH_B]) {
      const signature = `branch_absent_on_remote:${branch}`;
      expect(bySignature(skipped, signature)).toHaveLength(3);
      expect(bySignature(escalations, signature)).toHaveLength(1);
    }
    expect(skipped).toHaveLength(6);
    expect(escalations).toHaveLength(2);
    expect(escalations[0]!.details).toMatchObject({ refusalCount: 4, repeatLimit: 3, windowSeconds: 3600 });
  });

  it("does not let the fail-open row and the refusal row of one branch share a count", async () => {
    const { issueId } = await seedStrandedCard(BRANCH_A);
    for (let tick = 0; tick < 3; tick++) await tickReaper();
    expect(await rows(issueId, SKIPPED)).toHaveLength(3);

    await writeGuardSkippedAuditLog(db, issueRef(issueId), failOpenDetails(BRANCH_A));

    expect(await rows(issueId, SKIPPED)).toHaveLength(4);
    expect(await rows(issueId, SKIP_REPEATED)).toHaveLength(0);
  });

  it("writes every other skip reason unchanged, with no signature and no cap", async () => {
    const { issueId } = await seedStrandedCard(BRANCH_A);
    const issue = issueRef(issueId);
    const unchanged = [
      "token_missing",
      `compare_404_base_ref_unresolvable:${BRANCH_A}`,
      "branch_absent_landed_via_merged_pr:SUP-9001:2",
      `branch_absent_merged_pr_probe_failed:${BRANCH_A}`,
    ];

    for (const skipReason of unchanged) {
      for (let tick = 0; tick < 10; tick++) {
        await writeGuardSkippedAuditLog(db, issue, { reason: skipReason, skipReason, source: "done_transition_guard" });
      }
    }

    const skipped = await rows(issueId, SKIPPED);
    expect(skipped).toHaveLength(unchanged.length * 10);
    for (const row of skipped) {
      expect(Object.keys(row.details as object).sort()).toEqual(["identifier", "reason", "skipReason", "source"]);
    }
    expect(await rows(issueId, SKIP_REPEATED)).toHaveLength(0);
  });

  it("reopens the count once the window has passed, on the database clock", async () => {
    const { issueId } = await seedStrandedCard(BRANCH_A);
    const issue = issueRef(issueId);
    for (let tick = 0; tick < 5; tick++) await writeGuardSkippedAuditLog(db, issue, failOpenDetails(BRANCH_A));
    expect(await rows(issueId, SKIPPED)).toHaveLength(3);

    await db
      .update(activityLog)
      .set({ createdAt: sql`${activityLog.createdAt} - make_interval(mins => 61)` })
      .where(eq(activityLog.entityId, issueId));
    await writeGuardSkippedAuditLog(db, issue, failOpenDetails(BRANCH_A));

    expect(await rows(issueId, SKIPPED)).toHaveLength(4);
  });
});
