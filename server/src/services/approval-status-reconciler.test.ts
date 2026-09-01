import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  externalObjectMentions,
  externalObjects,
  issueExecutionDecisions,
  issues,
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
const USER_REVIEWER = "reviewer-user";

const PR_URL = "https://api.github.com/repos/TEA-Core/paperclip/pulls/42";
const PR_43_URL = "https://api.github.com/repos/TEA-Core/paperclip/pulls/43";
const PR_44_URL = "https://api.github.com/repos/TEA-Core/paperclip/pulls/44";
const COMBINED_STATUS_URL = `https://api.github.com/repos/TEA-Core/paperclip/commits/${NEW_HEAD}/status`;
const POST_STATUS_URL = `https://api.github.com/repos/TEA-Core/paperclip/statuses/${NEW_HEAD}`;
const BASE_SHA = "base00000000000000000000000000000000000000003";
const APPROVED_DIFF_URL = `https://api.github.com/repos/TEA-Core/paperclip/compare/${BASE_SHA}...${APPROVED_HEAD}`;
const LIVE_DIFF_URL = `https://api.github.com/repos/TEA-Core/paperclip/compare/${BASE_SHA}...${NEW_HEAD}`;
const COMMENT_LIST_URL = "https://api.github.com/repos/TEA-Core/paperclip/issues/42/comments?per_page=100&direction=desc";
const COMMENT_POST_URL = "https://api.github.com/repos/TEA-Core/paperclip/issues/42/comments";
const CLOSED_43_BODY = { state: "closed", merged: false, head: { ref: "dup-branch", sha: "closed430000000000000000000000000000000000" }, base: { ref: "main", sha: BASE_SHA } };
const MERGED_44_BODY = { state: "closed", merged: true, head: { ref: "dup-branch-44", sha: "merged440000000000000000000000000000000000" }, base: { ref: "main", sha: BASE_SHA } };
const OPEN_43_BODY = { state: "open", merged: false, head: { ref: "dup-branch", sha: "open43000000000000000000000000000000000000" }, base: { ref: "main", sha: BASE_SHA } };

const OPEN_PR_BODY = {
  state: "open",
  merged: false,
  head: { ref: "SUP-42-branch", sha: NEW_HEAD },
  base: { ref: "main", sha: BASE_SHA },
};

function zeroSummary(): ApprovalStatusReconcilerTickSummary {
  return {
    scanned: 0,
    republished: 0,
    skipped: {},
    skippedDetails: [],
    failed: 0,
    failedDetails: [],
    capped: 0,
    voidWarnings: 0,
    voidWarningDetails: [],
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
  });

  afterEach(async () => {
    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(issueExecutionDecisions);
    await db.delete(issues);
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
      createdByAgentId: overrides.createdByAgentId ?? null,
      createdByUserId: overrides.createdByUserId ?? null,
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
      // SHAs and carrying the dedup marker — and nothing written to
      // paperclip/approved.
      expect(postCommentCalls()).toHaveLength(1);
      const body = postCommentBodies()[0]!;
      expect(body).toContain(`This PR was approved at ${APPROVED_HEAD} (SUP-42)`);
      expect(body).toContain(`head ${NEW_HEAD} voids that approval`);
      expect(body).toContain(`[paperclip:approval-voided ${APPROVED_HEAD} -> ${NEW_HEAD}]`);
      expect(body).not.toContain("context");
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

    it("refuses to re-publish for a head that was never reviewed when the approved head is unrecoverable (guard A)", async () => {
      const issueId = await insertIssue({
        executionState: approvedState({ approvalStatus: null }),
      });
      await insertDecision(issueId);
      await insertMention(issueId);

      installRoutes([
        { url: PR_URL, body: OPEN_PR_BODY },
        { url: COMBINED_STATUS_URL, body: { state: "pending", statuses: [] } },
      ]);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.republished).toBe(0);
      expect(summary.skipped["guard-a:no-approved-head"]).toBe(1);
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

    it("skips when the approval was made by the card's own author (guard B)", async () => {
      await insertAgent(AGENT_AUTHOR, "Author");
      const issueId = await insertIssue({ createdByAgentId: AGENT_AUTHOR });
      await insertDecision(issueId, { actorAgentId: AGENT_AUTHOR });
      await insertMention(issueId);

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.skipped["guard-b:decision-by-author-or-return-assignee"]).toBe(1);
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

      expect(summary.skipped["guard-b:decision-by-author-or-return-assignee"]).toBe(1);
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

    it("skips cards whose only mention is a closed PR", async () => {
      const issueId = await insertIssue();
      await insertDecision(issueId);
      await insertMention(issueId, { state: "closed" });

      const summary = await runApprovalStatusReconcilerTick(db);

      expect(summary.skipped["no-open-pr"]).toBe(1);
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
  });
});
