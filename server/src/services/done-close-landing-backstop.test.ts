import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyPullRequestLanding,
  createDoneCloseLandingBackstopService,
  type DoneCloseLandingSweepResult,
} from "./done-close-landing-backstop.js";
import type { ExternalObjectResolveResult } from "./external-objects.js";

const mockResolveLinkedPullRequestsWithState = vi.hoisted(() => vi.fn());
const mockResolveCardPullRequest = vi.hoisted(() => vi.fn());
vi.mock("./merge-arming.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./merge-arming.js")>();
  return {
    ...orig,
    resolveLinkedPullRequestsWithState: mockResolveLinkedPullRequestsWithState,
    resolveCardPullRequest: mockResolveCardPullRequest,
  };
});

const mockCreateGitHubExternalObjectProvider = vi.hoisted(() => vi.fn());
vi.mock("./github-external-object-provider.js", () => ({
  createGitHubExternalObjectProvider: mockCreateGitHubExternalObjectProvider,
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "activity-row" }));
vi.mock("./activity-log.js", () => ({ logActivity: mockLogActivity }));

const mockAddComment = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "comment-row" }));
vi.mock("./issues.js", () => ({
  issueService: () => ({ addComment: mockAddComment }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logActivity } from "./activity-log.js";

type DbState = {
  candidates: Array<Record<string, unknown>>;
  existingLandingRows: Array<Record<string, unknown>>;
};

/** Discovery selects an `issue` sub-object; idempotency selects flat columns. */
function makeDb(state: DbState) {
  return {
    select: vi.fn((cols: Record<string, unknown>) => {
      const rows = "issue" in cols ? state.candidates : state.existingLandingRows;
      return {
        from: () => ({
          innerJoin: () => ({
            where: () => Promise.resolve(rows),
          }),
          where: () => Promise.resolve(rows),
        }),
      };
    }),
  };
}

function mockResolver(implementation: () => Promise<unknown>) {
  const resolve = vi.fn(implementation);
  mockCreateGitHubExternalObjectProvider.mockReset();
  mockCreateGitHubExternalObjectProvider.mockReturnValue({
    detector: {},
    resolvers: [{ providerKey: "github", objectType: "pull_request", resolve }],
  });
  return resolve;
}

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ISSUE = "33333333-3333-4333-8333-333333333333";
// Pinned sweep clock. In-window skips are >= 24h and <= 7d older than this.
const NOW = "2026-08-19T00:00:00Z";
const fixedNow = () => new Date(NOW);
// 3 days old: past the 24h grace, inside the 7d lookback.
const IN_WINDOW = "2026-08-16T00:00:00Z";

function linkedPr(overrides: Record<string, unknown> = {}) {
  return {
    id: "eo-3158",
    owner: "paperclipai",
    repo: "paperclip",
    number: 3158,
    nodeId: null,
    headRefName: "SUP-branch",
    displayName: "paperclipai/paperclip#3158",
    cachedState: "open",
    lastErrorCode: null,
    ...overrides,
  };
}

function candidateRow(overrides: {
  status?: string;
  identifier?: string | null;
  assigneeAgentId?: string | null;
  createdAt?: string;
  reason?: string;
  skipReason?: string;
} = {}) {
  const createdAt = overrides.createdAt ?? IN_WINDOW;
  const reason = overrides.reason ?? "open_linked_prs_decision_carried:1";
  return {
    details: {
      identifier: "SUP-13326",
      reason,
      skipReason: overrides.skipReason ?? reason,
      prs: "paperclipai/paperclip#3158",
    },
      createdAt: new Date(createdAt),
      issue: {
        id: ISSUE,
        companyId: COMPANY,
        status: overrides.status ?? "done",
        identifier: overrides.identifier ?? "SUP-13326",
        assigneeAgentId: overrides.assigneeAgentId === undefined ? AGENT : overrides.assigneeAgentId,
      },
    };
  }

  // SUP-14900: an arming-refusal candidate — the closing transition's arming was
  // refused (head_unresolvable, …), so the guard recorded no decision-carried skip
  // and the only signal the sweep can key on is `refusalReason`.
  function refusalCandidateRow(overrides: {
    status?: string;
    identifier?: string | null;
    assigneeAgentId?: string | null;
    createdAt?: string;
    refusalReason?: string;
  } = {}) {
    const createdAt = overrides.createdAt ?? IN_WINDOW;
    const refusalReason =
      overrides.refusalReason ??
      "status:skipped:head_unresolvable: no open PR carries the approved head for paperclipai/paperclip pull/364";
    return {
      details: {
        identifier: "SUP-14849",
        refusalReason,
        headSha: null,
        decisionOutcome: "approved",
      },
      createdAt: new Date(createdAt),
      issue: {
        id: ISSUE,
        companyId: COMPANY,
        status: overrides.status ?? "done",
        identifier: overrides.identifier ?? "SUP-14849",
        assigneeAgentId: overrides.assigneeAgentId === undefined ? AGENT : overrides.assigneeAgentId,
      },
    };
  }


const mergedSnapshot = {
  ok: true,
  snapshot: {
    statusKey: "merged",
    statusCategory: "succeeded",
    statusTone: "success",
    data: { state: "closed", merged: true, merged_at: "2026-08-18T20:34:57Z" },
  },
} as unknown as ExternalObjectResolveResult;
// SUP-13326 / #3158 fixture shape: closed without merging.
const closedSnapshot = {
  ok: true,
  snapshot: {
    statusKey: "closed",
    statusCategory: "closed",
    statusTone: "muted",
    data: { state: "closed", merged: false, closed_at: "2026-08-18T20:34:57Z" },
  },
} as unknown as ExternalObjectResolveResult;
// #3145 fixture shape: still open past the grace window.
const openSnapshot = {
  ok: true,
  snapshot: {
    statusKey: "open",
    statusCategory: "open",
    statusTone: "info",
    data: { state: "open", merged: false },
  },
} as unknown as ExternalObjectResolveResult;
// What the real resolver reports when resolveGitHubToken has no credential.
const authUnavailable = {
  ok: false,
  liveness: "auth_required",
  errorCode: "github_token_unavailable",
} as unknown as ExternalObjectResolveResult;
// Cached-only / 404 row: live snapshot carries no readable PR state.
const notFoundSnapshot = {
  ok: true,
  snapshot: {
    statusKey: "not_found",
    statusCategory: "unknown",
    statusTone: "neutral",
    data: { notFound: true },
  },
} as unknown as ExternalObjectResolveResult;

function makeService(
  state: DbState,
  opts: { now?: () => Date; wakeup?: unknown; sweepIntervalMs?: number } = {},
) {
  const db = makeDb(state);
  const service = createDoneCloseLandingBackstopService(db as never, {
    now: opts.now ?? fixedNow,
    sweepIntervalMs: opts.sweepIntervalMs ?? 0,
    ...(opts.wakeup ? { wakeup: opts.wakeup as never } : {}),
  });
  return { db, state, service };
}

beforeEach(() => {
  mockLogActivity.mockClear();
  mockAddComment.mockClear();
  mockResolveLinkedPullRequestsWithState.mockReset();
  mockResolveCardPullRequest.mockReset();
  mockCreateGitHubExternalObjectProvider.mockReset();
});

describe("classifyPullRequestLanding", () => {
  it("classifies from the raw provider snapshot, never from cached state", () => {
    expect(classifyPullRequestLanding(mergedSnapshot)).toBe("merged");
    expect(classifyPullRequestLanding(closedSnapshot)).toBe("closed");
    expect(classifyPullRequestLanding(openSnapshot)).toBe("open");
    expect(classifyPullRequestLanding(authUnavailable)).toBe("unknown");
    expect(classifyPullRequestLanding(notFoundSnapshot)).toBe("unknown");
  });
});

describe("createDoneCloseLandingBackstopService", () => {
  it("emits issue.done_close_landing_confirmed for a merged decision-carried PR and raises nothing else", async () => {
    const { service } = makeService({
      candidates: [candidateRow()],
      existingLandingRows: [],
    });
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([linkedPr()]);
    mockResolver(async () => mergedSnapshot);

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      confirmed: 1,
      failed: 0,
      deferred: 0,
    });

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorType: "system",
      actorId: "system:done-close-landing-backstop",
      action: "issue.done_close_landing_confirmed",
      entityType: "issue",
      entityId: ISSUE,
      details: {
        identifier: "SUP-13326",
        pr: "paperclipai/paperclip#3158",
        prState: "merged",
        closedAt: "2026-08-18T20:34:57Z",
        skipReason: "open_linked_prs_decision_carried:1",
        refusal: false,
      },
    }));
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("emits issue.done_close_landing_failed with a system comment and assignee wake when the PR closed unmerged", async () => {
    const wakeup = vi.fn().mockResolvedValue({ id: "wake" });
    const { service } = makeService(
      { candidates: [candidateRow()], existingLandingRows: [] },
      { wakeup },
    );
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([linkedPr()]);
    mockResolver(async () => closedSnapshot);

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      confirmed: 0,
      failed: 1,
      deferred: 0,
    });

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.done_close_landing_failed",
      details: expect.objectContaining({
        pr: "paperclipai/paperclip#3158",
        prState: "closed",
        closedAt: "2026-08-18T20:34:57Z",
        skipReason: "open_linked_prs_decision_carried:1",
      }),
    }));
    expect(mockAddComment).toHaveBeenCalledTimes(1);
    const [commentIssueId, commentBody, commentActor, commentOptions] = mockAddComment.mock.calls[0]!;
    expect(commentIssueId).toBe(ISSUE);
    expect(commentBody).toContain("[Done-close landing] SUP-13326: PR paperclipai/paperclip#3158 is closed");
    expect(commentActor).toEqual({});
    expect(commentOptions).toEqual({ authorType: "system" });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(AGENT, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: ISSUE, mutation: "comment" },
    });
  });

  it("emits issue.done_close_landing_failed when the PR is still open past the grace window", async () => {
    const wakeup = vi.fn().mockResolvedValue({ id: "wake" });
    const { service } = makeService(
      { candidates: [candidateRow()], existingLandingRows: [] },
      { wakeup },
    );
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([
      linkedPr({ number: 3145, displayName: "paperclipai/paperclip#3145" }),
    ]);
    mockResolver(async () => openSnapshot);

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      confirmed: 0,
      failed: 1,
      deferred: 0,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.done_close_landing_failed",
      details: expect.objectContaining({
        pr: "paperclipai/paperclip#3145",
        prState: "open",
        closedAt: null,
      }),
    }));
    expect(mockAddComment).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("emits issue.done_close_landing_failed for an arming-refusal card whose linked PR is still open (SUP-14900)", async () => {
    const wakeup = vi.fn().mockResolvedValue({ id: "wake" });
    const { service } = makeService(
      { candidates: [refusalCandidateRow()], existingLandingRows: [] },
      { wakeup },
    );
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([
      linkedPr({ number: 364, displayName: "paperclipai/paperclip#364" }),
    ]);
    mockResolver(async () => openSnapshot);

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      confirmed: 0,
      failed: 1,
      deferred: 0,
    });

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.done_close_landing_failed",
      details: expect.objectContaining({
        identifier: "SUP-14849",
        pr: "paperclipai/paperclip#364",
        prState: "open",
        refusal: true,
        skipReason: expect.stringContaining("head_unresolvable"),
      }),
    }));
    expect(mockAddComment).toHaveBeenCalledTimes(1);
    const [commentIssueId, commentBody] = mockAddComment.mock.calls[0]!;
    expect(commentIssueId).toBe(ISSUE);
    expect(commentBody).toContain("merge arming was REFUSED at close");
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("confirms (not flags) an arming-refusal card whose linked PR did merge (SUP-14900 negative)", async () => {
    const { service } = makeService({
      candidates: [refusalCandidateRow()],
      existingLandingRows: [],
    });
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([
      linkedPr({ number: 364, displayName: "paperclipai/paperclip#364" }),
    ]);
    mockResolver(async () => mergedSnapshot);

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      confirmed: 1,
      failed: 0,
      deferred: 0,
    });

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.done_close_landing_confirmed",
      details: expect.objectContaining({
        pr: "paperclipai/paperclip#364",
        prState: "merged",
        refusal: true,
      }),
    }));
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  describe("SUP-14917: zero cached mentions resolved via the shared workspace discovery", () => {
    const workspacePr = {
      kind: "single" as const,
      owner: "paperclipai",
      repo: "paperclip",
      number: 455,
      displayName: "paperclipai/paperclip#455",
      headRefName: "SUP-branch",
      source: "workspace" as const,
    };

    it("reports a done card whose workspace-resolved PR is open past the grace window (AC2)", async () => {
      const wakeup = vi.fn().mockResolvedValue({ id: "wake" });
      const { service } = makeService(
        { candidates: [candidateRow()], existingLandingRows: [] },
        { wakeup },
      );
      // Zero cached mentions; the shared resolution finds the delivered PR by workspace.
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([]);
      mockResolveCardPullRequest.mockResolvedValue(workspacePr);
      mockResolver(async () => openSnapshot);

      await expect(service.sweep()).resolves.toEqual({
        due: true,
        candidates: 1,
        confirmed: 0,
        failed: 1,
        deferred: 0,
      });

      expect(mockResolveCardPullRequest).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "issue.done_close_landing_failed",
        details: expect.objectContaining({
          pr: "paperclipai/paperclip#455",
          prState: "open",
        }),
      }));
      expect(wakeup).toHaveBeenCalledTimes(1);
    });

    it("stays silent when the shared resolution finds no PR by any path (AC3)", async () => {
      const { service } = makeService({
        candidates: [candidateRow()],
        existingLandingRows: [],
      });
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([]);
      mockResolveCardPullRequest.mockResolvedValue({ kind: "none" });
      mockResolver(async () => openSnapshot);

      await expect(service.sweep()).resolves.toEqual({
        due: true,
        candidates: 1,
        confirmed: 0,
        failed: 0,
        deferred: 0,
      });
      expect(mockLogActivity).not.toHaveBeenCalled();
      expect(mockAddComment).not.toHaveBeenCalled();
    });

    it("defers (never reports) when the shared resolution is ambiguous or undetermined (AC4)", async () => {
      const { service } = makeService({
        candidates: [candidateRow()],
        existingLandingRows: [],
      });
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([]);
      mockResolveCardPullRequest.mockResolvedValue({
        kind: "ambiguous",
        reason: "mention-workspace-disagreement",
        displayNames: ["paperclipai/paperclip#455", "paperclipai/paperclip#42"],
      });
      mockResolver(async () => openSnapshot);

      await expect(service.sweep()).resolves.toEqual({
        due: true,
        candidates: 1,
        confirmed: 0,
        failed: 0,
        deferred: 1,
      });
      expect(mockLogActivity).not.toHaveBeenCalled();
      expect(mockAddComment).not.toHaveBeenCalled();
    });
  });

  it("never evaluates a done issue without the decision-carried skip row, and ignores other skip reasons", async () => {
    const { service } = makeService({ candidates: [], existingLandingRows: [] });
    const result = await service.sweep();
    expect(result).toEqual({ due: true, candidates: 0, confirmed: 0, failed: 0, deferred: 0 });
    expect(mockResolveLinkedPullRequestsWithState).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();

    // Plain close and ahead-by skips carry different reason prefixes: even if
    // one reached the service it must not be evaluated.
    const { service: second } = makeService({
      candidates: [
        candidateRow({
          reason: "ahead_by_no_merged_pr_decision_carried:2",
          skipReason: "ahead_by_no_merged_pr_decision_carried:2",
        }),
      ],
      existingLandingRows: [],
    });
    const secondResult = await second.sweep();
    expect(secondResult.candidates).toBe(0);
    expect(mockResolveLinkedPullRequestsWithState).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("re-running the sweep emits no duplicate activity rows for any (issue, PR) pair", async () => {
    const state: DbState = { candidates: [candidateRow()], existingLandingRows: [] };
    const { service } = makeService(state);
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([linkedPr()]);
    mockResolver(async () => mergedSnapshot);

    const first: DoneCloseLandingSweepResult = await service.sweep();
    expect(first).toEqual({ due: true, candidates: 1, confirmed: 1, failed: 0, deferred: 0 });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);

    // The first sweep's row now exists; a later sweep must not re-emit.
    state.existingLandingRows.push({
      action: "issue.done_close_landing_confirmed",
      details: { identifier: "SUP-13326", pr: "paperclipai/paperclip#3158" },
    });
    const second = await service.sweep();
    expect(second).toEqual({ due: true, candidates: 1, confirmed: 0, failed: 0, deferred: 0 });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("defers unmeasured PRs (credential unavailable / ok:false / cached-only) without emitting either action", async () => {
    const state: DbState = { candidates: [candidateRow()], existingLandingRows: [] };
    const { service } = makeService(state);
    // Cached-only row: never hydrated, so only the live resolver can speak.
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([linkedPr({ cachedState: null })]);

    mockResolver(async () => authUnavailable);
    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      confirmed: 0,
      failed: 0,
      deferred: 1,
    });
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();

    mockResolver(async () => notFoundSnapshot);
    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      confirmed: 0,
      failed: 0,
      deferred: 1,
    });
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(mockAddComment).not.toHaveBeenCalled();
  });

  it("does not evaluate non-done issues whose skip row exists", async () => {
    const { service } = makeService({
      candidates: [
        candidateRow({ status: "in_review" }),
        candidateRow({ status: "todo" }),
      ],
      existingLandingRows: [],
    });
    const result = await service.sweep();
    expect(result.candidates).toBe(0);
    expect(mockResolveLinkedPullRequestsWithState).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("uses the latest skip row as the transition-of-record and never re-triggers older rows", async () => {
    const { service } = makeService({
      candidates: [
        candidateRow({
          createdAt: "2026-08-13T00:00:00Z",
          reason: "open_linked_prs_decision_carried:1",
          skipReason: "open_linked_prs_decision_carried:1",
        }),
        candidateRow({
          createdAt: "2026-08-16T00:00:00Z",
          reason: "open_linked_prs_decision_carried:2",
          skipReason: "open_linked_prs_decision_carried:2",
        }),
      ],
      existingLandingRows: [],
    });
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([linkedPr()]);
    mockResolver(async () => closedSnapshot);

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      confirmed: 0,
      failed: 1,
      deferred: 0,
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({
        skipReason: "open_linked_prs_decision_carried:2",
      }),
    }));
  });

  it("skips the wake for issues without an assignee but still surfaces the comment", async () => {
    const wakeup = vi.fn().mockResolvedValue({ id: "wake" });
    const { service } = makeService(
      { candidates: [candidateRow({ assigneeAgentId: null })], existingLandingRows: [] },
      { wakeup },
    );
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([linkedPr()]);
    mockResolver(async () => closedSnapshot);

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      candidates: 1,
      confirmed: 0,
      failed: 1,
      deferred: 0,
    });
    expect(mockAddComment).toHaveBeenCalledTimes(1);
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("keeps every non-due tick a no-op behind the min-interval gate", async () => {
    let clock = new Date(NOW).getTime();
    const state: DbState = { candidates: [candidateRow()], existingLandingRows: [] };
    const db = makeDb(state);
    const service = createDoneCloseLandingBackstopService(db as never, {
      sweepIntervalMs: 60 * 60 * 1000,
      now: () => new Date(clock),
    });
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([linkedPr()]);
    mockResolver(async () => mergedSnapshot);

    await expect(service.sweep()).resolves.toMatchObject({ due: true, confirmed: 1 });
    const selectCallsAfterFirst = db.select.mock.calls.length;
    clock += 30 * 1000;
    const second = await service.sweep();
    expect(second).toEqual({ due: false, candidates: 0, confirmed: 0, failed: 0, deferred: 0 });
    // Non-due tick performed no database work at all.
    expect(db.select.mock.calls.length).toBe(selectCallsAfterFirst);
    clock += 61 * 60 * 1000;
    await expect(service.sweep()).resolves.toMatchObject({ due: true });
  });
});
