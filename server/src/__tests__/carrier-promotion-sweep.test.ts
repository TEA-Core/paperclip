import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CARRIER_PROMOTION_READY_ACTION,
  createCarrierPromotionSweepService,
} from "../services/carrier-promotion-sweep.js";
import { markPullRequestReadyForReview } from "../services/merge-arming.js";

const mockGhFetch = vi.hoisted(() => vi.fn());
vi.mock("../services/github-fetch.js", () => ({
  ghFetch: mockGhFetch,
  gitHubApiBase: (hostname: string) =>
    hostname === "github.com" ? "https://api.github.com" : `https://${hostname}/api/v3`,
}));

const mockResolveCandidates = vi.hoisted(() => vi.fn());
const mockResolveToken = vi.hoisted(() => vi.fn());
vi.mock("../services/github-credential.js", () => ({
  isGitHubTokenResolution: (value: unknown) =>
    typeof value === "object" && value !== null && "token" in value,
  resolveGitHubTokenCandidatesForRepo: mockResolveCandidates,
  resolveGitHubTokenForRepo: mockResolveToken,
}));

const mockGetWakeable = vi.hoisted(() => vi.fn());
vi.mock("../services/issues.js", () => ({
  issueService: () => ({ getWakeableParentAfterChildCompletion: mockGetWakeable }),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "activity-row" }));
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PARENT = "33333333-3333-4333-8333-333333333333";
const CHILD = "44444444-4444-4444-8444-444444444444";
const PARENT_IDENTIFIER = "SUP-14093";
const CARRIER_BRANCH = `${PARENT_IDENTIFIER}-one-carrier-branch-per-parent`;
const NOW_ISO = "2026-09-01T00:00:00Z";
const YOUNG_ISO = "2026-08-30T00:00:00Z"; // 1 day before NOW
const STALE_ISO = "2026-08-28T00:00:00Z"; // 4 days before NOW: past the 3-day cap

const TOKEN_CANDIDATE = { token: "ghp_test_token_value", scope: "company", secretName: "github_org" };

/** Builds a minimal fetch-style Response stub with an async json() body. */
function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

const GRAPHQL_OK = () => jsonResponse({ data: { markPullRequestReadyForReview: { clientMutationId: "abc" } } });

/** Builds a cached draft pull-request discovery row with sensible defaults and per-test overrides. */
function draftRow(overrides: {
  number?: number;
  branch?: string | null;
  prCreatedAt?: string | null;
  nodeId?: string | null;
  sourceIssueId?: string;
} = {}) {
  const number = overrides.number ?? 400;
  const headRef = overrides.branch === undefined ? CARRIER_BRANCH : overrides.branch ?? "";
  const data: Record<string, unknown> = {
    state: "open",
    draft: true,
    node_id: overrides.nodeId === undefined ? `PR_node_${number}` : overrides.nodeId,
    created_at: overrides.prCreatedAt === undefined ? YOUNG_ISO : overrides.prCreatedAt,
  };
  if (headRef) data.headRef = headRef;
  return {
    sourceIssueId: overrides.sourceIssueId ?? CHILD,
    mentionCreatedAt: new Date(YOUNG_ISO),
    externalId: `TEA-Core/paperclip#pull/${number}`,
    data,
  };
}

/** Builds a sibling pull-request row (any state/draft) for the sequencing-guard query. */
function siblingRow(number: number, state: string, branch = CARRIER_BRANCH) {
  const data: Record<string, unknown> = { state };
  if (branch) data.headRef = branch;
  return { externalId: `TEA-Core/paperclip#pull/${number}`, data };
}

/**
 * Builds a cached row in the exact data shape the GitHub external-object
 * provider writes (`pullRequestSnapshot` in
 * `github-external-object-provider.ts`): flat `headRef` key, no nested
 * `head`, no cached `node_id` or `created_at` (age anchor falls back to
 * mentionCreatedAt; node id falls back to the REST lookup).
 */
function providerDraftRow(overrides: { number?: number; branch?: string | null } = {}) {
  const number = overrides.number ?? 400;
  const headRef = overrides.branch === undefined ? CARRIER_BRANCH : overrides.branch ?? "";
  const data: Record<string, unknown> = {
    provider: "github",
    owner: "TEA-Core",
    repo: "paperclip",
    number,
    state: "open",
    merged: false,
    draft: true,
  };
  if (headRef) data.headRef = headRef;
  data.headSha = "7d1f8a2c0b3e4f5a6c7d8e9f0a1b2c3d4e5f6071";
  data.baseRef = "fold/tea-patches-v2026.722.0";
  return {
    sourceIssueId: CHILD,
    mentionCreatedAt: new Date(YOUNG_ISO),
    externalId: `TEA-Core/paperclip#pull/${number}`,
    data,
  };
}

