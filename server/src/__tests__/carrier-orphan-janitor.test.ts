import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CARRIER_ORPHAN_JANITOR_CLOSED_ACTION,
  closeGitHubPullRequest,
  createCarrierOrphanJanitorService,
  deleteGitHubBranch,
  fetchGitHubPullRequestState,
} from "../services/carrier-orphan-janitor.js";
import {
  CARRIER_STRANDED_SURFACE_ACTION,
  buildStrandedCardTitle,
  createCarrierStrandedSurfaceService,
} from "../services/carrier-stranded-surface.js";

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

const mockCreate = vi.hoisted(() => vi.fn());
vi.mock("../services/issues.js", () => ({
  issueService: () => ({ create: mockCreate }),
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "activity-row" }));
vi.mock("../services/activity-log.js", () => ({ logActivity: mockLogActivity }));

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PARENT = "33333333-3333-4333-8333-333333333333";
const CHILD = "44444444-4444-4444-8444-444444444444";
const CHILD_DONE = "55555555-5555-4555-8555-555555555555";
const GRANDCHILD = "66666666-6666-4666-8666-666666666666";
const PARENT_IDENTIFIER = "SUP-7701";
const CARRIER_BRANCH = `${PARENT_IDENTIFIER}-one-carrier-branch`;
const PR_KEY = "TEA-Core/paperclip#400";
const NOW_ISO = "2026-09-01T00:00:00Z";

const TOKEN_CANDIDATE = { token: "ghp_test_token_value", scope: "company", secretName: "github_org" };
const TOKEN_CANDIDATE_2 = { token: "ghp_test_token_second", scope: "company", secretName: "github_org_2" };

/** Builds a minimal fetch-style Response stub with an async json() body. */
function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** Builds a cached open pull-request discovery row with sensible defaults and per-test overrides. */
function openPrRow(overrides: { number?: number; branch?: string | null; sourceIssueId?: string } = {}) {
  const number = overrides.number ?? 400;
  const headRef = overrides.branch === undefined ? CARRIER_BRANCH : overrides.branch ?? "";
  const data: Record<string, unknown> = { state: "open" };
  if (headRef) data.headRef = headRef;
  return {
    sourceIssueId: overrides.sourceIssueId ?? CHILD,
    externalId: `TEA-Core/paperclip#pull/${number}`,
    data,
  };
}

/** Live GitHub pull request shape for the state-measurement endpoint. */
function liveOpenResponse(branch = CARRIER_BRANCH) {
  return jsonResponse({ number: 400, state: "open", head: { ref: branch } });
}

interface TestState {
  openPrRows: Array<Record<string, unknown>>;
  sourceIssues: Array<Record<string, unknown>>;
  parentRow: Record<string, unknown> | null;
  /** Tree rows served one query at a time, in call order (classification, then re-checks). */
  treeResponses: Array<Array<Record<string, unknown>>>;
  activityRows: Array<Record<string, unknown>>;
  cardRows: Array<Record<string, unknown>>;
}

