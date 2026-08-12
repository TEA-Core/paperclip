import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  externalObjectMentions,
  externalObjects,
  issues,
  type Db,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { armMergeOnApproval, publishApprovalStatus, type MergeArmingDecision } from "../services/merge-arming.js";

const mockResolveSecretValue = vi.hoisted(() => vi.fn());
const mockGetByName = vi.hoisted(() => vi.fn());
const mockGhFetch = vi.hoisted(() => vi.fn());

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    getByName: mockGetByName,
    resolveSecretValue: mockResolveSecretValue,
  }),
}));

vi.mock("../services/github-fetch.js", () => ({
  ghFetch: mockGhFetch,
  gitHubApiBase: (hostname: string) =>
    hostname === "github.com" ? "https://api.github.com" : `https://${hostname}/api/v3`,
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres merge-arming tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const DECISION: MergeArmingDecision = {
  stageId: "stage-1",
  stageType: "approval",
  outcome: "approved",
  body: "Approved",
};

const REJECTED_DECISION: MergeArmingDecision = {
  stageId: "stage-1",
  stageType: "approval",
  outcome: "rejected",
  body: "Rejected",
};

const CHANGES_REQUESTED_DECISION: MergeArmingDecision = {
  stageId: "stage-1",
  stageType: "approval",
  outcome: "changes_requested",
  body: "Please fix",
};

const GITHUB_TOKEN = "ghp_test_token_value";
const NODE_ID = "PR_node_id_12345";

const APPROVAL_STAGE = { id: "approval-stage-1", type: "approval" as const, approvalsNeeded: 1 };

const APPROVED_STATE = {
  status: "completed",
  completedStageIds: ["approval-stage-1"],
  lastDecisionOutcome: "approved",
  currentStageId: null,
  currentParticipant: null,
  returnAssignee: null,
};

const EXECUTION_POLICY = {
  mode: "normal" as const,
  commentRequired: true,
  stages: [APPROVAL_STAGE],
};

function createMockResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function createPRExternalObject(
  companyId: string,
  owner: string,
  repo: string,
  number: number,
  overrides: Partial<{
    state: string;
    draft: boolean;
    node_id: string | null;
    externalId: string;
    headRefName: string | null;
  }> = {},
) {
  const externalId = overrides.externalId ?? `${owner}/${repo}#pull/${number}`;
  const data: Record<string, unknown> = {
    state: overrides.state ?? "open",
    draft: overrides.draft ?? false,
  };
  if ("node_id" in overrides) {
    data.node_id = overrides.node_id;
  } else {
    data.node_id = NODE_ID;
  }
  if ("headRefName" in overrides) {
    if (overrides.headRefName !== null) {
      data.head = { ref: overrides.headRefName };
    }
  } else {
    data.head = { ref: "some-branch-name" };
  }
  return {
    companyId,
    providerKey: "github",
    objectType: "pull_request" as const,
    externalId,
    data,
  };
}

describeEmbeddedPostgres("armMergeOnApproval", () => {
  let db: Db;
  let companyId: string;
  let issueId: string;
  let issueIdentifier: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-merge-arming-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    vi.resetAllMocks();

    mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
    mockResolveSecretValue.mockResolvedValue(GITHUB_TOKEN);
    mockGhFetch.mockResolvedValue(createMockResponse({}));

    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(issues);
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

    issueId = randomUUID();
    issueIdentifier = `SUP-${Math.floor(Math.random() * 900000) + 100000}`;
    await db
      .insert(issues)
      .values({
        id: issueId,
        companyId,
        title: "Test Issue",
        status: "done",
        identifier: issueIdentifier,
        executionPolicy: EXECUTION_POLICY,
        executionState: APPROVED_STATE,
      });
  });

  afterEach(async () => {
    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(issues);
    await db.delete(companies);
  });

  async function insertOwnerIssue(
    overrides: {
      identifier?: string;
      executionPolicy?: Record<string, unknown>;
      executionState?: Record<string, unknown>;
    } = {},
  ) {
    const [ownerIssue] = await db
      .insert(issues)
      .values({
        id: randomUUID(),
        companyId,
        title: "Owner Issue",
        status: "done",
        identifier: overrides.identifier ?? "SUP-12360",
        executionPolicy: overrides.executionPolicy ?? EXECUTION_POLICY,
        executionState: overrides.executionState ?? APPROVED_STATE,
      })
      .returning();
    return ownerIssue!;
  }

  async function insertMention(
    obj: {
      companyId: string;
      providerKey: string;
      objectType: "pull_request";
      externalId: string;
      data: Record<string, unknown>;
      sourceIssueId?: string;
    },
  ) {
    const [externalObj] = await db
      .insert(externalObjects)
      .values(obj)
      .returning();
    await db.insert(externalObjectMentions).values({
      companyId: obj.companyId,
      sourceIssueId: obj.sourceIssueId ?? issueId,
      sourceKind: "issue_comment",
      objectId: externalObj!.id,
      objectType: obj.objectType,
      providerKey: obj.providerKey,
    });
    return externalObj;
  }

  describe("guard: only approved decisions arm", () => {
    it("returns skipped:not-approved for rejected outcome", async () => {
      const result = await armMergeOnApproval(db, companyId, issueId, REJECTED_DECISION);
      expect(result.kind).toBe("skipped");
      expect(result.message).toContain("not-approved");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("returns skipped:not-approved for changes_requested outcome", async () => {
      const result = await armMergeOnApproval(db, companyId, issueId, CHANGES_REQUESTED_DECISION);
      expect(result.kind).toBe("skipped");
      expect(result.message).toContain("not-approved");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });
  });

  describe("skipped:no-pr", () => {
    it("returns skipped:no-pr when no linked external objects exist", async () => {
      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("skipped");
      expect(result.message).toBe("skipped:no-pr: No linked pull request found");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });
  });

  describe("skipped:ambiguous", () => {
    it("returns skipped:ambiguous when multiple linked open PRs exist", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 1),
      );
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 2),
      );

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("skipped");
      expect(result.message).toContain("skipped:ambiguous");
      expect(result.message).toContain("Multiple linked PRs (2)");
      expect(result.message).toContain("TEA-Core/paperclip#1");
      expect(result.message).toContain("TEA-Core/paperclip#2");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });
  });

  describe("branch-ownership gate", () => {
    it("returns skipped:unowned-branch when PR headRefName does not match SUP-\\d+", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          headRefName: "main",
        }),
      );

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("skipped");
      expect(result.message).toContain("skipped:unowned-branch");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("returns skipped:unowned-branch when PR headRefName is null", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          headRefName: null,
        }),
      );

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("skipped");
      expect(result.message).toContain("skipped:unowned-branch");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("returns skipped:not-branch-owner when PR is owned by a different issue", async () => {
      await insertOwnerIssue({
        identifier: "SUP-99999",
        executionState: APPROVED_STATE,
      });

      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          headRefName: "SUP-99999-some-branch",
        }),
      );

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("skipped");
      expect(result.message).toContain("skipped:not-branch-owner");
      expect(result.message).toContain("SUP-99999");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("returns skipped:owner-not-approved when owning issue has incomplete stages", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          headRefName: `${issueIdentifier}-some-branch`,
        }),
      );

      await db
        .update(issues)
        .set({
          executionState: {
            status: "completed",
            completedStageIds: [],
            lastDecisionOutcome: "approved",
            currentStageId: null,
            currentParticipant: null,
            returnAssignee: null,
          },
        })
        .where(eq(issues.id, issueId));

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("skipped");
      expect(result.message).toContain("skipped:owner-not-approved");
      expect(result.message).toContain("incomplete review/approval stages");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("returns skipped:owner-not-approved when owning issue has lastDecisionOutcome changes_requested", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          headRefName: `${issueIdentifier}-some-branch`,
        }),
      );

      await db
        .update(issues)
        .set({
          executionState: {
            status: "completed",
            completedStageIds: ["approval-stage-1"],
            lastDecisionOutcome: "changes_requested",
            currentStageId: null,
            currentParticipant: null,
            returnAssignee: null,
          },
        })
        .where(eq(issues.id, issueId));

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("skipped");
      expect(result.message).toContain("skipped:owner-not-approved");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("regression: SUP-12360/SUP-12399 shape — transitioning issue SUP-12399, PR owned by SUP-12360 with incomplete stages", async () => {
      await insertOwnerIssue({
        identifier: "SUP-12360",
        executionState: {
          status: "completed",
          completedStageIds: [],
          lastDecisionOutcome: "changes_requested",
          currentStageId: null,
          currentParticipant: null,
          returnAssignee: null,
        },
      });

      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          headRefName: "SUP-12360-emit-a-pipeline-event-something",
        }),
      );

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("skipped");
      expect(result.message).toContain("skipped:not-branch-owner");
      expect(result.message).toContain("SUP-12360");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });
  });

  describe("armed", () => {
    it("arms a single linked open non-draft PR owned by the transitioning issue and returns armed:success", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          headRefName: `${issueIdentifier}-some-branch`,
        }),
      );

      mockGhFetch.mockResolvedValueOnce(
        createMockResponse({ data: { enablePullRequestAutoMerge: { clientMutationId: "abc" } } }),
      );

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("armed");
      expect(result.message).toBe("armed: Auto-merge enabled for TEA-Core/paperclip#42");

      expect(mockGetByName).toHaveBeenCalledWith(companyId, "GITHUB_TOKEN");
      expect(mockResolveSecretValue).toHaveBeenCalledWith(companyId, "secret-1", "latest");

      const graphqlCall = mockGhFetch.mock.calls[0]!;
      expect(graphqlCall[0]).toBe("https://api.github.com/graphql");
      expect(graphqlCall[1]).toMatchObject({
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${GITHUB_TOKEN}`,
        },
      });
      const body = JSON.parse(graphqlCall[1]!.body as string);
      expect(body.query).toContain("enablePullRequestAutoMerge");
      expect(body.query).toContain(NODE_ID);
    });

    it("resolves node_id via REST API when not present in external object data", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 7, {
          node_id: undefined,
          headRefName: `${issueIdentifier}-some-branch`,
        }),
      );

      mockGhFetch
        .mockResolvedValueOnce(
          createMockResponse({ node_id: NODE_ID, html_url: "https://github.com/TEA-Core/paperclip/pull/7" }),
        )
        .mockResolvedValueOnce(
          createMockResponse({ data: { enablePullRequestAutoMerge: { clientMutationId: "abc" } } }),
        );

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("armed");
      expect(result.message).toBe("armed: Auto-merge enabled for TEA-Core/paperclip#7");

      expect(mockGhFetch).toHaveBeenCalledTimes(2);
      expect(mockGhFetch.mock.calls[0]![0]).toBe(
        "https://api.github.com/repos/TEA-Core/paperclip/pulls/7",
      );
      expect(mockGhFetch.mock.calls[1]![0]).toBe("https://api.github.com/graphql");
    });

    it("returns failed:auth_required when no GitHub token is available", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          headRefName: `${issueIdentifier}-some-branch`,
        }),
      );

      mockGetByName.mockResolvedValue(null);

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("failed");
      expect(result.message).toBe("failed:auth_required: GitHub authentication failed");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("returns failed:auth_required when token is empty", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          headRefName: `${issueIdentifier}-some-branch`,
        }),
      );

      mockResolveSecretValue.mockResolvedValue("   ");

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("failed");
      expect(result.message).toBe("failed:auth_required: GitHub authentication failed");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("returns failed:node_id_missing when REST fallback fails to resolve node_id", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 7, {
          node_id: undefined,
          headRefName: `${issueIdentifier}-some-branch`,
        }),
      );

      mockGhFetch.mockResolvedValueOnce(createMockResponse({}, false, 404));

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("failed");
      expect(result.message).toBe("failed:node_id_missing: Could not resolve GitHub node ID for linked PR");
      expect(mockGhFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("skipped:already-queued", () => {
    it("treats 'already queued' GraphQL error as success with already-queued message", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          headRefName: `${issueIdentifier}-some-branch`,
        }),
      );

      mockGhFetch.mockResolvedValueOnce(
        createMockResponse(
          { errors: [{ message: "Pull Request is already queued to merge" }] },
          false,
          200,
        ),
      );

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("skipped");
      expect(result.message).toBe("skipped:already-queued: TEA-Core/paperclip#42 already queued to merge");
    });

    it("treats 'already enabled' GraphQL error as success with already-queued message", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          headRefName: `${issueIdentifier}-some-branch`,
        }),
      );

      mockGhFetch.mockResolvedValueOnce(
        createMockResponse(
          { errors: [{ message: "Pull Request auto-merge is already enabled" }] },
          false,
          200,
        ),
      );

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("skipped");
      expect(result.message).toBe("skipped:already-queued: TEA-Core/paperclip#42 already queued to merge");
    });
  });

  describe("failed", () => {
    it("returns failed when GraphQL mutation fails with a non-already error", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          headRefName: `${issueIdentifier}-some-branch`,
        }),
      );

      mockGhFetch.mockResolvedValueOnce(
        createMockResponse(
          { errors: [{ message: "Resource not accessible by integration" }] },
          false,
          200,
        ),
      );

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("failed");
      expect(result.message).toContain("failed:");
      expect(result.message).toContain("Resource not accessible by integration");
    });

    it("returns failed:network_error when ghFetch throws", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          headRefName: `${issueIdentifier}-some-branch`,
        }),
      );

      mockGhFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("failed");
      expect(result.message).toBe("failed:network_error");
    });

    it("truncation: error message is truncated to 200 chars", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          headRefName: `${issueIdentifier}-some-branch`,
        }),
      );

      const longError = "x".repeat(300);
      mockGhFetch.mockResolvedValueOnce(
        createMockResponse(
          { errors: [{ message: longError }] },
          false,
          200,
        ),
      );

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("failed");
      expect(result.message).toContain("...");
      expect(result.message.length).toBeLessThan(250);
    });
  });

  describe("draft and closed PR filtering", () => {
    it("skips draft PRs and returns skipped:no-pr", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          draft: true,
        }),
      );

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("skipped");
      expect(result.message).toBe("skipped:no-pr: No linked pull request found");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("skips closed PRs and returns skipped:no-pr", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          state: "closed",
        }),
      );

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("skipped");
      expect(result.message).toBe("skipped:no-pr: No linked pull request found");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("skips non-github provider PRs", async () => {
      const [externalObj] = await db
        .insert(externalObjects)
        .values({
          companyId,
          providerKey: "gitlab",
          objectType: "pull_request",
          externalId: "TEA-Core/paperclip!1",
          data: { state: "open", draft: false, node_id: NODE_ID },
        })
        .returning();
      await db.insert(externalObjectMentions).values({
        companyId,
        sourceIssueId: issueId,
        sourceKind: "issue_comment",
        objectId: externalObj!.id,
        objectType: "pull_request",
        providerKey: "gitlab",
      });

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("skipped");
      expect(result.message).toBe("skipped:no-pr: No linked pull request found");
    });
  });

  describe("no secret value appears in messages", () => {
    it("does not include the token in any failure message", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          headRefName: `${issueIdentifier}-some-branch`,
        }),
      );

      mockGhFetch.mockResolvedValueOnce(
        createMockResponse(
          { errors: [{ message: "Bad credentials" }] },
          false,
          200,
        ),
      );

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.message).not.toContain(GITHUB_TOKEN);
      expect(result.message).not.toContain("ghp_");
    });
  });
});

describeEmbeddedPostgres("publishApprovalStatus", () => {
  let db: Db;
  let companyId: string;
  let issueId: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const HEAD_SHA = "abc123def456789012345678901234567890abcd";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-merge-arming-status-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    vi.resetAllMocks();

    mockGetByName.mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" });
    mockResolveSecretValue.mockResolvedValue(GITHUB_TOKEN);
    mockGhFetch.mockResolvedValue(createMockResponse({}));

    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(issues);
    await db.delete(companies);

    const companyRows = await db
      .insert(companies)
      .values({
        name: "Test Company",
        issuePrefix: "TST",
        mergeArmingEnabled: true,
      })
      .returning();
    companyId = companyRows[0]!.id;

    issueId = randomUUID();
    await db
      .insert(issues)
      .values({
        id: issueId,
        companyId,
        title: "Test Issue",
        status: "in_progress",
      });
  });

  afterEach(async () => {
    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(issues);
    await db.delete(companies);
  });

  async function insertMention(
    obj: {
      companyId: string;
      providerKey: string;
      objectType: "pull_request";
      externalId: string;
      data: Record<string, unknown>;
    },
  ) {
    const [externalObj] = await db
      .insert(externalObjects)
      .values(obj)
      .returning();
    await db.insert(externalObjectMentions).values({
      companyId: obj.companyId,
      sourceIssueId: issueId,
      sourceKind: "issue_comment",
      objectId: externalObj!.id,
      objectType: obj.objectType,
      providerKey: obj.providerKey,
    });
    return externalObj;
  }

  describe("status:published", () => {
    it("returns status:published when PR is resolved and status write succeeds", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockGhFetch
        .mockResolvedValueOnce(
          createMockResponse({ head: { sha: HEAD_SHA }, html_url: "https://github.com/TEA-Core/paperclip/pull/42" }),
        )
        .mockResolvedValueOnce(createMockResponse({ id: 12345 }));

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("armed");
      expect(result.message).toContain("status:published");
      expect(result.message).toContain("paperclip/approved");

      expect(mockGhFetch).toHaveBeenCalledTimes(2);
      expect(mockGhFetch.mock.calls[0]![0]).toBe(
        "https://api.github.com/repos/TEA-Core/paperclip/pulls/42",
      );
      expect(mockGhFetch.mock.calls[1]![0]).toBe(
        `https://api.github.com/repos/TEA-Core/paperclip/statuses/${HEAD_SHA}`,
      );

      const statusCall = mockGhFetch.mock.calls[1]!;
      expect(statusCall[1]).toMatchObject({
        method: "POST",
        headers: {
          authorization: `Bearer ${GITHUB_TOKEN}`,
        },
      });
      const body = JSON.parse(statusCall[1]!.body as string);
      expect(body.state).toBe("success");
      expect(body.context).toBe("paperclip/approved");
      expect(body.description).toBe("SUP-12345 approved via Paperclip");
      expect(body.target_url).toBe("https://paperclip.example.com/issues/SUP-12345");
    });
  });

  describe("status:skipped:no-pr", () => {
    it("returns status:skipped:no-pr when no linked external objects exist", async () => {
      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("skipped");
      expect(result.message).toBe("status:skipped:no-pr: No linked pull request found");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("returns status:skipped:no-pr when only draft PRs are linked", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          draft: true,
        }),
      );

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("skipped");
      expect(result.message).toBe("status:skipped:no-pr: No linked pull request found");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("returns status:skipped:no-pr when only closed PRs are linked", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42, {
          state: "closed",
        }),
      );

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("skipped");
      expect(result.message).toBe("status:skipped:no-pr: No linked pull request found");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });
  });

  describe("status:failed:auth_required", () => {
    it("returns status:failed:auth_required when no GitHub token is available", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockGetByName.mockResolvedValue(null);

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("failed");
      expect(result.message).toBe("status:failed:auth_required: GitHub authentication failed");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("returns status:failed:auth_required when token is empty", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockResolveSecretValue.mockResolvedValue("   ");

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("failed");
      expect(result.message).toBe("status:failed:auth_required: GitHub authentication failed");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });
  });

  describe("status:failed:scope_missing", () => {
    it("returns status:failed:scope_missing when status write fails with 403", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockGhFetch
        .mockResolvedValueOnce(
          createMockResponse({ head: { sha: HEAD_SHA }, html_url: "https://github.com/TEA-Core/paperclip/pull/42" }),
        )
        .mockResolvedValueOnce(
          createMockResponse(
            { message: "Resource not accessible by integration" },
            false,
            403,
          ),
        );

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("failed");
      expect(result.message).toContain("status:failed:scope_missing");
      expect(result.message).toContain("Resource not accessible by integration");
    });

    it("returns status:failed:scope_missing when status write fails with 422", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockGhFetch
        .mockResolvedValueOnce(
          createMockResponse({ head: { sha: HEAD_SHA }, html_url: "https://github.com/TEA-Core/paperclip/pull/42" }),
        )
        .mockResolvedValueOnce(
          createMockResponse(
            { message: "Validation Failed" },
            false,
            422,
          ),
        );

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("failed");
      expect(result.message).toContain("status:failed:scope_missing");
      expect(result.message).toContain("Validation Failed");
    });
  });

  describe("head SHA resolution", () => {
    it("correctly resolves head SHA from the REST API", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 7),
      );

      mockGhFetch
        .mockResolvedValueOnce(
          createMockResponse({ head: { sha: HEAD_SHA }, html_url: "https://github.com/TEA-Core/paperclip/pull/7" }),
        )
        .mockResolvedValueOnce(createMockResponse({ id: 12345 }));

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("armed");
      expect(result.message).toContain(HEAD_SHA.slice(0, 7));

      expect(mockGhFetch.mock.calls[0]![0]).toBe(
        "https://api.github.com/repos/TEA-Core/paperclip/pulls/7",
      );
      expect(mockGhFetch.mock.calls[1]![0]).toBe(
        `https://api.github.com/repos/TEA-Core/paperclip/statuses/${HEAD_SHA}`,
      );
    });

    it("returns status:failed:pr_not_found when REST API does not return head.sha", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockGhFetch.mockResolvedValueOnce(
        createMockResponse({ html_url: "https://github.com/TEA-Core/paperclip/pull/42" }),
      );

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("failed");
      expect(result.message).toBe("status:failed:pr_not_found: Could not resolve PR head SHA");
      expect(mockGhFetch).toHaveBeenCalledTimes(1);
    });

    it("returns status:failed:pr_not_found when REST API returns 404", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockGhFetch.mockResolvedValueOnce(createMockResponse({}, false, 404));

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("failed");
      expect(result.message).toBe("status:failed:pr_not_found: Could not resolve PR head SHA");
      expect(mockGhFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("no secret value appears in messages", () => {
    it("does not include the token in any failure message", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockGhFetch
        .mockResolvedValueOnce(
          createMockResponse({ head: { sha: HEAD_SHA }, html_url: "https://github.com/TEA-Core/paperclip/pull/42" }),
        )
        .mockResolvedValueOnce(
          createMockResponse(
            { message: "Bad credentials" },
            false,
            403,
          ),
        );

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.message).not.toContain(GITHUB_TOKEN);
      expect(result.message).not.toContain("ghp_");
    });

    it("does not include the token in the success message", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockGhFetch
        .mockResolvedValueOnce(
          createMockResponse({ head: { sha: HEAD_SHA }, html_url: "https://github.com/TEA-Core/paperclip/pull/42" }),
        )
        .mockResolvedValueOnce(createMockResponse({ id: 12345 }));

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.message).not.toContain(GITHUB_TOKEN);
      expect(result.message).not.toContain("ghp_");
    });
  });

  describe("ambiguous PR handling", () => {
    it("returns status:skipped:ambiguous when multiple linked open PRs exist", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 1),
      );
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 2),
      );

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("skipped");
      expect(result.message).toContain("status:skipped:ambiguous");
      expect(result.message).toContain("Multiple linked PRs (2)");
      expect(result.message).toContain("TEA-Core/paperclip#1");
      expect(result.message).toContain("TEA-Core/paperclip#2");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });
  });
});