interface TestState {
  draftRows: Array<Record<string, unknown>>;
  sourceIssues: Array<Record<string, unknown>>;
  parentRow: Record<string, unknown> | null;
  children: Array<Record<string, unknown>>;
  siblingRows: Array<Record<string, unknown>>;
  activityRows: Array<Record<string, unknown>>;
}

/** Maps a drizzle select column set to the matching fake-db row list, by column fingerprint. */
function selectRows(cols: Record<string, unknown>, state: TestState) {
  if ("mentionCreatedAt" in cols) return state.draftRows;
  if ("parentId" in cols) return state.sourceIssues;
  if ("identifier" in cols) return state.parentRow ? [state.parentRow] : [];
  if ("externalId" in cols) return state.siblingRows;
  if ("details" in cols) return state.activityRows;
  return state.children;
}

/** Builds a fake drizzle db whose select() serves rows from the given test state. */
function makeDb(state: TestState) {
  return {
    select: vi.fn((cols: Record<string, unknown>) => {
      const rows = selectRows(cols, state);
      return {
        from: () => ({
          innerJoin: () => ({ where: () => Promise.resolve(rows) }),
          where: () => Promise.resolve(rows),
        }),
      };
    }),
  };
}

/** Wires a sweep service over a fake db and returns both for assertions. */
function makeService(
  state: TestState,
  opts: { now?: () => Date; sweepIntervalMs?: number } = {},
) {
  const db = makeDb(state);
  const service = createCarrierPromotionSweepService(db as never, {
    now: opts.now ?? (() => new Date(NOW_ISO)),
    sweepIntervalMs: opts.sweepIntervalMs ?? 0,
  });
  return { db, service };
}

/** Returns a default single-parent/single-child test state, with per-test overrides. */
function state(overrides: Partial<TestState> = {}): TestState {
  return {
    draftRows: [],
    sourceIssues: [{ id: CHILD, parentId: PARENT }],
    parentRow: { id: PARENT, companyId: COMPANY, status: "in_progress", identifier: PARENT_IDENTIFIER },
    children: [{ id: CHILD }],
    siblingRows: [],
    activityRows: [],
    ...overrides,
  };
}

const wakeableParent = {
  id: PARENT,
  assigneeAgentId: "22222222-2222-4222-8222-222222222222",
  childIssueIds: [CHILD],
};

beforeEach(() => {
  mockGhFetch.mockReset();
  mockLogActivity.mockClear();
  mockResolveCandidates.mockReset().mockResolvedValue([TOKEN_CANDIDATE]);
  mockResolveToken.mockReset().mockResolvedValue({ kind: "unavailable", reason: "no token configured" });
  mockGetWakeable.mockReset().mockResolvedValue(null);
});

describe("markPullRequestReadyForReview", () => {
  it("POSTs the GraphQL mutation with a bearer token and reports success", async () => {
    mockGhFetch.mockResolvedValue(GRAPHQL_OK());
    const result = await markPullRequestReadyForReview("ghp_test", "PR_node_42");
    expect(result).toEqual({ success: true, alreadyReady: false, error: null, status: 200 });

    const [url, init] = mockGhFetch.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/graphql");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer ghp_test");
    const query = JSON.parse(init.body).query as string;
    expect(query).toContain("markPullRequestReadyForReview");
    expect(query).toContain("PR_node_42");
  });

  it("counts an already-ready PR as success (GitHub rejects it with 'not a draft')", async () => {
    mockGhFetch.mockResolvedValue(
      jsonResponse({ errors: [{ message: "Pull request is not a draft" }] }, false, 422),
    );
    await expect(markPullRequestReadyForReview("ghp_test", "PR_node_42")).resolves.toEqual({
      success: true,
      alreadyReady: true,
      error: null,
      status: 422,
    });
  });

  it("returns the GraphQL error message for non-draft rejections", async () => {
    mockGhFetch.mockResolvedValue(
      jsonResponse({ errors: [{ message: "You are not allowed to update this pull request" }] }, false, 403),
    );
    await expect(markPullRequestReadyForReview("ghp_test", "PR_node_42")).resolves.toEqual({
      success: false,
      alreadyReady: false,
      error: "You are not allowed to update this pull request",
      status: 403,
    });
  });

  it("returns network_error when ghFetch throws", async () => {
    mockGhFetch.mockRejectedValue(new Error("boom"));
    await expect(markPullRequestReadyForReview("ghp_test", "PR_node_42")).resolves.toEqual({
      success: false,
      alreadyReady: false,
      error: "network_error",
      status: 0,
    });
  });
});

