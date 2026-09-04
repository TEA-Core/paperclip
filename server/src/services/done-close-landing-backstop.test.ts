import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  classifyPullRequestLanding,
  createDoneCloseLandingBackstopService,
  buildDiscoveryQuery,
  selectLandingCandidates,
  MAX_REENQUEUE_ATTEMPTS,
  type DoneCloseLandingSweepResult,
} from "./done-close-landing-backstop.js";
import type { ExternalObjectResolveResult } from "./external-objects.js";

const mockResolveLinkedPullRequestsWithState = vi.hoisted(() => vi.fn());
const mockResolveCardPullRequest = vi.hoisted(() => vi.fn());
const mockResolveGitHubTokenForRepo = vi.hoisted(() => vi.fn());
const mockEnableAutoMerge = vi.hoisted(() => vi.fn());
const mockFetchGitHubNodeId = vi.hoisted(() => vi.fn());
vi.mock("./merge-arming.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./merge-arming.js")>();
  return {
    ...orig,
    resolveLinkedPullRequestsWithState: mockResolveLinkedPullRequestsWithState,
    resolveCardPullRequest: mockResolveCardPullRequest,
    resolveGitHubTokenForRepo: mockResolveGitHubTokenForRepo,
    enableAutoMerge: mockEnableAutoMerge,
    fetchGitHubNodeId: mockFetchGitHubNodeId,
  };
});

const mockCreateGitHubExternalObjectProvider = vi.hoisted(() => vi.fn());
vi.mock("./github-external-object-provider.js", () => ({
  createGitHubExternalObjectProvider: mockCreateGitHubExternalObjectProvider,
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "activity-row" }));
vi.mock("./activity-log.js", () => ({ logActivity: mockLogActivity }));

