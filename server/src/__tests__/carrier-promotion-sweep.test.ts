import { beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog } from "@paperclipai/db";
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
vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  logActivityInTransaction: (transaction: unknown, input: unknown) => mockLogActivity(transaction, input),
  publishActivity: vi.fn(),
}));

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

const LIVE_PR_OK = (nodeId = "PR_node_400") => jsonResponse({
  node_id: nodeId, state: "open", draft: true,
  head: { ref: CARRIER_BRANCH, sha: "sha-reviewed", repo: { full_name: "TEA-Core/paperclip" } },
});

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
    headSha: "sha-reviewed",
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
 * `github-external-object-provider.ts`): flat `headRef` and `headSha` keys, no
 * nested `head`, no cached `node_id` or `created_at` (age anchors on the
 * mention time; every promotion reads the node ID from live REST).
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
  data.headSha = "sha-reviewed";
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
  repoRows: Array<Record<string, unknown>>;
}

/** Maps a drizzle select column set to the matching fake-db row list, by column fingerprint. */
function selectRows(cols: Record<string, unknown> | undefined, state: TestState) {
  if (!cols) return state.repoRows;
  if ("mentionCreatedAt" in cols) return state.draftRows;
  if ("parentId" in cols) return state.sourceIssues;
  if ("identifier" in cols) return state.parentRow ? [state.parentRow] : [];
  if ("externalId" in cols) return state.siblingRows;
  if ("details" in cols) return state.activityRows;
  if ("id" in cols && cols.id === activityLog.id) return state.activityRows;
  return state.children;
}

/** Builds a fake drizzle db whose select() serves rows from the given test state. */
function makeDb(state: TestState) {
  const tx = {
    select: vi.fn((cols?: Record<string, unknown>) => {
      const rows = selectRows(cols, state);
      return {
        from: () => ({
          innerJoin: () => ({ where: () => Promise.resolve(rows) }),
          where: () => Promise.resolve(rows),
        }),
      };
    }),
    execute: vi.fn().mockResolvedValue([]),
  };
  return {
    ...tx,
    transaction: vi.fn(async (run: (transaction: typeof tx) => Promise<unknown>) => run(tx)),
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
    parentRow: { id: PARENT, companyId: COMPANY, status: "in_progress", identifier: PARENT_IDENTIFIER, projectId: "project-1", projectWorkspaceId: "workspace-1", executionWorkspaceId: null },
    children: [{ id: CHILD }],
    siblingRows: [],
    activityRows: [],
    repoRows: [{ repoUrl: "https://github.com/TEA-Core/paperclip" }],
    ...overrides,
    ...(overrides.parentRow ? { parentRow: {
      id: PARENT, companyId: COMPANY, status: "in_progress", identifier: PARENT_IDENTIFIER,
      projectId: "project-1", projectWorkspaceId: "workspace-1", executionWorkspaceId: null,
      ...overrides.parentRow,
    } } : {}),
  };
}

const wakeableParent = {
  id: PARENT,
  assigneeAgentId: "22222222-2222-4222-8222-222222222222",
  childIssueIds: [CHILD],
};