/** Maps a drizzle select column set to the matching fake-db row list, by column fingerprint. */
function selectRows(cols: Record<string, unknown>, state: TestState) {
  if ("sourceIssueId" in cols) return state.openPrRows;
  if ("parentId" in cols) return state.sourceIssues;
  if ("companyId" in cols) return state.parentRow ? [state.parentRow] : [];
  if ("details" in cols) return state.activityRows;
  if ("title" in cols) return state.cardRows;
  return state.treeResponses.length > 0 ? state.treeResponses.shift()! : [];
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

/** Returns a default single-parent test state, with per-test overrides. */
function state(overrides: Partial<TestState> = {}): TestState {
  return {
    openPrRows: [],
    sourceIssues: [{ id: CHILD, parentId: PARENT }],
    parentRow: { id: PARENT, companyId: COMPANY, status: "cancelled", identifier: PARENT_IDENTIFIER },
    treeResponses: [],
    activityRows: [],
    cardRows: [],
    ...overrides,
  };
}

const tree = (...rows: Array<Record<string, unknown>>) => rows;

function makeJanitor(stateFixture: TestState, opts: { enabled?: boolean; sweepIntervalMs?: number; now?: () => Date } = {}) {
  const db = makeDb(stateFixture);
  const service = createCarrierOrphanJanitorService(db as never, {
    enabled: opts.enabled,
    sweepIntervalMs: opts.sweepIntervalMs ?? 0,
    now: opts.now ?? (() => new Date(NOW_ISO)),
  });
  return { db, service };
}

function makeSurface(stateFixture: TestState, opts: { enabled?: boolean; sweepIntervalMs?: number; now?: () => Date } = {}) {
  const db = makeDb(stateFixture);
  const service = createCarrierStrandedSurfaceService(db as never, {
    enabled: opts.enabled,
    sweepIntervalMs: opts.sweepIntervalMs ?? 0,
    now: opts.now ?? (() => new Date(NOW_ISO)),
  });
  return { db, service };
}

beforeEach(() => {
  mockGhFetch.mockReset();
  mockLogActivity.mockClear();
  mockCreate.mockReset().mockResolvedValue({ id: "card-id-1", identifier: "SUP-7702" });
  mockResolveCandidates.mockReset().mockResolvedValue([TOKEN_CANDIDATE]);
  mockResolveToken.mockReset().mockResolvedValue({ kind: "unavailable", reason: "no token configured" });
});

describe("closeGitHubPullRequest", () => {
  it("POSTs the close endpoint with a bearer token and reports success", async () => {
    mockGhFetch.mockResolvedValue(jsonResponse({ number: 400, state: "closed" }, true, 204));
    const result = await closeGitHubPullRequest("ghp_test", "TEA-Core", "paperclip", 400);
    expect(result).toEqual({ success: true, status: 204, error: null });

    const [url, init] = mockGhFetch.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/TEA-Core/paperclip/pulls/400/close");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer ghp_test");
  });

  it("reports the GitHub error message on a 403", async () => {
    mockGhFetch.mockResolvedValue(jsonResponse({ message: "Resource not accessible" }, false, 403));
    await expect(closeGitHubPullRequest("ghp_test", "TEA-Core", "paperclip", 400)).resolves.toEqual({
      success: false,
      status: 403,
      error: "Resource not accessible",
    });
  });

  it("returns network_error when ghFetch throws", async () => {
    mockGhFetch.mockRejectedValue(new Error("boom"));
    await expect(closeGitHubPullRequest("ghp_test", "TEA-Core", "paperclip", 400)).resolves.toEqual({
      success: false,
      status: 0,
      error: "network_error",
    });
  });
});

describe("deleteGitHubBranch", () => {
  it("DELETEs the branch ref with a bearer token and reports success", async () => {
    mockGhFetch.mockResolvedValue(jsonResponse({ ref: `refs/heads/${CARRIER_BRANCH}` }, true, 200));
    const result = await deleteGitHubBranch("ghp_test", "TEA-Core", "paperclip", CARRIER_BRANCH);
    expect(result).toEqual({ success: true, alreadyDeleted: false, status: 200, error: null });

    const [url, init] = mockGhFetch.mock.calls[0]!;
    expect(url).toBe(`https://api.github.com/repos/TEA-Core/paperclip/git/refs/heads/${CARRIER_BRANCH}`);
    expect(init.method).toBe("DELETE");
    expect(init.headers.authorization).toBe("Bearer ghp_test");
  });

  it("counts a missing ref as already-deleted success so a retried sweep converges", async () => {
    mockGhFetch.mockResolvedValue(jsonResponse({ message: "Not Found" }, false, 404));
    await expect(deleteGitHubBranch("ghp_test", "TEA-Core", "paperclip", CARRIER_BRANCH)).resolves.toEqual({
      success: true,
      alreadyDeleted: true,
      status: 404,
      error: null,
    });
  });

  it("reports a 403 as a failure", async () => {
    mockGhFetch.mockResolvedValue(jsonResponse({ message: "Must have admin rights" }, false, 403));
    await expect(deleteGitHubBranch("ghp_test", "TEA-Core", "paperclip", CARRIER_BRANCH)).resolves.toEqual({
      success: false,
      alreadyDeleted: false,
      status: 403,
      error: "Must have admin rights",
    });
  });
});