describe("createCarrierPromotionSweepService", () => {
  it("promotes a draft carrier when the parent's last child reached terminal (trigger 1)", async () => {
    mockGetWakeable.mockResolvedValue(wakeableParent);
    const { service } = makeService(state({
      draftRows: [draftRow()],
      siblingRows: [siblingRow(400, "open")],
    }));
    mockGhFetch.mockResolvedValue(GRAPHQL_OK());

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      promoted: 1,
      alreadyReady: 0,
      blocked: 0,
      noTrigger: 0,
      failed: 0,
    });

    expect(mockGetWakeable).toHaveBeenCalledWith(PARENT);
    const [url, init] = mockGhFetch.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/graphql");
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN_CANDIDATE.token}`);
    expect(JSON.parse(init.body).query).toContain("PR_node_400");
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorType: "system",
      actorId: "system:carrier-promotion-sweep",
      action: CARRIER_PROMOTION_READY_ACTION,
      entityType: "issue",
      entityId: PARENT,
      issueId: PARENT,
      details: {
        identifier: PARENT_IDENTIFIER,
        pr: "TEA-Core/paperclip#400",
        trigger: "last_child_terminal",
        prState: "ready",
      },
    }));
  });

  it("promotes a draft carrier on three-day age-cap expiry even while children are still live (trigger 2)", async () => {
    mockGetWakeable.mockResolvedValue(null);
    const { service } = makeService(state({
      draftRows: [draftRow({ prCreatedAt: STALE_ISO })],
      siblingRows: [siblingRow(400, "open")],
    }));
    mockGhFetch.mockResolvedValue(GRAPHQL_OK());

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      promoted: 1,
      alreadyReady: 0,
      blocked: 0,
      noTrigger: 0,
      failed: 0,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ trigger: "age_cap", pr: "TEA-Core/paperclip#400" }),
    }));
  });

  it("leaves a young draft untouched when no trigger has fired", async () => {
    mockGetWakeable.mockResolvedValue(null);
    const { service } = makeService(state({
      draftRows: [draftRow()],
      siblingRows: [siblingRow(400, "open")],
    }));

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      promoted: 0,
      alreadyReady: 0,
      blocked: 0,
      noTrigger: 1,
      failed: 0,
    });
    expect(mockGhFetch).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("holds carrier N+1 while carrier N's external object still reads open (sequencing guard)", async () => {
    mockGetWakeable.mockResolvedValue(wakeableParent);
    const { service } = makeService(state({
      draftRows: [draftRow({ number: 401 })],
      siblingRows: [siblingRow(400, "open"), siblingRow(401, "open")],
    }));

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      promoted: 0,
      alreadyReady: 0,
      blocked: 1,
      noTrigger: 0,
      failed: 0,
    });
    expect(mockGhFetch).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("promotes once the earlier carrier no longer reads open", async () => {
    mockGetWakeable.mockResolvedValue(wakeableParent);
    const { service } = makeService(state({
      draftRows: [draftRow({ number: 401 })],
      siblingRows: [siblingRow(400, "closed"), siblingRow(401, "open")],
    }));
    mockGhFetch.mockResolvedValue(GRAPHQL_OK());

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      promoted: 1,
      alreadyReady: 0,
      blocked: 0,
      noTrigger: 0,
      failed: 0,
    });
  });

  it("does not re-promote a carrier an earlier sweep already dispositioned", async () => {
    mockGetWakeable.mockResolvedValue(wakeableParent);
    const { service } = makeService(state({
      draftRows: [draftRow()],
      siblingRows: [siblingRow(400, "open")],
      activityRows: [
        { action: CARRIER_PROMOTION_READY_ACTION, details: { pr: "TEA-Core/paperclip#400" } },
      ],
    }));

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      promoted: 0,
      alreadyReady: 1,
      blocked: 0,
      noTrigger: 0,
      failed: 0,
    });
    expect(mockGhFetch).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("ignores draft PRs whose branch is not the parent's carrier branch", async () => {
    mockGetWakeable.mockResolvedValue(wakeableParent);
    const { service } = makeService(state({
      draftRows: [draftRow({ branch: "SUP-9999-some-other-parent" })],
    }));

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 0,
      promoted: 0,
      alreadyReady: 0,
      blocked: 0,
      noTrigger: 0,
      failed: 0,
    });
    expect(mockGetWakeable).not.toHaveBeenCalled();
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("fails without an activity row when the GitHub token 401s", async () => {
    mockGetWakeable.mockResolvedValue(wakeableParent);
    const { service } = makeService(state({
      draftRows: [draftRow()],
      siblingRows: [siblingRow(400, "open")],
    }));
    mockGhFetch.mockResolvedValue(
      jsonResponse({ errors: [{ message: "Bad credentials" }] }, false, 401),
    );

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      promoted: 0,
      alreadyReady: 0,
      blocked: 0,
      noTrigger: 0,
      failed: 1,
    });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("resolves the node id over REST when the cached row has none", async () => {
    mockGetWakeable.mockResolvedValue(null);
    const { service } = makeService(state({
      draftRows: [draftRow({ nodeId: null, prCreatedAt: STALE_ISO })],
      siblingRows: [siblingRow(400, "open")],
    }));
    mockGhFetch
      .mockResolvedValueOnce(jsonResponse({ node_id: "PR_node_live_400" }))
      .mockResolvedValueOnce(GRAPHQL_OK());

    await expect(service.sweep()).resolves.toMatchObject({ due: true, promoted: 1 });
    expect(mockGhFetch).toHaveBeenCalledTimes(2);
    const [restUrl] = mockGhFetch.mock.calls[0]!;
    expect(String(restUrl)).toBe("https://api.github.com/repos/TEA-Core/paperclip/pulls/400");
    const [graphqlUrl, graphqlInit] = mockGhFetch.mock.calls[1]!;
    expect(graphqlUrl).toBe("https://api.github.com/graphql");
    expect(JSON.parse(graphqlInit.body).query).toContain("PR_node_live_400");
  });

  it("discovers and promotes a draft carrier from a row in the exact shape the GitHub provider writes (flat headRef, no node_id or created_at)", async () => {
    mockGetWakeable.mockResolvedValue(wakeableParent);
    const { service } = makeService(state({
      draftRows: [providerDraftRow()],
      siblingRows: [siblingRow(400, "open")],
    }));
    mockGhFetch
      .mockResolvedValueOnce(jsonResponse({ node_id: "PR_node_live_400" }))
      .mockResolvedValueOnce(GRAPHQL_OK());

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      promoted: 1,
      alreadyReady: 0,
      blocked: 0,
      noTrigger: 0,
      failed: 0,
    });
    expect(mockGhFetch).toHaveBeenCalledTimes(2);
    expect(String(mockGhFetch.mock.calls[0]![0])).toBe("https://api.github.com/repos/TEA-Core/paperclip/pulls/400");
    expect(JSON.parse(mockGhFetch.mock.calls[1]![1].body).query).toContain("PR_node_live_400");
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: CARRIER_PROMOTION_READY_ACTION,
      entityId: PARENT,
      details: expect.objectContaining({ trigger: "last_child_terminal", pr: "TEA-Core/paperclip#400" }),
    }));
  });

  it("still reads the legacy nested head.ref shape from cached rows", async () => {
    mockGetWakeable.mockResolvedValue(wakeableParent);
    const { service } = makeService(state({
      draftRows: [{
        sourceIssueId: CHILD,
        mentionCreatedAt: new Date(YOUNG_ISO),
        externalId: "TEA-Core/paperclip#pull/400",
        data: { state: "open", draft: true, node_id: "PR_node_400", created_at: YOUNG_ISO, head: { ref: CARRIER_BRANCH } },
      }],
      siblingRows: [{
        externalId: "TEA-Core/paperclip#pull/400",
        data: { state: "open", head: { ref: CARRIER_BRANCH } },
      }],
    }));
    mockGhFetch.mockResolvedValue(GRAPHQL_OK());

    await expect(service.sweep()).resolves.toMatchObject({ due: true, candidates: 1, promoted: 1 });
  });

  it("performs no work when no draft pull request exists", async () => {
    const { db, service } = makeService(state({}));

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 0,
      promoted: 0,
      alreadyReady: 0,
      blocked: 0,
      noTrigger: 0,
      failed: 0,
    });
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(mockGetWakeable).not.toHaveBeenCalled();
  });

  it("keeps every non-due tick a no-op behind the min-interval gate", async () => {
    let clock = new Date(NOW_ISO).getTime();
    mockGetWakeable.mockResolvedValue(wakeableParent);
    const { db, service } = makeService(
      state({ draftRows: [draftRow()], siblingRows: [siblingRow(400, "open")] }),
      { sweepIntervalMs: 60 * 60 * 1000, now: () => new Date(clock) },
    );
    mockGhFetch.mockResolvedValue(GRAPHQL_OK());

    await expect(service.sweep()).resolves.toMatchObject({ due: true, promoted: 1 });
    const selectCallsAfterFirst = db.select.mock.calls.length;
    clock += 30 * 1000;
    await expect(service.sweep()).resolves.toEqual({
      due: false,
      candidates: 0,
      promoted: 0,
      alreadyReady: 0,
      blocked: 0,
      noTrigger: 0,
      failed: 0,
    });
    expect(db.select.mock.calls.length).toBe(selectCallsAfterFirst);
    clock += 61 * 60 * 1000;
    await expect(service.sweep()).resolves.toMatchObject({ due: true });
  });
});
