import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  externalObjectMentions,
  externalObjects,
  issueExecutionDecisions,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  runApprovalStatusReconcilerTick,
  startApprovalStatusReconciler,
  type ApprovalStatusReconcilerTickSummary,
} from "./approval-status-reconciler.js";

const mockResolveSecretValue = vi.hoisted(() => vi.fn());
const mockGetByName = vi.hoisted(() => vi.fn());
const mockGhFetch = vi.hoisted(() => vi.fn());

vi.mock("./secrets.js", () => ({
  secretService: () => ({
    getByName: mockGetByName,
    resolveSecretValue: mockResolveSecretValue,
  }),
}));

vi.mock("./github-fetch.js", () => ({
  ghFetch: mockGhFetch,
  gitHubApiBase: (hostname: string) =>
    hostname === "github.com" ? "https://api.github.com" : `https://${hostname}/api/v3`,
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres approval-status-reconciler tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const GITHUB_TOKEN = "ghp_test_token_value";
const NEW_HEAD = "new0000000000000000000000000000000000000002";
const APPROVED_HEAD = "approved00000000000000000000000000000000001";
const MOVED_HEAD = "moved0000000000000000000000000000000000000004";
const APPROVED_AT = "2026-08-20T00:00:00Z";
const APPROVAL_STAGE_ID = "00000000-0000-0000-0000-0000000000a1";
const REVIEW_STAGE_ID = "00000000-0000-0000-0000-0000000000a2";
const PAPERCLIP_APPROVED = "paperclip/approved";
const AGENT_REVIEWER = "11111111-1111-1111-1111-111111111111";
const AGENT_AUTHOR = "22222222-2222-2222-2222-222222222222";
const AGENT_LEAD = "33333333-3333-3333-3333-333333333333";
const AGENT_CREATOR = "44444444-4444-4444-4444-444444444444";
const USER_REVIEWER = "reviewer-user";

const PR_URL = "https://api.github.com/repos/TEA-Core/paperclip/pulls/42";
const OPEN_PRS_LIST_URL = "https://api.github.com/repos/TEA-Core/paperclip/pulls?state=open&per_page=100";
const PR_43_URL = "https://api.github.com/repos/TEA-Core/paperclip/pulls/43";
const PR_44_URL = "https://api.github.com/repos/TEA-Core/paperclip/pulls/44";
const COMBINED_STATUS_URL = `https://api.github.com/repos/TEA-Core/paperclip/commits/${NEW_HEAD}/status`;
const POST_STATUS_URL = `https://api.github.com/repos/TEA-Core/paperclip/statuses/${NEW_HEAD}`;
const BASE_SHA = "base00000000000000000000000000000000000000003";
const APPROVED_DIFF_URL = `https://api.github.com/repos/TEA-Core/paperclip/compare/${BASE_SHA}...${APPROVED_HEAD}`;
const LIVE_DIFF_URL = `https://api.github.com/repos/TEA-Core/paperclip/compare/${BASE_SHA}...${NEW_HEAD}`;
const COMMENT_LIST_URL = "https://api.github.com/repos/TEA-Core/paperclip/issues/42/comments?per_page=100&direction=desc";
const COMMENT_POST_URL = "https://api.github.com/repos/TEA-Core/paperclip/issues/42/comments";
const CHECK_RUNS_URL = `https://api.github.com/repos/TEA-Core/paperclip/commits/${NEW_HEAD}/check-runs?per_page=100`;
const CLOSED_43_BODY = { state: "closed", merged: false, head: { ref: "dup-branch", sha: "closed430000000000000000000000000000000000" }, base: { ref: "main", sha: BASE_SHA } };
const MERGED_44_BODY = { state: "closed", merged: true, head: { ref: "dup-branch-44", sha: "merged440000000000000000000000000000000000" }, base: { ref: "main", sha: BASE_SHA } };
const OPEN_43_BODY = { state: "open", merged: false, head: { ref: "dup-branch", sha: "open43000000000000000000000000000000000000" }, base: { ref: "main", sha: BASE_SHA } };

const OPEN_PR_BODY = {
  state: "open",
  merged: false,
  head: { ref: "SUP-42-branch", sha: NEW_HEAD },
  base: { ref: "main", sha: BASE_SHA },
};

// SUP-14747 D-E backfill fixtures. The card's approval decision is seeded at
// APPROVED_AT (2026-08-20T00:00:00Z); all head-mutating events below sit before
// it, so "last head-mutating event at/before the approval" is the one listed.
const TIMELINE_URL = `https://api.github.com/repos/TEA-Core/paperclip/issues/42/timeline?per_page=100&page=1`;
// Last head-mutating event at/before the approval is NEW_HEAD — equals the live
// head, so the backfill invariant holds and the anchor is recovered.
const TIMELINE_SAME_HEAD_BODY = [
  { event: "committed", sha: NEW_HEAD, committer: { date: "2026-08-19T09:00:00Z" }, author: { date: "2026-08-19T09:00:00Z" } },
  { event: "labeled", created_at: "2026-08-19T09:30:00Z" },
  { event: "head_ref_force_pushed", commit_id: NEW_HEAD, created_at: "2026-08-19T10:00:00Z" },
];
// Last verified (server-timed) head at/before the approval is APPROVED_HEAD,
// which differs from the live head (NEW_HEAD): the head moved after approval.
// Uses a force-push so the "moved" path is exercised from a server timestamp.
const TIMELINE_MOVED_HEAD_BODY = [
  { event: "head_ref_force_pushed", commit_id: APPROVED_HEAD, created_at: "2026-08-19T09:00:00Z" },
  { event: "labeled", created_at: "2026-08-19T09:30:00Z" },
];
// Only committed (client-timed) head events, no force-push: the head-at-approval
// cannot be verified to a server timestamp, so the backfill must refuse.
const TIMELINE_COMMITTED_ONLY_BODY = [
  { event: "committed", sha: NEW_HEAD, committer: { date: "2026-08-19T09:00:00Z" }, author: { date: "2026-08-19T09:00:00Z" } },
  { event: "labeled", created_at: "2026-08-19T09:30:00Z" },
];
// A committed event whose client-set committer.date sits before the approval,
// followed by a force-push of the SAME sha whose server created_at sits AFTER
// the approval. The client date must not place the head at/before the approval;
// the only server-timed push is post-approval, so no verified head exists.
const TIMELINE_POST_APPROVAL_PUSH_BODY = [
  { event: "committed", sha: NEW_HEAD, committer: { date: "2026-08-19T09:00:00Z" }, author: { date: "2026-08-19T09:00:00Z" } },
  { event: "head_ref_force_pushed", commit_id: NEW_HEAD, created_at: "2026-08-20T01:00:00Z" },
];
// No head-mutating event at/before the approval — the head is unverifiable.
const TIMELINE_NO_HEAD_EVENT_BODY = [
  { event: "labeled", created_at: "2026-08-19T09:00:00Z" },
  { event: "review_dismissed", created_at: "2026-08-19T09:30:00Z" },
];
// Re-approval scenario: at the first approval time (APPROVED_AT) the newest
// server-timed force-push is APPROVED_HEAD (≠ the live head NEW_HEAD), so the
// backfill refuses head-moved-since-approval. The head is later force-pushed to
// NEW_HEAD; a re-approval at a LATER time (2026-08-21) makes the head-at-approval
// time equal the live head, so the backfill now succeeds. Drives the
// approval-time keying of the refusal cache
// (backfill-refusal-not-keyed-on-approval-time).
const TIMELINE_REAPPROVAL_BODY = [
  { event: "head_ref_force_pushed", commit_id: APPROVED_HEAD, created_at: "2026-08-19T09:00:00Z" },
  { event: "head_ref_force_pushed", commit_id: NEW_HEAD, created_at: "2026-08-21T00:00:00Z" },
];
// A head_ref_force_pushed event whose commit_id is null: structurally malformed
// but STABLE — the same bytes are read on every tick. Unlike a transient HTTP /
// network failure (which must be retried next tick), this is a DETERMINISTIC
// refusal that must be cached as a named refusal, and it must not be reported as
// a transient timeline-read-failed (backfill-unparseable-event-misclassified-
// transient).
const TIMELINE_UNPARSEABLE_FORCE_PUSH_BODY = [
  { event: "labeled", created_at: "2026-08-19T09:00:00Z" },
  { event: "head_ref_force_pushed", commit_id: null, created_at: "2026-08-19T10:00:00Z" },
];

function zeroSummary(): ApprovalStatusReconcilerTickSummary {
  return {
    scanned: 0,
    republished: 0,
    skipped: {},
    skippedDetails: [],
    failed: 0,
    failedDetails: [],
    capped: 0,
    nextScanKey: null,
    voidWarnings: 0,
    voidWarningDetails: [],
    backfilled: 0,
    backfilledDetails: [],
  };
}

function installRoutes(
  routes: Array<{ url: string | RegExp; body?: unknown; ok?: boolean; status?: number }>,
) {
  mockGhFetch.mockImplementation(async (url: string) => {
    for (const route of routes) {
      const matched = typeof route.url === "string" ? url === route.url : route.url.test(url);
      if (matched) {
        return {
          ok: route.ok ?? true,
          status: route.status ?? 200,
          json: async () => route.body ?? {},
        } as unknown as Response;
      }
    }
    throw new Error(`unmocked ghFetch URL: ${url}`);
  });
}

function postStatusCalls() {
  return mockGhFetch.mock.calls.filter((call) => {
    const url = String(call[0]);
    const init = call[1] as RequestInit | undefined;
    return url.includes("/statuses") && init?.method === "POST";
  });
}

function postStatusBodies(): Array<Record<string, unknown>> {
  return postStatusCalls().map((call) => JSON.parse(String((call[1] as RequestInit).body)));
}

function postCommentCalls() {
  return mockGhFetch.mock.calls.filter((call) => {
    const url = String(call[0]);
    const init = call[1] as RequestInit | undefined;
    return url === COMMENT_POST_URL && init?.method === "POST";
  });
}

function postCommentBodies(): string[] {
  return postCommentCalls().map(
    (call) => JSON.parse(String((call[1] as RequestInit).body)).body as string,
  );
}

describeEmbeddedPostgres("approval-status-reconciler", () => {
  let db: Db;
  let companyId: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  function approvedState(overrides: Record<string, unknown> = {}) {
    return {
      status: "completed",
      completedStageIds: [APPROVAL_STAGE_ID],
      lastDecisionOutcome: "approved",
      currentStageId: null,
      currentParticipant: null,
      returnAssignee: null,
      // Default: the approval was published on NEW_HEAD, which is also the
      // live PR head — so Guard A takes the same-SHA fast path and performs no
      // compare call in the happy-path tests. Tests that need a moved head or
      // the unrecoverable case override this.
      approvalStatus: { publishedHeadSha: NEW_HEAD, publishedAt: APPROVED_AT },
      ...overrides,
    };
  }

  const EXECUTION_POLICY = {
    mode: "normal",
    commentRequired: true,
    stages: [{ id: APPROVAL_STAGE_ID, type: "approval", approvalsNeeded: 1 }],
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-approval-status-reconciler-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    vi.resetAllMocks();

    mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
    mockResolveSecretValue.mockResolvedValue(GITHUB_TOKEN);
    mockGhFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);

    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(issueExecutionDecisions);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);

    const companyRows = await db
      .insert(companies)
      .values({
        name: "Test Company",
        issuePrefix: "SUP",
        mergeArmingEnabled: true,
      })
      .returning();
    companyId = companyRows[0]!.id;
    await db.insert(agents).values({ id: AGENT_CREATOR, companyId, name: "Creator" });
  });

  afterEach(async () => {
    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(issueExecutionDecisions);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function insertAgent(id: string, name: string) {
    await db.insert(agents).values({ id, companyId, name });
  }

  async function insertIssue(
    overrides: {
      identifier?: string;
      status?: string;
      executionState?: Record<string, unknown>;
      executionPolicy?: Record<string, unknown>;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
      assigneeAgentId?: string | null;
      assigneeUserId?: string | null;
    } = {},
  ) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test Issue",
      status: overrides.status ?? "in_review",
      identifier: overrides.identifier ?? "SUP-42",
      executionPolicy: overrides.executionPolicy ?? EXECUTION_POLICY,
      executionState: overrides.executionState ?? approvedState(),
      createdByAgentId: "createdByAgentId" in overrides ? overrides.createdByAgentId! : AGENT_CREATOR,
      createdByUserId: overrides.createdByUserId ?? null,
      assigneeAgentId: overrides.assigneeAgentId ?? null,
      assigneeUserId: overrides.assigneeUserId ?? null,
    });
    return issueId;
  }

  async function insertDecision(
    issueId: string,
    overrides: {
      stageId?: string;
      actorAgentId?: string | null;
      actorUserId?: string | null;
      outcome?: string;
      createdAt?: Date;
    } = {},
  ) {
    await db.insert(issueExecutionDecisions).values({
      companyId,
      issueId,
      stageId: overrides.stageId ?? APPROVAL_STAGE_ID,
      stageType: "approval",
      actorAgentId: overrides.actorAgentId ?? null,
      actorUserId: overrides.actorUserId ?? USER_REVIEWER,
      outcome: overrides.outcome ?? "approved",
      body: "Approved",
      createdAt: overrides.createdAt ?? new Date("2026-08-20T00:00:00Z"),
    });
  }

  async function insertMention(
    issueId: string,
    overrides: { state?: string | null; draft?: boolean; number?: number } = {},
  ) {
    const number = overrides.number ?? 42;
    const data: Record<string, unknown> = {
      state: overrides.state ?? "open",
      draft: overrides.draft ?? false,
      node_id: "PR_node_id_12345",
      head: { ref: "some-branch-name" },
      title: `Fix thing (SUP-${number})`,
    };
    const [externalObj] = await db
      .insert(externalObjects)
      .values({
        companyId,
        providerKey: "github",
        objectType: "pull_request",
        externalId: `TEA-Core/paperclip#pull/${number}`,
        data,
      })
      .returning();
    await db.insert(externalObjectMentions).values({
      companyId,
      sourceIssueId: issueId,
      sourceKind: "comment",
      objectId: externalObj!.id,
      objectType: "pull_request",
      providerKey: "github",
    });
    return externalObj;
  }

  /**
   * SUP-14715 D-B: give the card a resolvable delivery identity (its execution
   * workspace's branch + repo) so the ADR-091 D1 delivery-identity gate that a
   * first publish now enforces can pass or fail on the card's own branch. The
   * seeded branch/repo match the cached mention's head ref and TEA-Core/paperclip
   * so the linked PR is "delivered by the card".
   */
  async function seedDeliveryIdentity(issueId: string, branch: string, repoUrl: string) {
    const [projectRow] = await db
      .insert(projects)
      .values({ id: randomUUID(), companyId, name: "TEA-Core/paperclip", status: "in_progress" })
      .returning();
    const [ewRow] = await db
      .insert(executionWorkspaces)
      .values({
        id: randomUUID(),
        companyId,
        projectId: projectRow!.id,
        mode: "isolated",
        strategyType: "git_worktree",
        name: "card-workspace",
        status: "active",
        branchName: branch,
        repoUrl,
      })
      .returning();
    await db
      .update(issues)
      .set({ projectId: projectRow!.id, executionWorkspaceId: ewRow!.id })
      .where(eq(issues.id, issueId));
  }

  describe("runApprovalStatusReconcilerTick", () => {
    it("republishes exactly once when the status is missing on the live head", async () => {
      const issueId = await insertIssue();
      await insertDecision(issueId);
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: POST_STATUS_URL, body: { id: 12345 } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.scanned).toBe(1);
      expect(summary.republished).toBe(1);
      expect(summary.failed).toBe(0);
      expect(summary.capped).toBe(0);
      expect(Object.keys(summary.skipped)).toEqual([]);

      const calls = postStatusCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe(POST_STATUS_URL);
      expect(postStatusBodies()[0]).toMatchObject({
        state: "success",
        context: PAPERCLIP_APPROVED,
        description: "SUP-42 approved via Paperclip",
      });

      // Pre-publish reads are the live PR read and the head combined-status
      // read only — no head-history or compare probes. The delegated publish
      // re-reads the PR itself (live re-resolve, SUP-13313).
      const getUrls = mockGhFetch.mock.calls
        .filter((call) => (call[1] as RequestInit | undefined)?.method !== "POST")
        .map((call) => String(call[0]));
      const distinct = [...new Set(getUrls)];
      expect(distinct).toEqual([PR_URL, COMBINED_STATUS_URL]);
      expect(getUrls.slice(0, 2)).toEqual([PR_URL, COMBINED_STATUS_URL]);

      // The live head still matches publishedHeadSha — nothing is voided,
      // so no PR warning.
      expect(postCommentCalls()).toHaveLength(0);
      expect(summary.voidWarnings).toBe(0);
    });

    it("scans and evaluates the head of a zero-mention approved card via live workspace discovery (AC1)", async () => {
      const issueId = await insertIssue();
      await insertDecision(issueId);
      // NO external-object mention at all — the SUP-14737 / PR 455 shape. The card
      // still carries an approval anchor (approvedState().approvalStatus.publishedHeadSha)
      // and a delivery identity, so the widened candidate SQL now surfaces it.
      await seedDeliveryIdentity(issueId, "SUP-42-branch", "https://github.com/TEA-Core/paperclip");

      installRoutes([
        // The shared resolver's live open-PR list probe discovers PR 42 by its
        // delivery branch (SUP-42-branch contains the card's identifier).
        {
          url: OPEN_PRS_LIST_URL,
          body: [
            { number: 42, draft: false, head: { ref: "SUP-42-branch" }, title: "Unify PR resolution (SUP-42)", body: null },
          ],
        },
        // The reconciler then reads the discovered PR and its head combined status.
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: POST_STATUS_URL, body: { id: 12345 } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.scanned).toBe(1);
      expect(summary.republished).toBe(1);
      expect(summary.failed).toBe(0);
      expect(Object.keys(summary.skipped)).toEqual([]);

      const calls = postStatusCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe(POST_STATUS_URL);
      expect(postStatusBodies()[0]).toMatchObject({
        state: "success",
        context: PAPERCLIP_APPROVED,
        description: "SUP-42 approved via Paperclip",
      });
    });

    it("defers (not a permanent no-open-pr) when live workspace discovery fails terminally for a zero-mention card", async () => {
      const issueId = await insertIssue();
      await insertDecision(issueId);
      await seedDeliveryIdentity(issueId, "SUP-42-branch", "https://github.com/TEA-Core/paperclip");

      installRoutes([
        // Live discovery 404s — terminal for this tick, but NOT the no-open-pr wedge.
        { url: OPEN_PRS_LIST_URL, ok: false, status: 404, body: { message: "Not Found" } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.scanned).toBe(1);
      expect(summary.republished).toBe(0);
      expect(summary.skipped["pr-undetermined"]).toBe(1);
      expect(summary.skipped["no-open-pr"]).toBeUndefined();
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("still refuses a newly-reachable zero-mention card under Guard A when the head moved (AC5)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { publishedHeadSha: APPROVED_HEAD, publishedAt: APPROVED_AT },
        }),
      });
      await insertDecision(issueId);
      // Zero mentions + a delivery identity: the widened SQL + live discovery make
      // this card scannable, but Guard A must still refuse the moved head.
      await seedDeliveryIdentity(issueId, "SUP-42-branch", "https://github.com/TEA-Core/paperclip");

      installRoutes([
        {
          url: OPEN_PRS_LIST_URL,
          body: [
            { number: 42, draft: false, head: { ref: "SUP-42-branch" }, title: "Unify PR resolution (SUP-42)", body: null },
          ],
        },
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        {
          url: APPROVED_DIFF_URL,
          body: {
            status: "ahead",
            ahead_by: 1,
            files: [{ filename: "server/src/config.ts", sha: "blob0000000000000000000000000000000000000000000001", status: "modified" }],
          },
        },
        {
          url: LIVE_DIFF_URL,
          body: {
            status: "ahead",
            ahead_by: 2,
            files: [{ filename: "server/src/config.ts", sha: "blob0000000000000000000000000000000000000000000002", status: "modified" }],
          },
        },
        { url: COMMENT_LIST_URL, body: [] },
        { url: COMMENT_POST_URL, body: { id: 9001 } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      // Scanned (the discovery widening works) but NOT published — Guard A holds.
      expect(summary.scanned).toBe(1);
      expect(summary.republished).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.skipped["guard-a:changed-blob"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("persists a terminal `none` verdict and stops re-selecting the zero-mention card (SUP-14926 AC1)", async () => {
      const issueId = await insertIssue();
      await insertDecision(issueId);
      await seedDeliveryIdentity(issueId, "SUP-42-branch", "https://github.com/TEA-Core/paperclip");

      // The live open-PR list resolves to zero matches, so workspace discovery
      // returns `none` — the deterministic terminal verdict.
      installRoutes([{ url: OPEN_PRS_LIST_URL, body: [] }]);

      const summary = await runApprovalStatusReconcilerTick(db);
      expect(summary.scanned).toBe(1);
      expect(summary.republished).toBe(0);
      expect(summary.skipped["no-open-pr"]).toBe(1);

      // The terminal verdict is persisted with the anchor head and a timestamp.
      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      const approvalStatus = (row!.executionState as Record<string, unknown>).approvalStatus as Record<string, unknown>;
      const wd = approvalStatus.workspaceDiscovery as Record<string, unknown>;
      expect(wd.verdict).toBe("none");
      expect(wd.headSha).toBe(NEW_HEAD);
      expect(typeof wd.at).toBe("string");

      // The following tick no longer selects the card (AC1).
      const summary2 = await runApprovalStatusReconcilerTick(db);
      expect(summary2.scanned).toBe(0);
      expect(summary2.skipped["no-open-pr"]).toBeUndefined();
    });

    it("re-selects a zero-mention card whose updated_at advances past the persisted verdict (SUP-14926 AC2)", async () => {
      const issueId = await insertIssue();
      await insertDecision(issueId);
      await seedDeliveryIdentity(issueId, "SUP-42-branch", "https://github.com/TEA-Core/paperclip");

      installRoutes([{ url: OPEN_PRS_LIST_URL, body: [] }]);
      const summary = await runApprovalStatusReconcilerTick(db);
      expect(summary.scanned).toBe(1);
      expect(summary.skipped["no-open-pr"]).toBe(1);

      const summary2 = await runApprovalStatusReconcilerTick(db);
      expect(summary2.scanned).toBe(0);

      // A new PR / activity arrives after the verdict was recorded, moving the
      // card's updated_at past the recorded `at` and re-admitting it.
      await db
        .update(issues)
        .set({ updatedAt: new Date(Date.now() + 60_000) })
        .where(eq(issues.id, issueId));

      const summary3 = await runApprovalStatusReconcilerTick(db);
      expect(summary3.scanned).toBe(1);
      expect(summary3.skipped["no-open-pr"]).toBe(1);
    });

    it("does not persist a verdict when live workspace discovery is undetermined (SUP-14926 AC3)", async () => {
      const issueId = await insertIssue();
      await insertDecision(issueId);
      await seedDeliveryIdentity(issueId, "SUP-42-branch", "https://github.com/TEA-Core/paperclip");

      // Live discovery 404s — transient (auth/HTTP), never a terminal verdict.
      installRoutes([{ url: OPEN_PRS_LIST_URL, ok: false, status: 404, body: { message: "Not Found" } }]);

      const summary = await runApprovalStatusReconcilerTick(db);
      expect(summary.scanned).toBe(1);
      expect(summary.skipped["pr-undetermined"]).toBe(1);

      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      const approvalStatus = (row!.executionState as Record<string, unknown>).approvalStatus as Record<string, unknown>;
      expect(approvalStatus.workspaceDiscovery).toBeUndefined();
    });

    it("does not persist a verdict when live workspace discovery is ambiguous (SUP-14926 AC4)", async () => {
      const issueId = await insertIssue();
      await insertDecision(issueId);
      await seedDeliveryIdentity(issueId, "SUP-42-branch", "https://github.com/TEA-Core/paperclip");

      installRoutes([
        {
          url: OPEN_PRS_LIST_URL,
          body: [
            { number: 42, draft: false, head: { ref: "SUP-42-branch" }, title: "First (SUP-42)", body: null },
            { number: 43, draft: false, head: { ref: "SUP-42-branch-2" }, title: "Second (SUP-42)", body: null },
          ],
        },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);
      expect(summary.scanned).toBe(1);
      expect(summary.skipped["ambiguous-pr"]).toBe(1);

      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      const approvalStatus = (row!.executionState as Record<string, unknown>).approvalStatus as Record<string, unknown>;
      expect(approvalStatus.workspaceDiscovery).toBeUndefined();
    });

    it("stops re-selecting a card whose linked PRs are all closed (SUP-14959)", async () => {
      const issueId = await insertIssue();
      await insertDecision(issueId);
      // The 343-shape census card: an approval anchor (publishedHeadSha) + a
      // workspace context, but every linked PR mention is closed. The mention
      // arm's EXISTS is false (no open/unhydrated PR) and, post-fix, the OR arm's
      // NOT-EXISTS also excludes it because a pull_request mention row exists.
      // Before the fix this card was re-selected on every tick and disposed as
      // no-open-pr, consuming the whole window.
      await insertMention(issueId, { state: "closed", number: 42 });
      await seedDeliveryIdentity(issueId, "SUP-42-branch", "https://github.com/TEA-Core/paperclip");

      // No routes: the card must not be selected, so no GitHub call is made.
      installRoutes([]);

      const summary = await runApprovalStatusReconcilerTick(db);
      expect(summary.scanned).toBe(0);
      expect(summary.capped).toBe(0);
      expect(summary.skipped["no-open-pr"]).toBeUndefined();
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("stops re-selecting a card with several closed mentions (SUP-14959, multi-PR)", async () => {
      const issueId = await insertIssue();
      await insertDecision(issueId);
      // A card whose linked PRs are all closed (the census's `#3248 closed,
      // #3287 closed` shape) is still excluded once any closed mention exists.
      await insertMention(issueId, { state: "closed", number: 42 });
      await insertMention(issueId, { state: "closed", number: 43 });
      await seedDeliveryIdentity(issueId, "SUP-42-branch", "https://github.com/TEA-Core/paperclip");

      installRoutes([]);
      const summary = await runApprovalStatusReconcilerTick(db);
      expect(summary.scanned).toBe(0);
      expect(summary.skipped["no-open-pr"]).toBeUndefined();
    });

    it("still selects a card with an open mention alongside a closed one (mention arm unchanged, SUP-14959 AC2)", async () => {
      const issueId = await insertIssue();
      await insertDecision(issueId);
      // #42 open, #43 closed. The mention arm's EXISTS matches the open PR, so
      // the card is still a candidate even though a closed mention row also
      // exists — the OR arm's NOT-EXISTS is irrelevant because the mention arm
      // admits it. The in-memory resolver picks the single open PR as the target.
      await insertMention(issueId, { state: "open", number: 42 });
      await insertMention(issueId, { state: "closed", number: 43 });

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: POST_STATUS_URL, body: { id: 12345 } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);
      expect(summary.scanned).toBe(1);
      expect(summary.republished).toBe(1);
      expect(Object.keys(summary.skipped)).toEqual([]);
      expect(postStatusCalls()).toHaveLength(1);
    });

    it("performs zero writes when the head already carries paperclip/approved=success", async () => {
      const issueId = await insertIssue();
      await insertDecision(issueId);
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        {
          url: COMBINED_STATUS_URL,
          body: {
            state: "success",
            statuses: [{ context: PAPERCLIP_APPROVED, state: "success" }],
          },
        },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.skipped["already-success"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("refuses to re-publish when the PR's diff-vs-base changed after approval (guard A)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { publishedHeadSha: APPROVED_HEAD, publishedAt: APPROVED_AT },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        {
          url: APPROVED_DIFF_URL,
          body: {
            status: "ahead",
            ahead_by: 1,
            files: [{ filename: "server/src/config.ts", sha: "blob0000000000000000000000000000000000000001", status: "modified" }],
          },
        },
        {
          url: LIVE_DIFF_URL,
          body: {
            status: "ahead",
            ahead_by: 2,
            files: [{ filename: "server/src/config.ts", sha: "blob0000000000000000000000000000000000000002", status: "modified" }],
          },
        },
        { url: COMMENT_LIST_URL, body: [] },
        { url: COMMENT_POST_URL, body: { id: 9001 } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.skipped["guard-a:changed-blob"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("warns on the PR when a new head voids the published approval (SUP-14049, #349 repro)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { publishedHeadSha: APPROVED_HEAD, publishedAt: APPROVED_AT },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        {
          url: APPROVED_DIFF_URL,
          body: {
            status: "ahead",
            ahead_by: 1,
            files: [{ filename: "docs/sup-13870.md", sha: "blob0000000000000000000000000000000000000001", status: "modified" }],
          },
        },
        {
          url: LIVE_DIFF_URL,
          body: {
            status: "ahead",
            ahead_by: 2,
            files: [{ filename: "docs/sup-13870.md", sha: "blob0000000000000000000000000000000000000002", status: "modified" }],
          },
        },
        { url: COMMENT_LIST_URL, body: [] },
        { url: COMMENT_POST_URL, body: { id: 9001 } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      // Guard A's verdict is unchanged: the voided head is refused, not re-stamped.
      expect(summary.republished).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.skipped["guard-a:changed-blob"]).toBe(1);
      expect(summary.voidWarnings).toBe(1);
      expect(summary.voidWarningDetails).toEqual(["SUP-42: posted"]);
      expect(postStatusCalls()).toHaveLength(0);

      // Advisory-only signal, visible on the PR itself: one comment naming both
      // SHAs, the owning card, the approval timestamp, the remedies, and the
      // dedup marker — and nothing written to paperclip/approved.
      expect(postCommentCalls()).toHaveLength(1);
      const body = postCommentBodies()[0]!;
      expect(body).toContain(`This PR was approved at ${APPROVED_HEAD} (SUP-42, ${APPROVED_AT})`);
      expect(body).toContain(`head ${NEW_HEAD} voids that approval`);
      expect(body).toContain("the merge queue will reject this PR");
      expect(body).toContain("re-approve at the live head");
      expect(body).toContain(`move the late commit to its own PR and reset this branch back to ${APPROVED_HEAD}`);
      expect(body).toContain("a reset needs no new review");
      expect(body).toContain(`[paperclip:approval-voided ${APPROVED_HEAD} -> ${NEW_HEAD}]`);
      expect(body).not.toContain("context");
    });

    it("warns when the head move only ADDED an unreviewed file over byte-identical reviewed blobs (SUP-14996 #349 repro)", async () => {
      // PR #349 shape: every reviewed file has a byte-identical blob SHA at
      // both heads and the only delta is one added markdown spec — Guard A
      // refuses (an added file is unreviewed content) and the PR must be told.
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { publishedHeadSha: APPROVED_HEAD, publishedAt: APPROVED_AT },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        {
          url: APPROVED_DIFF_URL,
          body: {
            status: "ahead",
            ahead_by: 7,
            files: [
              { filename: "server/src/config.ts", sha: "blob0000000000000000000000000000000000000001", status: "modified" },
              { filename: "docs/spec.md", sha: "blob0000000000000000000000000000000000000002", status: "modified" },
            ],
          },
        },
        {
          url: LIVE_DIFF_URL,
          body: {
            status: "ahead",
            ahead_by: 8,
            files: [
              { filename: "server/src/config.ts", sha: "blob0000000000000000000000000000000000000001", status: "modified" },
              { filename: "docs/spec.md", sha: "blob0000000000000000000000000000000000000002", status: "modified" },
              { filename: "docs/sup-13870.md", sha: "blob0000000000000000000000000000000000000003", status: "added" },
            ],
          },
        },
        { url: COMMENT_LIST_URL, body: [] },
        { url: COMMENT_POST_URL, body: { id: 9003 } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.skipped["guard-a:changed-blob"]).toBe(1);
      expect(summary.voidWarnings).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);

      expect(postCommentCalls()).toHaveLength(1);
      const body = postCommentBodies()[0]!;
      expect(body).toContain(`This PR was approved at ${APPROVED_HEAD} (SUP-42, ${APPROVED_AT})`);
      expect(body).toContain(`head ${NEW_HEAD} voids that approval`);
      expect(body).toContain("docs/sup-13870.md (added)");
      expect(body).toContain("re-approve at the live head");
      expect(body).toContain("no new review");
      expect(body).toContain(`[paperclip:approval-voided ${APPROVED_HEAD} -> ${NEW_HEAD}]`);
    });

    it("does not re-post the void warning when the same pair was already warned (dedup)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { publishedHeadSha: APPROVED_HEAD, publishedAt: APPROVED_AT },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        {
          url: APPROVED_DIFF_URL,
          body: {
            status: "ahead",
            ahead_by: 1,
            files: [{ filename: "docs/sup-13870.md", sha: "blob0000000000000000000000000000000000000001", status: "modified" }],
          },
        },
        {
          url: LIVE_DIFF_URL,
          body: {
            status: "ahead",
            ahead_by: 2,
            files: [{ filename: "docs/sup-13870.md", sha: "blob0000000000000000000000000000000000000002", status: "modified" }],
          },
        },
        {
          url: COMMENT_LIST_URL,
          body: [
            {
              id: 9001,
              body: `previous warning [paperclip:approval-voided ${APPROVED_HEAD} -> ${NEW_HEAD}]`,
            },
          ],
        },
        { url: COMMENT_POST_URL, body: { id: 9002 } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.skipped["guard-a:changed-blob"]).toBe(1);
      expect(summary.voidWarnings).toBe(1);
      expect(summary.voidWarningDetails).toEqual(["SUP-42: already-posted"]);
      expect(postCommentCalls()).toHaveLength(0);
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("republishes when the PR's own diff-vs-base is unchanged after an update-branch (guard A passes)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { publishedHeadSha: APPROVED_HEAD, publishedAt: APPROVED_AT },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);

      const ownDiff = [
        { filename: "server/src/a.ts", sha: "blobaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", status: "modified" },
        { filename: "server/src/b.ts", sha: "blobbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", status: "added" },
      ];
      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: APPROVED_DIFF_URL, body: { status: "ahead", ahead_by: 7, files: ownDiff } },
        { url: LIVE_DIFF_URL, body: { status: "ahead", ahead_by: 7, files: ownDiff } },
        { url: POST_STATUS_URL, body: { id: 12346 } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(1);
      expect(summary.failed).toBe(0);
      const calls = postStatusCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe(POST_STATUS_URL);
    });

    it("republishes exactly once on a byte-identical head move (guard A passes)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { publishedHeadSha: APPROVED_HEAD, publishedAt: APPROVED_AT },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        {
          url: APPROVED_DIFF_URL,
          body: { status: "ahead", ahead_by: 1, files: [{ filename: "server/src/a.ts", sha: "blobaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", status: "modified" }] },
        },
        {
          url: LIVE_DIFF_URL,
          body: { status: "ahead", ahead_by: 1, files: [{ filename: "server/src/a.ts", sha: "blobaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", status: "modified" }] },
        },
        { url: POST_STATUS_URL, body: { id: 12346 } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(1);
      expect(summary.failed).toBe(0);
      const calls = postStatusCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe(POST_STATUS_URL);
    });

    it("refuses to re-publish for a renumber, even when blob content is unchanged (guard A, ADR-074 coupling)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { publishedHeadSha: APPROVED_HEAD, publishedAt: APPROVED_AT },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        {
          url: APPROVED_DIFF_URL,
          body: {
            status: "ahead",
            ahead_by: 1,
            files: [
              { filename: "server/db/migrations/000328_thing.sql", sha: "blob0000000000000000000000000000000000000001", status: "modified" },
            ],
          },
        },
        {
          url: LIVE_DIFF_URL,
          body: {
            status: "ahead",
            ahead_by: 1,
            files: [
              { filename: "server/db/migrations/000329_thing.sql", sha: "blob0000000000000000000000000000000000000001", status: "renamed", previous_filename: "server/db/migrations/000328_thing.sql" },
            ],
          },
        },
        { url: COMMENT_LIST_URL, body: [] },
        { url: COMMENT_POST_URL, body: { id: 9001 } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.skipped["guard-a:changed-blob"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("refuses when the live PR payload carries no base sha (guard A)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { publishedHeadSha: APPROVED_HEAD, publishedAt: APPROVED_AT },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: { ...OPEN_PR_BODY, base: { ref: "main" } } },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.skipped["guard-a:no-base-ref"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("refuses to re-publish when the approved head is unrecoverable and the PR timeline cannot be read (backfill fail-closed)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({ approvalStatus: null }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        // No timeline route: the SUP-14747 backfill cannot positively read the
        // head at approval time, so it must refuse rather than infer an anchor.
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.skipped["backfill:timeline-read-failed"]).toBe(1);
      expect(summary.backfilled).toBe(0);
      expect(postStatusCalls()).toHaveLength(0);
      // No publishedHeadSha means nothing is voided — no PR warning either.
      expect(postCommentCalls()).toHaveLength(0);
      expect(summary.voidWarnings).toBe(0);
    });

    it("fails closed when the diff-vs-base compare cannot be verified (guard A)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { publishedHeadSha: APPROVED_HEAD, publishedAt: APPROVED_AT },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: APPROVED_DIFF_URL, ok: false, status: 500, body: { message: "server error" } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.skipped["guard-a:compare-failed"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("fails closed when the live diff-vs-base compare cannot be verified (guard A)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { publishedHeadSha: APPROVED_HEAD, publishedAt: APPROVED_AT },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        {
          url: APPROVED_DIFF_URL,
          body: { status: "ahead", ahead_by: 1, files: [] },
        },
        { url: LIVE_DIFF_URL, ok: false, status: 500, body: { message: "server error" } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.skipped["guard-a:compare-failed"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("fails closed when a compare returns no file list (guard A, truncation)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { publishedHeadSha: APPROVED_HEAD, publishedAt: APPROVED_AT },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: APPROVED_DIFF_URL, body: { status: "ahead", ahead_by: 1 } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.skipped["guard-a:unverifiable"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("fails closed when a compare is truncated (guard A)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { publishedHeadSha: APPROVED_HEAD, publishedAt: APPROVED_AT },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: APPROVED_DIFF_URL, body: { status: "ahead", ahead_by: 1, truncated: true, files: [] } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.skipped["guard-a:unverifiable"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("does not stamp a head that moves between validation and the delegated write (TOCTOU pin)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { publishedHeadSha: APPROVED_HEAD, publishedAt: APPROVED_AT },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);

      let prReads = 0;
      mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        const method = (init as RequestInit | undefined)?.method ?? "GET";
        if (url === PR_URL && method === "GET") {
          prReads += 1;
          const headSha = prReads === 1 ? NEW_HEAD : MOVED_HEAD;
          return {
            ok: true,
            status: 200,
            json: async () => ({ ...OPEN_PR_BODY, head: { ref: "SUP-42-branch", sha: headSha } }),
          } as unknown as Response;
        }
        if (url === COMBINED_STATUS_URL) {
          return { ok: true, status: 200, json: async () => ({ state: "pending", statuses: [] }) } as unknown as Response;
        }
        if (url === APPROVED_DIFF_URL || url === LIVE_DIFF_URL) {
          return { ok: true, status: 200, json: async () => ({ status: "ahead", ahead_by: 1, files: [] }) } as unknown as Response;
        }
        if (url.includes("/statuses") && method === "POST") {
          return { ok: true, status: 201, json: async () => ({ id: 12347 }) } as unknown as Response;
        }
        throw new Error(`unmocked ghFetch URL: ${url} method ${method}`);
      });

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.skipped["guard-a:head-moved-during-write"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("never scans a card that was never approved", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({ lastDecisionOutcome: null }),
      });
      await insertMention(issueId);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.scanned).toBe(0);
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("never scans rejected cards", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({ lastDecisionOutcome: "rejected" }),
      });
      await insertDecision(issueId, { outcome: "rejected" });
      await insertMention(issueId);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.scanned).toBe(0);
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("never scans cancelled issues", async () => {
      const issueId = await insertIssue({ status: "cancelled" });
      await insertDecision(issueId);
      await insertMention(issueId);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.scanned).toBe(0);
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("skips when the live PR is merged", async () => {
      const issueId = await insertIssue();
      await insertDecision(issueId);
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: { ...OPEN_PR_BODY, state: "closed", merged: true } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.skipped["pr-merged"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("skips when the live PR is closed", async () => {
      const issueId = await insertIssue();
      await insertDecision(issueId);
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: { ...OPEN_PR_BODY, state: "closed", merged: false } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.skipped["pr-closed"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("skips when the approval was made by the card's createdByAgentId (guard B, ADR-092 D3 createdByAgentId fallback)", async () => {
      await insertAgent(AGENT_AUTHOR, "Creator");
      const issueId = await insertIssue({ createdByAgentId: AGENT_AUTHOR, assigneeAgentId: AGENT_AUTHOR });
      await insertDecision(issueId, { actorAgentId: AGENT_AUTHOR });
      await insertMention(issueId);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.skipped["guard-b:decision-by-return-assignee"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("skips when the approval was made by the card's returnAssignee (guard B)", async () => {
      await insertAgent(AGENT_LEAD, "Lead");
      const issueId = await insertIssue({
        executionPolicy: { ...EXECUTION_POLICY, returnAssigneeAgentId: AGENT_LEAD },
      });
      await insertDecision(issueId, { actorAgentId: AGENT_LEAD });
      await insertMention(issueId);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.skipped["guard-b:decision-by-return-assignee"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("refuses when no return assignee, delivery author, or creator agent is recorded (guard B, unresolvable)", async () => {
      const stage2Id = "00000000-0000-0000-0000-0000000000b1";
      const stage3Id = "00000000-0000-0000-0000-0000000000b2";
      await insertAgent(AGENT_AUTHOR, "Assignee");
      await insertAgent(AGENT_REVIEWER, "Reviewer");
      const issueId = await insertIssue({
        assigneeAgentId: AGENT_AUTHOR,
        createdByAgentId: null,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [
            { id: REVIEW_STAGE_ID, type: "review", approvalsNeeded: 1 },
            { id: APPROVAL_STAGE_ID, type: "approval", approvalsNeeded: 1 },
          ],
        },
        executionState: approvedState({
          completedStageIds: [REVIEW_STAGE_ID, APPROVAL_STAGE_ID],
          returnAssignee: null,
        }),
      });
      await insertDecision(issueId, { stageId: REVIEW_STAGE_ID, actorAgentId: AGENT_AUTHOR, actorUserId: null });
      await insertDecision(issueId, { stageId: APPROVAL_STAGE_ID, actorAgentId: AGENT_REVIEWER, actorUserId: null });
      await insertMention(issueId);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.skipped["guard-b:return-assignee-unresolved"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("does not refuse when the current assignee decided but delivery author is a different agent (SUP-13568 regression)", async () => {
      await insertAgent(AGENT_REVIEWER, "Reviewer");
      await insertAgent(AGENT_LEAD, "Deliverer");
      const issueId = await insertIssue({
        assigneeAgentId: AGENT_REVIEWER,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [
            { id: REVIEW_STAGE_ID, type: "review", approvalsNeeded: 1 },
          ],
        },
        executionState: approvedState({
          completedStageIds: [REVIEW_STAGE_ID],
          returnAssignee: null,
          deliveryAuthor: { type: "agent", agentId: AGENT_LEAD, userId: null },
        }),
      });
      await insertDecision(issueId, { stageId: REVIEW_STAGE_ID, actorAgentId: AGENT_REVIEWER, actorUserId: null });
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { statuses: [] } },
        { url: POST_STATUS_URL, body: {} },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.skipped["guard-b:decision-by-return-assignee"]).toBeUndefined();
      expect(summary.skipped["guard-b:return-assignee-unresolved"]).toBeUndefined();
      expect(summary.republished).toBe(1);
    });

    it("passes when creator=assignee, declared return assignee is a third agent, none decided by return assignee (ADR-092 D7 legal shape)", async () => {
      const stage2Id = "00000000-0000-0000-0000-0000000000c1";
      const stage3Id = "00000000-0000-0000-0000-0000000000c2";
      await insertAgent(AGENT_AUTHOR, "FilerAndAssignee");
      await insertAgent(AGENT_REVIEWER, "Reviewer");
      await insertAgent(AGENT_LEAD, "ReturnAssignee");
      const issueId = await insertIssue({
        createdByAgentId: AGENT_AUTHOR,
        assigneeAgentId: AGENT_AUTHOR,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [
            { id: REVIEW_STAGE_ID, type: "review", approvalsNeeded: 1 },
            { id: APPROVAL_STAGE_ID, type: "approval", approvalsNeeded: 1 },
          ],
          returnAssigneeAgentId: AGENT_LEAD,
        },
        executionState: approvedState({
          completedStageIds: [REVIEW_STAGE_ID, APPROVAL_STAGE_ID],
          returnAssignee: { type: "agent", agentId: AGENT_LEAD, userId: null },
        }),
      });
      await insertDecision(issueId, { stageId: REVIEW_STAGE_ID, actorAgentId: AGENT_REVIEWER, actorUserId: null });
      await insertDecision(issueId, { stageId: APPROVAL_STAGE_ID, actorAgentId: AGENT_AUTHOR, actorUserId: null });
      await insertMention(issueId);

      installRoutes([{ url: PR_URL, body: OPEN_PR_BODY }]);
      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { statuses: [] } },
        { url: POST_STATUS_URL, body: {} },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.skipped["guard-b:decision-by-return-assignee"]).toBeUndefined();
      expect(summary.republished).toBe(1);
    });

    it("refuses when the return assignee decided a completed stage (ADR-092 D7 illegal twin)", async () => {
      const stage2Id = "00000000-0000-0000-0000-0000000000d1";
      await insertAgent(AGENT_AUTHOR, "FilerAndAssignee");
      await insertAgent(AGENT_REVIEWER, "Reviewer");
      await insertAgent(AGENT_LEAD, "ReturnAssignee");
      const issueId = await insertIssue({
        createdByAgentId: AGENT_AUTHOR,
        assigneeAgentId: AGENT_AUTHOR,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [
            { id: REVIEW_STAGE_ID, type: "review", approvalsNeeded: 1 },
            { id: APPROVAL_STAGE_ID, type: "approval", approvalsNeeded: 1 },
          ],
          returnAssigneeAgentId: AGENT_LEAD,
        },
        executionState: approvedState({
          completedStageIds: [REVIEW_STAGE_ID, APPROVAL_STAGE_ID],
          returnAssignee: { type: "agent", agentId: AGENT_LEAD, userId: null },
        }),
      });
      await insertDecision(issueId, { stageId: REVIEW_STAGE_ID, actorAgentId: AGENT_LEAD, actorUserId: null });
      await insertDecision(issueId, { stageId: APPROVAL_STAGE_ID, actorAgentId: AGENT_REVIEWER, actorUserId: null });
      await insertMention(issueId);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.skipped["guard-b:decision-by-return-assignee"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("skips when a stage was auto-skipped (guard B)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          completedStageIds: [APPROVAL_STAGE_ID],
          skippedStageIds: [REVIEW_STAGE_ID],
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.skipped["guard-b:skipped-stage"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("skips when a completed stage has no decision row (guard B)", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.skipped["guard-b:stage-without-decision"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("skips when a completed stage is not in the execution policy (guard B)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          completedStageIds: [APPROVAL_STAGE_ID, REVIEW_STAGE_ID],
        }),
      });
      await insertDecision(issueId, { stageId: APPROVAL_STAGE_ID });
      await insertMention(issueId);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.skipped["guard-b:stage-not-in-policy"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("skips ambiguous cards with several open linked PRs", async () => {
      const issueId = await insertIssue();
      await insertDecision(issueId);
      await insertMention(issueId, { number: 42 });
      await insertMention(issueId, { number: 43, state: "open" });

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.skipped["ambiguous-pr"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("does not select cards whose only mention is a closed PR (dead cards stay out of the scan)", async () => {
      const issueId = await insertIssue();
      await insertDecision(issueId);
      await insertMention(issueId, { state: "closed" });

      const summary = await runApprovalStatusReconcilerTick(db);

      // SUP-14736: the linked-PR EXISTS now requires a live open/unhydrated
      // PR, so an all-closed card is excluded before it ever reaches the
      // per-candidate resolver — it no longer consumes the window.
      expect(summary.scanned).toBe(0);
      expect(summary.republished).toBe(0);
      expect(Object.keys(summary.skipped)).toEqual([]);
      expect(postStatusCalls()).toHaveLength(0);
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("caps the per-tick candidate count and reports the excess", async () => {
      for (const identifier of ["SUP-42", "SUP-43", "SUP-44"]) {
        const issueId = await insertIssue({ identifier });
        await insertDecision(issueId);
        await insertMention(issueId, { number: Number(identifier.split("-")[1]) });
      }

      installRoutes([
        { url: "https://api.github.com/repos/TEA-Core/paperclip/pulls/42", body: { ...OPEN_PR_BODY, state: "closed", merged: false } },
        { url: "https://api.github.com/repos/TEA-Core/paperclip/pulls/43", body: { ...OPEN_PR_BODY, state: "closed", merged: false } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db, { maxCandidates: 2 });

      expect(summary.scanned).toBe(2);
      expect(summary.capped).toBe(1);
      expect(summary.skipped["pr-closed"]).toBe(2);
      expect(mockGhFetch.mock.calls.map((call) => String(call[0]))).not.toContain(
        "https://api.github.com/repos/TEA-Core/paperclip/pulls/44",
      );
    });

    describe("candidate scan traversal (SUP-14736)", () => {
      function installClosedPrRoutes(numbers: number[]) {
        installRoutes(
          numbers.map((n) => ({
            url: `https://api.github.com/repos/TEA-Core/paperclip/pulls/${n}`,
            body: { ...OPEN_PR_BODY, state: "closed", merged: false },
          })),
        );
      }

      async function seedOpenCandidates(identifiers: string[]) {
        for (const identifier of identifiers) {
          const issueId = await insertIssue({ identifier });
          await insertDecision(issueId);
          await insertMention(issueId, { number: Number(identifier.split("-")[1]) });
        }
      }

      it("walks the candidate set across consecutive ticks instead of re-reading the head", async () => {
        await seedOpenCandidates(["SUP-42", "SUP-43", "SUP-44", "SUP-45", "SUP-46"]);
        installClosedPrRoutes([42, 43, 44, 45, 46]);

        const tick1 = await runApprovalStatusReconcilerTick(db, { maxCandidates: 2 });
        expect(tick1.scanned).toBe(2);
        expect(tick1.capped).toBe(1);
        expect(tick1.nextScanKey).toBe("SUP-43");

        const tick2 = await runApprovalStatusReconcilerTick(db, {
          maxCandidates: 2,
          resumeAfter: tick1.nextScanKey,
        });
        expect(tick2.scanned).toBe(2);
        expect(tick2.capped).toBe(1);
        expect(tick2.nextScanKey).toBe("SUP-45");

        const tick3 = await runApprovalStatusReconcilerTick(db, {
          maxCandidates: 2,
          resumeAfter: tick2.nextScanKey,
        });
        expect(tick3.scanned).toBe(1);
        expect(tick3.capped).toBe(0);
        expect(tick3.nextScanKey).toBeNull();

        // Every candidate was reached, and no candidate was scanned twice.
        const scannedTotal = tick1.scanned + tick2.scanned + tick3.scanned;
        expect(scannedTotal).toBe(5);
        // Consecutive ticks advanced the window — the second tick's candidate
        // set differs from the first (no re-reading of the dead head).
        expect(tick2.skippedDetails).not.toEqual(tick1.skippedDetails);
      });

      it("wraps to the start of the set once the cursor reaches the end", async () => {
        await seedOpenCandidates(["SUP-42", "SUP-43", "SUP-44"]);
        installClosedPrRoutes([42, 43, 44]);

        const tick1 = await runApprovalStatusReconcilerTick(db, { maxCandidates: 2 });
        expect(tick1.scanned).toBe(2);
        expect(tick1.nextScanKey).toBe("SUP-43");

        const tick2 = await runApprovalStatusReconcilerTick(db, {
          maxCandidates: 2,
          resumeAfter: tick1.nextScanKey,
        });
        expect(tick2.scanned).toBe(1);
        expect(tick2.capped).toBe(0);
        expect(tick2.nextScanKey).toBeNull();

        // With the cursor reset to null the scan starts back at the head.
        const tick3 = await runApprovalStatusReconcilerTick(db, {
          maxCandidates: 2,
          resumeAfter: tick2.nextScanKey,
        });
        expect(tick3.scanned).toBe(2);
        expect(tick3.nextScanKey).toBe("SUP-43");
      });
    });

    describe("pending candidate recovery (SUP-14602)", () => {
      const STABLE_DIFF = [
        { filename: "server/src/a.ts", sha: "blobaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", status: "modified" },
      ];

      function pendingCandidatesState() {
        return {
          status: "completed",
          completedStageIds: [APPROVAL_STAGE_ID],
          lastDecisionOutcome: "approved",
          currentStageId: null,
          currentParticipant: null,
          returnAssignee: null,
          // The approval transition was skipped:ambiguous — no publishedHeadSha,
          // but the per-candidate approval-time heads survived.
          approvalStatus: {
            skipReason: "skipped:ambiguous",
            certifiedAt: APPROVED_AT,
            pendingCandidates: [
              { owner: "TEA-Core", repo: "paperclip", number: 42, headShaAtApproval: APPROVED_HEAD },
              { owner: "TEA-Core", repo: "paperclip", number: 43, headShaAtApproval: MOVED_HEAD },
            ],
          },
        };
      }

      it("republishes the surviving candidate's approved head when ambiguity resolves to exactly one open PR", async () => {
        const issueId = await insertIssue({ executionState: pendingCandidatesState() });
        await insertDecision(issueId);
        await insertMention(issueId, { number: 42, state: "open" });
        await insertMention(issueId, { number: 43, state: "closed" });

        installRoutes([
          { url: PR_URL, body: OPEN_PR_BODY },
          { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
          { url: PR_43_URL, body: CLOSED_43_BODY },
          { url: APPROVED_DIFF_URL, body: { status: "ahead", ahead_by: 1, files: STABLE_DIFF } },
          { url: LIVE_DIFF_URL, body: { status: "ahead", ahead_by: 1, files: STABLE_DIFF } },
          { url: POST_STATUS_URL, body: { id: 12345 } },
        ]);

        const summary = await runApprovalStatusReconcilerTick(db);

        expect(summary.scanned).toBe(1);
        expect(summary.republished).toBe(1);
        expect(summary.failed).toBe(0);
        expect(Object.keys(summary.skipped)).toEqual([]);
        const calls = postStatusCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0]![0]).toBe(POST_STATUS_URL);
        expect(postStatusBodies()[0]).toMatchObject({
          state: "success",
          context: PAPERCLIP_APPROVED,
        });

        // The recovery persisted publishedHeadSha for the certified head so
        // the normal path takes over from here.
        const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
        const approvalStatus = (row!.executionState as Record<string, unknown>).approvalStatus as Record<string, unknown>;
        expect(approvalStatus.publishedHeadSha).toBe(NEW_HEAD);
      });

      it("refuses recovery when the surviving candidate's diff-vs-base changed in substance (zero writes)", async () => {
        const issueId = await insertIssue({ executionState: pendingCandidatesState() });
        await insertDecision(issueId);
        await insertMention(issueId, { number: 42, state: "open" });
        await insertMention(issueId, { number: 43, state: "closed" });

        installRoutes([
          { url: PR_URL, body: OPEN_PR_BODY },
          { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
          { url: PR_43_URL, body: CLOSED_43_BODY },
          {
            url: APPROVED_DIFF_URL,
            body: {
              status: "ahead",
              ahead_by: 1,
              files: [{ filename: "server/src/a.ts", sha: "blob0000000000000000000000000000000000000000000000000001", status: "modified" }],
            },
          },
          {
            url: LIVE_DIFF_URL,
            body: {
              status: "ahead",
              ahead_by: 2,
              files: [{ filename: "server/src/a.ts", sha: "blob0000000000000000000000000000000000000000000000000002", status: "modified" }],
            },
          },
          { url: COMMENT_LIST_URL, body: [] },
          { url: COMMENT_POST_URL, body: { id: 9001 } },
        ]);

        const summary = await runApprovalStatusReconcilerTick(db);

        expect(summary.republished).toBe(0);
        expect(summary.skipped["guard-a:changed-blob"]).toBe(1);
        expect(summary.voidWarnings).toBe(1);
        expect(postStatusCalls()).toHaveLength(0);

        // No publishedHeadSha was persisted — the card stays unrecovered.
        const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
        const approvalStatus = (row!.executionState as Record<string, unknown>).approvalStatus as Record<string, unknown>;
        expect(approvalStatus.publishedHeadSha).toBeUndefined();
      });

      it("refuses recovery while more than one pending candidate is still open (zero writes)", async () => {
        const issueId = await insertIssue({ executionState: pendingCandidatesState() });
        await insertDecision(issueId);
        await insertMention(issueId, { number: 42, state: "open" });
        // Stale cached state: #43 is cached closed but is in fact still open.
        await insertMention(issueId, { number: 43, state: "closed" });

        installRoutes([
          { url: PR_URL, body: OPEN_PR_BODY },
          { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
          { url: PR_43_URL, body: OPEN_43_BODY },
        ]);

        const summary = await runApprovalStatusReconcilerTick(db);

        expect(summary.republished).toBe(0);
        expect(summary.skipped["guard-a:ambiguity-unresolved"]).toBe(1);
        expect(postStatusCalls()).toHaveLength(0);
      });

      it("refuses recovery when a pending candidate's live state is unverifiable (zero writes)", async () => {
        const issueId = await insertIssue({ executionState: pendingCandidatesState() });
        await insertDecision(issueId);
        await insertMention(issueId, { number: 42, state: "open" });
        await insertMention(issueId, { number: 43, state: "closed" });

        installRoutes([
          { url: PR_URL, body: OPEN_PR_BODY },
          { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
          { url: PR_43_URL, ok: false, status: 500, body: { message: "server error" } },
        ]);

        const summary = await runApprovalStatusReconcilerTick(db);

        expect(summary.republished).toBe(0);
        expect(summary.skipped["guard-a:ambiguity-unresolved"]).toBe(1);
        expect(postStatusCalls()).toHaveLength(0);
      });

      it("refuses recovery when no pending candidate is open or matches the live target (zero writes)", async () => {
        const issueId = await insertIssue({
          executionState: {
            ...pendingCandidatesState(),
            approvalStatus: {
              skipReason: "skipped:ambiguous",
              certifiedAt: APPROVED_AT,
              pendingCandidates: [
                { owner: "TEA-Core", repo: "paperclip", number: 43, headShaAtApproval: APPROVED_HEAD },
                { owner: "TEA-Core", repo: "paperclip", number: 44, headShaAtApproval: MOVED_HEAD },
              ],
            },
          },
        });
        await insertDecision(issueId);
        // The only open linked PR (#42) was never an approval candidate: the
        // candidates are #43 (closed) and #44 (merged).
        await insertMention(issueId, { number: 42, state: "open" });
        await insertMention(issueId, { number: 43, state: "closed" });
        await insertMention(issueId, { number: 44, state: "closed" });

        installRoutes([
          { url: PR_URL, body: OPEN_PR_BODY },
          { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
          { url: PR_43_URL, body: CLOSED_43_BODY },
          { url: PR_44_URL, body: MERGED_44_BODY },
        ]);

        const summary = await runApprovalStatusReconcilerTick(db);

        expect(summary.republished).toBe(0);
        expect(summary.skipped["guard-a:candidate-resolved"]).toBe(1);
        expect(postStatusCalls()).toHaveLength(0);
      });

      it("refuses recovery when the only open pending candidate is not the live target PR (zero writes)", async () => {
        // The live target (#42) was never an approval-time candidate, but
        // candidate #43 is still open. Guard A must not pair #43's certified
        // head with #42's live diff — that would compare two different PRs
        // and could post a misleading void warning on #42.
        const issueId = await insertIssue({
          executionState: {
            ...pendingCandidatesState(),
            approvalStatus: {
              skipReason: "skipped:ambiguous",
              certifiedAt: APPROVED_AT,
              pendingCandidates: [
                { owner: "TEA-Core", repo: "paperclip", number: 43, headShaAtApproval: APPROVED_HEAD },
                { owner: "TEA-Core", repo: "paperclip", number: 44, headShaAtApproval: MOVED_HEAD },
              ],
            },
          },
        });
        await insertDecision(issueId);
        await insertMention(issueId, { number: 42, state: "open" });
        // Stale cached state: #43 is cached closed but is in fact still open.
        await insertMention(issueId, { number: 43, state: "closed" });
        await insertMention(issueId, { number: 44, state: "closed" });

        installRoutes([
          { url: PR_URL, body: OPEN_PR_BODY },
          { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
          { url: PR_43_URL, body: OPEN_43_BODY },
          { url: PR_44_URL, body: MERGED_44_BODY },
        ]);

        const summary = await runApprovalStatusReconcilerTick(db);

        expect(summary.republished).toBe(0);
        expect(summary.skipped["guard-a:candidate-not-target"]).toBe(1);
        expect(postStatusCalls()).toHaveLength(0);

        // No publishedHeadSha was persisted — the card stays unrecovered.
        const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
        const approvalStatus = (row!.executionState as Record<string, unknown>).approvalStatus as Record<string, unknown>;
        expect(approvalStatus.publishedHeadSha).toBeUndefined();
      });

      it("refuses recovery when the surviving candidate has no persisted head anchor (zero writes)", async () => {
        const issueId = await insertIssue({
          executionState: {
            ...pendingCandidatesState(),
            approvalStatus: {
              skipReason: "skipped:ambiguous",
              certifiedAt: APPROVED_AT,
              pendingCandidates: [
                { owner: "TEA-Core", repo: "paperclip", number: 42, headShaAtApproval: null },
                { owner: "TEA-Core", repo: "paperclip", number: 43, headShaAtApproval: MOVED_HEAD },
              ],
            },
          },
        });
        await insertDecision(issueId);
        await insertMention(issueId, { number: 42, state: "open" });
        await insertMention(issueId, { number: 43, state: "closed" });

        installRoutes([
          { url: PR_URL, body: OPEN_PR_BODY },
          { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
          { url: PR_43_URL, body: CLOSED_43_BODY },
        ]);

        const summary = await runApprovalStatusReconcilerTick(db);

        expect(summary.republished).toBe(0);
        expect(summary.skipped["guard-a:no-approved-head"]).toBe(1);
        expect(postStatusCalls()).toHaveLength(0);
      });

      it("performs zero writes on the re-run after a successful recovery republish", async () => {
        const issueId = await insertIssue({ executionState: pendingCandidatesState() });
        await insertDecision(issueId);
        await insertMention(issueId, { number: 42, state: "open" });
        await insertMention(issueId, { number: 43, state: "closed" });

        installRoutes([
          { url: PR_URL, body: OPEN_PR_BODY },
          { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
          { url: PR_43_URL, body: CLOSED_43_BODY },
          { url: APPROVED_DIFF_URL, body: { status: "ahead", ahead_by: 1, files: STABLE_DIFF } },
          { url: LIVE_DIFF_URL, body: { status: "ahead", ahead_by: 1, files: STABLE_DIFF } },
          { url: POST_STATUS_URL, body: { id: 12345 } },
        ]);

        const first = await runApprovalStatusReconcilerTick(db);
        expect(first.republished).toBe(1);

        const callsBeforeSecondTick = mockGhFetch.mock.calls.length;
        installRoutes([
          { url: PR_URL, body: OPEN_PR_BODY },
          {
            url: COMBINED_STATUS_URL,
            body: {
              state: "success",
              statuses: [{ context: PAPERCLIP_APPROVED, state: "success" }],
            },
          },
        ]);

        const second = await runApprovalStatusReconcilerTick(db);

        expect(second.republished).toBe(0);
        expect(second.skipped["already-success"]).toBe(1);
        // Zero writes on the re-run — and the pending-candidate walk is no
        // longer needed now that publishedHeadSha is persisted.
        const secondTickUrls = mockGhFetch.mock.calls
          .slice(callsBeforeSecondTick)
          .map((call) => String(call[0]));
        expect(secondTickUrls).not.toContain(PR_43_URL);
        expect(postStatusCalls()).toHaveLength(1);
      });
    });
  });

  describe("first publish anchored on approvedHeadSha (SUP-14715 D-B)", () => {
    it("certifies a first publish when the live head still equals approvedHeadSha and the card delivered its own PR", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { approvedHeadSha: NEW_HEAD, approvedAt: APPROVED_AT },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);
      // The card's delivery identity matches the linked PR (branch + repo), so
      // the first publish's delivery-identity gate passes.
      await seedDeliveryIdentity(issueId, "some-branch-name", "https://github.com/TEA-Core/paperclip");

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: POST_STATUS_URL, body: { id: 12348 } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(1);
      expect(summary.failed).toBe(0);
      expect(Object.keys(summary.skipped)).toEqual([]);
      const calls = postStatusCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe(POST_STATUS_URL);
      expect(postStatusBodies()[0]).toMatchObject({ state: "success", context: PAPERCLIP_APPROVED });
    });

    it("enforces the delivery-identity gate on a first publish — refuses when no delivery branch is recorded", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { approvedHeadSha: NEW_HEAD, approvedAt: APPROVED_AT },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);
      // No execution workspace: the card's delivery identity is unresolvable.
      // The live head equals the anchor (no Guard A compare), so the only thing
      // that can stop the publish is the D1 delivery-identity gate — which this
      // first publish now enforces (a re-publish would have stamped here).

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.skipped["publish:skipped"]).toBe(1);
      expect(summary.skippedDetails[0]).toContain("delivery_identity_unresolved");
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("gates a first publish through Guard A when the live head moved off approvedHeadSha (changed blob refuses)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { approvedHeadSha: APPROVED_HEAD, approvedAt: APPROVED_AT },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        {
          url: APPROVED_DIFF_URL,
          body: {
            status: "ahead",
            ahead_by: 1,
            files: [{ filename: "server/src/config.ts", sha: "blob0000000000000000000000000000000000000001", status: "modified" }],
          },
        },
        {
          url: LIVE_DIFF_URL,
          body: {
            status: "ahead",
            ahead_by: 2,
            files: [{ filename: "server/src/config.ts", sha: "blob0000000000000000000000000000000000000002", status: "modified" }],
          },
        },
        { url: COMMENT_LIST_URL, body: [] },
        { url: COMMENT_POST_URL, body: { id: 9001 } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.skipped["guard-a:changed-blob"]).toBe(1);
      // The voided-anchor warning still surfaces on the PR for the first-publish
      // anchor, exactly as it does for a re-publish.
      expect(summary.voidWarnings).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("recovers a stranded pre-D-B first publish from the PR timeline and publishes it when the head is unchanged since approval (SUP-14747 D-E)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { approvedHeadSha: null, publishedHeadSha: null },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);
      // The card's delivery identity matches the linked PR, so the first
      // publish's ADR-091 D1 delivery-identity gate passes.
      await seedDeliveryIdentity(issueId, "some-branch-name", "https://github.com/TEA-Core/paperclip");

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: TIMELINE_URL, body: TIMELINE_SAME_HEAD_BODY },
        { url: POST_STATUS_URL, body: { id: 12348 } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(1);
      expect(summary.failed).toBe(0);
      expect(summary.backfilled).toBe(1);
      expect(Object.keys(summary.skipped)).toEqual([]);
      expect(postStatusCalls()).toHaveLength(1);
      expect(postStatusBodies()[0]).toMatchObject({ state: "success", context: PAPERCLIP_APPROVED });

      // The recovered D-B anchor and the published stamp both persist.
      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      const approvalStatus = (row!.executionState as Record<string, unknown>).approvalStatus as Record<string, unknown>;
      expect(approvalStatus.approvedHeadSha).toBe(NEW_HEAD);
      expect(approvalStatus.publishedHeadSha).toBe(NEW_HEAD);
    });

    it("refuses the backfill when the head moved after approval and leaves the card stranded, writing no anchor (SUP-14747 D-E)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { approvedHeadSha: null, publishedHeadSha: null },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);
      await seedDeliveryIdentity(issueId, "some-branch-name", "https://github.com/TEA-Core/paperclip");

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: TIMELINE_URL, body: TIMELINE_MOVED_HEAD_BODY },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.skipped["backfill:head-moved-since-approval"]).toBe(1);
      expect(summary.backfilled).toBe(0);
      expect(postStatusCalls()).toHaveLength(0);

      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      const approvalStatus = (row!.executionState as Record<string, unknown>).approvalStatus as Record<string, unknown>;
      expect(approvalStatus.approvedHeadSha).toBeNull();
      expect(approvalStatus.publishedHeadSha).toBeNull();
    });

    it("refuses the backfill when there is no head-mutating event at or before the approval, writing no anchor (SUP-14747 D-E)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { approvedHeadSha: null, publishedHeadSha: null },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);
      await seedDeliveryIdentity(issueId, "some-branch-name", "https://github.com/TEA-Core/paperclip");

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: TIMELINE_URL, body: TIMELINE_NO_HEAD_EVENT_BODY },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.skipped["backfill:no-head-mutating-event"]).toBe(1);
      expect(summary.backfilled).toBe(0);
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("refuses the backfill when the head is provable only through committed (client-timed) events and the earliest server timestamp is after the approval, writing no anchor (SUP-14747 D-E, backfill-committed-event-timing)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { approvedHeadSha: null, publishedHeadSha: null },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);
      await seedDeliveryIdentity(issueId, "some-branch-name", "https://github.com/TEA-Core/paperclip");

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: TIMELINE_URL, body: TIMELINE_COMMITTED_ONLY_BODY },
        {
          url: CHECK_RUNS_URL,
          // A check run GitHub triggered on this PR's head branch, whose
          // server-assigned created_at is AFTER the approval: no branch-bound
          // evidence at/before the approval, so the head is unverifiable.
          body: {
            total_count: 1,
            check_runs: [{ check_suite: { head_branch: "some-branch-name" }, created_at: "2026-08-20T01:00:00Z" }],
          },
        },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.skipped["backfill:head-unverifiable"]).toBe(1);
      expect(summary.backfilled).toBe(0);
      expect(postStatusCalls()).toHaveLength(0);

      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      const approvalStatus = (row!.executionState as Record<string, unknown>).approvalStatus as Record<string, unknown>;
      expect(approvalStatus.approvedHeadSha).toBeNull();
      expect(approvalStatus.publishedHeadSha).toBeNull();
    });

    it("does not anchor a head whose force-push landed after the approval even when a committed event's client date is earlier (SUP-14747 D-E, backfill-committed-event-timing)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { approvedHeadSha: null, publishedHeadSha: null },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);
      await seedDeliveryIdentity(issueId, "some-branch-name", "https://github.com/TEA-Core/paperclip");

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: TIMELINE_URL, body: TIMELINE_POST_APPROVAL_PUSH_BODY },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      // The committed event's committer.date sits before the approval, but the
      // only server-timed push is after it: the head-at-approval cannot be
      // verified to a server timestamp, so nothing is anchored and nothing is
      // stamped.
      expect(summary.republished).toBe(0);
      expect(summary.skipped["backfill:head-unverifiable"]).toBe(1);
      expect(summary.backfilled).toBe(0);
      expect(postStatusCalls()).toHaveLength(0);

      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      const approvalStatus = (row!.executionState as Record<string, unknown>).approvalStatus as Record<string, unknown>;
      expect(approvalStatus.approvedHeadSha).toBeNull();
      expect(approvalStatus.publishedHeadSha).toBeNull();
    });

    it("anchors a never-force-pushed PR whose head has a check run on this PR's branch created at/before the approval time (SUP-14844)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { approvedHeadSha: null, publishedHeadSha: null },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);
      await seedDeliveryIdentity(issueId, "some-branch-name", "https://github.com/TEA-Core/paperclip");

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: TIMELINE_URL, body: TIMELINE_COMMITTED_ONLY_BODY },
        {
          url: CHECK_RUNS_URL,
          // A check run GitHub triggered on this PR's head branch, whose
          // server-assigned created_at is BEFORE the approval: the sha
          // provably existed on this branch at/before the approval.
          body: {
            total_count: 1,
            check_runs: [{ check_suite: { head_branch: "some-branch-name" }, created_at: "2026-08-19T12:00:00Z" }],
          },
        },
        { url: POST_STATUS_URL, body: { id: 12348 } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(1);
      expect(summary.failed).toBe(0);
      expect(summary.backfilled).toBe(1);
      expect(Object.keys(summary.skipped)).toEqual([]);
      expect(postStatusCalls()).toHaveLength(1);
      expect(postStatusBodies()[0]).toMatchObject({ state: "success", context: PAPERCLIP_APPROVED });

      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      const approvalStatus = (row!.executionState as Record<string, unknown>).approvalStatus as Record<string, unknown>;
      expect(approvalStatus.approvedHeadSha).toBe(NEW_HEAD);
      expect(approvalStatus.publishedHeadSha).toBe(NEW_HEAD);
    });

    it("reports a transient skip and does not persist when check-runs read fails (SUP-14844)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { approvedHeadSha: null, publishedHeadSha: null },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);
      await seedDeliveryIdentity(issueId, "some-branch-name", "https://github.com/TEA-Core/paperclip");

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: TIMELINE_URL, body: TIMELINE_COMMITTED_ONLY_BODY },
        { url: CHECK_RUNS_URL, body: {}, ok: false, status: 500 },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.skipped["backfill:sha-existence-read-failed"]).toBe(1);
      expect(summary.backfilled).toBe(0);
      expect(postStatusCalls()).toHaveLength(0);

      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      const approvalStatus = (row!.executionState as Record<string, unknown>).approvalStatus as Record<string, unknown>;
      expect(approvalStatus.approvedHeadSha).toBeNull();
      expect(approvalStatus.backfillRefusal).toBeUndefined();
    });

    it("refuses (persistent) when the head sha's only check runs are cross-branch — no check run on this PR's head branch (SUP-14844, branch-binding)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { approvedHeadSha: null, publishedHeadSha: null },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);
      await seedDeliveryIdentity(issueId, "some-branch-name", "https://github.com/TEA-Core/paperclip");

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: TIMELINE_URL, body: TIMELINE_COMMITTED_ONLY_BODY },
        // The only check run for this sha was triggered on a DIFFERENT branch,
        // with a pre-approval created_at: without branch-binding this older
        // timestamp would wrongly anchor the sha, but it is not this PR's
        // evidence, so the binding cannot be shown and the head is unverifiable.
        {
          url: CHECK_RUNS_URL,
          body: {
            total_count: 1,
            check_runs: [{ check_suite: { head_branch: "other-branch" }, created_at: "2026-08-19T01:00:00Z" }],
          },
        },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.skipped["backfill:head-unverifiable"]).toBe(1);
      expect(summary.backfilled).toBe(0);
      expect(postStatusCalls()).toHaveLength(0);

      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      const approvalStatus = (row!.executionState as Record<string, unknown>).approvalStatus as Record<string, unknown>;
      expect(approvalStatus.approvedHeadSha).toBeNull();
      expect(approvalStatus.publishedHeadSha).toBeNull();
      // The absence of branch-bound evidence is deterministic, so it persists.
      expect(approvalStatus.backfillRefusal).toMatchObject({ reason: "backfill:head-unverifiable" });
    });

    it("refuses the laundering trace: a cross-branch pre-approval check run is ignored in favor of this-branch post-approval check runs (SUP-14844, Finding 2)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { approvedHeadSha: null, publishedHeadSha: null },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);
      await seedDeliveryIdentity(issueId, "some-branch-name", "https://github.com/TEA-Core/paperclip");

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: TIMELINE_URL, body: TIMELINE_COMMITTED_ONLY_BODY },
        // Head A is approved; the branch is later fast-forwarded (a normal push,
        // no force-push) to a pre-existing sha B that was already CI'd on another
        // branch BEFORE the approval. The cross-branch run (01:00) predates the
        // approval (2026-08-20T00:00), but the only run on THIS branch landed
        // after it (05:00). Unbound, the older cross-branch run would launder B
        // in; branch-binding keeps only the this-branch run, which is
        // post-approval, so the head is unverifiable.
        {
          url: CHECK_RUNS_URL,
          body: {
            total_count: 2,
            check_runs: [
              { check_suite: { head_branch: "other-branch" }, created_at: "2026-08-19T01:00:00Z" },
              { check_suite: { head_branch: "some-branch-name" }, created_at: "2026-08-20T05:00:00Z" },
            ],
          },
        },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.skipped["backfill:head-unverifiable"]).toBe(1);
      expect(summary.backfilled).toBe(0);
      expect(postStatusCalls()).toHaveLength(0);

      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      const approvalStatus = (row!.executionState as Record<string, unknown>).approvalStatus as Record<string, unknown>;
      expect(approvalStatus.approvedHeadSha).toBeNull();
      expect(approvalStatus.publishedHeadSha).toBeNull();
      expect(approvalStatus.backfillRefusal).toMatchObject({ reason: "backfill:head-unverifiable" });
    });

    it("skips the timeline re-read on a stable refusal while the live head is unchanged (SUP-14747 D-E, backfill-repeat-fanout)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { approvedHeadSha: null, publishedHeadSha: null },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);
      await seedDeliveryIdentity(issueId, "some-branch-name", "https://github.com/TEA-Core/paperclip");

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: TIMELINE_URL, body: TIMELINE_COMMITTED_ONLY_BODY },
        {
          url: CHECK_RUNS_URL,
          // A branch-bound check run whose server created_at is post-approval:
          // a deterministic head-unverifiable refusal to drive the repeat-fanout.
          body: {
            total_count: 1,
            check_runs: [{ check_suite: { head_branch: "some-branch-name" }, created_at: "2026-08-20T01:00:00Z" }],
          },
        },
      ]);

      const timelineCalls = () =>
        mockGhFetch.mock.calls.filter((call) => String(call[0]) === TIMELINE_URL).length;

      const summary1 = await runApprovalStatusReconcilerTick(db);
      expect(summary1.skipped["backfill:head-unverifiable"]).toBe(1);
      const readsAfterFirst = timelineCalls();
      expect(readsAfterFirst).toBeGreaterThan(0);

      // Second tick, same live head: the persisted refusal short-circuits the
      // timeline re-read and re-reports the same refusal.
      const summary2 = await runApprovalStatusReconcilerTick(db);
      expect(summary2.skipped["backfill:head-unverifiable"]).toBe(1);
      expect(timelineCalls()).toBe(readsAfterFirst);

      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      const approvalStatus = (row!.executionState as Record<string, unknown>).approvalStatus as Record<string, unknown>;
      expect(approvalStatus.approvedHeadSha).toBeNull();
      const refusal = approvalStatus.backfillRefusal as Record<string, unknown>;
      expect(refusal).toMatchObject({
        reason: "backfill:head-unverifiable",
        observedHeadSha: NEW_HEAD,
        approvedAtMs: new Date(APPROVED_AT).getTime(),
      });
    });

    it("does not persist a stable refusal on a transient timeline read failure, so the next tick retries the read (SUP-14747 D-E, backfill-refusal-caches-transient-failures)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { approvedHeadSha: null, publishedHeadSha: null },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);
      await seedDeliveryIdentity(issueId, "some-branch-name", "https://github.com/TEA-Core/paperclip");

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        // A transient HTTP 500 on the timeline read (a rate-limit / network blip
        // shares this branch with deterministic failures).
        { url: TIMELINE_URL, ok: false, status: 500, body: { message: "server error" } },
      ]);

      const timelineCalls = () =>
        mockGhFetch.mock.calls.filter((call) => String(call[0]) === TIMELINE_URL).length;

      const summary1 = await runApprovalStatusReconcilerTick(db);
      expect(summary1.skipped["backfill:timeline-read-failed"]).toBe(1);
      expect(summary1.backfilled).toBe(0);
      const readsAfterFirst = timelineCalls();
      expect(readsAfterFirst).toBeGreaterThan(0);

      // The transient failure must NOT be cached as a stable refusal: the
      // persisted approvalStatus carries no backfillRefusal.
      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      const approvalStatus = (row!.executionState as Record<string, unknown>).approvalStatus as Record<string, unknown>;
      expect(approvalStatus.backfillRefusal).toBeUndefined();

      // Second tick: because nothing was cached, the timeline read is retried
      // rather than short-circuited on a cached refusal.
      const summary2 = await runApprovalStatusReconcilerTick(db);
      expect(summary2.skipped["backfill:timeline-read-failed"]).toBe(1);
      expect(timelineCalls()).toBeGreaterThan(readsAfterFirst);
    });

    it("persists a stable refusal for a deterministic unparseable force-push event, so the next tick does not re-read the timeline (SUP-14747 D-E, backfill-unparseable-event-misclassified-transient)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { approvedHeadSha: null, publishedHeadSha: null },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);
      await seedDeliveryIdentity(issueId, "some-branch-name", "https://github.com/TEA-Core/paperclip");

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        // A structurally malformed but stable event: a head_ref_force_pushed with
        // a null commit_id. Unlike the transient 500 above, the same bytes are
        // read on every tick, so this is a DETERMINISTIC refusal that must be
        // cached — and it must NOT be reported as a transient
        // timeline-read-failed.
        { url: TIMELINE_URL, body: TIMELINE_UNPARSEABLE_FORCE_PUSH_BODY },
      ]);

      const timelineCalls = () =>
        mockGhFetch.mock.calls.filter((call) => String(call[0]) === TIMELINE_URL).length;

      const summary1 = await runApprovalStatusReconcilerTick(db);
      // The unparseable event is its own deterministic refusal, not the transient
      // read-failed bucket.
      expect(summary1.skipped["backfill:unparseable-force-push"]).toBe(1);
      expect(summary1.skipped["backfill:timeline-read-failed"]).toBeUndefined();
      expect(summary1.backfilled).toBe(0);
      const readsAfterFirst = timelineCalls();
      expect(readsAfterFirst).toBeGreaterThan(0);

      // Zero writes: no anchor is persisted, and the deterministic refusal is.
      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      const approvalStatus = (row!.executionState as Record<string, unknown>).approvalStatus as Record<string, unknown>;
      expect(approvalStatus.approvedHeadSha).toBeNull();
      const refusal = approvalStatus.backfillRefusal as Record<string, unknown>;
      expect(refusal).toMatchObject({
        reason: "backfill:unparseable-force-push",
        observedHeadSha: NEW_HEAD,
        approvedAtMs: new Date(APPROVED_AT).getTime(),
      });

      // Second tick, same live head + approval time: the persisted refusal
      // short-circuits the timeline re-read. No additional timeline HTTP calls.
      const summary2 = await runApprovalStatusReconcilerTick(db);
      expect(summary2.skipped["backfill:unparseable-force-push"]).toBe(1);
      expect(timelineCalls()).toBe(readsAfterFirst);
    });

    it("re-evaluates a cached backfill refusal when the card is re-approved at a later time with the live head unchanged (SUP-14747 D-E, backfill-refusal-not-keyed-on-approval-time)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { approvedHeadSha: null, publishedHeadSha: null },
        }),
      });
      await insertDecision(issueId); // first approval at APPROVED_AT (2026-08-20T00:00:00Z)
      await insertMention(issueId);
      await seedDeliveryIdentity(issueId, "some-branch-name", "https://github.com/TEA-Core/paperclip");

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: TIMELINE_URL, body: TIMELINE_REAPPROVAL_BODY },
        { url: POST_STATUS_URL, body: { id: 12348 } },
      ]);

      // First approval time: the verified head at approval (APPROVED_HEAD)
      // differs from the live head (NEW_HEAD), so the backfill refuses and
      // caches the refusal against (head, first-approval-time).
      const summary1 = await runApprovalStatusReconcilerTick(db);
      expect(summary1.skipped["backfill:head-moved-since-approval"]).toBe(1);
      expect(summary1.backfilled).toBe(0);

      // Re-approval at a LATER time (after the head was force-pushed to
      // NEW_HEAD): the head-at-approval-time now equals the live head. The live
      // head is unchanged, so a cache keyed only on the head would wrongly reuse
      // the stale head-moved refusal; keyed on the approval time too, the stale
      // refusal is invalidated and the backfill re-runs — now it recovers the
      // anchor and publishes.
      await insertDecision(issueId, { createdAt: new Date("2026-08-21T00:00:00Z") });

      const summary2 = await runApprovalStatusReconcilerTick(db);
      expect(summary2.skipped["backfill:head-moved-since-approval"]).toBeUndefined();
      expect(summary2.backfilled).toBe(1);
      expect(summary2.republished).toBe(1);
    });

    it("recovers a stranded card's anchor but refuses to stamp it when the card is not the PR's delivering card (delivery-identity gate) (SUP-14747 D-E)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({
          approvalStatus: { approvedHeadSha: null, publishedHeadSha: null },
        }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);
      // No delivery identity recorded: the card cannot be proven to have
      // delivered the linked PR. The backfill still recovers a valid anchor
      // (timeline head matches the live head), but the ADR-091 D1
      // delivery-identity gate the first publish enforces must refuse the stamp.

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: TIMELINE_URL, body: TIMELINE_SAME_HEAD_BODY },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.backfilled).toBe(1);
      expect(summary.skipped["publish:skipped"]).toBe(1);
      expect(summary.skippedDetails[0]).toContain("delivery_identity_unresolved");
      expect(postStatusCalls()).toHaveLength(0);

      // The backfill persisted the recovered anchor; no stamp was published.
      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      const approvalStatus = (row!.executionState as Record<string, unknown>).approvalStatus as Record<string, unknown>;
      expect(approvalStatus.approvedHeadSha).toBe(NEW_HEAD);
      expect(approvalStatus.publishedHeadSha).toBeNull();
    });

    it("still fires the stage-integrity (self-approval) refusal on a first-publish-anchored card", async () => {
      await insertAgent(AGENT_AUTHOR, "Assignee");
      const issueId = await insertIssue({
        createdByAgentId: AGENT_AUTHOR,
        assigneeAgentId: AGENT_AUTHOR,
        executionState: approvedState({
          approvalStatus: { approvedHeadSha: NEW_HEAD, approvedAt: APPROVED_AT },
        }),
      });
      await insertDecision(issueId, { actorAgentId: AGENT_AUTHOR });
      await insertMention(issueId);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.skipped["guard-b:decision-by-return-assignee"]).toBe(1);
      expect(postStatusCalls()).toHaveLength(0);
      // Guard B refuses before any GitHub read.
      expect(mockGhFetch).not.toHaveBeenCalled();
    });
  });

  describe("SUP-14911: terminal resolution error on unhydrated PR", () => {
    /**
     * Insert a phantom external object that mimics a typo'd GitHub URL:
     * never successfully resolved (state=null), lastErrorCode set to a
     * terminal auth error. This is the exact shape that wedged the
     * reconciler on SUP-14747.
     */
    async function insertPhantomMention(issueId: string, externalId: string, lastErrorCode: string) {
      const data: Record<string, unknown> = {};
      const [externalObj] = await db
        .insert(externalObjects)
        .values({
          companyId,
          providerKey: "github",
          objectType: "pull_request",
          externalId,
          data,
          lastErrorCode,
        })
        .returning();
      await db.insert(externalObjectMentions).values({
        companyId,
        sourceIssueId: issueId,
        sourceKind: "comment",
        objectId: externalObj!.id,
        objectType: "pull_request",
        providerKey: "github",
      });
      return externalObj;
    }

    it("skips with dead-unhydrated-pr when the only unhydrated link has a terminal auth error (zero fetches)", async () => {
      // Merged real PR + phantom pairclip PR = the exact SUP-14747 shape.
      const issueId = await insertIssue();
      await insertDecision(issueId);
      // Real PR is merged.
      await insertMention(issueId, { state: "merged", number: 461 });
      // Phantom: typo'd repo, never resolved, terminal auth error.
      await insertPhantomMention(issueId, "TEA-Core/pairclip#pull/461", "github_auth_required");

      // No routes needed: the fix must perform ZERO GitHub fetches.
      mockGhFetch.mockImplementation(async (url: string) => {
        throw new Error(`unexpected ghFetch call: ${url}`);
      });

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.scanned).toBe(1);
      expect(summary.republished).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.skipped["dead-unhydrated-pr"]).toBe(1);
      expect(summary.skippedDetails[0]).toContain("TEA-Core/pairclip#461");
      expect(summary.skippedDetails[0]).toContain("err=github_auth_required");
      // Zero fetches: the terminal-error object was excluded before any call.
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("still selects and fetches a genuinely unhydrated PR with no error (negative test AC3)", async () => {
      const issueId = await insertIssue();
      await insertDecision(issueId);
      // Genuinely unhydrated: state=null, lastErrorCode=null (never attempted).
      const [phantom] = await db
        .insert(externalObjects)
        .values({
          companyId,
          providerKey: "github",
          objectType: "pull_request",
          externalId: "TEA-Core/paperclip#pull/461",
          data: {},
          lastErrorCode: null,
        })
        .returning();
      await db.insert(externalObjectMentions).values({
        companyId,
        sourceIssueId: issueId,
        sourceKind: "comment",
        objectId: phantom!.id,
        objectType: "pull_request",
        providerKey: "github",
      });

      const PHANTOM_PR_URL = "https://api.github.com/repos/TEA-Core/paperclip/pulls/461";
      installRoutes([
        { url: PHANTOM_PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
        { url: POST_STATUS_URL, body: { id: 12345 } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      // The PR was selected, fetched, and republished — not skipped.
      expect(summary.republished).toBe(1);
      expect(summary.failed).toBe(0);
      expect(summary.skipped["dead-unhydrated-pr"]).toBeUndefined();
      expect(mockGhFetch).toHaveBeenCalled();
    });

    it("reports failed with owner/repo/number when a legitimate open PR 401s (AC4 + AC5)", async () => {
      const issueId = await insertIssue();
      await insertDecision(issueId);
      // A real PR that is cached as open but whose live fetch will 401.
      await insertMention(issueId, { state: "open", number: 461 });

      const LEGIT_PR_URL = "https://api.github.com/repos/TEA-Core/paperclip/pulls/461";
      mockGhFetch.mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ message: "Bad credentials" }),
      } as unknown as Response);

      const summary = await runApprovalStatusReconcilerTick(db);

      // A genuine credential failure on a real, previously-hydrated PR still fails.
      expect(summary.failed).toBe(1);
      expect(summary.skipped["dead-unhydrated-pr"]).toBeUndefined();
      // AC5: the error detail names the owner/repo/number fetched.
      expect(summary.failedDetails[0]).toContain("TEA-Core/paperclip#461");
      expect(summary.failedDetails[0]).toContain("401");
    });
  });

  describe("startApprovalStatusReconciler", () => {
    it("runs ticks on the interval and stops on request", async () => {
      vi.useFakeTimers();
      try {
        const runTick = vi.fn().mockResolvedValue(zeroSummary());
        const stop = startApprovalStatusReconciler(db, {
          intervalMs: 60_000,
          initialDelayMs: 1_000,
          runTick,
        });

        await vi.advanceTimersByTimeAsync(1_000);
        expect(runTick).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(runTick).toHaveBeenCalledTimes(2);

        stop();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(runTick).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("skips overlapping ticks instead of queueing", async () => {
      vi.useFakeTimers();
      try {
        const deferred = { resolve: null as (() => void) | null };
        const runTick = vi.fn(() =>
          new Promise<ApprovalStatusReconcilerTickSummary>((resolve) => {
            deferred.resolve = () => resolve(zeroSummary());
          }),
        );
        const stop = startApprovalStatusReconciler(db, {
          intervalMs: 1_000,
          initialDelayMs: 10,
          runTick,
        });

        await vi.advanceTimersByTimeAsync(10);
        expect(runTick).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(runTick).toHaveBeenCalledTimes(1);

        deferred.resolve?.();
        await vi.advanceTimersByTimeAsync(0);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(runTick).toHaveBeenCalledTimes(2);

        stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("threads the keyset cursor into the next tick (SUP-14736)", async () => {
      vi.useFakeTimers();
      try {
        const summaries = [
          { ...zeroSummary(), nextScanKey: "SUP-43" },
          { ...zeroSummary(), nextScanKey: "SUP-44" },
          zeroSummary(),
        ];
        const runTick = vi.fn().mockImplementation(async () => summaries.shift()!);
        const stop = startApprovalStatusReconciler(db, {
          intervalMs: 60_000,
          initialDelayMs: 1_000,
          runTick,
        });

        await vi.advanceTimersByTimeAsync(1_000);
        expect(runTick).toHaveBeenCalledTimes(1);
        expect(runTick.mock.calls[0]![0]).toMatchObject({ resumeAfter: null });

        await vi.advanceTimersByTimeAsync(60_000);
        expect(runTick).toHaveBeenCalledTimes(2);
        expect(runTick.mock.calls[1]![0]).toMatchObject({ resumeAfter: "SUP-43" });

        await vi.advanceTimersByTimeAsync(60_000);
        expect(runTick).toHaveBeenCalledTimes(3);
        expect(runTick.mock.calls[2]![0]).toMatchObject({ resumeAfter: "SUP-44" });

        stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
