import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  externalObjectMentions,
  externalObjects,
  issues,
  projectWorkspaces,
  projects,
  type Db,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { armMergeOnApproval, publishApprovalStatus, shouldPublishApprovalStatus, type MergeArmingDecision } from "../services/merge-arming.js";

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
      expect(result.message).toBe(
        "failed:auth_required: No GitHub token resolvable for TEA-Core/paperclip (repo not found at company or project scope)",
      );
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
      expect(result.message).toBe(
        "failed:auth_required: No GitHub token resolvable for TEA-Core/paperclip (repo not found at company or project scope)",
      );
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
      expect(result.message).toBe("failed:node_id_missing: Could not resolve GitHub node ID for linked PR (HTTP 404)");
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
    await db.delete(projectWorkspaces);
    await db.delete(projects);
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
    await db.delete(projectWorkspaces);
    await db.delete(projects);
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

  describe("D1: fail-open on un-hydrated data (draft-hoist fix)", () => {
    it("returns status:published when PR data is empty {} (un-hydrated) — head SHA resolved live", async () => {
      await insertMention({
        companyId,
        providerKey: "github",
        objectType: "pull_request",
        externalId: "TEA-Core/paperclip#pull/42",
        data: {},
      });

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
    });

    it("drops a PR with { data: { draft: true } } (draft present, state absent) — draft-hoist", async () => {
      await insertMention({
        companyId,
        providerKey: "github",
        objectType: "pull_request",
        externalId: "TEA-Core/paperclip#pull/42",
        data: { draft: true },
      });

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("skipped");
      expect(result.message).toBe("status:skipped:no-pr: No linked pull request found");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("returns status:skipped:no-pr only when there is genuinely no pull_request mention row", async () => {
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
      expect(result.message).toBe(
        "status:failed:auth_required: No GitHub token resolvable for TEA-Core/paperclip (repo not found at company or project scope)",
      );
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("returns status:failed:auth_required when token is empty", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockResolveSecretValue.mockResolvedValue("   ");

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("failed");
      expect(result.message).toBe(
        "status:failed:auth_required: No GitHub token resolvable for TEA-Core/paperclip (repo not found at company or project scope)",
      );
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
      expect(result.message).toContain("HTTP 403");
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
      expect(result.message).toContain("HTTP 422");
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

    it("returns status:failed:pr_not_found with HTTP 404 when REST API returns 404", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockGhFetch.mockResolvedValueOnce(
        createMockResponse({ message: "Not Found" }, false, 404),
      );

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("failed");
      expect(result.message).toBe("status:failed:pr_not_found: HTTP 404 Not Found");
      expect(mockGhFetch).toHaveBeenCalledTimes(1);
    });

    it("returns status:failed:pr_auth with HTTP 401 when REST API returns 401", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockGhFetch.mockResolvedValueOnce(
        createMockResponse({ message: "Bad credentials" }, false, 401),
      );

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("failed");
      expect(result.message).toBe("status:failed:pr_auth: HTTP 401 Bad credentials");
      expect(mockGhFetch).toHaveBeenCalledTimes(1);
    });

    it("returns status:failed:pr_auth with HTTP 403 when REST API returns 403", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockGhFetch.mockResolvedValueOnce(
        createMockResponse({ message: "Forbidden" }, false, 403),
      );

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("failed");
      expect(result.message).toBe("status:failed:pr_auth: HTTP 403 Forbidden");
      expect(mockGhFetch).toHaveBeenCalledTimes(1);
    });

    it("returns status:failed:pr_rate_limited with HTTP 429 when REST API returns 429", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockGhFetch.mockResolvedValueOnce(
        createMockResponse({ message: "API rate limit exceeded" }, false, 429),
      );

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("failed");
      expect(result.message).toBe("status:failed:pr_rate_limited: HTTP 429 API rate limit exceeded");
      expect(mockGhFetch).toHaveBeenCalledTimes(1);
    });

    it("returns status:failed:pr_network when ghFetch throws", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockGhFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("failed");
      expect(result.message).toBe("status:failed:pr_network: network_error");
      expect(mockGhFetch).toHaveBeenCalledTimes(1);
    });

    it("returns status:failed:pr_error when REST API does not return head.sha", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockGhFetch.mockResolvedValueOnce(
        createMockResponse({ html_url: "https://github.com/TEA-Core/paperclip/pull/42" }),
      );

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("failed");
      expect(result.message).toContain("status:failed:pr_error");
      expect(result.message).toContain("head.sha missing from response");
      expect(mockGhFetch).toHaveBeenCalledTimes(1);
    });

    it("returns status:failed:pr_not_found with HTTP 404 and no message when REST API returns 404 without message body", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockGhFetch.mockResolvedValueOnce(
        createMockResponse({}, false, 404),
      );

      const result = await publishApprovalStatus(db, companyId, issueId, "SUP-12345");
      expect(result.kind).toBe("failed");
      expect(result.message).toBe("status:failed:pr_not_found: HTTP 404 ");
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

describeEmbeddedPostgres("resolveGitHubTokenForRepo — project env secret_ref binding", () => {
  let db: Db;
  let companyId: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-merge-arming-token-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    vi.resetAllMocks();
    await db.delete(projectWorkspaces);
    await db.delete(projects);
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
  });

  afterEach(async () => {
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  it("resolves project-scoped GitHub token via env secret_ref binding", async () => {
    const [projectRow] = await db
      .insert(projects)
      .values({
        id: randomUUID(),
        companyId,
        name: "Trading Signal Platform v2",
        urlKey: "trading-signal-platform-v2",
        status: "in_progress",
        env: {
          GITHUB_TOKEN: {
            type: "secret_ref",
            secretId: "secret-tsp",
            version: "latest",
          },
        },
      })
      .returning();

    await db.insert(projectWorkspaces).values({
      id: randomUUID(),
      companyId,
      projectId: projectRow!.id,
      name: "paperclip",
      repoUrl: "https://github.com/TEA-Core/Trading-Signal-Platform",
      isPrimary: true,
    });

    mockResolveSecretValue.mockResolvedValue("ghp_tsp_token_value");

    const { resolveGitHubTokenForRepo } = await import("../services/merge-arming.js");
    const result = await resolveGitHubTokenForRepo(db, companyId, "TEA-Core", "Trading-Signal-Platform");

    expect(result.token).toBe("ghp_tsp_token_value");
    expect(result.source).toBe("GITHUB_TOKEN");
    expect(mockResolveSecretValue).toHaveBeenCalledWith(companyId, "secret-tsp", "latest");
  });

  it("prefers project env secret_ref binding over company-scoped token", async () => {
    const [projectRow] = await db
      .insert(projects)
      .values({
        id: randomUUID(),
        companyId,
        name: "Trading Signal Platform v2",
        urlKey: "trading-signal-platform-v2",
        status: "in_progress",
        env: {
          GITHUB_TOKEN: {
            type: "secret_ref",
            secretId: "secret-tsp",
            version: "latest",
          },
        },
      })
      .returning();

    await db.insert(projectWorkspaces).values({
      id: randomUUID(),
      companyId,
      projectId: projectRow!.id,
      name: "paperclip",
      repoUrl: "https://github.com/TEA-Core/Trading-Signal-Platform",
      isPrimary: true,
    });

    mockGetByName.mockImplementation((_companyId: string, name: string) => {
      if (name === "GITHUB_TOKEN") {
        return Promise.resolve({ id: "secret-company", name: "GITHUB_TOKEN" });
      }
      return Promise.resolve(null);
    });
    mockResolveSecretValue.mockImplementation((_companyId: string, secretId: string) => {
      if (secretId === "secret-company") return Promise.resolve("ghp_company_token");
      return Promise.resolve("ghp_tsp_token_value");
    });

    const { resolveGitHubTokenForRepo } = await import("../services/merge-arming.js");
    const result = await resolveGitHubTokenForRepo(db, companyId, "TEA-Core", "Trading-Signal-Platform");

    expect(result.token).toBe("ghp_tsp_token_value");
    expect(result.source).toBe("GITHUB_TOKEN");
  });

  it("falls back to company-scoped token when project env has no GitHub token binding", async () => {
    const [projectRow] = await db
      .insert(projects)
      .values({
        id: randomUUID(),
        companyId,
        name: "Trading Signal Platform v2",
        urlKey: "trading-signal-platform-v2",
        status: "in_progress",
        env: {},
      })
      .returning();

    await db.insert(projectWorkspaces).values({
      id: randomUUID(),
      companyId,
      projectId: projectRow!.id,
      name: "paperclip",
      repoUrl: "https://github.com/TEA-Core/Trading-Signal-Platform",
      isPrimary: true,
    });

    mockGetByName.mockImplementation((_companyId: string, name: string) => {
      if (name === "GITHUB_TOKEN") {
        return Promise.resolve({ id: "secret-company", name: "GITHUB_TOKEN" });
      }
      return Promise.resolve(null);
    });
    mockResolveSecretValue.mockResolvedValue("ghp_company_token");

    const { resolveGitHubTokenForRepo } = await import("../services/merge-arming.js");
    const result = await resolveGitHubTokenForRepo(db, companyId, "TEA-Core", "Trading-Signal-Platform");

    expect(result.token).toBe("ghp_company_token");
    expect(result.source).toBe("company-scoped");
  });

  it("returns failure naming the project when no binding and no company token", async () => {
    const [projectRow] = await db
      .insert(projects)
      .values({
        id: randomUUID(),
        companyId,
        name: "Trading Signal Platform v2",
        urlKey: "trading-signal-platform-v2",
        status: "in_progress",
        env: {},
      })
      .returning();

    await db.insert(projectWorkspaces).values({
      id: randomUUID(),
      companyId,
      projectId: projectRow!.id,
      name: "paperclip",
      repoUrl: "https://github.com/TEA-Core/Trading-Signal-Platform",
      isPrimary: true,
    });

    mockGetByName.mockResolvedValue(null);

    const { resolveGitHubTokenForRepo } = await import("../services/merge-arming.js");
    const result = await resolveGitHubTokenForRepo(db, companyId, "TEA-Core", "Trading-Signal-Platform");

    expect(result.token).toBeNull();
    expect(result.reason).toBe("No GitHub token bound to project for TEA-Core/Trading-Signal-Platform");
  });

  it("returns failure when repo is not found at company or project scope", async () => {
    mockGetByName.mockResolvedValue(null);

    const { resolveGitHubTokenForRepo } = await import("../services/merge-arming.js");
    const result = await resolveGitHubTokenForRepo(db, companyId, "TEA-Core", "Some-Unknown-Repo");

    expect(result.token).toBeNull();
    expect(result.reason).toBe("No GitHub token resolvable for TEA-Core/Some-Unknown-Repo (repo not found at company or project scope)");
  });
});

describe("guard: shouldPublishApprovalStatus (SUP-12558)", () => {
  it("approved decision on a review stage returns true", () => {
    expect(
      shouldPublishApprovalStatus({ stageId: "s", stageType: "review", outcome: "approved", body: "" }),
    ).toBe(true);
  });

  it("approved decision on an approval stage returns true (pre-existing path)", () => {
    expect(
      shouldPublishApprovalStatus({ stageId: "s", stageType: "approval", outcome: "approved", body: "" }),
    ).toBe(true);
  });

  it("changes_requested decision on a review stage returns false", () => {
    expect(
      shouldPublishApprovalStatus({ stageId: "s", stageType: "review", outcome: "changes_requested", body: "" }),
    ).toBe(false);
  });

  it("rejected decision on a review stage returns false", () => {
    expect(
      shouldPublishApprovalStatus({ stageId: "s", stageType: "review", outcome: "rejected", body: "" }),
    ).toBe(false);
  });

  it("null decision returns false", () => {
    expect(shouldPublishApprovalStatus(null)).toBe(false);
  });

  it("undefined decision returns false", () => {
    expect(shouldPublishApprovalStatus(undefined)).toBe(false);
  });
});