describe("fetchGitHubPullRequestState", () => {
  it("measures open state and the live head ref", async () => {
    mockGhFetch.mockResolvedValue(liveOpenResponse());
    await expect(fetchGitHubPullRequestState("ghp_test", "TEA-Core", "paperclip", 400)).resolves.toEqual({
      state: "open",
      headRef: CARRIER_BRANCH,
      status: 200,
    });
  });

  it("reports unknown on a 404", async () => {
    mockGhFetch.mockResolvedValue(jsonResponse({ message: "Not Found" }, false, 404));
    await expect(fetchGitHubPullRequestState("ghp_test", "TEA-Core", "paperclip", 400)).resolves.toEqual({
      state: "unknown",
      headRef: null,
      status: 404,
    });
  });
});

describe("createCarrierOrphanJanitorService", () => {
  it("never touches a carrier whose parent has a non-terminal descendant (the terminal sweep's descendant guard)", async () => {
    const { service } = makeJanitor(state({
      openPrRows: [openPrRow()],
      treeResponses: [tree(
        { id: PARENT, status: "cancelled" },
        { id: CHILD, status: "in_progress" },
      )],
    }));

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 0,
      skippedNonTerminalTree: 1,
      stranded: 0,
      alreadyClosed: 0,
      closed: 0,
      failed: 0,
    });
    expect(mockGhFetch).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("holds the carrier when a live descendant sits behind a cancelled child (recursive tree, not just direct children)", async () => {
    const { service } = makeJanitor(state({
      openPrRows: [openPrRow()],
      treeResponses: [tree(
        { id: PARENT, status: "cancelled" },
        { id: CHILD, status: "cancelled" },
        { id: GRANDCHILD, status: "todo" },
      )],
    }));

    await expect(service.sweep()).resolves.toMatchObject({
      due: true,
      skippedNonTerminalTree: 1,
      closed: 0,
    });
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("treats a cancelled parent with completed children as stranded and never deletes", async () => {
    const { service } = makeJanitor(state({
      openPrRows: [openPrRow()],
      treeResponses: [tree(
        { id: PARENT, status: "cancelled" },
        { id: CHILD_DONE, status: "done" },
      )],
    }));

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 0,
      skippedNonTerminalTree: 0,
      stranded: 1,
      alreadyClosed: 0,
      closed: 0,
      failed: 0,
    });
    expect(mockGhFetch).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("deletes the branch and closes the PR for a clean orphan, then logs the disposition", async () => {
    const { service } = makeJanitor(state({
      openPrRows: [openPrRow()],
      treeResponses: [
        tree(
          { id: PARENT, status: "cancelled" },
          { id: CHILD, status: "cancelled" },
        ),
        tree(
          { id: PARENT, status: "cancelled" },
          { id: CHILD, status: "cancelled" },
        ),
      ],
    }));
    mockGhFetch
      .mockResolvedValueOnce(liveOpenResponse())
      .mockResolvedValueOnce(jsonResponse({ ref: `refs/heads/${CARRIER_BRANCH}` }, true, 200))
      .mockResolvedValueOnce(jsonResponse({ number: 400, state: "closed" }, true, 204));

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      skippedNonTerminalTree: 0,
      stranded: 0,
      alreadyClosed: 0,
      closed: 1,
      failed: 0,
    });

    expect(mockGhFetch).toHaveBeenCalledTimes(3);
    expect(String(mockGhFetch.mock.calls[0]![0])).toBe("https://api.github.com/repos/TEA-Core/paperclip/pulls/400");
    expect(mockGhFetch.mock.calls[1]![0]).toBe(`https://api.github.com/repos/TEA-Core/paperclip/git/refs/heads/${CARRIER_BRANCH}`);
    expect(mockGhFetch.mock.calls[1]![1].method).toBe("DELETE");
    expect(mockGhFetch.mock.calls[2]![0]).toBe("https://api.github.com/repos/TEA-Core/paperclip/pulls/400/close");
    expect(mockGhFetch.mock.calls[2]![1].method).toBe("POST");
    for (const call of mockGhFetch.mock.calls) {
      expect(call[1].headers.authorization).toBe(`Bearer ${TOKEN_CANDIDATE.token}`);
    }

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorType: "system",
      actorId: "system:carrier-orphan-janitor",
      action: CARRIER_ORPHAN_JANITOR_CLOSED_ACTION,
      entityType: "issue",
      entityId: PARENT,
      issueId: PARENT,
      details: {
        identifier: PARENT_IDENTIFIER,
        pr: PR_KEY,
        branch: CARRIER_BRANCH,
        prState: "closed",
      },
    }));
  });

  it("refuses the write when the fail-closed re-check finds a live descendant after discovery", async () => {
    const { service } = makeJanitor(state({
      openPrRows: [openPrRow()],
      treeResponses: [
        tree(
          { id: PARENT, status: "cancelled" },
          { id: CHILD, status: "cancelled" },
        ),
        tree(
          { id: PARENT, status: "cancelled" },
          { id: CHILD, status: "in_progress" },
        ),
      ],
    }));
    mockGhFetch.mockResolvedValue(liveOpenResponse());

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      skippedNonTerminalTree: 1,
      stranded: 0,
      alreadyClosed: 0,
      closed: 0,
      failed: 0,
    });
    // Only the live state measurement happens; no delete, no close, no activity row.
    expect(mockGhFetch).toHaveBeenCalledTimes(1);
    expect(mockGhFetch.mock.calls[0]![1].method ?? "GET").toBe("GET");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("does not re-dispose a carrier an earlier sweep already closed", async () => {
    const { service } = makeJanitor(state({
      openPrRows: [openPrRow()],
      treeResponses: [tree({ id: PARENT, status: "cancelled" })],
      activityRows: [{ action: CARRIER_ORPHAN_JANITOR_CLOSED_ACTION, details: { pr: PR_KEY } }],
    }));

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 0,
      skippedNonTerminalTree: 0,
      stranded: 0,
      alreadyClosed: 1,
      closed: 0,
      failed: 0,
    });
    expect(mockGhFetch).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("counts a live-closed PR as already handled without writing", async () => {
    const { service } = makeJanitor(state({
      openPrRows: [openPrRow()],
      treeResponses: [
        tree({ id: PARENT, status: "cancelled" }),
        tree({ id: PARENT, status: "cancelled" }),
      ],
    }));
    mockGhFetch.mockResolvedValue(jsonResponse({ number: 400, state: "closed" }));

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      skippedNonTerminalTree: 0,
      stranded: 0,
      alreadyClosed: 1,
      closed: 0,
      failed: 0,
    });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("fails without writing when the live state cannot be measured", async () => {
    const { service } = makeJanitor(state({
      openPrRows: [openPrRow()],
      treeResponses: [tree({ id: PARENT, status: "cancelled" })],
    }));
    mockGhFetch.mockRejectedValue(new Error("boom"));

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      skippedNonTerminalTree: 0,
      stranded: 0,
      alreadyClosed: 0,
      closed: 0,
      failed: 1,
    });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("tries the next token candidate when the first 401s on the live measurement", async () => {
    mockResolveCandidates.mockResolvedValue([TOKEN_CANDIDATE, TOKEN_CANDIDATE_2]);
    const { service } = makeJanitor(state({
      openPrRows: [openPrRow()],
      treeResponses: [
        tree({ id: PARENT, status: "cancelled" }),
        tree({ id: PARENT, status: "cancelled" }),
      ],
    }));
    mockGhFetch
      .mockResolvedValueOnce(jsonResponse({ message: "Bad credentials" }, false, 401))
      .mockResolvedValueOnce(liveOpenResponse())
      .mockResolvedValueOnce(jsonResponse({ ref: `refs/heads/${CARRIER_BRANCH}` }, true, 200))
      .mockResolvedValueOnce(jsonResponse({ number: 400, state: "closed" }, true, 204));

    await expect(service.sweep()).resolves.toMatchObject({ due: true, closed: 1, failed: 0 });
    expect(mockGhFetch).toHaveBeenCalledTimes(4);
    expect(mockGhFetch.mock.calls[1]![1].headers.authorization).toBe(`Bearer ${TOKEN_CANDIDATE_2.token}`);
  });

  it("ignores a parent that is not cancelled", async () => {
    const { service } = makeJanitor(state({
      openPrRows: [openPrRow()],
      parentRow: { id: PARENT, companyId: COMPANY, status: "in_progress", identifier: PARENT_IDENTIFIER },
    }));

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 0,
      skippedNonTerminalTree: 0,
      stranded: 0,
      alreadyClosed: 0,
      closed: 0,
      failed: 0,
    });
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("ignores open pull requests whose head branch is not the parent's carrier branch", async () => {
    const { service } = makeJanitor(state({
      openPrRows: [openPrRow({ branch: "SUP-9999-some-other-parent" })],
      treeResponses: [tree({ id: PARENT, status: "cancelled" })],
    }));

    await expect(service.sweep()).resolves.toMatchObject({ due: true, candidates: 0 });
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("performs no work when no open pull request exists", async () => {
    const { db, service } = makeJanitor(state({}));

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 0,
      skippedNonTerminalTree: 0,
      stranded: 0,
      alreadyClosed: 0,
      closed: 0,
      failed: 0,
    });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("is separately disableable: a disabled tick is a no-op with no database work", async () => {
    const { db, service } = makeJanitor(state({ openPrRows: [openPrRow()] }), { enabled: false });

    await expect(service.sweep()).resolves.toEqual({
      due: false,
      candidates: 0,
      skippedNonTerminalTree: 0,
      stranded: 0,
      alreadyClosed: 0,
      closed: 0,
      failed: 0,
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(mockGhFetch).not.toHaveBeenCalled();
  });

  it("keeps every non-due tick a no-op behind the min-interval gate", async () => {
    let clock = new Date(NOW_ISO).getTime();
    const { db, service } = makeJanitor(
      state({
        openPrRows: [openPrRow()],
        treeResponses: [
          tree({ id: PARENT, status: "cancelled" }, { id: CHILD, status: "cancelled" }),
          tree({ id: PARENT, status: "cancelled" }, { id: CHILD, status: "cancelled" }),
        ],
      }),
      { sweepIntervalMs: 60 * 60 * 1000, now: () => new Date(clock) },
    );
    mockGhFetch
      .mockResolvedValueOnce(liveOpenResponse())
      .mockResolvedValueOnce(jsonResponse({ ref: `refs/heads/${CARRIER_BRANCH}` }, true, 200))
      .mockResolvedValueOnce(jsonResponse({ number: 400, state: "closed" }, true, 204));

    await expect(service.sweep()).resolves.toMatchObject({ due: true, closed: 1 });
    const selectCallsAfterFirst = db.select.mock.calls.length;
    clock += 30 * 1000;
    await expect(service.sweep()).resolves.toMatchObject({ due: false });
    expect(db.select.mock.calls.length).toBe(selectCallsAfterFirst);
    clock += 61 * 60 * 1000;
    await expect(service.sweep()).resolves.toMatchObject({ due: true });
  });
});

describe("createCarrierStrandedSurfaceService", () => {
  it("creates a single operator card for a cancelled parent with completed children — a card, never a deletion", async () => {
    const { service } = makeSurface(state({
      openPrRows: [openPrRow()],
      treeResponses: [tree(
        { id: PARENT, status: "cancelled", identifier: PARENT_IDENTIFIER },
        { id: CHILD_DONE, status: "done", identifier: "SUP-7701a" },
        { id: CHILD, status: "cancelled", identifier: "SUP-7701b" },
      )],
    }));
    mockGhFetch.mockResolvedValue(liveOpenResponse());

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      surfaced: 1,
      alreadySurfaced: 0,
      prNotOpen: 0,
      failed: 0,
    });

    // The only GitHub call is a read: the surface never writes.
    expect(mockGhFetch).toHaveBeenCalledTimes(1);
    expect(mockGhFetch.mock.calls[0]![0]).toBe("https://api.github.com/repos/TEA-Core/paperclip/pulls/400");
    expect(mockGhFetch.mock.calls[0]![1].method).toBeUndefined();

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [companyId, card] = mockCreate.mock.calls[0]!;
    expect(companyId).toBe(COMPANY);
    expect(card).toMatchObject({
      title: buildStrandedCardTitle(PARENT_IDENTIFIER),
      parentId: PARENT,
      status: "backlog",
      assigneeAgentId: null,
      assigneeUserId: null,
      idempotencyKey: `carrier-stranded-surface:${PARENT}`,
    });
    expect(card.description).toContain(PR_KEY);
    expect(card.description).toContain(CARRIER_BRANCH);
    expect(card.description).toContain("SUP-7701a");
    expect(card.description).toContain("will not close this PR");

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorId: "system:carrier-stranded-surface",
      action: CARRIER_STRANDED_SURFACE_ACTION,
      entityId: PARENT,
      details: expect.objectContaining({
        pr: PR_KEY,
        branch: CARRIER_BRANCH,
        cardId: "card-id-1",
      }),
    }));
  });

  it("never creates a second card when an open card already exists for the parent", async () => {
    const { service } = makeSurface(state({
      openPrRows: [openPrRow()],
      treeResponses: [tree(
        { id: PARENT, status: "cancelled", identifier: PARENT_IDENTIFIER },
        { id: CHILD_DONE, status: "done", identifier: "SUP-7701a" },
      )],
      cardRows: [{ id: "card-id-1", status: "backlog", title: buildStrandedCardTitle(PARENT_IDENTIFIER) }],
    }));

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 0,
      surfaced: 0,
      alreadySurfaced: 1,
      prNotOpen: 0,
      failed: 0,
    });
    expect(mockGhFetch).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("skips a cancelled parent whose tree holds no completed work (the janitor's territory)", async () => {
    const { service } = makeSurface(state({
      openPrRows: [openPrRow()],
      treeResponses: [tree(
        { id: PARENT, status: "cancelled" },
        { id: CHILD, status: "cancelled" },
      )],
    }));

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 0,
      surfaced: 0,
      alreadySurfaced: 0,
      prNotOpen: 0,
      failed: 0,
    });
    expect(mockGhFetch).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("does not surface a parent whose live carrier PR is no longer open", async () => {
    const { service } = makeSurface(state({
      openPrRows: [openPrRow()],
      treeResponses: [tree(
        { id: PARENT, status: "cancelled", identifier: PARENT_IDENTIFIER },
        { id: CHILD_DONE, status: "done", identifier: "SUP-7701a" },
      )],
    }));
    mockGhFetch.mockResolvedValue(jsonResponse({ number: 400, state: "closed", head: { ref: CARRIER_BRANCH } }));

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 0,
      surfaced: 0,
      alreadySurfaced: 0,
      prNotOpen: 1,
      failed: 0,
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("ignores a parent that is not cancelled", async () => {
    const { service } = makeSurface(state({
      openPrRows: [openPrRow()],
      parentRow: { id: PARENT, companyId: COMPANY, status: "done", identifier: PARENT_IDENTIFIER },
    }));

    await expect(service.sweep()).resolves.toMatchObject({ due: true, candidates: 0, surfaced: 0 });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("ignores open pull requests whose head branch is not the parent's carrier branch", async () => {
    const { service } = makeSurface(state({
      openPrRows: [openPrRow({ branch: "SUP-9999-some-other-parent" })],
      treeResponses: [tree({ id: PARENT, status: "cancelled" })],
    }));

    await expect(service.sweep()).resolves.toMatchObject({ due: true, candidates: 0, surfaced: 0 });
    expect(mockGhFetch).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("is separately disableable: a disabled tick is a no-op with no database work", async () => {
    const { db, service } = makeSurface(state({ openPrRows: [openPrRow()] }), { enabled: false });

    await expect(service.sweep()).resolves.toEqual({
      due: false,
      candidates: 0,
      surfaced: 0,
      alreadySurfaced: 0,
      prNotOpen: 0,
      failed: 0,
    });
    expect(db.select).not.toHaveBeenCalled();
    expect(mockGhFetch).not.toHaveBeenCalled();
  });
});