beforeEach(() => {
  mockGhFetch.mockReset();
  mockGhFetch.mockImplementation(async (url: string) =>
    String(url).includes("/pulls/") ? LIVE_PR_OK(String(url).endsWith("/401") ? "PR_node_401" : "PR_node_400") : GRAPHQL_OK(),
  );
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
    const [restUrl, restInit] = mockGhFetch.mock.calls[0]!;
    expect(restUrl).toBe("https://api.github.com/repos/TEA-Core/paperclip/pulls/400");
    expect(restInit.headers.authorization).toBe(`Bearer ${TOKEN_CANDIDATE.token}`);
    const [recheckUrl] = mockGhFetch.mock.calls[1]!;
    expect(recheckUrl).toBe(restUrl);
    const [url, init] = mockGhFetch.mock.calls[2]!;
    expect(url).toBe("https://api.github.com/graphql");
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

  it("promotes an open draft carrier even after its parent becomes done", async () => {
    const { service } = makeService(state({
      parentRow: { id: PARENT, companyId: COMPANY, status: "done", identifier: PARENT_IDENTIFIER },
      draftRows: [draftRow({ prCreatedAt: STALE_ISO })],
      siblingRows: [siblingRow(400, "open")],
    }));

    const result = await service.sweep();
    expect(result.promoted).toBe(1);
    expect(mockGhFetch).toHaveBeenCalledTimes(3);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: CARRIER_PROMOTION_READY_ACTION,
      entityId: PARENT,
      details: expect.objectContaining({ pr: "TEA-Core/paperclip#400" }),
    }));
  });

  it.each([
    { label: "other delivery repository", externalId: "TEA-Core/other#pull/400", liveRepo: "TEA-Core/other", liveRef: CARRIER_BRANCH, liveSha: "sha-reviewed", state: "open", draft: true },
    { label: "forked head repository", externalId: "TEA-Core/paperclip#pull/400", liveRepo: "Other/paperclip", liveRef: CARRIER_BRANCH, liveSha: "sha-reviewed", state: "open", draft: true },
    { label: "moved branch", externalId: "TEA-Core/paperclip#pull/400", liveRepo: "TEA-Core/paperclip", liveRef: "SUP-99999-other", liveSha: "sha-reviewed", state: "open", draft: true },
    { label: "case-changed branch", externalId: "TEA-Core/paperclip#pull/400", liveRepo: "TEA-Core/paperclip", liveRef: `${PARENT_IDENTIFIER.toLowerCase()}-one-carrier-branch-per-parent`, liveSha: "sha-reviewed", state: "open", draft: true },
    { label: "changed head SHA", externalId: "TEA-Core/paperclip#pull/400", liveRepo: "TEA-Core/paperclip", liveRef: CARRIER_BRANCH, liveSha: "sha-moved", state: "open", draft: true },
    { label: "missing cached head SHA", externalId: "TEA-Core/paperclip#pull/400", liveRepo: "TEA-Core/paperclip", liveRef: CARRIER_BRANCH, liveSha: "sha-reviewed", state: "open", draft: true, cachedSha: null },
    { label: "closed draft", externalId: "TEA-Core/paperclip#pull/400", liveRepo: "TEA-Core/paperclip", liveRef: CARRIER_BRANCH, liveSha: "sha-reviewed", state: "closed", draft: true },
    { label: "already ready", externalId: "TEA-Core/paperclip#pull/400", liveRepo: "TEA-Core/paperclip", liveRef: CARRIER_BRANCH, liveSha: "sha-reviewed", state: "open", draft: false },
  ])("does not promote an unverified cached draft: $label", async ({ label, externalId, liveRepo, liveRef, liveSha, state: liveState, draft, cachedSha }) => {
    const row = draftRow({ prCreatedAt: STALE_ISO });
    row.externalId = externalId;
    row.data.headSha = cachedSha === undefined ? "sha-reviewed" : cachedSha;
    const { service } = makeService(state({
      parentRow: { id: PARENT, companyId: COMPANY, status: "done", identifier: PARENT_IDENTIFIER },
      draftRows: [row],
      siblingRows: [siblingRow(400, "open")],
    }));
    mockGhFetch.mockImplementation(async (url: string) =>
      String(url).includes("/pulls/400")
        ? jsonResponse({
          node_id: "PR_node_400", state: liveState, draft,
          head: { ref: liveRef, sha: liveSha, repo: { full_name: liveRepo } },
        })
        : GRAPHQL_OK(),
    );
    const result = await service.sweep();
    expect(result.promoted).toBe(0);
    expect(mockGhFetch.mock.calls.some(([url]) => url === "https://api.github.com/graphql")).toBe(false);
    expect(mockLogActivity).not.toHaveBeenCalled();
    if (label === "other delivery repository") {
      // A matching branch in another repo is rejected before resolving the
      // foreign repository's GitHub credential, killing the repo-gate mutant.
      expect(mockResolveCandidates).not.toHaveBeenCalled();
      expect(mockGhFetch).not.toHaveBeenCalled();
    }
  });

  it.each([
    { label: "head SHA changed", movedRef: CARRIER_BRANCH, movedSha: "sha-moved", movedRepo: "TEA-Core/paperclip" },
    { label: "branch changed", movedRef: "SUP-99999-moved", movedSha: "sha-reviewed", movedRepo: "TEA-Core/paperclip" },
    { label: "head repository changed", movedRef: CARRIER_BRANCH, movedSha: "sha-reviewed", movedRepo: "Other/paperclip" },
  ])("does not promote a carrier whose $label after the first live read", async ({ movedRef, movedSha, movedRepo }) => {
    const { service } = makeService(state({
      parentRow: { id: PARENT, companyId: COMPANY, status: "done", identifier: PARENT_IDENTIFIER },
      draftRows: [draftRow({ prCreatedAt: STALE_ISO })],
      siblingRows: [siblingRow(400, "open")],
    }));
    let reads = 0;
    mockGhFetch.mockImplementation(async (url: string) => {
      if (String(url).includes("/pulls/400")) {
        reads += 1;
        return jsonResponse({
          node_id: "PR_node_400", state: "open", draft: true,
          head: { ref: reads === 1 ? CARRIER_BRANCH : movedRef,
            sha: reads === 1 ? "sha-reviewed" : movedSha,
            repo: { full_name: reads === 1 ? "TEA-Core/paperclip" : movedRepo } },
        });
      }
      return GRAPHQL_OK();
    });

    const result = await service.sweep();
    expect(reads).toBe(2);
    expect(result.promoted).toBe(0);
    expect(mockGhFetch.mock.calls.some(([url]) => url === "https://api.github.com/graphql")).toBe(false);
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("leaves a cancelled parent's draft carrier untouched even past the age cap", async () => {
    const { service } = makeService(state({
      parentRow: { id: PARENT, companyId: COMPANY, status: "cancelled", identifier: PARENT_IDENTIFIER },
      draftRows: [draftRow({ prCreatedAt: STALE_ISO })],
      siblingRows: [siblingRow(400, "open")],
    }));

    const result = await service.sweep();
    expect(result.promoted).toBe(0);
    expect(mockGhFetch).not.toHaveBeenCalled();
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

  it("uses the live node id instead of a stale cached node id", async () => {
    mockGetWakeable.mockResolvedValue(null);
    const { service } = makeService(state({
      draftRows: [draftRow({ nodeId: "PR_node_stale_400", prCreatedAt: STALE_ISO })],
      siblingRows: [siblingRow(400, "open")],
    }));
    mockGhFetch.mockImplementation(async (url: string) =>
      String(url).includes("/pulls/") ? LIVE_PR_OK("PR_node_live_400") : GRAPHQL_OK(),
    );

    await expect(service.sweep()).resolves.toMatchObject({ due: true, promoted: 1 });
    expect(mockGhFetch).toHaveBeenCalledTimes(3);
    const [restUrl] = mockGhFetch.mock.calls[0]!;
    expect(String(restUrl)).toBe("https://api.github.com/repos/TEA-Core/paperclip/pulls/400");
    const [graphqlUrl, graphqlInit] = mockGhFetch.mock.calls[2]!;
    expect(graphqlUrl).toBe("https://api.github.com/graphql");
    expect(JSON.parse(graphqlInit.body).query).toContain("PR_node_live_400");
  });

  it("discovers and promotes a draft carrier from a row in the exact shape the GitHub provider writes (flat headRef, no node_id or created_at)", async () => {
    mockGetWakeable.mockResolvedValue(wakeableParent);
    const { service } = makeService(state({
      draftRows: [providerDraftRow()],
      siblingRows: [siblingRow(400, "open")],
    }));
    mockGhFetch.mockImplementation(async (url: string) =>
      String(url).includes("/pulls/") ? LIVE_PR_OK("PR_node_live_400") : GRAPHQL_OK(),
    );

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      promoted: 1,
      alreadyReady: 0,
      blocked: 0,
      noTrigger: 0,
      failed: 0,
    });
    expect(mockGhFetch).toHaveBeenCalledTimes(3);
    expect(String(mockGhFetch.mock.calls[0]![0])).toBe("https://api.github.com/repos/TEA-Core/paperclip/pulls/400");
    expect(JSON.parse(mockGhFetch.mock.calls[2]![1].body).query).toContain("PR_node_live_400");
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
        data: { state: "open", draft: true, headSha: "sha-reviewed", node_id: "PR_node_400", created_at: YOUNG_ISO, head: { ref: CARRIER_BRANCH } },
      }],
      siblingRows: [{
        externalId: "TEA-Core/paperclip#pull/400",
        data: { state: "open", head: { ref: CARRIER_BRANCH } },
      }],
    }));

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