const mockAddComment = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "comment-row" }));
const mockUpdate = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "issue-row" }));
vi.mock("./issues.js", () => ({
  issueService: () => ({ addComment: mockAddComment, update: mockUpdate }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logActivity } from "./activity-log.js";

type DbState = {
  candidates: Array<Record<string, unknown>>;
  existingLandingRows: Array<Record<string, unknown>>;
  companyMergeArmingEnabled?: boolean;
};

/** Discovery selects an `issue` sub-object; company query selects mergeArmingEnabled; idempotency selects flat columns. */
function makeDb(state: DbState) {
  return {
    select: vi.fn((cols: Record<string, unknown>) => {
      if ("issue" in cols) {
        return {
          from: () => ({
            innerJoin: () => ({
              where: () => Promise.resolve(state.candidates),
            }),
          }),
        };
      }
      if ("mergeArmingEnabled" in cols) {
        return {
          from: () => ({
            where: () => Promise.resolve(
              state.companyMergeArmingEnabled !== undefined
                ? [{ mergeArmingEnabled: state.companyMergeArmingEnabled }]
                : [],
            ),
          }),
        };
      }
      return {
        from: () => ({
          where: () => Promise.resolve(state.existingLandingRows),
        }),
      };
    }),
  };
}

function mockResolver(implementation: (input: unknown) => Promise<unknown>) {
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
  mockUpdate.mockClear();
  mockResolveLinkedPullRequestsWithState.mockReset();
  mockResolveCardPullRequest.mockReset();
  mockResolveGitHubTokenForRepo.mockReset();
  mockEnableAutoMerge.mockReset();
  mockFetchGitHubNodeId.mockReset();
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

describe("done-close-landing discovery predicate (AC1 — #514-class card)", () => {
  // AC1 proof anchor: the VERBATIM live row recorded on SUP-14959 when it closed
  // done with an open linked PR. This is the concrete row that proves the sweep's
  // discovery predicate catches a "published-but-un-merged" card (#514-class).
  //   action   = issue.done_transition_guard_skipped
  //   reason   = open_linked_prs_decision_carried:1
  //   prs      = tea-core/paperclip#514
  //   createdAt= 2026-09-04T15:59:15.623Z
  //   issue    = 794fc6b8-... status=done identifier=SUP-14959
  const sup14959Row = {
    details: {
      prs: "tea-core/paperclip#514",
      reason: "open_linked_prs_decision_carried:1",
      identifier: "SUP-14959",
      skipReason: "open_linked_prs_decision_carried:1",
    },
    createdAt: new Date("2026-09-04T15:59:15.623Z"),
    issue: {
      id: "794fc6b8-7e52-467a-b4d7-99b93ef30f19",
      companyId: COMPANY,
      status: "done",
      identifier: "SUP-14959",
      assigneeAgentId: "3ff8593a-4231-4c76-9b72-446f668bf8cc",
    },
  };
  // A lookback/grace window that contains SUP-14959's real transition timestamp.
  const windowStart = new Date("2026-08-28T00:00:00Z");
  const graceCutoff = new Date("2026-09-05T00:00:00Z");

  it("compiles the actual discovery WHERE to the #514-class predicate", () => {
    const db = createDb("postgres://user:pass@127.0.0.1:59999/probe");
    const compiled = buildDiscoveryQuery(db, windowStart, graceCutoff).toSQL();
    // The decision-carried arm keys on the guard's skip reason via ->>'reason'.
    expect(compiled.sql).toContain(
      `"activity_log"."details"->>'reason' LIKE 'open_linked_prs_decision_carried:%'`,
    );
    // The arming-refusal arm keys on the explicit refusal action (SUP-14900).
    expect(compiled.params).toContain("issue.merge_arming_refused_on_close");
    // Only issue-scoped rows, joined to the card, and only cards still `done`.
    expect(compiled.sql).toContain(`inner join "issues"`);
    expect(compiled.sql).toContain(`"activity_log"."entity_id" = "issues"."id"`);
    expect(compiled.params).toContain("issue");
    expect(compiled.params).toContain("issue.done_transition_guard_skipped");
    expect(compiled.params).toContain("done");
    // The time window is bound, not omitted.
    const asMs = (v: unknown) =>
      v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : null;
    expect(compiled.params.map(asMs)).toContain(windowStart.getTime());
    expect(compiled.params.map(asMs)).toContain(graceCutoff.getTime());
  });

  it("selects the verbatim SUP-14959 row through selectLandingCandidates", () => {
    const selected = selectLandingCandidates([sup14959Row], windowStart, graceCutoff);
    expect(selected).toHaveLength(1);
    expect(selected[0].issue.id).toBe("794fc6b8-7e52-467a-b4d7-99b93ef30f19");
    expect(selected[0].details as Record<string, unknown>).toMatchObject({
      reason: "open_linked_prs_decision_carried:1",
      prs: "tea-core/paperclip#514",
    });
  });

  it("selects an arming-refusal row (SUP-14900) with the same window logic", () => {
    const refusalRow = {
      details: {
        refusalReason:
          "status:skipped:head_unresolvable: no open PR carries the approved head for tea-core/paperclip pull/514",
      },
      createdAt: new Date("2026-09-04T09:00:00Z"),
      issue: {
        id: "88888888-8888-4888-8888-888888888888",
        companyId: COMPANY,
        status: "done",
        identifier: "SUP-14900",
        assigneeAgentId: AGENT,
      },
    };
    const selected = selectLandingCandidates([refusalRow], windowStart, graceCutoff);
    expect(selected).toHaveLength(1);
  });

  it("excludes the documented edge cases", () => {
    // (a) never-linked/never-armed: a plain "ahead, N PRs open" close with no
    // decision-carried reason and no refusalReason is NOT a candidate. This pins
    // the known limitation honestly — such a card produces no qualifying row.
    const plainCloseRow = candidateRow({
      reason: "open_linked_prs:2",
      skipReason: "open_linked_prs:2",
    });
    // (b) a card that is no longer `done`.
    const notDoneRow = candidateRow({ status: "in_review" });
    // (c) a transition outside the lookback window (too old).
    const outOfWindowRow = candidateRow({ createdAt: "2026-08-01T00:00:00Z" });
    // (d) a decision-carrying reason with a different prefix.
    const otherPrefixRow = candidateRow({
      reason: "ahead_by_no_merged_pr_decision_carried:2",
      skipReason: "ahead_by_no_merged_pr_decision_carried:2",
    });

    for (const row of [plainCloseRow, notDoneRow, outOfWindowRow, otherPrefixRow]) {
      expect(selectLandingCandidates([row], windowStart, graceCutoff)).toHaveLength(0);
    }
  });

  it("discovers only the decision-carried raw row from a mixed raw activity_log set", async () => {
    const qualifying = candidateRow(); // issue id = ISSUE, decision-carried, done, in-window
    const plainClose = {
      details: {
        prs: "paperclipai/paperclip#999",
        reason: "open_linked_prs:2",
        skipReason: "open_linked_prs:2",
        identifier: "SUP-9999",
      },
      createdAt: new Date(IN_WINDOW),
      issue: {
        id: "44444444-4444-4444-8444-444444444444",
        companyId: COMPANY,
        status: "done",
        identifier: "SUP-9999",
        assigneeAgentId: AGENT,
      },
    };
    const { service } = makeService({
      candidates: [qualifying, plainClose],
      existingLandingRows: [],
    });
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([linkedPr()]);
    mockResolver(async () => mergedSnapshot);

    const result = await service.sweep();

    // Only the decision-carried card is a candidate; the plain-close card is
    // excluded by the discovery predicate + qualification, so its PR is never
    // resolved.
    expect(result.candidates).toBe(1);
    expect(result.confirmed).toBe(1);
    expect(mockResolveLinkedPullRequestsWithState).toHaveBeenCalledTimes(1);
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
      reenqueued: 0,
      escalated: 0,
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
      reenqueued: 0,
      escalated: 0,
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

  it("escalates when the PR is still open past the grace window and merge arming lane is closed", async () => {
    const wakeup = vi.fn().mockResolvedValue({ id: "wake" });
    const { service } = makeService(
      { candidates: [candidateRow()], existingLandingRows: [], companyMergeArmingEnabled: false },
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
      failed: 0,
      deferred: 0,
      reenqueued: 0,
      escalated: 1,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.done_close_landing_escalated",
      details: expect.objectContaining({
        pr: "paperclipai/paperclip#3145",
        prState: "open",
        reason: expect.stringContaining("mergeArmingEnabled=false"),
      }),
    }));
    expect(mockUpdate).toHaveBeenCalledWith(ISSUE, expect.objectContaining({
      status: "blocked",
      unblockDescriptor: expect.objectContaining({
        owner: "board",
        action: expect.stringContaining("PR paperclipai/paperclip#3145"),
      }),
    }));
    expect(mockAddComment).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("escalates an arming-refusal card whose linked PR is still open past grace (SUP-14900)", async () => {
    const wakeup = vi.fn().mockResolvedValue({ id: "wake" });
    const { service } = makeService(
      { candidates: [refusalCandidateRow()], existingLandingRows: [], companyMergeArmingEnabled: false },
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
      failed: 0,
      deferred: 0,
      reenqueued: 0,
      escalated: 1,
    });

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "issue.done_close_landing_escalated",
      details: expect.objectContaining({
        identifier: "SUP-14849",
        pr: "paperclipai/paperclip#364",
        prState: "open",
        refusal: true,
        skipReason: expect.stringContaining("head_unresolvable"),
      }),
    }));
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockAddComment).toHaveBeenCalledTimes(1);
    const [commentIssueId, commentBody] = mockAddComment.mock.calls[0]!;
    expect(commentIssueId).toBe(ISSUE);
    expect(commentBody).toContain("merge arming lane is closed");
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
      reenqueued: 0,
      escalated: 0,
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

    it("escalates a done card whose workspace-resolved PR is open past the grace window when lane closed (AC2)", async () => {
      const wakeup = vi.fn().mockResolvedValue({ id: "wake" });
      const { service } = makeService(
        { candidates: [candidateRow()], existingLandingRows: [], companyMergeArmingEnabled: false },
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
        failed: 0,
        deferred: 0,
        reenqueued: 0,
        escalated: 1,
      });

      expect(mockResolveCardPullRequest).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "issue.done_close_landing_escalated",
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
        reenqueued: 0,
        escalated: 0,
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
        reenqueued: 0,
        escalated: 0,
      });
      expect(mockLogActivity).not.toHaveBeenCalled();
      expect(mockAddComment).not.toHaveBeenCalled();
    });
  });

  describe("SUP-14971: superseded-carrier reconciliation across the card's PR set", () => {
    it("reports a closed-unmerged carrier as superseded (audit row, no comment/wake, no failed count) when a sibling merged (AC2, SUP-14849 shape)", async () => {
      const wakeup = vi.fn().mockResolvedValue({ id: "wake" });
      const { service } = makeService(
        { candidates: [refusalCandidateRow()], existingLandingRows: [] },
        { wakeup },
      );
      // Two linked PRs on one card: #364 closed-unmerged (the carrier), #368 merged
      // (where the work actually landed). Both are measured in the same sweep.
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        linkedPr({ number: 364, displayName: "paperclipai/paperclip#364" }),
        linkedPr({ id: "eo-368", number: 368, displayName: "paperclipai/paperclip#368" }),
      ]);
      mockResolver(async (input: unknown) =>
        (input as { object: { externalId: string } }).object.externalId.endsWith("pull/364")
          ? closedSnapshot
          : mergedSnapshot,
      );

      await expect(service.sweep()).resolves.toEqual({
        due: true,
        candidates: 1,
        confirmed: 1,
        failed: 0,
        deferred: 0,
        reenqueued: 0,
        escalated: 0,
      });

      // Two audit rows: the merged sibling confirmed, the closed carrier recorded
      // as superseded and named against the merged sibling. No attention taken.
      expect(mockLogActivity).toHaveBeenCalledTimes(2);
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "issue.done_close_landing_confirmed",
        details: expect.objectContaining({ pr: "paperclipai/paperclip#368", prState: "merged" }),
      }));
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "issue.done_close_landing_failed",
        details: expect.objectContaining({
          pr: "paperclipai/paperclip#364",
          prState: "closed",
          supersededBy: "paperclipai/paperclip#368",
        }),
      }));
      expect(mockAddComment).not.toHaveBeenCalled();
      expect(wakeup).not.toHaveBeenCalled();
    });

    it("still emits the comment and assignee wake for every closed-unmerged PR when no sibling merged (AC3)", async () => {
      const wakeup = vi.fn().mockResolvedValue({ id: "wake" });
      const { service } = makeService(
        { candidates: [refusalCandidateRow()], existingLandingRows: [] },
        { wakeup },
      );
      // Two closed-unmerged PRs, no merged sibling: both are genuinely stranded.
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        linkedPr({ number: 364, displayName: "paperclipai/paperclip#364" }),
        linkedPr({ id: "eo-368", number: 368, displayName: "paperclipai/paperclip#368" }),
      ]);
      mockResolver(async () => closedSnapshot);

      await expect(service.sweep()).resolves.toEqual({
        due: true,
        candidates: 1,
        confirmed: 0,
        failed: 2,
        deferred: 0,
        reenqueued: 0,
        escalated: 0,
      });

      expect(mockAddComment).toHaveBeenCalledTimes(2);
      expect(wakeup).toHaveBeenCalledTimes(2);
      // Both rows are ordinary failures (attention path) with no supersededBy detail.
      const failedDetails = mockLogActivity.mock.calls
        .map((call) => call[1] as { action: string; details: Record<string, unknown> })
        .filter((record) => record.action === "issue.done_close_landing_failed")
        .map((record) => record.details);
      expect(failedDetails).toHaveLength(2);
      for (const details of failedDetails) {
        expect(details).not.toHaveProperty("supersededBy");
      }
    });
  });

  it("never evaluates a done issue without the decision-carried skip row, and ignores other skip reasons", async () => {
    const { service } = makeService({ candidates: [], existingLandingRows: [] });
    const result = await service.sweep();
    expect(result).toEqual({ due: true, candidates: 0, confirmed: 0, failed: 0, deferred: 0, reenqueued: 0, escalated: 0 });
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
    expect(first).toEqual({ due: true, candidates: 1, confirmed: 1, failed: 0, deferred: 0, reenqueued: 0, escalated: 0 });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);

    // The first sweep's row now exists; a later sweep must not re-emit.
    state.existingLandingRows.push({
      action: "issue.done_close_landing_confirmed",
      details: { identifier: "SUP-13326", pr: "paperclipai/paperclip#3158" },
    });
    const second = await service.sweep();
    expect(second).toEqual({ due: true, candidates: 1, confirmed: 0, failed: 0, deferred: 0, reenqueued: 0, escalated: 0 });
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
      reenqueued: 0,
      escalated: 0,
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
      reenqueued: 0,
      escalated: 0,
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
      reenqueued: 0,
      escalated: 0,
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
      reenqueued: 0,
      escalated: 0,
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
    expect(second).toEqual({ due: false, candidates: 0, confirmed: 0, failed: 0, deferred: 0, reenqueued: 0, escalated: 0 });
    // Non-due tick performed no database work at all.
    expect(db.select.mock.calls.length).toBe(selectCallsAfterFirst);
    clock += 61 * 60 * 1000;
    await expect(service.sweep()).resolves.toMatchObject({ due: true });
  });

  describe("SUP-14991: re-enqueue and escalate branches for open-past-grace PRs", () => {
    it("re-enqueues the PR when merge arming is enabled and the token resolves", async () => {
      const { service } = makeService(
        { candidates: [candidateRow()], existingLandingRows: [], companyMergeArmingEnabled: true },
      );
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        linkedPr({ number: 514, nodeId: "PRNode_abc123", displayName: "paperclipai/paperclip#514" }),
      ]);
      mockResolver(async () => openSnapshot);
      mockResolveGitHubTokenForRepo.mockResolvedValue({
        token: "ghp_test_token",
        scope: "company",
        secretName: "github-token",
      });
      mockEnableAutoMerge.mockResolvedValue({ success: true, alreadyQueued: false, error: null, status: 200 });

      await expect(service.sweep()).resolves.toEqual({
        due: true,
        candidates: 1,
        confirmed: 0,
        failed: 0,
        deferred: 0,
        reenqueued: 1,
        escalated: 0,
      });

      expect(mockEnableAutoMerge).toHaveBeenCalledTimes(1);
      expect(mockEnableAutoMerge).toHaveBeenCalledWith("ghp_test_token", "PRNode_abc123");
      expect(mockLogActivity).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "issue.done_close_landing_reenqueued",
        details: expect.objectContaining({
          pr: "paperclipai/paperclip#514",
          prState: "open",
        }),
      }));
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockAddComment).not.toHaveBeenCalled();
    });

    it("escalates when merge arming is enabled but no token is resolvable", async () => {
      const wakeup = vi.fn().mockResolvedValue({ id: "wake" });
      const { service } = makeService(
        { candidates: [candidateRow()], existingLandingRows: [], companyMergeArmingEnabled: true },
        { wakeup },
      );
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        linkedPr({ number: 514, nodeId: "PRNode_abc123", displayName: "paperclipai/paperclip#514" }),
      ]);
      mockResolver(async () => openSnapshot);
      mockResolveGitHubTokenForRepo.mockResolvedValue({
        token: null,
        reason: "No GitHub token resolvable for paperclipai/paperclip",
      });

      await expect(service.sweep()).resolves.toEqual({
        due: true,
        candidates: 1,
        confirmed: 0,
        failed: 0,
        deferred: 0,
        reenqueued: 0,
        escalated: 1,
      });

      expect(mockEnableAutoMerge).not.toHaveBeenCalled();
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "issue.done_close_landing_escalated",
        details: expect.objectContaining({
          pr: "paperclipai/paperclip#514",
          prState: "open",
          reason: expect.stringContaining("re-enqueue attempt failed"),
        }),
      }));
      expect(mockUpdate).toHaveBeenCalledWith(ISSUE, expect.objectContaining({
        status: "blocked",
        unblockDescriptor: expect.objectContaining({ owner: "board" }),
      }));
      expect(wakeup).toHaveBeenCalledTimes(1);
    });

    it("fetches the node ID when the cached PR row has no nodeId", async () => {
      const { service } = makeService(
        { candidates: [candidateRow()], existingLandingRows: [], companyMergeArmingEnabled: true },
      );
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        linkedPr({ number: 514, nodeId: null, displayName: "paperclipai/paperclip#514" }),
      ]);
      mockResolver(async () => openSnapshot);
      mockResolveGitHubTokenForRepo.mockResolvedValue({
        token: "ghp_fetched",
        scope: "company",
        secretName: "github-token",
      });
      mockFetchGitHubNodeId.mockResolvedValue({ ok: true, status: 200, message: null, nodeId: "PRNode_fetched" });
      mockEnableAutoMerge.mockResolvedValue({ success: true, alreadyQueued: false, error: null, status: 200 });

      await expect(service.sweep()).resolves.toEqual({
        due: true,
        candidates: 1,
        confirmed: 0,
        failed: 0,
        deferred: 0,
        reenqueued: 1,
        escalated: 0,
      });

      expect(mockFetchGitHubNodeId).toHaveBeenCalledWith("ghp_fetched", "paperclipai", "paperclip", 514);
      expect(mockEnableAutoMerge).toHaveBeenCalledWith("ghp_fetched", "PRNode_fetched");
    });

    it("re-examines and re-enqueues again on a later sweep while the cap is unexhausted (SUP-15073)", async () => {
      const state: DbState = {
        candidates: [candidateRow()],
        existingLandingRows: [],
        companyMergeArmingEnabled: true,
      };
      const { service } = makeService(state);
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        linkedPr({ number: 514, nodeId: "PRNode_abc123" }),
      ]);
      mockResolver(async () => openSnapshot);
      mockResolveGitHubTokenForRepo.mockResolvedValue({
        token: "ghp_tok",
        scope: "company",
        secretName: "github-token",
      });
      mockEnableAutoMerge.mockResolvedValue({ success: true, alreadyQueued: false, error: null, status: 200 });

      // First sweep re-enqueues (attempt 1).
      const first = await service.sweep();
      expect(first.reenqueued).toBe(1);
      expect(first.escalated).toBe(0);
      expect(mockEnableAutoMerge).toHaveBeenCalledTimes(1);

      // Second sweep: the PR was re-enqueued once but is still `open` (the queue
      // ejected it). The old code skipped it forever (alreadyReenqueued); now the
      // sweep re-examines and re-enqueues again, because the cap is unexhausted.
      state.existingLandingRows.push({
        action: "issue.done_close_landing_reenqueued",
        details: { pr: "paperclipai/paperclip#514" },
      });
      const second = await service.sweep();
      expect(second.reenqueued).toBe(1);
      expect(second.escalated).toBe(0);
      expect(mockEnableAutoMerge).toHaveBeenCalledTimes(2);
      // Still under the cap: no escalation, no block.
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("escalates instead of re-enqueuing once the cap is exhausted and the PR is still open (SUP-15073)", async () => {
      const wakeup = vi.fn().mockResolvedValue({ id: "wake" });
      // Pre-seed the cap's worth of prior re-enqueue rows: the PR has already
      // been re-enqueued MAX times and is back to `open` (ejected) each time.
      const priorRows = Array.from({ length: MAX_REENQUEUE_ATTEMPTS }, () => ({
        action: "issue.done_close_landing_reenqueued",
        details: { pr: "paperclipai/paperclip#514" },
      }));
      const { service } = makeService(
        {
          candidates: [candidateRow()],
          existingLandingRows: priorRows,
          companyMergeArmingEnabled: true,
        },
        { wakeup },
      );
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        linkedPr({ number: 514, nodeId: "PRNode_abc123" }),
      ]);
      mockResolver(async () => openSnapshot);

      const result = await service.sweep();

      // Cap exhausted: NO re-enqueue attempt, and the sweep reaches _escalated
      // (the old skip returned deferred: 0 / escalated: 0 — permanently silent).
      expect(result).toEqual({
        due: true,
        candidates: 1,
        confirmed: 0,
        failed: 0,
        deferred: 0,
        reenqueued: 0,
        escalated: 1,
      });
      expect(mockEnableAutoMerge).not.toHaveBeenCalled();
      expect(mockLogActivity).toHaveBeenCalledTimes(1);
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "issue.done_close_landing_escalated",
        details: expect.objectContaining({
          pr: "paperclipai/paperclip#514",
          prState: "open",
          reason: expect.stringContaining("re-enqueued"),
        }),
      }));
      expect(mockUpdate).toHaveBeenCalledWith(ISSUE, expect.objectContaining({
        status: "blocked",
        unblockDescriptor: expect.objectContaining({
          owner: "board",
          action: expect.stringContaining("re-enqueued"),
        }),
      }));
      expect(mockAddComment).toHaveBeenCalledTimes(1);
      expect(wakeup).toHaveBeenCalledTimes(1);
    });

    it("still confirms when the PR merges after a prior re-enqueue (SUP-15073 AC4, no regression)", async () => {
      const { service } = makeService(
        {
          candidates: [candidateRow()],
          existingLandingRows: [
            { action: "issue.done_close_landing_reenqueued", details: { pr: "paperclipai/paperclip#514" } },
          ],
          companyMergeArmingEnabled: true,
        },
      );
      mockResolveLinkedPullRequestsWithState.mockResolvedValue([
        linkedPr({ number: 514, nodeId: "PRNode_abc123" }),
      ]);
      mockResolver(async () => mergedSnapshot);

      const result = await service.sweep();

      // Merged after a re-enqueue → confirm path fires normally; the re-enqueue
      // count neither blocks it nor triggers a spurious escalate.
      expect(result).toEqual({
        due: true,
        candidates: 1,
        confirmed: 1,
        failed: 0,
        deferred: 0,
        reenqueued: 0,
        escalated: 0,
      });
      expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        action: "issue.done_close_landing_confirmed",
      }));
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockEnableAutoMerge).not.toHaveBeenCalled();
    });
  });
});