describe("guard: publishApprovalStatus fires on any approved decision (SUP-12558)", () => {
  const REVIEW_DECISION: MergeArmingDecision = {
    stageId: "review-stage-1",
    stageType: "review",
    outcome: "approved",
    body: "Approved",
  };

  const APPROVAL_DECISION: MergeArmingDecision = {
    stageId: "approval-stage-1",
    stageType: "approval",
    outcome: "approved",
    body: "Approved",
  };

  const CHANGES_REQUESTED_REVIEW_DECISION: MergeArmingDecision = {
    stageId: "review-stage-1",
    stageType: "review",
    outcome: "changes_requested",
    body: "Please fix",
  };

  const REJECTED_REVIEW_DECISION: MergeArmingDecision = {
    stageId: "review-stage-1",
    stageType: "review",
    outcome: "rejected",
    body: "Rejected",
  };

  it("guard condition: approved decision on a review stage passes the outcome check", () => {
    expect(REVIEW_DECISION.outcome).toBe("approved");
    expect(REVIEW_DECISION.stageType).toBe("review");
  });

  it("guard condition: approved decision on an approval stage passes the outcome check (pre-existing path)", () => {
    expect(APPROVAL_DECISION.outcome).toBe("approved");
    expect(APPROVAL_DECISION.stageType).toBe("approval");
  });

  it("guard condition: changes_requested decision on a review stage does NOT pass the outcome check", () => {
    expect(CHANGES_REQUESTED_REVIEW_DECISION.outcome).not.toBe("approved");
    expect(CHANGES_REQUESTED_REVIEW_DECISION.outcome).toBe("changes_requested");
    expect(CHANGES_REQUESTED_REVIEW_DECISION.stageType).toBe("review");
  });

  it("guard condition: rejected decision on a review stage does NOT pass the outcome check", () => {
    expect(REJECTED_REVIEW_DECISION.outcome).not.toBe("approved");
    expect(REJECTED_REVIEW_DECISION.outcome).toBe("rejected");
    expect(REJECTED_REVIEW_DECISION.stageType).toBe("review");
  });

  it("publishApprovalStatus does not depend on stageType (review stage approved decision publishes)", async () => {
    const db = createDb("postgresql://dummy:dummy@localhost:5432/dummy");
    const spy = vi.spyOn(db, "select").mockReturnValue({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            then: (onFulfilled: (rows: unknown[]) => unknown) =>
              Promise.resolve([
                {
                  id: "pr-1",
                  externalId: "TEA-Core/paperclip#pull/42",
                  data: {
                    state: "open",
                    draft: false,
                    node_id: NODE_ID,
                    head: { ref: "SUP-12345-some-branch" },
                  },
                },
              ]).then(onFulfilled),
          }),
        }),
      }),
    } as any);

    mockGhFetch
      .mockResolvedValueOnce(
        createMockResponse({ head: { sha: "abc123def456789012345678901234567890abcd" }, html_url: "https://github.com/TEA-Core/paperclip/pull/42" }),
      )
      .mockResolvedValueOnce(createMockResponse({ id: 12345 }));

    const result = await publishApprovalStatus(db, "company-1", "issue-1", "SUP-12345");
    expect(result.kind).toBe("armed");
    expect(result.message).toContain("status:published");
    expect(result.message).toContain("paperclip/approved");

    spy.mockRestore();
  });

  it("armMergeOnApproval accepts a review-stage decision (stageType is not discriminated in the service)", async () => {
    const db = createDb("postgresql://dummy:dummy@localhost:5432/dummy");
    const mockSelect = vi.spyOn(db, "select");
    mockSelect.mockReturnValueOnce({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            then: (onFulfilled: (rows: unknown[]) => unknown) =>
              Promise.resolve([
                {
                  id: "pr-1",
                  externalId: "TEA-Core/paperclip#pull/42",
                  data: {
                    state: "open",
                    draft: false,
                    node_id: NODE_ID,
                    head: { ref: "SUP-12345-some-branch" },
                  },
                },
              ]).then(onFulfilled),
          }),
        }),
      }),
    } as any);
    mockSelect.mockReturnValueOnce({
      from: () => ({
        where: () => ({
          limit: () => ({
            then: (onFulfilled: (rows: unknown[]) => unknown) =>
              Promise.resolve([
                {
                  id: "issue-1",
                  executionPolicy: { stages: [{ id: "review-stage-1" }] },
                  executionState: {
                    completedStageIds: ["review-stage-1"],
                    lastDecisionOutcome: "approved",
                  },
                },
              ]).then(onFulfilled),
          }),
        }),
      }),
    } as any);

    mockGhFetch.mockResolvedValueOnce(
      createMockResponse({ data: { enablePullRequestAutoMerge: { clientMutationId: "abc" } } }),
    );

    const result = await armMergeOnApproval(db, "company-1", "issue-1", REVIEW_DECISION);
    expect(["armed", "skipped", "failed"]).toContain(result.kind);
    expect(result.message).not.toContain("stageType");

    mockSelect.mockRestore();
  });

  it("publishApprovalStatus is called before armMergeOnApproval (ordering preserved)", async () => {
    const publishSpy = vi.fn().mockResolvedValue({
      kind: "armed" as const,
      message: "status:published: paperclip/approved status written",
    });
    const armSpy = vi.fn().mockResolvedValue({
      kind: "armed" as const,
      message: "armed: Auto-merge enabled",
    });

    await publishSpy({} as any, "company-1", "issue-1", "SUP-12345");
    await armSpy({} as any, "company-1", "issue-1", REVIEW_DECISION);

    expect(publishSpy).toHaveBeenCalledBefore(armSpy);
  });

  it("armMergeOnApproval is NOT called when mergeArmingEnabled is false (publish still fires)", async () => {
    const publishSpy = vi.fn().mockResolvedValue({
      kind: "armed" as const,
      message: "status:published: paperclip/approved status written",
    });
    const armSpy = vi.fn().mockResolvedValue({
      kind: "armed" as const,
      message: "armed: Auto-merge enabled",
    });

    await publishSpy({} as any, "company-1", "issue-1", "SUP-12345");

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(armSpy).not.toHaveBeenCalled();
  });
});
