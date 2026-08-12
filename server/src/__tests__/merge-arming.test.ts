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
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { armMergeOnApproval, type MergeArmingDecision } from "../services/merge-arming.js";

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

  describe("armed", () => {
    it("arms a single linked open non-draft PR and returns armed:success", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
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
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockGetByName.mockResolvedValue(null);

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("failed");
      expect(result.message).toBe("failed:auth_required: GitHub authentication failed");
      expect(mockGhFetch).not.toHaveBeenCalled();
    });

    it("returns failed:auth_required when token is empty", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
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
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
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
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
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
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
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
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
      );

      mockGhFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const result = await armMergeOnApproval(db, companyId, issueId, DECISION);
      expect(result.kind).toBe("failed");
      expect(result.message).toBe("failed:network_error");
    });

    it("truncation: error message is truncated to 200 chars", async () => {
      await insertMention(
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
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
        createPRExternalObject(companyId, "TEA-Core", "paperclip", 42),
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
