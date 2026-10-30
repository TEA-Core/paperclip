import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  externalObjectMentions,
  externalObjects,
  issueComments,
  issueExecutionDecisions,
  issueThreadInteractions,
  issues,
  projectWorkspaces,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { disarmTiming, resumePendingAutoMergeDisarms, retryPendingAutoMergeDisarms } from "./auto-merge-disarm.js";
import { runApprovalStatusReconcilerTick } from "./approval-status-reconciler.js";
import { GITHUB_APP_PRIVATE_KEY_SECRET_NAME, GITHUB_TOKEN_SECRET_NAMES } from "./github-credential.js";
import {
  armMergeOnApproval,
  createAuthorityGuard,
  disarmBacklog,
  disarmEscalation,
  openArmInFlight,
  openArmRecord,
  disableAutoMerge,
  enableAutoMerge,
  enableTiming,
  ENABLE_ATTEMPT_TIMEOUT_MS,
  ENABLE_WORST_CASE_MS,
  fetchBranchHeadSha,
  fetchGitHubNodeId,
  fetchHeadApprovedStatusViaTokenCandidates,
  fetchOpenPullRequests,
  isTransientHttpStatus,
  isTransientReadStatus,
  ladderIncompleteStageIds,
  ladderIsTerminallyApproved,
  pickMostRecentMergeQueueEjection,
  narrowToDelivered,
  preflightFinalDelivery,
  publishApprovalStatus,
  recordApprovalAnchor,
  recordPendingAutoMergeDisarm,
  recordApprovalPublishOutcome,
  resolveApprovalDecisionHead,
  resolveCardDeliveryBranchOwnership,
  resolveCardPullRequest,
  resolveLinkedPullRequests,
  resolveLinkedPullRequestsWithState,
  writeCommitStatusWithRetry,
  withTransientReadRetry,
  type NoPrBranchAnchor,
} from "./merge-arming.js";
// SUP-16140 (relocation of the SUP-16081 fix #2 route-level guard regression from
// the now-deleted server/src/__tests__/merge-arming-guard-outcome.test.ts): the
// guard-outcome suite drives the POST /issues/:id/execution-stage/board-decision
// route (which calls runApprovalMergeArming post-commit), so it needs the route
// harness. These imports are used only by that suite.
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const mockResolveSecretValue = vi.hoisted(() => vi.fn());
const mockGetByName = vi.hoisted(() => vi.fn());
const mockGhFetch = vi.hoisted(() => vi.fn());
// The arm gate (a `paperclip/arm-gate` status the control plane writes before every enable and closes when the arm is settled)
// is answered here, apart from the per-test GitHub fakes: by default GitHub accepts it, and a test that needs it refused, slow
// or recorded sets `answer`. Every write is kept in `writes`, in order.
const armGateFake = vi.hoisted(() => {
  const created = () => ({ ok: true, status: 201, json: async () => ({ id: 9000 }) }) as unknown as Response;
  return {
    created,
    writes: [] as Array<{ url: string; state: string; description: string; context: string; accepted: boolean }>,
    answer: created as (body: { state: string; description: string; context: string }) => Response | Promise<Response>,
  };
});

vi.mock("./secrets.js", () => ({
  secretService: () => ({
    getByName: mockGetByName,
    resolveSecretValue: mockResolveSecretValue,
  }),
}));

vi.mock("./github-fetch.js", () => ({
  ghFetch: (url: string, init?: RequestInit) => {
    if (typeof url === "string" && /\/statuses\//.test(url) && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { state: string; description: string; context: string };
      if (body.context === "paperclip/arm-gate") {
        return Promise.resolve(armGateFake.answer(body)).then((response) => {
          armGateFake.writes.push({ url, state: body.state, description: body.description, context: body.context, accepted: response.ok });
          return response;
        });
      }
    }
    // An arm that names no head reads the PR's live head for the arm gate; a test whose fake does not model that read gets one.
    return Promise.resolve(mockGhFetch(url, init)).catch((error: unknown) => {
      if (typeof url === "string" && /\/pulls\/\d+$/.test(url) && /unmocked|unexpected/i.test(String((error as Error)?.message))) {
        return { ok: true, status: 200, json: async () => ({ head: { sha: "c".repeat(40), ref: "live-head" }, state: "open", draft: false, merged: false }) } as unknown as Response;
      }
      throw error;
    });
  },
  gitHubApiBase: (hostname: string) =>
    hostname === "github.com" ? "https://api.github.com" : `https://${hostname}/api/v3`,
}));

// SUP-16140 (relocation): the guard-outcome route suite drives runApprovalMergeArming
// (in routes/issues.ts) with a controlled evaluateStageIntegrity and, for the
// anchor-before-publish cases, stubs resolveApprovalDecisionHead /
// publishApprovalStatus while keeping the REAL recordApprovalAnchor and
// recordApprovalPublishOutcome. This file's OWN tests call the REAL
// resolveApprovalDecisionHead / publishApprovalStatus, so every override below is
// gated on `guardRouteControl.active` (false by default, true only inside the
// guard-outcome suite) and delegates to the real export otherwise — a single file,
// two mock postures, no test sees the wrong one.
const guardRouteControl = vi.hoisted(() => ({
  active: false,
  stageIntegrity: "pass" as "pass" | "finding" | "throw",
  publishMode: "fail" as "fail" | "throw" | "armed",
  // SUP-17163: the escape-hatch door suites drive a full arm by stubbing the
  // publish as `armed` and the actuator as a controlled ArmingOutcome. The
  // publishMode "fail"/"throw" cases never reach the actuator, so the actuator
  // stub is inert for the pre-existing guard-outcome tests.
  armMode: "armed" as "armed" | "skipped" | "failed",
  headSha: "approved00000000000000000000000000000000001",
}));

vi.mock("./approval-status-reconciler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./approval-status-reconciler.js")>();
  return {
    ...actual,
    evaluateStageIntegrity: (
      ...args: Parameters<typeof actual.evaluateStageIntegrity>
    ) => {
      if (!guardRouteControl.active) {
        return actual.evaluateStageIntegrity(...args);
      }
      if (guardRouteControl.stageIntegrity === "throw") {
        return Promise.reject(new Error("injected stage-integrity guard exception"));
      }
      if (guardRouteControl.stageIntegrity === "finding") {
        return Promise.resolve({
          reason: "guard-c:test-finding",
          detail: "injected stage-integrity finding",
        });
      }
      return Promise.resolve(null);
    },
  };
});

vi.mock("./merge-arming.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./merge-arming.js")>();
  return {
    ...actual,
    // Guard-outcome fixtures certify their controlled delivery before exercising
    // post-commit failures. Real preflight behavior is covered by the route suite.
    preflightFinalDelivery: (...args: Parameters<typeof actual.preflightFinalDelivery>) =>
      guardRouteControl.active
        ? Promise.resolve({
            kind: "resolved" as const,
            headSha: guardRouteControl.headSha,
            displayName: "TEA-Core/paperclip#448",
            pr: { owner: "TEA-Core", repo: "paperclip", number: 448 },
          })
        : actual.preflightFinalDelivery(...args),
    resolveApprovalDecisionHead: (
      ...args: Parameters<typeof actual.resolveApprovalDecisionHead>
    ) =>
      guardRouteControl.active
        ? Promise.resolve({
            kind: "resolved" as const,
            headSha: guardRouteControl.headSha,
            displayName: "TEA-Core/paperclip#448",
            pr: { owner: "TEA-Core", repo: "paperclip", number: 448 },
          })
        : actual.resolveApprovalDecisionHead(...args),
    publishApprovalStatus: (
      ...args: Parameters<typeof actual.publishApprovalStatus>
    ) =>
      guardRouteControl.active
        ? guardRouteControl.publishMode === "throw"
          ? Promise.reject(new Error("injected first-publish exception"))
          : guardRouteControl.publishMode === "armed"
            ? Promise.resolve({
                kind: "armed" as const,
                message: "status:published: approved head stamped",
                headSha: guardRouteControl.headSha,
                certifiedPr: null,
              } as unknown as ReturnType<typeof actual.publishApprovalStatus>)
            : Promise.resolve({
                kind: "failed" as const,
                message:
                  "status:failed:scope_missing: HTTP 403 Resource not accessible by integration",
                headSha: guardRouteControl.headSha,
              } as unknown as ReturnType<typeof actual.publishApprovalStatus>)
        : actual.publishApprovalStatus(...args),
    // SUP-17163: the escape-hatch door suites stub the actuator so the wiring
    // (route -> runApprovalMergeArming -> armMergeOnApproval -> [Merge-arming]
    // comment + armOutcome) is provable without a live GitHub merge. The real
    // actuator is exercised by this file's D2A suite.
    armMergeOnApproval: (
      ...args: Parameters<typeof actual.armMergeOnApproval>
    ) =>
      guardRouteControl.active
        ? Promise.resolve({
            kind: guardRouteControl.armMode,
            message: `status:${guardRouteControl.armMode}: test actuator outcome`,
            headSha: guardRouteControl.headSha,
          } as unknown as Awaited<ReturnType<typeof actual.armMergeOnApproval>>)
        : actual.armMergeOnApproval(...args),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres merge-arming tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// SUP-15459: the ladder-terminality predicate gates every paperclip/approved
// write. It is pure (no I/O), so these run even where embedded Postgres is
// absent — no DB fixtures required.
beforeEach(() => { armGateFake.writes.length = 0; armGateFake.answer = armGateFake.created; });

describe("ladderIsTerminallyApproved", () => {
  const A = "stage-a";
  const B = "stage-b";
  const policy = { stages: [{ id: A }, { id: B }] };

  it("is true when every policy stage is completed and the last outcome is approved", () => {
    expect(
      ladderIsTerminallyApproved(policy, { completedStageIds: [A, B], lastDecisionOutcome: "approved" }),
    ).toBe(true);
  });

  it("is false when a policy stage is not yet completed (the mid-ladder shape)", () => {
    expect(
      ladderIsTerminallyApproved(policy, { completedStageIds: [A], lastDecisionOutcome: "approved" }),
    ).toBe(false);
  });

  it("allows publication after pre-merge approval while a post-merge stage is pending", () => {
    const phasedPolicy = { stages: [{ id: A }, { id: B, phase: "post_merge" as const }] };
    expect(
      ladderIsTerminallyApproved(phasedPolicy, { completedStageIds: [A], lastDecisionOutcome: "approved" }),
    ).toBe(true);
  });

  it("lists only incomplete pre-merge stages in refusal diagnostics", () => {
    const phasedPolicy = { stages: [{ id: A }, { id: B, phase: "post_merge" as const }, { id: "stage-c" }] };
    expect(ladderIncompleteStageIds(phasedPolicy, { completedStageIds: [A] })).toEqual(["stage-c"]);
    expect(ladderIncompleteStageIds(phasedPolicy, { completedStageIds: [A, "stage-c"] })).toEqual([]);
  });

  it("still requires every explicit or implicit pre-merge stage", () => {
    const phasedPolicy = {
      stages: [{ id: A, phase: "pre_merge" as const }, { id: B, phase: "post_merge" as const }, { id: "stage-c" }],
    };
    expect(
      ladderIsTerminallyApproved(phasedPolicy, { completedStageIds: [A, B], lastDecisionOutcome: "approved" }),
    ).toBe(false);
  });

  it("does not publish a phased ladder after changes are requested", () => {
    const phasedPolicy = { stages: [{ id: A }, { id: B, phase: "post_merge" as const }] };
    expect(
      ladderIsTerminallyApproved(phasedPolicy, { completedStageIds: [A], lastDecisionOutcome: "changes_requested" }),
    ).toBe(false);
  });

  it("replays the SUP-15163 4-stage shape: stage-1 of 4 approved is NOT terminally approved; all four complete + approved IS", () => {
    // The exact executed-instance shape from the card: a 4-stage policy where
    // only stage 1 (the support-CR review) is complete and approved. That is the
    // mid-ladder stamp that armed and merged TSP PR #3484 at stage 1/4.
    const s1 = "stage-1";
    const s2 = "stage-2";
    const s3 = "stage-3";
    const s4 = "stage-4";
    const fourStagePolicy = { stages: [{ id: s1 }, { id: s2 }, { id: s3 }, { id: s4 }] };

    // Mid-ladder: completedStageIds length 1, last outcome approved -> refuse.
    expect(
      ladderIsTerminallyApproved(fourStagePolicy, {
        completedStageIds: [s1],
        lastDecisionOutcome: "approved",
      }),
    ).toBe(false);

    // Terminal: all four ids completed and last outcome approved -> stamp + arm.
    expect(
      ladderIsTerminallyApproved(fourStagePolicy, {
        completedStageIds: [s1, s2, s3, s4],
        lastDecisionOutcome: "approved",
      }),
    ).toBe(true);
  });

  it("is false when the last decision outcome is not approved, even with all stages completed", () => {
    expect(
      ladderIsTerminallyApproved(policy, {
        completedStageIds: [A, B],
        lastDecisionOutcome: "changes_requested",
      }),
    ).toBe(false);
  });

  it("treats a null/empty policy as vacuously complete, so the outcome decides", () => {
    expect(ladderIsTerminallyApproved(null, { lastDecisionOutcome: "approved" })).toBe(true);
    expect(ladderIsTerminallyApproved({ stages: [] }, { lastDecisionOutcome: "approved" })).toBe(true);
    expect(ladderIsTerminallyApproved(null, { lastDecisionOutcome: "changes_requested" })).toBe(false);
  });

  it("is false when the state is null/undefined or lacks an approved outcome for a declared policy", () => {
    expect(ladderIsTerminallyApproved(policy, null)).toBe(false);
    expect(ladderIsTerminallyApproved(policy, undefined)).toBe(false);
    expect(ladderIsTerminallyApproved(policy, { completedStageIds: [A, B] })).toBe(false);
    expect(ladderIsTerminallyApproved(undefined, undefined)).toBe(false);
  });
});

// SUP-16081 fix #2: the transient-vs-deterministic split for a failed status write
// is a pure predicate (no I/O), so it runs even where embedded Postgres is absent.
// The transient class is the ONLY class that is ever retried: no response
// (status 0 = the request never reached GitHub), request-timeout (408),
// rate-limited (429), and any 5xx server error. Every other 4xx is a
// deterministic refusal — the same request will refuse again — and must NOT be
// retried.
describe("isTransientHttpStatus", () => {
  it("treats no-response (0), 408, 429, and 5xx as transient", () => {
    expect(isTransientHttpStatus(0)).toBe(true);
    expect(isTransientHttpStatus(408)).toBe(true);
    expect(isTransientHttpStatus(429)).toBe(true);
    expect(isTransientHttpStatus(500)).toBe(true);
    expect(isTransientHttpStatus(502)).toBe(true);
    expect(isTransientHttpStatus(503)).toBe(true);
    expect(isTransientHttpStatus(599)).toBe(true);
  });

  it("treats every deterministic 4xx and 2xx/3xx as non-transient", () => {
    // 403 scope_missing and 422 shape refusal are the canonical operator signals.
    expect(isTransientHttpStatus(403)).toBe(false);
    expect(isTransientHttpStatus(422)).toBe(false);
    // Other deterministic client errors: a bad head, missing scope, a 404 ref.
    expect(isTransientHttpStatus(400)).toBe(false);
    expect(isTransientHttpStatus(401)).toBe(false);
    expect(isTransientHttpStatus(404)).toBe(false);
    // Success / redirect statuses are not the "failed write" class at all.
    expect(isTransientHttpStatus(200)).toBe(false);
    expect(isTransientHttpStatus(301)).toBe(false);
    // The 5xx band has a hard upper bound.
    expect(isTransientHttpStatus(600)).toBe(false);
  });
});

// SUP-17273: the READ-path transient class is narrower than the write-path one —
// it retries a network error (0) and 5xx ONLY, and treats every 4xx (incl. 429)
// as deterministic. AC2: deterministic statuses are NOT retried.
describe("isTransientReadStatus", () => {
  it("treats only no-response (0) and the gateway allowlist (500/502/503/504) as transient", () => {
    expect(isTransientReadStatus(0)).toBe(true);
    expect(isTransientReadStatus(500)).toBe(true);
    expect(isTransientReadStatus(502)).toBe(true);
    expect(isTransientReadStatus(503)).toBe(true);
    expect(isTransientReadStatus(504)).toBe(true);
  });

  it("treats every 4xx (incl. 401/403/404/429), 2xx/3xx, and non-allowlisted 5xx as deterministic", () => {
    expect(isTransientReadStatus(401)).toBe(false);
    expect(isTransientReadStatus(403)).toBe(false);
    expect(isTransientReadStatus(404)).toBe(false);
    expect(isTransientReadStatus(429)).toBe(false);
    expect(isTransientReadStatus(408)).toBe(false);
    expect(isTransientReadStatus(400)).toBe(false);
    expect(isTransientReadStatus(200)).toBe(false);
    expect(isTransientReadStatus(301)).toBe(false);
    // Non-allowlisted 5xx are deterministic: a short retry cannot clear them.
    expect(isTransientReadStatus(501)).toBe(false);
    expect(isTransientReadStatus(505)).toBe(false);
    expect(isTransientReadStatus(599)).toBe(false);
    expect(isTransientReadStatus(600)).toBe(false);
  });
});

// SUP-17273: the bounded transient retry wrapper that the head/PR resolution
// reads are wrapped in. Pure (no I/O) — `fetchOnce` and `delay` are injected.
describe("withTransientReadRetry (SUP-17273)", () => {
  it("AC1: transient-then-success — retries the transient read and returns the success", async () => {
    let calls = 0;
    const fetchOnce = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 500, message: "server exploded" };
      return { ok: true, status: 200, message: null };
    });

    const result = await withTransientReadRetry(fetchOnce, { delay: async () => {} });

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("AC1: a network error (status 0) is also retried to success", async () => {
    let calls = 0;
    const fetchOnce = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 0, message: "network_error" };
      return { ok: true, status: 200, message: null };
    });

    const result = await withTransientReadRetry(fetchOnce, { delay: async () => {} });

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("AC3: transient-exhausted — retries to the attempt bound, returns the last transient result", async () => {
    let calls = 0;
    const fetchOnce = vi.fn(async () => {
      calls += 1;
      return { ok: false, status: 503, message: "unavailable" };
    });

    const result = await withTransientReadRetry(fetchOnce, { attempts: 3, delay: async () => {} });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(calls).toBe(3);
  });

  it("AC2: deterministic-4xx-not-retried — a 404 returns after the first attempt", async () => {
    let calls = 0;
    const fetchOnce = vi.fn(async () => {
      calls += 1;
      return { ok: false, status: 404, message: "Not Found" };
    });

    const result = await withTransientReadRetry(fetchOnce, { attempts: 3, delay: async () => {} });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    // Operator signal: exactly one attempt, never retried.
    expect(calls).toBe(1);
  });
});

// SUP-17273 findings approval-node-id-read-unretried /
// approval-live-pr-discovery-unretried / approval-branch-head-read-unretried: the
// remaining approval-time head/PR resolution reads are each wrapped in
// withTransientReadRetry. These Postgres-free leaf tests prove the wrapper is
// actually WIRED to each read — a transient 5xx is retried on the SAME token
// (2 attempts for transient-then-success), while a deterministic 4xx returns
// after exactly one attempt. (The wrapper's own AC logic is covered above; this
// covers the leaf<->wrapper wiring the findings called out.)
describe("approval-time read retry wiring (SUP-17273)", () => {
  beforeEach(() => {
    mockGhFetch.mockReset();
  });

  it("fetchGitHubNodeId: retries a transient 503 to success on the same token", async () => {
    mockGhFetch
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ node_id: "PR_node_id_abc" }),
      } as unknown as Response);

    const result = await fetchGitHubNodeId("tok", "owner", "repo", 42);

    expect(result.ok).toBe(true);
    expect(result.nodeId).toBe("PR_node_id_abc");
    expect(mockGhFetch).toHaveBeenCalledTimes(2);
  });

  it("fetchGitHubNodeId: does not retry a deterministic 404", async () => {
    mockGhFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ message: "Not Found" }),
    } as unknown as Response);

    const result = await fetchGitHubNodeId("tok", "owner", "repo", 42);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(mockGhFetch).toHaveBeenCalledTimes(1);
  });

  it("fetchOpenPullRequests: retries a transient 502 to success on the same token", async () => {
    mockGhFetch
      .mockResolvedValueOnce({ ok: false, status: 502, json: async () => ({}) } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [{ number: 42, draft: false, head: { ref: "b" }, title: "t", body: "b" }],
      } as unknown as Response);

    const result = await fetchOpenPullRequests("tok", "owner", "repo");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items).toHaveLength(1);
    expect(mockGhFetch).toHaveBeenCalledTimes(2);
  });

  it("fetchOpenPullRequests: does not retry a deterministic 404", async () => {
    mockGhFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ message: "Not Found" }),
    } as unknown as Response);

    const result = await fetchOpenPullRequests("tok", "owner", "repo");

    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(mockGhFetch).toHaveBeenCalledTimes(1);
  });

  it("fetchBranchHeadSha: retries a transient 503 to success on the same token", async () => {
    mockGhFetch
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ object: { sha: "abc123def" } }),
      } as unknown as Response);

    const result = await fetchBranchHeadSha("tok", "owner", "repo", "SUP-42/branch");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.headSha).toBe("abc123def");
    expect(mockGhFetch).toHaveBeenCalledTimes(2);
  });

  it("fetchBranchHeadSha: does not retry a deterministic 404", async () => {
    mockGhFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ message: "Not Found" }),
    } as unknown as Response);

    const result = await fetchBranchHeadSha("tok", "owner", "repo", "SUP-42/branch");

    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(mockGhFetch).toHaveBeenCalledTimes(1);
  });
});

// SUP-15953 / review finding `latest-ejection-invalid-timestamp-fail-open`:
// `pickMostRecentMergeQueueEjection` is pure (no I/O), so it runs even where
// embedded Postgres is absent — no DB fixtures required. GitHub returns
// `timelineItems(last:)` nodes chronologically (oldest first), so recency MUST
// be decided by array position. The regression: an OLDER readable event plus a
// NEWER unreadable one — the older event must NOT win.
describe("pickMostRecentMergeQueueEjection", () => {
  it("returns the last non-null node when every event is readable", () => {
    const nodes = [
      { reason: "failed_checks", createdAt: "2026-09-12T16:00:00Z", beforeCommit: { oid: "aaa" } },
      { reason: "merge_conflict", createdAt: "2026-09-12T17:04:36Z", beforeCommit: { oid: "f03a03ce" } },
    ];
    expect(pickMostRecentMergeQueueEjection(nodes)).toEqual({
      reason: "merge_conflict",
      createdAt: "2026-09-12T17:04:36Z",
      beforeCommitOid: "f03a03ce",
    });
  });

  // The review regression fixture: an OLDER readable event and a NEWER event
  // whose `createdAt` is malformed/missing (so the old `parsed || index` trick
  // gave the older event the win and re-enqueueed a merge_conflict head). The
  // newest event must win even though its timestamp is unreadable — that null
  // reason is what makes the caller fail closed (defer).
  it("picks the NEWER unreadable event, never an older readable one (fail closed)", () => {
    const nodes = [
      // Older, fully readable, valid epoch-ms timestamp (~1.7e12).
      {
        reason: "failed_checks",
        createdAt: "2026-09-12T16:07:16Z",
        beforeCommit: { oid: "older-head" },
      },
      // Newer, but malformed/missing `createdAt` and an unreadable reason —
      // recency must still come from array position, not from the older event's
      // valid timestamp.
      { reason: "", createdAt: "not-a-timestamp", beforeCommit: { oid: "newer-head" } },
    ];
    const picked = pickMostRecentMergeQueueEjection(nodes);
    // NOT the older `failed_checks`/`older-head` (that would be the fail-open bug);
    // the newer, unreadable event, so `reason === null` and the caller defers.
    expect(picked).toEqual({
      reason: null,
      createdAt: "not-a-timestamp",
      beforeCommitOid: "newer-head",
    });
  });

  it("picks a newest event with a missing reason and null beforeCommit", () => {
    const nodes = [
      { reason: "failed_checks", createdAt: "2026-09-12T16:00:00Z", beforeCommit: { oid: "aaa" } },
      { reason: null },
    ];
    expect(pickMostRecentMergeQueueEjection(nodes)).toEqual({
      reason: null,
      createdAt: null,
      beforeCommitOid: null,
    });
  });

  it("skips trailing null nodes and returns the most recent real ejection", () => {
    const nodes = [
      null,
      { reason: "merge_conflict", createdAt: "2026-09-12T17:04:36Z", beforeCommit: { oid: "f03a03ce" } },
      null,
    ];
    expect(pickMostRecentMergeQueueEjection(nodes)).toEqual({
      reason: "merge_conflict",
      createdAt: "2026-09-12T17:04:36Z",
      beforeCommitOid: "f03a03ce",
    });
  });

  it("returns null when there are no ejection nodes", () => {
    expect(pickMostRecentMergeQueueEjection([])).toBeNull();
    expect(pickMostRecentMergeQueueEjection([null, null])).toBeNull();
  });
});

const GITHUB_TOKEN = "ghp_test_token_value";
// The head the approving decision was rendered against (decision-time pin).
const APPROVED_HEAD = "approved00000000000000000000000000000000001";
// The head GitHub reports after a push lands between the decision and the write.
const LIVE_HEAD = "moved0000000000000000000000000000000000000004";
const OWNER = "TEA-Core";
const REPO = "paperclip";

const PR_URL = `https://api.github.com/repos/${OWNER}/${REPO}/pulls/42`;
const POST_STATUS_URL = (sha: string) =>
  `https://api.github.com/repos/${OWNER}/${REPO}/statuses/${sha}`;
// The shared live workspace re-resolve lists open PRs by identifier substring.
const OPEN_PRS_LIST_URL = `https://api.github.com/repos/${OWNER}/${REPO}/pulls?state=open&per_page=100`;
// SUP-15016: the no-pr delivery-branch ref read (GET .../git/refs/heads/SUP-42-branch).
const BRANCH_REF_URL = `https://api.github.com/repos/${OWNER}/${REPO}/git/refs/heads/SUP-42-branch`;
const BRANCH_HEAD = "branch000000000000000000000000000000000001";
function openPrsListItem(overrides: Record<string, unknown> = {}) {
  return {
    number: 455,
    draft: false,
    head: { ref: "SUP-42-branch" },
    title: "Unify PR resolution",
    body: "Closes SUP-42",
    ...overrides,
  };
}

function prHeadBody(sha: string, headRef = "SUP-42-branch") {
  return { state: "open", merged: false, head: { ref: headRef, sha } };
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

function postStatusShas(): string[] {
  return postStatusCalls().map((call) => {
    const url = String(call[0]);
    return url.split("/statuses/")[1]!;
  });
}

describeEmbeddedPostgres("adr-091-d2a decision-time head pin", () => {
  let db: Db;
  let companyId: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-merge-arming-d2a-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    vi.resetAllMocks();

    // Skip the app-installation path entirely (no private key), and resolve the
    // company-scope GITHUB_TOKEN the way a real deployment would.
    mockGetByName.mockImplementation(async (_companyId: string, name: string) => {
      if (name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME) return null;
      if ((GITHUB_TOKEN_SECRET_NAMES as readonly string[]).includes(name)) {
        return { id: "secret-1", name };
      }
      return null;
    });
    mockResolveSecretValue.mockResolvedValue(GITHUB_TOKEN);
    mockGhFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);

    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(companies);

    const companyRows = await db
      .insert(companies)
      .values({ name: "Test Company", issuePrefix: "SUP", mergeArmingEnabled: true })
      .returning();
    companyId = companyRows[0]!.id;
  });

  afterEach(async () => {
    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  async function insertIssue(
    overrides: {
      identifier?: string;
      deliveryIdentity?: boolean;
      /**
       * ADR-091 D1 (SUP-15909): the card's `parent_id`, used to build a genuine
       * strict-ancestor chain so a carrier owner (a strict ancestor of the card)
       * passes the ADR-083 carrier gate in resolveCardDeliveryBranchOwnership.
       */
      parentId?: string;
      /**
       * SUP-14783: make the card's execution-workspace row a `shared_workspace`
       * OWNED BY ANOTHER ISSUE, carrying that owner's branch — the shape every
       * TSP child card has. Default undefined leaves the row's sourceIssueId
       * null, which is the pre-existing fixture and must keep its verdicts.
       */
      sharedWorkspaceOwnerIssueId?: string;
      /**
       * ADR-091 D1 (SUP-15909): when true, a sharedWorkspaceOwnerIssueId owner is
       * NOT wired as the card's ancestor — the UNRELATED-owner laundering shape D1
       * must refuse. Default false: the owner is the card's parent (the real
       * ADR-083 carrier shape).
       */
      sharedWorkspaceOwnerUnrelated?: boolean;
      branchName?: string;
      delivery?: Record<string, unknown>;
    } = {},
  ) {
    const issueId = randomUUID();
    let projectId: string | null = null;
    let executionWorkspaceId: string | null = null;
    // Default: the card delivered on its own execution-workspace branch — the D1
    // delivery identity both the resolver and publishApprovalStatus narrow by.
    // Pass { deliveryIdentity: false } to exercise the fail-closed
    // delivery_identity_unresolved path.
    if (overrides.deliveryIdentity !== false) {
      const [projectRow] = await db
        .insert(projects)
        .values({
          id: randomUUID(),
          companyId,
          name: `${OWNER}/${REPO}`,
          status: "in_progress",
        })
        .returning();
      projectId = projectRow!.id;
      const [ewRow] = await db
        .insert(executionWorkspaces)
        .values({
          id: randomUUID(),
          companyId,
          projectId,
          mode: "isolated",
          strategyType: "git_worktree",
          name: "card-workspace",
          status: "active",
          branchName: overrides.branchName ?? "SUP-42-branch",
          repoUrl: `https://github.com/${OWNER}/${REPO}`,
          ...(overrides.sharedWorkspaceOwnerIssueId
            ? { mode: "shared_workspace", sourceIssueId: overrides.sharedWorkspaceOwnerIssueId }
            : {}),
        })
        .returning();
      executionWorkspaceId = ewRow!.id;
    }
    // ADR-091 D1 (SUP-15909): a shared-workspace owner is the real ADR-083 carrier
    // ancestor, so wire it as the card's parent by default (an explicit parentId
    // wins; sharedWorkspaceOwnerUnrelated opts out to model an unrelated owner).
    const ancestorParentId =
      overrides.parentId ??
      (overrides.sharedWorkspaceOwnerIssueId && !overrides.sharedWorkspaceOwnerUnrelated
        ? overrides.sharedWorkspaceOwnerIssueId
        : undefined);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test Issue",
      status: "in_review",
      identifier: overrides.identifier ?? "SUP-42",
      projectId,
      executionWorkspaceId,
      ...(overrides.delivery ? { executionState: { delivery: overrides.delivery } } : {}),
      ...(ancestorParentId ? { parentId: ancestorParentId } : {}),
    });

    return issueId;
  }

  async function insertMention(
    issueId: string,
    overrides: {
      state?: string | null;
      draft?: boolean;
      number?: number;
      headRefName?: string;
      baseRef?: string | null;
      owner?: string;
      repo?: string;
    } = {},
  ) {
    const number = overrides.number ?? 42;
    const owner = overrides.owner ?? OWNER;
    const repo = overrides.repo ?? REPO;
    const data: Record<string, unknown> = {
      state: overrides.state ?? "open",
      draft: overrides.draft ?? false,
      node_id: "PR_node_id_12345",
      head: { ref: overrides.headRefName ?? "SUP-42-branch" },
      ...(overrides.baseRef === undefined ? {} : { baseRef: overrides.baseRef }),
      title: `Fix thing (SUP-${number})`,
    };
    const [externalObj] = await db
      .insert(externalObjects)
      .values({
        companyId,
        providerKey: "github",
        objectType: "pull_request",
        externalId: `${owner}/${repo}#pull/${number}`,
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

  async function readApprovalStatus(issueId: string): Promise<Record<string, unknown> | null> {
    const rows = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(eq(issues.id, issueId));
    const execState = (rows[0]?.executionState ?? null) as Record<string, unknown> | null;
    const approvalStatus = execState?.approvalStatus as Record<string, unknown> | null | undefined;
    return approvalStatus ?? null;
  }

  // SUP-16081 fix #1: the first `paperclip/approved` publish outcome is now TOTAL.
  // After a closing transition the executionState.approvalStatus key is never
  // absent: `armed` keeps the success shape, and a `skipped`/`failed` outcome
  // leaves a named publishSkipped / publishFailure record carrying the
  // publisher's own refusal vocabulary and the attempted head. A thrown outcome
  // is caught in the route and recorded the same way (the exact hole SUP-16041
  // fell through).
  describe("SUP-16081 recordApprovalPublishOutcome (fix #1: total outcome record)", () => {
    it("AC1: a thrown first publish leaves a named publishFailure record; the key is never absent", async () => {
      const issueId = await insertIssue();
      // The exact call the route's catch-backstop makes when a throw escapes the
      // first-publish flow: a synthetic internal failure, no resolved head.
      await recordApprovalPublishOutcome(
        db,
        issueId,
        {},
        null,
        { kind: "failed", message: "status:failed:internal: boom" },
      );

      const approvalStatus = await readApprovalStatus(issueId);
      expect(approvalStatus).not.toBeNull();
      // The record is a named failure, not a dropped key.
      expect(approvalStatus!.publishFailure).toMatchObject({
        reason: "status:failed:internal: boom",
        headSha: null,
      });
      expect(typeof (approvalStatus!.publishFailure as Record<string, unknown>).at).toBe("string");
    });

    it("AC1: an armed outcome keeps the success shape (publishedHeadSha + publishedAt)", async () => {
      const issueId = await insertIssue();
      // A prior cycle left a stale publishedHeadSha; a resolved head must FRESHEN
      // the record so the stale anchor cannot survive a new certification.
      await db
        .update(issues)
        .set({
          executionState: {
            approvalStatus: { publishedHeadSha: "stale000000000000000000000000000000" },
          },
        })
        .where(eq(issues.id, issueId));

      await recordApprovalPublishOutcome(
        db,
        issueId,
        {},
        APPROVED_HEAD,
        { kind: "armed", message: "status:published: written to head", headSha: APPROVED_HEAD },
      );

      const approvalStatus = await readApprovalStatus(issueId);
      expect(approvalStatus!.publishedHeadSha).toBe(APPROVED_HEAD);
      expect(typeof approvalStatus!.publishedAt).toBe("string");
      // The positively-resolved head also writes the D-B anchor.
      expect(approvalStatus!.approvedHeadSha).toBe(APPROVED_HEAD);
      expect(typeof approvalStatus!.approvedAt).toBe("string");
      // No failure/skip record on a success.
      expect(approvalStatus!.publishFailure).toBeUndefined();
      expect(approvalStatus!.publishSkipped).toBeUndefined();
    });

    it.each(["failed", "armed"] as const)("preserves the live final-delivery binding after a %s first publish", async (kind) => {
      const issueId = await insertIssue();
      const finalDelivery = {
        owner: OWNER, repo: REPO, number: 42, headSha: APPROVED_HEAD,
        displayName: `${OWNER}/${REPO}#42`, decisionId: "decision-42",
      };
      await db.update(issues).set({
        executionState: { approvalStatus: { finalDelivery, publishedHeadSha: "stale-head" } },
      }).where(eq(issues.id, issueId));

      await recordApprovalPublishOutcome(db, issueId, {}, APPROVED_HEAD,
        kind === "failed"
          ? { kind, message: "status:failed:scope_missing" }
          : { kind, message: "status:published", headSha: APPROVED_HEAD });

      const approvalStatus = await readApprovalStatus(issueId);
      expect(approvalStatus?.finalDelivery).toEqual(finalDelivery);
      expect(approvalStatus?.approvedHeadSha).toBe(APPROVED_HEAD);
      expect(approvalStatus?.publishedHeadSha).toBe(kind === "armed" ? APPROVED_HEAD : undefined);
    });

    it("AC2: a named skip outcome persists its exact refusal reason + attempted head", async () => {
      const issueId = await insertIssue();
      const refusal = "status:skipped:not_delivered: branch mismatch";
      await recordApprovalPublishOutcome(db, issueId, {}, APPROVED_HEAD, {
        kind: "skipped",
        message: refusal,
      });

      const approvalStatus = await readApprovalStatus(issueId);
      // Reuses the publisher's refusal vocabulary verbatim — no second spelling.
      expect(approvalStatus!.publishSkipped).toMatchObject({
        reason: refusal,
        headSha: APPROVED_HEAD,
      });
      expect(typeof (approvalStatus!.publishSkipped as Record<string, unknown>).at).toBe("string");
    });

    it("AC2: a named failure outcome persists its exact refusal reason + attempted head", async () => {
      const issueId = await insertIssue();
      const refusal = "status:failed:scope_missing: HTTP 403 Resource not accessible by integration";
      await recordApprovalPublishOutcome(db, issueId, {}, APPROVED_HEAD, {
        kind: "failed",
        message: refusal,
      });

      const approvalStatus = await readApprovalStatus(issueId);
      expect(approvalStatus!.publishFailure).toMatchObject({
        reason: refusal,
        headSha: APPROVED_HEAD,
      });
      // A resolved head that then failed still writes the D-B anchor for recovery.
      expect(approvalStatus!.approvedHeadSha).toBe(APPROVED_HEAD);
    });

    it("AC2: an unresolvable skip with pendingCandidates persists the recovery anchors", async () => {
      const issueId = await insertIssue();
      const candidates = [
        { owner: OWNER, repo: REPO, number: 42, headShaAtApproval: APPROVED_HEAD },
      ];
      const refusal = "status:skipped:ambiguous: Multiple linked PRs (2)";
      await recordApprovalPublishOutcome(db, issueId, {}, null, {
        kind: "skipped",
        message: refusal,
      }, candidates);

      const approvalStatus = await readApprovalStatus(issueId);
      expect(approvalStatus!.publishSkipped).toMatchObject({ reason: refusal, headSha: null });
      // No head resolved -> the ambiguous recovery anchors are persisted so the
      // reconciler can later re-run Guard A once the duplicate closes.
      expect(approvalStatus!.skipReason).toBe(refusal);
      expect(Array.isArray(approvalStatus!.pendingCandidates)).toBe(true);
      expect((approvalStatus!.pendingCandidates as unknown[]).length).toBe(1);
      expect(typeof approvalStatus!.certifiedAt).toBe("string");
    });

    // SUP-16081 stage-3 finding (publish-outcome-root-state-lost-update): the
    // record is written atomically against the LIVE approvalStatus subtree, so a
    // stale client snapshot passed by the route can no longer clobber the card's
    // root executionState keys (monitor, currentStageId, completedStageIds,
    // pendingSince) or a concurrent approvalStatus field. The previous
    // SELECT-then-whole-row UPDATE rebuilt the whole column from that snapshot
    // and dropped every root key the snapshot lacked.
    it("stage-3: a stale-snapshot outcome write preserves the live root executionState keys (no lost update)", async () => {
      const issueId = await insertIssue();
      // The card already carries live root keys + a concurrent approvalStatus
      // field committed AFTER the route captured its snapshot.
      await db
        .update(issues)
        .set({
          executionState: {
            currentStageId: "stage-3",
            completedStageIds: ["stage-1", "stage-2"],
            monitor: { armed: true, nextCheckAt: "2026-09-13T10:29:00.000Z" },
            pendingSince: "2026-09-13T10:28:00.000Z",
            approvalStatus: {
              backfillRefusal: { reason: "head_moved" },
            },
          },
        })
        .where(eq(issues.id, issueId));

      // The route's stale client snapshot — captured before that commit, so it
      // carries NONE of the root keys and NONE of the concurrent approvalStatus
      // field. This is the exact interleaving that clobbered state on the old
      // whole-row shape.
      const staleSnapshot: Record<string, unknown> = {};

      await recordApprovalPublishOutcome(db, issueId, staleSnapshot, null, {
        kind: "skipped",
        message: "status:skipped:not_delivered: branch mismatch",
      });

      const rows = await db
        .select({ executionState: issues.executionState })
        .from(issues)
        .where(eq(issues.id, issueId));
      const execState = rows[0]?.executionState as Record<string, unknown>;
      const approvalStatus = execState.approvalStatus as Record<string, unknown>;

      // The named outcome record is present (the record stays total).
      expect(approvalStatus.publishSkipped).toMatchObject({
        reason: "status:skipped:not_delivered: branch mismatch",
        headSha: null,
      });
      // The concurrently-committed approvalStatus field survives the merge.
      expect(approvalStatus.backfillRefusal).toMatchObject({ reason: "head_moved" });
      // No anchor on an unresolvable outcome.
      expect(approvalStatus.approvedHeadSha).toBeUndefined();
      // Every live root key SURVIVES the outcome write — the assertion the old
      // whole-row shape fails (it rebuilt the column from the empty snapshot).
      expect(execState.currentStageId).toBe("stage-3");
      expect(execState.completedStageIds).toEqual(["stage-1", "stage-2"]);
      expect(execState.monitor).toMatchObject({ armed: true });
      expect(execState.pendingSince).toBe("2026-09-13T10:28:00.000Z");
    });

    it("stage-3: a stale-snapshot RESOLVED-head write freshens the subtree but preserves the live root keys", async () => {
      const issueId = await insertIssue();
      await db
        .update(issues)
        .set({
          executionState: {
            currentStageId: "stage-4",
            monitor: { armed: true, nextCheckAt: "2026-09-13T10:30:00.000Z" },
            approvalStatus: { publishedHeadSha: "stale000000000000000000000000000000" },
          },
        })
        .where(eq(issues.id, issueId));

      // A positively-resolved head (post-publish armed record) with a stale
      // snapshot that carries no root keys.
      await recordApprovalPublishOutcome(
        db,
        issueId,
        {},
        APPROVED_HEAD,
        { kind: "armed", message: "status:published: written to head", headSha: APPROVED_HEAD },
      );

      const rows = await db
        .select({ executionState: issues.executionState })
        .from(issues)
        .where(eq(issues.id, issueId));
      const execState = rows[0]?.executionState as Record<string, unknown>;
      const approvalStatus = execState.approvalStatus as Record<string, unknown>;

      // A resolved head FRESHENS the subtree: the success shape + anchor are
      // written, and the stale prior publishedHeadSha does not survive.
      expect(approvalStatus.publishedHeadSha).toBe(APPROVED_HEAD);
      expect(approvalStatus.approvedHeadSha).toBe(APPROVED_HEAD);
      expect(approvalStatus.publishFailure).toBeUndefined();
      // The live root keys still survive the freshen (only the subtree is replaced).
      expect(execState.currentStageId).toBe("stage-4");
      expect(execState.monitor).toMatchObject({ armed: true });
    });
  });

  // SUP-16081 (comment a78bf2d2): the approval anchor must be written BEFORE the
  // publish attempt. recordApprovalAnchor is the pre-publish writer: it
  // merge-writes approvedHeadSha + approvedAt onto the card's approvalStatus,
  // preserving every concurrent field, so a dropped/throwing publish still leaves
  // a real anchor both recovery paths (backfill D-B fallback,
  // merge-arming/republish) can run.
  describe("SUP-16081 recordApprovalAnchor (a78bf2d2: anchor before publish)", () => {
    it("writes approvedHeadSha + approvedAt when approvalStatus is absent", async () => {
      const issueId = await insertIssue();
      await recordApprovalAnchor(db, issueId, APPROVED_HEAD);

      const approvalStatus = await readApprovalStatus(issueId);
      expect(approvalStatus).not.toBeNull();
      expect(approvalStatus!.approvedHeadSha).toBe(APPROVED_HEAD);
      expect(typeof approvalStatus!.approvedAt).toBe("string");
    });

    it("merge-writes the anchor, preserving concurrent fields (never clobbers)", async () => {
      const issueId = await insertIssue();
      await db
        .update(issues)
        .set({
          executionState: {
            approvalStatus: {
              publishedHeadSha: "stale000000000000000000000000000000",
              backfillRefusal: { reason: "head_moved" },
            },
          },
        })
        .where(eq(issues.id, issueId));

      await recordApprovalAnchor(db, issueId, APPROVED_HEAD);

      const approvalStatus = await readApprovalStatus(issueId);
      expect(approvalStatus!.approvedHeadSha).toBe(APPROVED_HEAD);
      expect(typeof approvalStatus!.approvedAt).toBe("string");
      // Concurrent fields survive the anchor write.
      expect(approvalStatus!.publishedHeadSha).toBe("stale000000000000000000000000000000");
      expect(approvalStatus!.backfillRefusal).toMatchObject({ reason: "head_moved" });
    });

    it("is idempotent: a second call rewrites the same anchor without error", async () => {
      const issueId = await insertIssue();
      await recordApprovalAnchor(db, issueId, APPROVED_HEAD);
      await recordApprovalAnchor(db, issueId, APPROVED_HEAD);

      const approvalStatus = await readApprovalStatus(issueId);
      expect(approvalStatus!.approvedHeadSha).toBe(APPROVED_HEAD);
      expect(typeof approvalStatus!.approvedAt).toBe("string");
    });

    // SUP-16141 (finding prepublish-anchor-lost-update): the anchor write must be
    // a live-subtree merge, not a stale read-modify-write. A concurrent writer
    // that commits a publishFailure between the anchor's read and write must
    // survive; a SELECT-then-whole-row UPDATE clobbers it. The hook below makes
    // the anchor's SELECT return the pre-concurrent snapshot while the live row
    // already carries the field — the deterministic interleaving the embedded
    // Postgres suite distinguishes.
    it("SUP-16141: a concurrent publishFailure committed after the anchor's read survives the atomic merge (no lost update)", async () => {
      const issueId = await insertIssue();

      // The card starts with no executionState. A concurrent writer (a failed
      // publish outcome / the reconciler) commits a live publishFailure.
      await db
        .update(issues)
        .set({
          executionState: {
            approvalStatus: {
              publishFailure: {
                reason: "status:failed:scope_missing",
                headSha: APPROVED_HEAD,
                at: "2026-09-13T10:28:39.441Z",
              },
            },
          },
        })
        .where(eq(issues.id, issueId));

      // Deterministic stale-read hook: the anchor's SELECT returns the snapshot
      // captured BEFORE that commit (an empty executionState), exactly as a
      // pre-concurrent SELECT would have. Everything else routes to the real db,
      // so the anchor's write still lands on the live row.
      const frozenPreConcurrentExecutionState: Record<string, unknown> = {};
      const hookDb = new Proxy(db, {
        get(target, prop) {
          if (prop === "select") {
            return () => ({
              from: () => ({
                where: () => ({
                  limit: () =>
                    Promise.resolve([{ executionState: frozenPreConcurrentExecutionState }]),
                }),
              }),
            });
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      await recordApprovalAnchor(hookDb, issueId, APPROVED_HEAD);

      const approvalStatus = await readApprovalStatus(issueId);
      // The new anchor is written on top of the concurrent field.
      expect(approvalStatus!.approvedHeadSha).toBe(APPROVED_HEAD);
      expect(typeof approvalStatus!.approvedAt).toBe("string");
      // The concurrent field SURVIVES — no lost update. This is the assertion a
      // SELECT-then-whole-row implementation fails: it would clobber the field
      // with the stale snapshot.
      expect(approvalStatus!.publishFailure).toMatchObject({
        reason: "status:failed:scope_missing",
        headSha: APPROVED_HEAD,
      });
    });
  });

  // SUP-16081 fix #2: a transient GitHub status-write failure is retried; a
  // deterministic refusal is not.
  describe("SUP-16081 writeCommitStatusWithRetry (fix #2: transient retry)", () => {
    it("AC3: a transient status-write failure (500) is retried and succeeds on the retry", async () => {
      let statusPosts = 0;
      mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/statuses") && init?.method === "POST") {
          statusPosts += 1;
          if (statusPosts === 1) {
            return {
              ok: false,
              status: 500,
              json: async () => ({ message: "server exploded" }),
            } as unknown as Response;
          }
          return { ok: true, status: 201, json: async () => ({}) } as unknown as Response;
        }
        throw new Error(`unmocked ghFetch URL: ${String(url)}`);
      });

      const result = await writeCommitStatusWithRetry(
        GITHUB_TOKEN,
        OWNER,
        REPO,
        APPROVED_HEAD,
        "SUP-42",
        { delay: async () => {} },
      );

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
      expect(statusPosts).toBe(2);
    });

    it("AC3: a deterministic refusal (403 scope_missing) is NOT retried", async () => {
      let statusPosts = 0;
      mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/statuses") && init?.method === "POST") {
          statusPosts += 1;
          return {
            ok: false,
            status: 403,
            json: async () => ({ message: "Resource not accessible by integration" }),
          } as unknown as Response;
        }
        throw new Error(`unmocked ghFetch URL: ${String(url)}`);
      });

      const result = await writeCommitStatusWithRetry(
        GITHUB_TOKEN,
        OWNER,
        REPO,
        APPROVED_HEAD,
        "SUP-42",
        { delay: async () => {} },
      );

      expect(result.success).toBe(false);
      expect(result.transient).toBe(false);
      expect(result.attempts).toBe(1);
      expect(result.error ?? "").toContain("scope_missing");
      // Operator signal: exactly one attempt, never retried.
      expect(statusPosts).toBe(1);
    });

    it("AC3: a transient failure is retried up to the attempt bound, then reported transient", async () => {
      let statusPosts = 0;
      mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/statuses") && init?.method === "POST") {
          statusPosts += 1;
          return {
            ok: false,
            status: 503,
            json: async () => ({ message: "unavailable" }),
          } as unknown as Response;
        }
        throw new Error(`unmocked ghFetch URL: ${String(url)}`);
      });

      const result = await writeCommitStatusWithRetry(
        GITHUB_TOKEN,
        OWNER,
        REPO,
        APPROVED_HEAD,
        "SUP-42",
        { attempts: 3, delay: async () => {} },
      );

      expect(result.success).toBe(false);
      expect(result.transient).toBe(true);
      expect(result.attempts).toBe(3);
      expect(statusPosts).toBe(3);
    });

    it("AC3: a transient status-write inside publishApprovalStatus is retried and arms", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId);
      let statusPosts = 0;
      mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/statuses") && init?.method === "POST") {
          statusPosts += 1;
          if (statusPosts === 1) {
            return {
              ok: false,
              status: 500,
              json: async () => ({ message: "server exploded" }),
            } as unknown as Response;
          }
          return { ok: true, status: 201, json: async () => ({}) } as unknown as Response;
        }
        if (u === PR_URL) {
          return { ok: true, status: 200, json: async () => prHeadBody(APPROVED_HEAD) } as unknown as Response;
        }
        throw new Error(`unmocked ghFetch URL: ${u}`);
      });

      const outcome = await publishApprovalStatus(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
        expectedHeadSha: APPROVED_HEAD,
      });

      // The transient first write was retried and the card armed on the live head.
      expect(outcome.kind).toBe("armed");
      expect(outcome.headSha).toBe(APPROVED_HEAD);
      expect(postStatusShas()).toEqual([APPROVED_HEAD, APPROVED_HEAD]);
    });
  });

  // SUP-17273: the READ path (head / PR resolution) retries transient transport
  // failures (5xx / network) with a bounded backoff, while deterministic 4xx stay
  // single-attempt. Drives the real fetchHeadApprovedStatusViaTokenCandidates so
  // the retry is proven to be wired into the actual leaf read, not just the
  // pure wrapper.
  describe("SUP-17273 read-path transient retry", () => {
    const HEAD_STATUSES_URL = (sha: string) =>
      `https://api.github.com/repos/${OWNER}/${REPO}/statuses/${sha}?per_page=100`;

    it("AC1: a transient 500 on the head-status read is retried and succeeds", async () => {
      let statusesReads = 0;
      mockGhFetch.mockImplementation(async (url: string) => {
        if (String(url) === HEAD_STATUSES_URL(APPROVED_HEAD)) {
          statusesReads += 1;
          if (statusesReads === 1) {
            return {
              ok: false,
              status: 500,
              json: async () => ({ message: "server exploded" }),
            } as unknown as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => [
              { context: "paperclip/approved", state: "success" },
            ],
          } as unknown as Response;
        }
        throw new Error(`unmocked ghFetch URL: ${String(url)}`);
      });

      const result = await fetchHeadApprovedStatusViaTokenCandidates(
        db,
        companyId,
        OWNER,
        REPO,
        APPROVED_HEAD,
      );

      expect(result).toEqual({ ok: true, approved: true, controlPlaneApproved: false });
      expect(statusesReads).toBe(2);
    });

    describe("SUP-20772: strict reading of the approval for arming decisions", () => {
      const CONTROL_PLANE = { id: 317012809, login: "tea-core[bot]" };
      const FLEET = { id: 555, login: "fleet-agent[bot]" };
      const release = { id: 7001, context: "paperclip/approved", state: "success", creator: CONTROL_PLANE, description: `released by user:u1 for ${APPROVED_HEAD}: ladder cannot complete` };
      const review = { id: 7002, context: "paperclip/approved", state: "success", creator: CONTROL_PLANE, description: "SUP-42 approved via Paperclip" };
      const read = async (statuses: unknown[], options?: { strict?: boolean; confirmedReleaseStatusId?: string | null }) => {
        mockGhFetch.mockImplementation(async (url: string) => {
          if (String(url) === HEAD_STATUSES_URL(APPROVED_HEAD)) {
            return { ok: true, status: 200, json: async () => statuses } as unknown as Response;
          }
          throw new Error(`unmocked ghFetch URL: ${String(url)}`);
        });
        return fetchHeadApprovedStatusViaTokenCandidates(db, companyId, OWNER, REPO, APPROVED_HEAD, options);
      };

      it("without options any matching success counts, as before", async () => {
        expect(await read([release])).toMatchObject({ ok: true, approved: true });
        expect(await read([{ context: "paperclip/approved", state: "success" }])).toMatchObject({ ok: true, approved: true });
      });

      it("a board-release success is an approval only when it is the status the publisher confirmed; an ordinary control-plane success is one regardless", async () => {
        expect(await read([release], { strict: true, confirmedReleaseStatusId: null })).toMatchObject({ approved: false });
        expect(await read([review], { strict: true, confirmedReleaseStatusId: null })).toMatchObject({ approved: true });
        expect(await read([release], { strict: true, confirmedReleaseStatusId: "7001" })).toMatchObject({ approved: true });
        // A release status the publisher did not confirm (another id, e.g. a write whose answer was lost) never counts.
        expect(await read([release], { strict: true, confirmedReleaseStatusId: "9999" })).toMatchObject({ approved: false });
        expect(await read([{ ...release, id: undefined }], { strict: true, confirmedReleaseStatusId: "7001" })).toMatchObject({ approved: false });
      });

      it("strict: a success written by anyone but the control plane is not an approval", async () => {
        const forged = { ...review, creator: FLEET };
        expect(await read([forged], { strict: true })).toMatchObject({ approved: false });
        expect(await read([forged, release], { strict: true, confirmedReleaseStatusId: null })).toMatchObject({ approved: false });
        expect(await read([{ context: "paperclip/approved", state: "success" }], { strict: true })).toMatchObject({ approved: false });
      });

      it("strict: only the newest paperclip/approved status decides, so a failure after a success revokes it", async () => {
        const failure = { id: 7003, context: "paperclip/approved", state: "failure", creator: CONTROL_PLANE, description: "superseded" };
        expect(await read([failure, review], { strict: true })).toMatchObject({ approved: false });
        expect(await read([failure, release], { strict: true, confirmedReleaseStatusId: "7001" })).toMatchObject({ approved: false });
        expect(await read([review, failure], { strict: true })).toMatchObject({ approved: true });
      });
    });

    it("AC3: transient-exhausted yields the terminal outcome with its prefix intact", async () => {
      let statusesReads = 0;
      mockGhFetch.mockImplementation(async (url: string) => {
        if (String(url) === HEAD_STATUSES_URL(APPROVED_HEAD)) {
          statusesReads += 1;
          return {
            ok: false,
            status: 500,
            json: async () => ({ message: "server exploded" }),
          } as unknown as Response;
        }
        throw new Error(`unmocked ghFetch URL: ${String(url)}`);
      });

      const result = await fetchHeadApprovedStatusViaTokenCandidates(
        db,
        companyId,
        OWNER,
        REPO,
        APPROVED_HEAD,
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        // Prefix stays byte-compatible with the sweep classifier; detail is suffix-only.
        expect(result.reason).toMatch(/^pr_error: HTTP 500 /);
      }
      // Default bounded budget: 3 attempts total.
      expect(statusesReads).toBe(3);
    });

    it("AC2: a deterministic 404 on the head-status read is NOT retried", async () => {
      let statusesReads = 0;
      mockGhFetch.mockImplementation(async (url: string) => {
        if (String(url) === HEAD_STATUSES_URL(APPROVED_HEAD)) {
          statusesReads += 1;
          return {
            ok: false,
            status: 404,
            json: async () => ({ message: "Not Found" }),
          } as unknown as Response;
        }
        throw new Error(`unmocked ghFetch URL: ${String(url)}`);
      });

      const result = await fetchHeadApprovedStatusViaTokenCandidates(
        db,
        companyId,
        OWNER,
        REPO,
        APPROVED_HEAD,
      );

      expect(result).toEqual({ ok: false, reason: "pr_not_found: HTTP 404" });
      // Deterministic refusal: exactly one attempt, byte-identical to today.
      expect(statusesReads).toBe(1);
    });
  });

  describe("resolveApprovalDecisionHead", () => {
    it("resolves the single cached PR head at decision time", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId);
      installRoutes([{ url: PR_URL, body: prHeadBody(APPROVED_HEAD) }]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("resolved");
      if (result.kind === "resolved") {
        expect(result.headSha).toBe(APPROVED_HEAD);
        expect(result.displayName).toBe(`${OWNER}/${REPO}#42`);
      }
    });

    it("publishes only the bound PR head when a cited PR shares the branch", async () => {
      const issueId = await insertIssue({
        delivery: {
          repo: { owner: OWNER, repo: REPO },
          prNumber: 42,
          prUrl: `https://github.com/${OWNER}/${REPO}/pull/42`,
          branch: "SUP-42-branch",
          headSha: APPROVED_HEAD,
        },
      });
      await insertMention(issueId);
      await insertMention(issueId, { number: 43 });
      installRoutes([
        { url: PR_URL, body: prHeadBody(APPROVED_HEAD) },
        { url: `${PR_URL.slice(0, -2)}43`, body: prHeadBody(LIVE_HEAD) },
        { url: POST_STATUS_URL(APPROVED_HEAD), body: {} },
      ]);

      const outcome = await publishApprovalStatus(db, companyId, issueId, "SUP-42", {
        enforceDeliveryIdentity: true,
        expectedHeadSha: APPROVED_HEAD,
      });

      expect(outcome.kind).toBe("armed");
      expect(outcome.headSha).toBe(APPROVED_HEAD);
      expect(postStatusShas()).toEqual([APPROVED_HEAD]);
    });

    it("refuses with a named skipped reason when no linked PR exists", async () => {
      const issueId = await insertIssue();
      // No mention rows; closingTransition=false keeps the zero-mention path off
      // the repo-context lookup so the refusal is purely the missing linked PR.
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", false);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toMatch(/^no-pr:/);
      }
    });

    // SUP-16667: a draft is not "no PR" — the link exists and the PR is live; it
    // simply cannot be armed until promoted (GitHub refuses auto-merge on a
    // draft). Name it (`head_draft`) so the refusal is diagnosable from the
    // message alone instead of reading as a missing link (`no-pr`) and sending
    // the reader to the wrong place.
    it("names a draft-only cached head as head_draft, not no-pr (SUP-16667)", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId, { draft: true });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", false);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toMatch(/^head_draft:/);
        expect(result.reason).not.toMatch(/^no-pr:/);
        expect(result.reason).toContain(`${OWNER}/${REPO}#42`);
        // No pendingCandidates: a no-pr branch anchor would let the approval-status
        // reconciler stamp the draft head by content identity, arming exactly what
        // this refusal exists to prevent.
        expect(result.pendingCandidates).toBeUndefined();
      }
    });

    it("names a workspace-discovered draft head as head_draft on a closing transition (SUP-16667)", async () => {
      const issueId = await insertIssue();
      // No cached mention: the live workspace re-resolve finds the open draft.
      installRoutes([{ url: OPEN_PRS_LIST_URL, body: [openPrsListItem({ draft: true })] }]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toMatch(/^head_draft:/);
        expect(result.reason).not.toMatch(/^no-pr:/);
        expect(result.pendingCandidates).toBeUndefined();
      }
    });

    it("still arms the non-draft head when a card cites a draft and a non-draft PR (SUP-16667)", async () => {
      const issueId = await insertIssue();
      // #42 is the delivered (non-draft) PR; #43 is a cited draft. Including drafts
      // must not make the authorizing set ambiguous nor arm the draft.
      await insertMention(issueId, { number: 42, headRefName: "SUP-42-branch", draft: false });
      await insertMention(issueId, { number: 43, headRefName: "SUP-42-branch", draft: true });
      installRoutes([{ url: PR_URL, body: prHeadBody(APPROVED_HEAD) }]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("resolved");
      if (result.kind === "resolved") {
        expect(result.headSha).toBe(APPROVED_HEAD);
        expect(result.displayName).toBe(`${OWNER}/${REPO}#42`);
      }
    });

    // SUP-15016: a no-pr decision certifies the card's OWN delivery-branch head so a
    // later reconciler tick has an anchor to verify against. The no-pr refusal reason
    // is unchanged (acceptance #5); only the certification evidence is now attached.
    it("certifies the card's own delivery-branch head on a no-pr decision (acceptance 1)", async () => {
      const issueId = await insertIssue();
      installRoutes([
        { url: OPEN_PRS_LIST_URL, body: [] },
        {
          url: BRANCH_REF_URL,
          body: { ref: "refs/heads/SUP-42-branch", object: { type: "commit", sha: BRANCH_HEAD } },
        },
      ]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toMatch(/^no-pr:/);
        expect(result.pendingCandidates).toHaveLength(1);
        const anchor = result.pendingCandidates![0] as NoPrBranchAnchor;
        expect(anchor.owner).toBe(OWNER);
        expect(anchor.repo).toBe(REPO);
        expect(anchor.branch).toBe("SUP-42-branch");
        expect(anchor.headSha).toBe(BRANCH_HEAD);
        expect(anchor.source).toBe("no-pr-branch");
        expect(typeof anchor.certifiedAt).toBe("string");
      }
    });

    it("anchors the no-pr delivery-branch head to null when the ref cannot be read (acceptance 2)", async () => {
      const issueId = await insertIssue();
      installRoutes([
        { url: OPEN_PRS_LIST_URL, body: [] },
        { url: BRANCH_REF_URL, ok: false, status: 404, body: { message: "Not Found" } },
      ]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toMatch(/^no-pr:/);
        expect(result.pendingCandidates).toHaveLength(1);
        const anchor = result.pendingCandidates![0] as NoPrBranchAnchor;
        expect(anchor.branch).toBe("SUP-42-branch");
        expect(anchor.headSha).toBeNull();
        expect(anchor.source).toBe("no-pr-branch");
      }
    });

    it("certifies nothing on a no-pr card with no delivery branch (acceptance 3)", async () => {
      const issueId = await insertIssue({ deliveryIdentity: false });
      installRoutes([{ url: OPEN_PRS_LIST_URL, body: [] }]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toMatch(/^no-pr:/);
        expect(result.pendingCandidates).toBeUndefined();
      }
    });

    it("certifies nothing on a no-pr card whose delivery branch belongs to another issue (acceptance 3)", async () => {
      const ownerIssueId = await insertIssue({ identifier: "SUP-99" });
      const issueId = await insertIssue({ sharedWorkspaceOwnerIssueId: ownerIssueId });
      installRoutes([{ url: OPEN_PRS_LIST_URL, body: [] }]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toMatch(/^no-pr:/);
        expect(result.pendingCandidates).toBeUndefined();
      }
    });

    it("refuses with a named auth reason when no token resolves", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId);
      // No token resolvable at any scope -> decision-time head cannot be read.
      mockGetByName.mockResolvedValue(null);
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toMatch(/^auth_required:/);
      }
    });

    // ADR-091 D1 (SUP-14676 round-1): the resolver must apply the delivery-identity
    // narrowing BEFORE the length arithmetic, exactly as publishApprovalStatus does.
    // A card that delivered PR #42 and merely CITED a second PR (#43) must pin the
    // delivered one — the round-1 regression refused its own first publish here.
    it("pins the delivered PR when the card delivered one PR and merely cited another", async () => {
      const issueId = await insertIssue();
      // #42 is on the card's own delivery branch (delivered); #43 is on another
      // card's branch (merely cited / linked).
      await insertMention(issueId, { number: 42, headRefName: "SUP-42-branch" });
      await insertMention(issueId, { number: 43, headRefName: "SUP-43-other-card-branch" });
      installRoutes([{ url: PR_URL, body: prHeadBody(APPROVED_HEAD) }]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("resolved");
      if (result.kind === "resolved") {
        expect(result.headSha).toBe(APPROVED_HEAD);
        expect(result.displayName).toBe(`${OWNER}/${REPO}#42`);
      }
    });

    it("refuses as ambiguous only when two linked PRs are BOTH delivered on the card's branch", async () => {
      const issueId = await insertIssue();
      // Both PRs sit on the card's delivery branch -> genuinely ambiguous.
      await insertMention(issueId, { number: 42, headRefName: "SUP-42-branch" });
      await insertMention(issueId, { number: 43, headRefName: "SUP-42-branch" });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toMatch(/^ambiguous:/);
        expect(result.reason).toContain("2");
      }
    });

    it("refuses with not_delivered when the only linked PR is not this card's delivery branch", async () => {
      const issueId = await insertIssue();
      // The card cited another card's PR (same repo, other branch) and delivered nothing.
      await insertMention(issueId, { number: 42, headRefName: "SUP-43-other-card-branch" });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toMatch(/^not_delivered:/);
        expect(result.reason).toContain(`${OWNER}/${REPO}#42`);
      }
    });

    // ADR-091 D5 (SUP-14734): the not_delivered refusal must name the mismatched
    // half. The two halves: a REPO mismatch (head branch can equal the delivery
    // branch yet the head repo differs) vs a REF mismatch (repo matches, ref
    // differs). The repo half must not read as "branch X is not branch X".
    it("names the repo mismatch (not a branch-vs-itself sentence) when the head branch equals the delivery branch but the head repo differs", async () => {
      const issueId = await insertIssue();
      // Same branch as the card's delivery branch, but in a DIFFERENT repo.
      await insertMention(issueId, { number: 42, headRefName: "SUP-42-branch", owner: "other-org", repo: "other-repo" });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toBe(
          `not_delivered: other-org/other-repo#42 head repo other-org/other-repo is not this card's delivery repo ${OWNER}/${REPO}; a deliverable in other-org/other-repo must be filed under a project bound to that repo (ADR-091 D5)`,
        );
        expect(result.reason).not.toContain("is not this card's delivery branch");
      }
    });

    it.each([
      { label: "owner", owner: "other-org", repo: REPO },
      { label: "repository name", owner: OWNER, repo: "other-repo" },
    ])("never treats another $label's same-branch PR as this card's delivery", async ({ owner, repo }) => {
      const issueId = await insertIssue();
      const foreignPr = {
        number: 42,
        owner,
        repo,
        headRefName: "SUP-42-branch",
        displayName: `${owner}/${repo}#42`,
      };

      const result = await narrowToDelivered(db, companyId, issueId, [foreignPr]);
      expect(result.outcome).toBe("not-delivered");
    });

    it("keeps branch language when the head repo matches but the head ref differs", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId, { number: 42, headRefName: "SUP-99-other-branch" });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toBe(
          `not_delivered: ${OWNER}/${REPO}#42 head ${OWNER}/${REPO}:SUP-99-other-branch is not this card's delivery branch SUP-42-branch`,
        );
      }
    });

    it("names the repo mismatch (the decisive half) when BOTH the head repo and head ref differ", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId, { number: 42, headRefName: "SUP-99-other-branch", owner: "other-org", repo: "other-repo" });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toBe(
          `not_delivered: other-org/other-repo#42 head repo other-org/other-repo is not this card's delivery repo ${OWNER}/${REPO}; a deliverable in other-org/other-repo must be filed under a project bound to that repo (ADR-091 D5)`,
        );
        expect(result.reason).not.toContain("is not this card's delivery branch");
      }
    });

    it("emits the SAME not_delivered fragment from resolveApprovalDecisionHead and publishApprovalStatus (one fixture)", async () => {
      const issueId = await insertIssue();
      // One repo-mismatch candidate; both entry points must surface the same text.
      await insertMention(issueId, { number: 42, headRefName: "SUP-42-branch", owner: "other-org", repo: "other-repo" });
      installRoutes([]);

      const decision = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);
      expect(decision.kind).toBe("unresolvable");
      const decisionReason = decision.kind === "unresolvable" ? decision.reason : "";
      expect(decisionReason.startsWith("not_delivered: ")).toBe(true);
      const decisionFragment = decisionReason.slice("not_delivered: ".length);

      const publish = await publishApprovalStatus(db, companyId, issueId, "SUP-42", {
        enforceDeliveryIdentity: true,
      });
      expect(publish.kind).toBe("skipped");
      expect(publish.message.startsWith("status:skipped:not_delivered: ")).toBe(true);
      const publishFragment = publish.message.slice("status:skipped:not_delivered: ".length);

      expect(publishFragment).toBe(decisionFragment);
      expect(decisionFragment).toBe(
        `other-org/other-repo#42 head repo other-org/other-repo is not this card's delivery repo ${OWNER}/${REPO}; a deliverable in other-org/other-repo must be filed under a project bound to that repo (ADR-091 D5)`,
      );
    });

    it("refuses with delivery_identity_unresolved when the card's delivery identity cannot be resolved", async () => {
      // No execution workspace -> no delivery branch; fail closed (ADR-091 D4).
      const issueId = await insertIssue({ deliveryIdentity: false });
      await insertMention(issueId, { number: 42, headRefName: "SUP-42-branch" });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toMatch(/^delivery_identity_unresolved:/);
      }
    });
  });

  // SUP-21513: a card whose recorded delivery PR has MERGED is a COMPLETED
  // delivery, not an unresolved one — the approve preflight (the 409
  // approval_final_delivery_preflight gate) must accept it once the merge
  // commit is proven on the recorded base branch (GitHub compare
  // base...merge_commit_sha reports ahead_by=0 / status behind|identical).
  // Closed-UNMERGED keeps refusing, byte-identically (ADR-091 D4 fail-closed).
  describe("SUP-21513 merged recorded delivery PR", () => {
    const MERGE_SHA = "mergec000000000000000000000000000000000001";
    const COMPARE_URL = `https://api.github.com/repos/${OWNER}/${REPO}/compare/main...${MERGE_SHA}`;

    function mergedPrHeadBody() {
      // Superset of both live readers: fetchPullRequestHeadShaOnce (head.sha,
      // head.ref, state, merged, merge_commit_sha, base.ref) and
      // finalDeliveryLiveSchema (title, head.repo.full_name).
      return {
        state: "closed",
        draft: false,
        merged: true,
        title: "Fix thing (SUP-42)",
        merge_commit_sha: MERGE_SHA,
        base: { ref: "main" },
        head: {
          ref: "SUP-42-branch",
          sha: APPROVED_HEAD,
          repo: { full_name: `${OWNER}/${REPO}` },
        },
      };
    }

    function closedUnmergedPrHeadBody() {
      return {
        state: "closed",
        draft: false,
        merged: false,
        title: "Fix thing (SUP-42)",
        head: {
          ref: "SUP-42-branch",
          sha: APPROVED_HEAD,
          repo: { full_name: `${OWNER}/${REPO}` },
        },
      };
    }

    async function insertBoundCard() {
      const issueId = await insertIssue({
        delivery: {
          repo: { owner: OWNER, repo: REPO },
          prNumber: 42,
          prUrl: `https://github.com/${OWNER}/${REPO}/pull/42`,
          branch: "SUP-42-branch",
          headSha: APPROVED_HEAD,
        },
      });
      await insertMention(issueId);
      return issueId;
    }

    it("resolves the decision head when the merged PR's merge commit is on the base branch", async () => {
      const issueId = await insertBoundCard();
      installRoutes([
        { url: PR_URL, body: mergedPrHeadBody() },
        { url: COMPARE_URL, body: { status: "behind", ahead_by: 0 } },
      ]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("resolved");
      if (result.kind === "resolved") {
        expect(result.headSha).toBe(APPROVED_HEAD);
        expect(result.displayName).toBe(`${OWNER}/${REPO}#42`);
      }
    });

    it("keeps refusing a closed-UNMERGED recorded PR byte-identically (ADR-091 D4)", async () => {
      const issueId = await insertBoundCard();
      installRoutes([{ url: PR_URL, body: closedUnmergedPrHeadBody() }]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toContain("recorded delivery identity PR is not open");
      }
    });

    it("refuses a merged PR whose merge commit is NOT on the base branch", async () => {
      const issueId = await insertBoundCard();
      installRoutes([
        { url: PR_URL, body: mergedPrHeadBody() },
        { url: COMPARE_URL, body: { status: "ahead", ahead_by: 2 } },
      ]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toContain("merged but not proven on its base branch");
      }
    });

    it("refuses a merged PR whose containment cannot be checked (fail closed, no compare route)", async () => {
      const issueId = await insertBoundCard();
      installRoutes([{ url: PR_URL, body: mergedPrHeadBody() }]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toContain("merged but not proven on its base branch");
      }
    });

    it("preflightFinalDelivery (the approve 409 gate) accepts the merged proven delivery", async () => {
      const issueId = await insertBoundCard();
      installRoutes([
        { url: PR_URL, body: mergedPrHeadBody() },
        { url: COMPARE_URL, body: { status: "identical", ahead_by: 0 } },
      ]);

      const result = await preflightFinalDelivery(db, companyId, issueId, "SUP-42");

      expect(result.kind).toBe("resolved");
      if (result.kind === "resolved") {
        expect(result.headSha).toBe(APPROVED_HEAD);
        expect(result.displayName).toBe(`${OWNER}/${REPO}#42`);
      }
    });

    it("preflightFinalDelivery keeps refusing the closed-UNMERGED delivery", async () => {
      const issueId = await insertBoundCard();
      installRoutes([{ url: PR_URL, body: closedUnmergedPrHeadBody() }]);

      const result = await preflightFinalDelivery(db, companyId, issueId, "SUP-42");

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toContain("recorded delivery identity PR is not open");
      }
    });

    it("publishes no status for the merged proven delivery — truthful skip, zero GitHub writes", async () => {
      const issueId = await insertBoundCard();
      installRoutes([
        { url: PR_URL, body: mergedPrHeadBody() },
        { url: COMPARE_URL, body: { status: "behind", ahead_by: 0 } },
      ]);

      const outcome = await publishApprovalStatus(db, companyId, issueId, "SUP-42", {
        enforceDeliveryIdentity: true,
        expectedHeadSha: APPROVED_HEAD,
      });

      expect(outcome.kind).toBe("skipped");
      if (outcome.kind === "skipped") {
        expect(outcome.message).toContain("pr-not-eligible");
        expect(outcome.message).toContain("merged");
      }
      expect(postStatusShas()).toEqual([]);
    });
  });

  describe("resolveCardPullRequest (SUP-14917 shared resolution)", () => {
    it("resolves a single cached OPEN mention with no live GitHub call (source=mention)", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId, { number: 42, headRefName: "SUP-42-branch" });
      // No live route: any GitHub call would throw, proving the open-mention
      // short-circuit makes no discovery call.
      installRoutes([]);

      const resolution = await resolveCardPullRequest(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
      });

      expect(resolution).toEqual({
        kind: "single",
        owner: OWNER,
        repo: REPO,
        number: 42,
        displayName: `${OWNER}/${REPO}#42`,
        headRefName: "SUP-42-branch",
        source: "mention",
        draft: false,
      });
    });

    it("reports ambiguous when two cached OPEN mentions exist", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId, { number: 42, headRefName: "SUP-42-branch" });
      await insertMention(issueId, { number: 43, headRefName: "SUP-43-other-card-branch" });
      installRoutes([]);

      const resolution = await resolveCardPullRequest(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
      });

      expect(resolution.kind).toBe("ambiguous");
      if (resolution.kind === "ambiguous") {
        expect(resolution.reason).toBe("multiple-cached-open-mentions");
        expect(resolution.displayNames).toHaveLength(2);
      }
    });

    it("resolves a zero-mention card from live workspace discovery (source=workspace)", async () => {
      const issueId = await insertIssue();
      // No external-object mentions at all — the SUP-14737 / PR 455 shape.
      installRoutes([{ url: OPEN_PRS_LIST_URL, body: [openPrsListItem({ number: 455 })] }]);

      const resolution = await resolveCardPullRequest(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
      });

      expect(resolution).toEqual({
        kind: "single",
        owner: OWNER,
        repo: REPO,
        number: 455,
        displayName: `${OWNER}/${REPO}#455`,
        headRefName: "SUP-42-branch",
        source: "workspace",
        draft: false,
      });
    });

    it("returns none when zero mentions and live discovery finds no matching open PR (AC3)", async () => {
      const issueId = await insertIssue();
      installRoutes([{ url: OPEN_PRS_LIST_URL, body: [] }]);

      const resolution = await resolveCardPullRequest(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
      });

      expect(resolution).toEqual({ kind: "none" });
    });

    it("returns undetermined (not none) when live discovery fails terminally (transient, AC3)", async () => {
      const issueId = await insertIssue();
      installRoutes([
        { url: OPEN_PRS_LIST_URL, ok: false, status: 404, body: { message: "Not Found" } },
      ]);

      const resolution = await resolveCardPullRequest(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
      });

      expect(resolution.kind).toBe("undetermined");
      if (resolution.kind === "undetermined") {
        expect(resolution.reason).toBe("live-discovery-failed");
        expect(resolution.failure.status).toBe(404);
        expect(resolution.failure.noToken).toBe(false);
      }
    });

    it("returns undetermined when no GitHub token resolves for the workspace pair", async () => {
      const issueId = await insertIssue();
      mockGetByName.mockResolvedValue(null);
      installRoutes([]);

      const resolution = await resolveCardPullRequest(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
      });

      expect(resolution.kind).toBe("undetermined");
      if (resolution.kind === "undetermined") {
        expect(resolution.failure.noToken).toBe(true);
      }
    });

    it("reports ambiguous when a closed cached mention DISAGREES with the live match (AC4)", async () => {
      const issueId = await insertIssue();
      // A closed (hence non-open) cached mention pointing at PR #42...
      await insertMention(issueId, { number: 42, state: "closed", headRefName: "SUP-42-branch" });
      // ...while the live workspace discovery finds a DIFFERENT open PR (#455).
      installRoutes([{ url: OPEN_PRS_LIST_URL, body: [openPrsListItem({ number: 455 })] }]);

      const resolution = await resolveCardPullRequest(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
      });

      expect(resolution.kind).toBe("ambiguous");
      if (resolution.kind === "ambiguous") {
        expect(resolution.reason).toBe("mention-workspace-disagreement");
        expect(resolution.displayNames).toContain(`${OWNER}/${REPO}#455`);
        expect(resolution.displayNames).toContain(`${OWNER}/${REPO}#42`);
      }
    });

    it("does NOT flag disagreement when the closed cached mention matches the live PR", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId, { number: 455, state: "closed", headRefName: "SUP-42-branch" });
      installRoutes([{ url: OPEN_PRS_LIST_URL, body: [openPrsListItem({ number: 455 })] }]);

      const resolution = await resolveCardPullRequest(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
      });

      expect(resolution.kind).toBe("single");
      if (resolution.kind === "single") {
        expect(resolution.source).toBe("workspace");
        expect(resolution.number).toBe(455);
      }
    });
  });

  describe("SUP-17162: workspace discovery must not resolve a card from a citation of its identifier", () => {
    // The pre-fix defect: discovery matched by identifier SUBSTRING on head ref /
    // title / body, so any PR that merely CITES a card's identifier (mid-branch
    // slug, mid-title, or anywhere in the body) resolved as that card's PR. The
    // SUP-17075 close falsely resolved its sibling SUP-17079's in-review PR #760
    // and knocked the ruling card back to in_progress. Every test below asserts the
    // anchored boundary instead of a substring hit.

    it("AC5: does NOT resolve a sibling's PR that merely cites the card's identifier (SUP-17075 -> #760, verbatim)", async () => {
      // SUP-17075 is a ruling card: no code, no branch commits, zero external-object
      // PR mentions. Its close fell through to live workspace discovery, which on
      // pre-fix code matched the sibling card SUP-17079's in-review PR #760 — that
      // PR's branch slug AND body both cite SUP-17075. Assert none. This test FAILS
      // on pre-fix code, where headRef.includes("sup-17075") matched the mid-slug.
      const issueId = await insertIssue({ identifier: "SUP-17075", branchName: "SUP-17075-ruling" });
      installRoutes([
        {
          url: OPEN_PRS_LIST_URL,
          body: [
            openPrsListItem({
              number: 760,
              head: { ref: "SUP-17079-fix-interaction-acceptance-cards-sup-17075-d1-ppc-be" },
              title: "fix: interaction acceptance cards (SUP-17075 D1)",
              body: "**Parent ruling: SUP-17075**\n\nDelivers the D1 acceptance cards.",
            }),
          ],
        },
      ]);

      const resolution = await resolveCardPullRequest(db, companyId, issueId, "SUP-17075", {
        closingTransition: true,
      });

      expect(resolution).toEqual({ kind: "none" });
    });

    it("AC1: a branch that carries the identifier only mid-slug is NOT resolved", async () => {
      const issueId = await insertIssue();
      installRoutes([
        {
          url: OPEN_PRS_LIST_URL,
          body: [
            openPrsListItem({
              number: 761,
              head: { ref: "SUP-99-feature-sup-42-hotfix" },
              title: "Unrelated feature",
              body: "no identifier citations",
            }),
          ],
        },
      ]);

      const resolution = await resolveCardPullRequest(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
      });

      expect(resolution).toEqual({ kind: "none" });
    });

    it("AC2: a body citation alone (no anchored branch or title match) is NOT resolved", async () => {
      const issueId = await insertIssue();
      installRoutes([
        {
          url: OPEN_PRS_LIST_URL,
          body: [
            openPrsListItem({
              number: 762,
              head: { ref: "SUP-99-unrelated-branch" },
              title: "Some unrelated change",
              body: "Closes SUP-42\n\n(see also the discussion)",
            }),
          ],
        },
      ]);

      const resolution = await resolveCardPullRequest(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
      });

      expect(resolution).toEqual({ kind: "none" });
    });

    it("AC3: still resolves a shared-branch child PR whose TITLE leads with the card's identifier (SUP-13361)", async () => {
      const ownerIssueId = await insertIssue({ identifier: "SUP-1" });
      const PARENT_BRANCH = "SUP-1-parent-architecture-review";
      const issueId = await insertIssue({
        identifier: "SUP-42",
        sharedWorkspaceOwnerIssueId: ownerIssueId,
        branchName: PARENT_BRANCH,
      });
      // Zero cached mentions; the child PR rides the CARRIER's branch (not a SUP-42-
      // branch) and carries the child's identifier only in the title, which LEADS
      // with it. The anchored title-lead predicate must still match.
      installRoutes([
        {
          url: OPEN_PRS_LIST_URL,
          body: [
            openPrsListItem({
              number: 455,
              head: { ref: PARENT_BRANCH },
              title: "SUP-42: unify resolution",
              body: "shared worktree deliverable",
            }),
          ],
        },
      ]);

      const resolution = await resolveCardPullRequest(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
      });

      expect(resolution).toEqual({
        kind: "single",
        owner: OWNER,
        repo: REPO,
        number: 455,
        displayName: `${OWNER}/${REPO}#455`,
        headRefName: PARENT_BRANCH,
        source: "workspace",
        draft: false,
      });
    });

    it("AC4: still resolves a card's own delivery PR whose branch carries its identifier prefix (no regression)", async () => {
      const issueId = await insertIssue({ identifier: "SUP-42", branchName: "SUP-42-branch" });
      installRoutes([
        {
          url: OPEN_PRS_LIST_URL,
          body: [openPrsListItem({ number: 455, head: { ref: "SUP-42-branch" } })],
        },
      ]);

      const resolution = await resolveCardPullRequest(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
      });

      expect(resolution).toEqual({
        kind: "single",
        owner: OWNER,
        repo: REPO,
        number: 455,
        displayName: `${OWNER}/${REPO}#455`,
        headRefName: "SUP-42-branch",
        source: "workspace",
        draft: false,
      });
    });
  });

  describe("SUP-16689: linked-PR draft filter (arming stays draft-blind; backstop opts in)", () => {
    it("AC3: the default resolver stays draft-blind — a linked draft is excluded (regression guard)", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId, { number: 42, draft: true, headRefName: "SUP-42-branch" });
      await insertMention(issueId, { number: 43, draft: false, headRefName: "SUP-43-branch" });
      installRoutes([]);

      const result = await resolveLinkedPullRequestsWithState(db, companyId, issueId);

      // Default (no includeDrafts): the draft #42 is dropped; only the non-draft
      // #43 remains. This is the exact set every arming-path caller has always seen.
      expect(result.map((pr) => pr.number)).toEqual([43]);
      expect(result[0]!.draft).toBe(false);
    });

    it("includeDrafts: true surfaces the linked draft with draft:true (new opt-in)", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId, { number: 42, draft: true, headRefName: "SUP-42-branch" });
      await insertMention(issueId, { number: 43, draft: false, headRefName: "SUP-43-branch" });
      installRoutes([]);

      const result = await resolveLinkedPullRequestsWithState(db, companyId, issueId, {
        includeDrafts: true,
      });

      expect(result.map((pr) => pr.number).sort((a, b) => a - b)).toEqual([42, 43]);
      const byNumber = new Map(result.map((pr) => [pr.number, pr]));
      expect(byNumber.get(42)?.draft).toBe(true);
      expect(byNumber.get(43)?.draft).toBe(false);
    });

    it("resolveCardPullRequest: a single draft mention is excluded by default but surfaced with includeDrafts", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId, { number: 42, draft: true, headRefName: "SUP-42-branch" });
      installRoutes([{ url: OPEN_PRS_LIST_URL, body: [] }]);

      const defaultResolution = await resolveCardPullRequest(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
      });
      // Default is draft-blind: the only open mention is a draft -> excluded ->
      // zero open mentions -> live discovery (empty) -> none.
      expect(defaultResolution).toEqual({ kind: "none" });

      const draftResolution = await resolveCardPullRequest(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
        includeDrafts: true,
      });
      expect(draftResolution).toEqual({
        kind: "single",
        owner: OWNER,
        repo: REPO,
        number: 42,
        displayName: `${OWNER}/${REPO}#42`,
        headRefName: "SUP-42-branch",
        source: "mention",
        draft: true,
      });
    });
  });

  describe("SUP-21684: cached GitHub baseRef propagates to LinkedPullRequest.baseRefName", () => {
    it("resolveLinkedPullRequests maps cached data.baseRef to baseRefName", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId, { number: 42, baseRef: "main" });
      await insertMention(issueId, { number: 43, baseRef: null });

      const result = await resolveLinkedPullRequests(db, companyId, issueId);
      const byNumber = new Map(result.map((pr) => [pr.number, pr]));

      expect(byNumber.get(42)?.baseRefName).toBe("main");
      expect(byNumber.get(43)?.baseRefName ?? null).toBeNull();
    });

    it("resolveLinkedPullRequestsWithState maps cached data.baseRef to baseRefName (incl. closed rows)", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId, { number: 42, baseRef: "main" });
      await insertMention(issueId, { number: 43, state: "closed", baseRef: "release-1" });
      await insertMention(issueId, { number: 44, baseRef: null });

      const result = await resolveLinkedPullRequestsWithState(db, companyId, issueId);
      const byNumber = new Map(result.map((pr) => [pr.number, pr]));

      expect(byNumber.get(42)?.baseRefName).toBe("main");
      expect(byNumber.get(43)?.baseRefName).toBe("release-1");
      expect(byNumber.get(44)?.baseRefName ?? null).toBeNull();
    });
  });

  describe("publishApprovalStatus with expectedHeadSha", () => {
    it("refuses (head_moved, zero writes) when the live head moved past the pin", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId);
      // Live head has moved to LIVE_HEAD; the decision pinned APPROVED_HEAD.
      installRoutes([{ url: PR_URL, body: prHeadBody(LIVE_HEAD) }]);

      const outcome = await publishApprovalStatus(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
        expectedHeadSha: APPROVED_HEAD,
      });

      expect(outcome.kind).toBe("skipped");
      expect(outcome.message).toContain("head_moved");
      expect(outcome.message).toContain(APPROVED_HEAD.slice(0, 7));
      expect(postStatusCalls()).toHaveLength(0);
    });

    it("publishes on the pinned head when the live head is unchanged", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId);
      installRoutes([
        { url: PR_URL, body: prHeadBody(APPROVED_HEAD) },
        { url: POST_STATUS_URL(APPROVED_HEAD), body: {} },
      ]);

      const outcome = await publishApprovalStatus(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
        expectedHeadSha: APPROVED_HEAD,
      });

      expect(outcome.kind).toBe("armed");
      expect(outcome.headSha).toBe(APPROVED_HEAD);
      expect(postStatusShas()).toEqual([APPROVED_HEAD]);
    });
  });

  describe("decision-time pin end to end", () => {
    it("refuses when the head moves between the decision read and the publish", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId);

      // 1. The approving decision renders against APPROVED_HEAD.
      installRoutes([{ url: PR_URL, body: prHeadBody(APPROVED_HEAD) }]);
      const decisionHead = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);
      expect(decisionHead.kind).toBe("resolved");
      if (decisionHead.kind !== "resolved") throw new Error("expected resolved decision head");
      expect(decisionHead.headSha).toBe(APPROVED_HEAD);

      // 2. A push lands: the live head is now LIVE_HEAD by the time we publish.
      // The first publish runs with enforceDeliveryIdentity: true, exactly as
      // runApprovalMergeArming does — the same gate the resolver just applied.
      installRoutes([{ url: PR_URL, body: prHeadBody(LIVE_HEAD) }]);
      const outcome = await publishApprovalStatus(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
        enforceDeliveryIdentity: true,
        expectedHeadSha: decisionHead.headSha,
      });

      expect(outcome.kind).toBe("skipped");
      expect(outcome.message).toContain("head_moved");
      expect(postStatusCalls()).toHaveLength(0);
    });
  });

  // SUP-15394 (root SUP-15393): on the zero-mention card, publishApprovalStatus
  // resolves a PR via live workspace discovery, stamps it, and hands the actuator
  // the EXACT PR it certified. The actuator must arm THAT PR instead of running a
  // second, independent resolveLinkedPullRequests — the divergent re-resolve that
  // produced the no-pr refusal on main (SUP-15377's #572: stamped and fully
  // authorized, yet unqueued and never durably refused).
  describe("SUP-15394: arm the PR publishApprovalStatus certified (zero-mention card)", () => {
    const PR455_URL = `https://api.github.com/repos/${OWNER}/${REPO}/pulls/455`;
    // Serves both publishApprovalStatus's head-SHA read (head.sha) and
    // armMergeOnApproval's node-id fetch (node_id) — one GET /pulls/455.
    const PR455_BODY = {
      node_id: "PR_node_455",
      head: { ref: "SUP-42-branch", sha: APPROVED_HEAD },
      title: "Unify PR resolution",
      state: "open",
    };

    // A zero-mention card whose single review stage is complete and approved, so
    // the owner-approved stage-completion gate in armMergeOnApproval passes.
    async function insertApprovedCard() {
      const issueId = await insertIssue();
      await db
        .update(issues)
        .set({
          executionPolicy: {
            mode: "normal",
            stages: [{ id: "stage-a", type: "review", approvalsNeeded: 1 }],
          },
          executionState: {
            completedStageIds: ["stage-a"],
            lastDecisionOutcome: "approved",
          },
        })
        .where(eq(issues.id, issueId));
      return issueId;
    }

    it("arms the certified PR instead of refusing no-pr (AC#1, AC#2)", async () => {
      const issueId = await insertApprovedCard();
      // Zero pull_request mention rows — only live workspace discovery finds #455.
      installRoutes([
        { url: OPEN_PRS_LIST_URL, body: [openPrsListItem({ number: 455 })] },
        { url: PR455_URL, body: PR455_BODY },
        { url: POST_STATUS_URL(APPROVED_HEAD), body: {} },
        {
          url: "https://api.github.com/graphql",
          body: { data: { enablePullRequestAutoMerge: { clientMutationId: "mut-455" } } },
        },
      ]);

      // The publisher resolves, delivery-gates, and stamps #455 — handing over the
      // exact PR it certified.
      const statusOutcome = await publishApprovalStatus(db, companyId, issueId, "SUP-42", {
        closingTransition: true,
        enforceDeliveryIdentity: true,
      });
      expect(statusOutcome.kind).toBe("armed");
      expect(statusOutcome.headSha).toBe(APPROVED_HEAD);
      expect(statusOutcome.certifiedPr).toMatchObject({
        owner: OWNER,
        repo: REPO,
        number: 455,
        headRefName: "SUP-42-branch",
      });

      // The actuator arms EXACTLY the certified PR. On main the 5th argument did
      // not exist, so the actuator re-resolved (0 mentions) and returned no-pr.
      const armingOutcome = await armMergeOnApproval(
        db,
        companyId,
        issueId,
        { stageId: "stage-a", stageType: "review", outcome: "approved", body: "LGTM" },
        statusOutcome.certifiedPr,
      );
      expect(armingOutcome.kind).toBe("armed");
      expect(armingOutcome.message).toContain("Auto-merge enabled for TEA-Core/paperclip#455");
    });

    it("still refuses no-pr when no certified subject is supplied (fallback re-resolve unchanged)", async () => {
      const issueId = await insertApprovedCard();
      // The same zero-mention card, but no certified subject handed over: the
      // historical cached resolve finds nothing, so the actuator still refuses.
      installRoutes([]);

      const armingOutcome = await armMergeOnApproval(
        db,
        companyId,
        issueId,
        { stageId: "stage-a", stageType: "review", outcome: "approved", body: "LGTM" },
      );
      expect(armingOutcome.kind).toBe("skipped");
      expect(armingOutcome.message).toBe("skipped:no-pr: No linked pull request found");
    });
  });

  // SUP-16088: the SUP-16050 miss. armMergeOnApproval WAS invoked for the
  // final-stage approval (single review stage completed + approved, PR base
  // fold/tea-patches-v2026.722.0) but returned a TERMINAL failed:HTTP 502 — a
  // transient gateway error on the enablePullRequestAutoMerge mutation, never
  // retried. The PR sat stamped and authorized but unqueued until the hourly
  // backstop re-armed it 1h46m later. The actuator now retries a transient 5xx
  // before giving up, so an approval of this shape enqueues the governing PR.
  describe("SUP-16088: retry a transient 5xx on the arming mutation", () => {
    const GRAPHQL_URL = "https://api.github.com/graphql";
    // The SUP-16050 shape: a card whose single review stage is complete and
    // approved — the final-stage approval that closes the card via status:done.
    async function insertFinalStageApprovedCard() {
      const issueId = await insertIssue({ branchName: "SUP-42-branch" });
      await db
        .update(issues)
        .set({
          executionPolicy: {
            mode: "normal",
            stages: [{ id: "stage-a", type: "review", approvalsNeeded: 1 }],
          },
          executionState: {
            completedStageIds: ["stage-a"],
            lastDecisionOutcome: "approved",
          },
        })
        .where(eq(issues.id, issueId));
      return issueId;
    }

    // The PR this card delivered, certified by publishApprovalStatus: owned by
    // the card (title + head branch name SUP-42), base the fold branch, node id
    // already known so the actuator goes straight to the arming mutation.
    const certifiedPr = {
      id: "obj-676",
      owner: OWNER,
      repo: REPO,
      number: 676,
      nodeId: "PR_node_676",
      headRefName: "SUP-42-branch",
      displayName: `${OWNER}/${REPO}#676`,
      title: "Fix continuation gate (SUP-42) [base fold/tea-patches-v2026.722.0]",
      cachedState: "open",
      lastErrorCode: null,
      reviewDecision: "APPROVED",
    };

    it("enqueues the governing PR after retrying a transient 502 (AC#2, AC#4)", async () => {
      const issueId = await insertFinalStageApprovedCard();
      let graphqlCalls = 0;
      mockGhFetch.mockImplementation(async (url: string) => {
        if (url === GRAPHQL_URL) {
          graphqlCalls += 1;
          // The located cause: the first arming attempt is a transient 502 (a real
          // HTTP response, no JSON body), then the mutation clears on the retry.
          if (graphqlCalls === 1) {
            return { ok: false, status: 502, json: async () => null } as unknown as Response;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: { enablePullRequestAutoMerge: { clientMutationId: "mut-676" } } }),
          } as unknown as Response;
        }
        throw new Error(`unmocked ghFetch URL: ${url}`);
      });

      const armingOutcome = await armMergeOnApproval(
        db,
        companyId,
        issueId,
        { stageId: "stage-a", stageType: "review", outcome: "approved", body: "LGTM" },
        certifiedPr,
      );

      // The transient 502 was retried and the enqueue WAS made: the mutation ran
      // twice (502 then success) and the outcome is armed, not a terminal failed.
      expect(armingOutcome.kind).toBe("armed");
      expect(armingOutcome.message).toContain("Auto-merge enabled for TEA-Core/paperclip#676");
      expect(graphqlCalls).toBe(2);
    });

    it("surfaces a terminal failed after the transient-5xx retry budget is exhausted", async () => {
      const issueId = await insertFinalStageApprovedCard();
      // Every arming attempt 502s — the retry budget is exhausted and the miss is
      // surfaced (and persisted as armOutcome.kind === "failed"), not hung.
      let graphqlCalls = 0;
      mockGhFetch.mockImplementation(async (url: string) => {
        if (url === GRAPHQL_URL) {
          graphqlCalls += 1;
          return { ok: false, status: 502, json: async () => null } as unknown as Response;
        }
        throw new Error(`unmocked ghFetch URL: ${url}`);
      });

      const armingOutcome = await armMergeOnApproval(
        db,
        companyId,
        issueId,
        { stageId: "stage-a", stageType: "review", outcome: "approved", body: "LGTM" },
        certifiedPr,
      );

      expect(armingOutcome.kind).toBe("failed");
      expect(armingOutcome.message).toContain("HTTP 502");
      expect(graphqlCalls).toBe(3); // 1 initial + 2 retries
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SUP-16921: head-pinned direct-merge fallback when enablePullRequestAutoMerge
  // refuses a clean-status PR. The measured defect: on a queue-less repo, GitHub
  // returns `errors[0].message = "Pull request Pull request is in clean status"`
  // in a 200 body, and the actuator had no second lever. The fallback merges
  // directly, pinned to publishedHeadSha, using the repo's default merge method.
  // ─────────────────────────────────────────────────────────────────────────
  describe("SUP-16921: clean-status refusal → head-pinned direct merge fallback", () => {
    const GRAPHQL_URL = "https://api.github.com/graphql";
    const REPO_URL = `https://api.github.com/repos/${OWNER}/${REPO}`;
    const PUBLISHED_HEAD = "d38b413a726d93c5ddc2f28a59571afe54d49dce";

    const certifiedPr = {
      id: "obj-125",
      owner: OWNER,
      repo: REPO,
      number: 125,
      nodeId: "PR_node_125",
      headRefName: "SUP-42-branch",
      displayName: `${OWNER}/${REPO}#125`,
      title: "Fix router (SUP-42)",
      cachedState: "open",
      lastErrorCode: null,
      reviewDecision: "APPROVED",
    };

    async function insertApprovedCardWithPublishedHead(publishedHeadSha: string | null) {
      const issueId = await insertIssue({ branchName: "SUP-42-branch" });
      await db
        .update(issues)
        .set({
          executionPolicy: {
            mode: "normal",
            stages: [{ id: "stage-a", type: "review", approvalsNeeded: 1 }],
          },
          executionState: {
            completedStageIds: ["stage-a"],
            lastDecisionOutcome: "approved",
            approvalStatus: {
              publishedHeadSha,
              publishedAt: "2026-09-19T02:12:10.439Z",
            },
          },
        })
        .where(eq(issues.id, issueId));
      return issueId;
    }

    it("falls through to a head-pinned direct merge with the correct expectedHeadOid on a clean-status refusal", async () => {
      const issueId = await insertApprovedCardWithPublishedHead(PUBLISHED_HEAD);

      let graphqlCalls = 0;
      mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === GRAPHQL_URL) {
          graphqlCalls += 1;
          if (graphqlCalls === 1) {
            // enablePullRequestAutoMerge → clean-status refusal in a 200 body
            return {
              ok: true,
              status: 200,
              json: async () => ({
                errors: [{ message: "Pull request Pull request is in clean status" }],
              }),
            } as unknown as Response;
          }
          // mergePullRequest → success
          const body = JSON.parse((init?.body as string) ?? "{}");
          const query = body.query ?? "";
          expect(query).toContain("mergePullRequest");
          expect(query).toContain(`expectedHeadOid: "${PUBLISHED_HEAD}"`);
          expect(query).toContain("mergeMethod: MERGE");
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: { mergePullRequest: { clientMutationId: "mut-125", pullRequest: { merged: true } } },
            }),
          } as unknown as Response;
        }
        if (url === REPO_URL) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ default_merge_method: "merge" }),
          } as unknown as Response;
        }
        throw new Error(`unmocked ghFetch URL: ${url}`);
      });

      const armingOutcome = await armMergeOnApproval(
        db,
        companyId,
        issueId,
        { stageId: "stage-a", stageType: "review", outcome: "approved", body: "LGTM" },
        certifiedPr,
      );

      expect(armingOutcome.kind).toBe("armed");
      expect(armingOutcome.message).toBe(`armed:direct-merge: ${OWNER}/${REPO}#125 (head ${PUBLISHED_HEAD})`);
      expect(graphqlCalls).toBe(2);
    });

    // Round 8 (R7-F1): the direct merge is a CAS on one head; it must be the head the caller VERIFIED.
    const cleanStatusThenMerge = (opts: { onFirst?: () => Promise<void>; mergeQueries: string[] }) =>
      async (url: string, init?: RequestInit) => {
        if (url === GRAPHQL_URL) {
          const query = String(JSON.parse((init?.body as string) ?? "{}").query ?? "");
          if (query.includes("mergePullRequest")) {
            opts.mergeQueries.push(query);
            return { ok: true, status: 200, json: async () => ({ data: { mergePullRequest: { pullRequest: { merged: true } } } }) } as unknown as Response;
          }
          await opts.onFirst?.();
          return { ok: true, status: 200, json: async () => ({ errors: [{ message: "Pull request Pull request is in clean status" }] }) } as unknown as Response;
        }
        if (url === REPO_URL) return { ok: true, status: 200, json: async () => ({ default_merge_method: "merge" }) } as unknown as Response;
        throw new Error(`unmocked ghFetch URL: ${url}`);
      };
    const VERIFIED_HEAD = "e".repeat(40);

    it("does not direct-merge a stale published head when the caller verified another head", async () => {
      const issueId = await insertApprovedCardWithPublishedHead(PUBLISHED_HEAD);
      const mergeQueries: string[] = [];
      mockGhFetch.mockImplementation(cleanStatusThenMerge({ mergeQueries }));

      const armingOutcome = await armMergeOnApproval(
        db, companyId, issueId,
        { stageId: "stage-a", stageType: "review", outcome: "approved", body: "LGTM" },
        certifiedPr,
        { expectedHeadOid: VERIFIED_HEAD },
      );

      expect(armingOutcome.kind).toBe("skipped");
      expect(armingOutcome.message).toContain("skipped:head-mismatch");
      expect(mergeQueries).toEqual([]);
    });

    it("direct-merges exactly the verified head when it is also the published head", async () => {
      const issueId = await insertApprovedCardWithPublishedHead(VERIFIED_HEAD);
      const mergeQueries: string[] = [];
      mockGhFetch.mockImplementation(cleanStatusThenMerge({ mergeQueries }));

      const armingOutcome = await armMergeOnApproval(
        db, companyId, issueId,
        { stageId: "stage-a", stageType: "review", outcome: "approved", body: "LGTM" },
        certifiedPr,
        { expectedHeadOid: VERIFIED_HEAD },
      );

      expect(armingOutcome.kind).toBe("armed");
      expect(mergeQueries).toHaveLength(1);
      expect(mergeQueries[0]).toContain(`expectedHeadOid: "${VERIFIED_HEAD}"`);
    });

    it("does not direct-merge when the card's approval is revoked after the auto-merge attempt", async () => {
      const issueId = await insertApprovedCardWithPublishedHead(VERIFIED_HEAD);
      const mergeQueries: string[] = [];
      mockGhFetch.mockImplementation(cleanStatusThenMerge({
        mergeQueries,
        // The reviewer reverses the decision while the clean-status refusal is in flight.
        onFirst: async () => {
          await db.update(issues).set({
            executionState: {
              completedStageIds: [], lastDecisionOutcome: "changes_requested",
              approvalStatus: { publishedHeadSha: VERIFIED_HEAD },
            },
          }).where(eq(issues.id, issueId));
        },
      }));

      const armingOutcome = await armMergeOnApproval(
        db, companyId, issueId,
        { stageId: "stage-a", stageType: "review", outcome: "approved", body: "LGTM" },
        certifiedPr,
        { expectedHeadOid: VERIFIED_HEAD },
      );

      expect(armingOutcome.kind).toBe("skipped");
      expect(armingOutcome.message).toContain("skipped:authority-changed");
      expect(mergeQueries).toEqual([]);
    });

    // Round 11: a direct merge has no undo, so a head the board released is never direct-merged.
    it("does not direct-merge a head that carries a board-release confirmation", async () => {
      const issueId = await insertApprovedCardWithPublishedHead(VERIFIED_HEAD);
      const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
      const state = row!.executionState as { approvalStatus: Record<string, unknown> };
      await db.update(issues).set({
        executionState: { ...state, approvalStatus: { ...state.approvalStatus, releaseConfirmation: { owner: OWNER, repo: REPO, number: 125, headSha: VERIFIED_HEAD, statusId: "9001" } } },
      }).where(eq(issues.id, issueId));
      const mergeQueries: string[] = [];
      mockGhFetch.mockImplementation(cleanStatusThenMerge({ mergeQueries }));

      const armingOutcome = await armMergeOnApproval(
        db, companyId, issueId,
        { stageId: "stage-a", stageType: "review", outcome: "approved", body: "LGTM" },
        certifiedPr,
        { expectedHeadOid: VERIFIED_HEAD },
      );

      expect(armingOutcome.kind).toBe("skipped");
      expect(armingOutcome.message).toContain("skipped:direct-merge-not-used");
      expect(mergeQueries).toEqual([]);
    });

    it("does not enable auto-merge when the approval record changes before the call", async () => {
      const issueId = await insertApprovedCardWithPublishedHead(VERIFIED_HEAD);
      let graphqlCalls = 0;
      mockGhFetch.mockImplementation(async (url: string) => {
        if (url.endsWith("/pulls/125")) {
          // The PR node-id lookup: the card is cancelled while it runs.
          await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, issueId));
          return { ok: true, status: 200, json: async () => ({ node_id: "PR_node_125" }) } as unknown as Response;
        }
        if (url === GRAPHQL_URL) graphqlCalls += 1;
        throw new Error(`unexpected ghFetch URL: ${url}`);
      });

      const armingOutcome = await armMergeOnApproval(
        db, companyId, issueId,
        { stageId: "stage-a", stageType: "review", outcome: "approved", body: "LGTM" },
        { ...certifiedPr, nodeId: null } as unknown as typeof certifiedPr,
        { expectedHeadOid: VERIFIED_HEAD },
      );

      expect(armingOutcome.kind).toBe("skipped");
      expect(armingOutcome.message).toContain("skipped:authority-changed");
      expect(graphqlCalls).toBe(0);
    });

    // Round 9 (R7-AUTH): the authority the arm acts on is checked before every attempt, including a retry,
    // and again after an accepted enable. Four ways of revoking it, at three moments each.
    describe("a revocation of the card's authority on the same head", () => {
      const AUTH_STAGE = "11111111-1111-4111-8111-111111111111";
      const AUTH_HEAD = "e".repeat(40);
      const revocations: Array<[string, (ctx: { issueId: string; reviewerId: string }) => Promise<void>]> = [
        ["the decision row becomes changes_requested", async ({ issueId }) => {
          await db.update(issueExecutionDecisions).set({ outcome: "changes_requested" }).where(eq(issueExecutionDecisions.issueId, issueId));
        }],
        ["the card's last decision outcome becomes changes_requested", async ({ issueId }) => {
          const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
          await db.update(issues).set({ executionState: { ...(row!.executionState as object), lastDecisionOutcome: "changes_requested" } }).where(eq(issues.id, issueId));
        }],
        ["the certificate is removed", async ({ issueId }) => {
          const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
          const state = row!.executionState as { approvalStatus: Record<string, unknown> };
          const { finalDelivery: _removed, ...rest } = state.approvalStatus;
          await db.update(issues).set({ executionState: { ...state, approvalStatus: rest } }).where(eq(issues.id, issueId));
        }],
        ["the reviewer agent is terminated", async ({ reviewerId }) => {
          await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, reviewerId));
        }],
      ];

      const defaultPromptDelays = [...disarmTiming.promptDelaysMs];
      // The prompt retries are timers; the tests that do not look at them keep them off.
      beforeEach(() => { disarmTiming.promptDelaysMs = []; });
      afterEach(async () => {
        disarmTiming.promptDelaysMs = defaultPromptDelays;
        // Records are instance-wide (the sweep takes them all): none may outlive its test.
        await db.execute(sql`update issues set execution_state = execution_state #- '{approvalStatus,autoMergeDisarm}' where execution_state -> 'approvalStatus' -> 'autoMergeDisarm' is not null`);
        await db.delete(activityLog);
        await db.delete(issueExecutionDecisions);
        await db.delete(agents);
      });

      async function seedAuthorityCard(identifier?: string) {
        const reviewerId = randomUUID();
        await db.insert(agents).values({
          id: reviewerId, companyId, name: "Reviewer", role: "engineer", status: "active", adapterType: "codex_local",
          adapterConfig: {}, runtimeConfig: {}, permissions: {},
        });
        const issueId = await insertIssue({ branchName: "SUP-42-branch", ...(identifier ? { identifier } : {}) });
        const decisionId = randomUUID();
        await db.update(issues).set({
          executionPolicy: { mode: "normal", stages: [{ id: AUTH_STAGE, type: "review", approvalsNeeded: 1 }] },
          executionState: {
            completedStageIds: [AUTH_STAGE], lastDecisionId: decisionId, lastDecisionOutcome: "approved",
            approvalStatus: {
              publishedHeadSha: AUTH_HEAD,
              finalDelivery: { owner: OWNER, repo: REPO, number: 125, headSha: AUTH_HEAD, decisionId },
            },
          },
        }).where(eq(issues.id, issueId));
        await db.insert(issueExecutionDecisions).values({
          id: decisionId, companyId, issueId, stageId: AUTH_STAGE, stageType: "review",
          actorAgentId: reviewerId, actorUserId: null, outcome: "approved", body: "LGTM",
        });
        return { issueId, reviewerId };
      }
      const decide = { stageId: AUTH_STAGE, stageType: "review", outcome: "approved", body: "LGTM" };
      const okBody = () => ({ ok: true, status: 200, json: async () => ({ data: { enablePullRequestAutoMerge: { clientMutationId: "m" } } }) }) as unknown as Response;
      const graphqlQueries = () => mockGhFetch.mock.calls
        .filter(([url]) => url === GRAPHQL_URL)
        .map(([, init]) => String(JSON.parse(String((init as RequestInit).body)).query));
      const enables = () => graphqlQueries().filter((q) => q.includes("enablePullRequestAutoMerge"));
      const disables = () => graphqlQueries().filter((q) => q.includes("disablePullRequestAutoMerge"));

      it.each(revocations)("is refused before the first attempt when %s", async (_name, revoke) => {
        const { issueId, reviewerId } = await seedAuthorityCard();
        mockGhFetch.mockImplementation(async (url: string) => {
          if (url.endsWith("/pulls/125")) {
            await revoke({ issueId, reviewerId }); // while the PR node id is looked up
            return { ok: true, status: 200, json: async () => ({ node_id: "PR_node_125" }) } as unknown as Response;
          }
          throw new Error(`unexpected ghFetch URL: ${url}`);
        });

        const outcome = await armMergeOnApproval(db, companyId, issueId, decide, { ...certifiedPr, nodeId: null } as unknown as typeof certifiedPr, { expectedHeadOid: AUTH_HEAD });

        expect(outcome.kind).toBe("skipped");
        expect(outcome.message).toContain("skipped:authority-changed");
        expect(enables()).toEqual([]);
      });

      it.each(revocations)("is refused before a retry when %s", async (_name, revoke) => {
        const { issueId, reviewerId } = await seedAuthorityCard();
        mockGhFetch.mockImplementation(async (url: string) => {
          if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
          await revoke({ issueId, reviewerId }); // commits as the first attempt answers 502
          return { ok: false, status: 502, json: async () => ({}) } as unknown as Response;
        });

        const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certifiedPr, { expectedHeadOid: AUTH_HEAD });

        expect(outcome.kind).toBe("skipped");
        expect(outcome.message).toContain("skipped:authority-changed");
        expect(enables()).toHaveLength(1);
      });

      it.each(revocations)("takes the arm back when %s while the enable call is in flight", async (_name, revoke) => {
        const { issueId, reviewerId } = await seedAuthorityCard();
        mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
          if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
          if (String(JSON.parse(String(init?.body)).query).includes("enablePullRequestAutoMerge")) await revoke({ issueId, reviewerId });
          return okBody();
        });

        const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certifiedPr, { expectedHeadOid: AUTH_HEAD });

        expect(outcome.kind).toBe("failed");
        expect(outcome.message).toContain("failed:authority-revoked");
        expect(outcome.message).toContain("auto-merge was disabled again");
        expect(enables()).toHaveLength(1);
        expect(disables()).toHaveLength(1);
      });

      // Round 12: the 16-cell matrix release assurance applies (2 consumers x 2 timings x 4 revocations), run against a real
      // database and a fake provider. Each consumer builds its guard the way it does in production (the reconciler's re-arm
      // requires the approved ladder, the done-close backstop does not); both then hand it to the same actuator.
      describe("the 16-cell authority matrix", () => {
        const consumers: Array<[string, (issueId: string) => Promise<Awaited<ReturnType<typeof createAuthorityGuard>>>]> = [
          ["reconciler re-arm", (issueId) => createAuthorityGuard(db, companyId, issueId, { requireApprovedLadder: true, headSha: AUTH_HEAD })],
          ["done-close backstop", (issueId) => createAuthorityGuard(db, companyId, issueId, { headSha: AUTH_HEAD })],
        ];
        const cells = consumers.flatMap(([consumer, guardFor]) =>
          (["before a transient retry", "at the final accepted enable write"] as const).flatMap((timing) =>
            revocations.map(([revocation, revoke]) => ({ consumer, guardFor, timing, revocation, revoke }))));
        expect(cells).toHaveLength(16);

        it.each(cells)("$consumer, change $timing, $revocation", async ({ guardFor, timing, revoke }) => {
          const { issueId, reviewerId } = await seedAuthorityCard();
          const authorityGuard = await guardFor(issueId);
          mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
            const query = String(JSON.parse(String(init?.body)).query);
            if (query.includes("disablePullRequestAutoMerge")) return { ok: true, status: 200, json: async () => ({ data: { disablePullRequestAutoMerge: { clientMutationId: "m" } } }) } as unknown as Response;
            await revoke({ issueId, reviewerId });
            return timing === "before a transient retry" ? ({ ok: false, status: 502, json: async () => ({}) } as unknown as Response) : okBody();
          });

          const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certifiedPr, { expectedHeadOid: AUTH_HEAD, authorityGuard });

          if (timing === "before a transient retry") {
            // Refused before the retry: no enable was ever accepted, nothing to take back.
            expect(outcome.kind).toBe("skipped");
            expect(outcome.message).toContain("skipped:authority-changed");
            expect(disables()).toHaveLength(0);
          } else {
            // The revocation committed inside the accepted call: it is accepted, seen at the recheck and taken back. The window
            // between the guard's last read and GitHub accepting the enable is not closable (no authority compare-and-set).
            expect(outcome.kind).toBe("failed");
            expect(outcome.message).toContain("failed:authority-revoked");
            expect(outcome.message).toContain("auto-merge was disabled again");
            expect(disables()).toHaveLength(1);
          }
          expect(enables()).toHaveLength(1);
          // No cell ever merges directly.
          expect(graphqlQueries().filter((q) => /mergePullRequest/i.test(q))).toHaveLength(0);
          expect(mockGhFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT")).toHaveLength(0);
        });
      });

      it("says so when the arm that was revoked could not be taken back", async () => {
        const { issueId, reviewerId } = await seedAuthorityCard();
        mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
          if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
          const query = String(JSON.parse(String(init?.body)).query);
          if (query.includes("disablePullRequestAutoMerge")) return { ok: false, status: 502, json: async () => ({}) } as unknown as Response;
          await revocations[0]![1]({ issueId, reviewerId });
          return okBody();
        });

        const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certifiedPr, { expectedHeadOid: AUTH_HEAD });

        expect(outcome.kind).toBe("failed");
        expect(outcome.message).toContain("could NOT be disabled");
      });

      // Round 11: an accepted arm that could not be turned off is never left silently in force.
      const failingDisable = (revoke: () => Promise<void>, disableAnswer: () => Response) =>
        async (url: string, init?: RequestInit) => {
          if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
          const query = String(JSON.parse(String(init?.body)).query);
          if (query.includes("disablePullRequestAutoMerge")) return disableAnswer();
          await revoke();
          return okBody();
        };
      const forbidden = () => ({ ok: false, status: 403, json: async () => ({ errors: [{ message: "Resource not accessible by integration" }] }) }) as unknown as Response;
      const disarmRecord = async (issueId: string) => {
        const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
        return (row!.executionState as { approvalStatus?: { autoMergeDisarm?: Record<string, unknown> } }).approvalStatus?.autoMergeDisarm;
      };

      it("keeps a failed take-back on the card, and a later tick turns auto-merge off and clears it", async () => {
        const { issueId, reviewerId } = await seedAuthorityCard();
        mockGhFetch.mockImplementation(failingDisable(() => revocations[0]![1]({ issueId, reviewerId }), forbidden));

        const outcome = await armMergeOnApproval(db, companyId, issueId, decide, { ...certifiedPr, nodeId: "PR_node_125" } as typeof certifiedPr, { expectedHeadOid: AUTH_HEAD });

        expect(outcome.kind).toBe("failed");
        expect(outcome.message).toContain("STILL ENABLED");
        expect(outcome.message).toContain("on every reconciler tick");
        expect(await disarmRecord(issueId)).toMatchObject({ owner: OWNER, repo: REPO, number: 125, nodeId: "PR_node_125", attempts: 1 });

        mockGhFetch.mockReset();
        mockGhFetch.mockImplementation(async (url: string) => {
          if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
          return { ok: true, status: 200, json: async () => ({ data: { disablePullRequestAutoMerge: { clientMutationId: "m" } } }) } as unknown as Response;
        });
        const summary = await retryPendingAutoMergeDisarms(db);

        expect(summary).toMatchObject({ checked: 1, disabled: 1, stillArmed: 0 });
        expect(disables()).toHaveLength(1);
        expect(await disarmRecord(issueId)).toBeUndefined();
      });

      it("keeps retrying every round while GitHub refuses, and says so loudly", async () => {
        const { issueId, reviewerId } = await seedAuthorityCard();
        mockGhFetch.mockImplementation(failingDisable(() => revocations[0]![1]({ issueId, reviewerId }), forbidden));
        await armMergeOnApproval(db, companyId, issueId, decide, { ...certifiedPr, nodeId: "PR_node_125" } as typeof certifiedPr, { expectedHeadOid: AUTH_HEAD });
        mockGhFetch.mockReset();
        mockGhFetch.mockImplementation(async () => forbidden());

        const first = await retryPendingAutoMergeDisarms(db);
        const second = await retryPendingAutoMergeDisarms(db);

        expect(first).toMatchObject({ checked: 1, disabled: 0, stillArmed: 1 });
        expect(second).toMatchObject({ checked: 1, disabled: 0, stillArmed: 1 });
        expect(await disarmRecord(issueId)).toMatchObject({ attempts: 3, lastError: "Resource not accessible by integration" });
        const rows = await db.select().from(activityLog);
        expect(rows.filter((row) => row.action === "issue.merge_disarm_failed")).toHaveLength(2);
      });

      it("retries a pending take-back on every reconciler tick", async () => {
        const { issueId, reviewerId } = await seedAuthorityCard();
        mockGhFetch.mockImplementation(failingDisable(() => revocations[0]![1]({ issueId, reviewerId }), forbidden));
        await armMergeOnApproval(db, companyId, issueId, decide, { ...certifiedPr, nodeId: "PR_node_125" } as typeof certifiedPr, { expectedHeadOid: AUTH_HEAD });
        mockGhFetch.mockReset();
        mockGhFetch.mockImplementation(async (url: string) => {
          if (url !== GRAPHQL_URL) return { ok: true, status: 200, json: async () => ([]) } as unknown as Response;
          return { ok: true, status: 200, json: async () => ({ data: { disablePullRequestAutoMerge: { clientMutationId: "m" } } }) } as unknown as Response;
        });

        const summary = await runApprovalStatusReconcilerTick(db);

        expect(summary.disarm).toMatchObject({ checked: 1, disabled: 1 });
        expect(await disarmRecord(issueId)).toBeUndefined();
      });

      // Round 13 (R10-AUTH-DISABLE): the take-back record is written BEFORE the enable call, the backlog is capped at
      // admission (an arm is refused, a disable is never dropped), and a restart resumes what the last process left.
      describe("the take-back record written before the arm", () => {
        const certified = () => ({ ...certifiedPr, nodeId: "PR_node_125" }) as typeof certifiedPr;
        const disableOk = () => ({ ok: true, status: 200, json: async () => ({ data: { disablePullRequestAutoMerge: { clientMutationId: "m" } } }) }) as unknown as Response;
        const inFlightRecord = async (issueId: string, since: string, extra: Record<string, unknown> = {}) => {
          const guard = await createAuthorityGuard(db, companyId, issueId, { requireApprovedLadder: true, headSha: AUTH_HEAD });
          await recordPendingAutoMergeDisarm(db, companyId, issueId, {
            owner: OWNER, repo: REPO, number: 125, nodeId: "PR_node_125", headSha: AUTH_HEAD, reason: "arm in flight",
            since, attempts: 0, lastError: null, state: "in_flight", token: "tok", baseline: guard.baseline, requireApprovedLadder: true, ...extra,
          });
        };
        afterEach(() => { disarmBacklog.cap = 50; disarmTiming.inFlightGraceMs = 120_000; });

        it("is on the card while GitHub is asked to enable, and gone once the arm stands", async () => {
          const { issueId } = await seedAuthorityCard();
          let seen: Record<string, unknown> | undefined;
          mockGhFetch.mockImplementation(async (url: string) => {
            if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
            seen = await disarmRecord(issueId);
            return okBody();
          });

          const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certified(), { expectedHeadOid: AUTH_HEAD });

          expect(outcome.kind).toBe("armed");
          expect(seen).toMatchObject({ state: "in_flight", nodeId: "PR_node_125", headSha: AUTH_HEAD, requireApprovedLadder: true });
          expect(typeof seen?.token).toBe("string");
          expect(typeof seen?.baseline).toBe("string");
          expect(await disarmRecord(issueId)).toBeUndefined();
        });

        it("arms nothing when the record cannot be written", async () => {
          const { issueId } = await seedAuthorityCard();
          await db.execute(sql`create or replace function r13_block_record() returns trigger as $$ begin raise exception 'r13 database unavailable'; end $$ language plpgsql`);
          await db.execute(sql`create trigger r13_block before update on issues for each row when (new.execution_state -> 'approvalStatus' -> 'autoMergeDisarm' is not null) execute function r13_block_record()`);
          mockGhFetch.mockImplementation(async () => okBody());
          try {
            const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certified(), { expectedHeadOid: AUTH_HEAD });
            expect(outcome.kind).toBe("failed");
            expect(outcome.message).toContain("failed:disarm-record-unavailable");
            expect(enables()).toHaveLength(0);
          } finally {
            await db.execute(sql`drop trigger r13_block on issues`);
          }
        });

        for (const [label, revoke] of [["the authority changed", true], ["the authority still holds", false]] as const) {
          it(`keeps the record when GitHub gives no answer, and the sweep takes the arm back when ${label}`, async () => {
            disarmTiming.inFlightGraceMs = 0;
            const { issueId, reviewerId } = await seedAuthorityCard();
            mockGhFetch.mockImplementation(async () => { throw new TypeError("fetch failed: ECONNRESET"); });
            const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certified(), { expectedHeadOid: AUTH_HEAD });
            expect(outcome.message).toContain("failed:");
            expect(await disarmRecord(issueId)).toMatchObject({ state: "in_flight" });
            if (revoke) await revocations[3]![1]({ issueId, reviewerId });
            mockGhFetch.mockReset();
            mockGhFetch.mockImplementation(async (url: string) => { if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`); return disableOk(); });

            const summary = await retryPendingAutoMergeDisarms(db);

            expect(summary).toMatchObject({ checked: 1, disabled: 1 });
            expect(disables()).toHaveLength(1);
            expect(await disarmRecord(issueId)).toBeUndefined();
          });
        }

        it("takes back an arm a previous process left in flight whatever the authority is now, and leaves a young record alone", async () => {
          const old = await seedAuthorityCard("SUP-952");
          const young = await seedAuthorityCard("SUP-953");
          const unchanged = await seedAuthorityCard("SUP-954");
          await inFlightRecord(old.issueId, new Date(Date.now() - 10 * 60_000).toISOString());
          await inFlightRecord(young.issueId, new Date().toISOString());
          await inFlightRecord(unchanged.issueId, new Date(Date.now() - 10 * 60_000).toISOString());
          await revocations[0]![1]({ issueId: old.issueId, reviewerId: old.reviewerId });
          await revocations[0]![1]({ issueId: young.issueId, reviewerId: young.reviewerId });
          mockGhFetch.mockImplementation(async (url: string) => { if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`); return disableOk(); });

          const summary = await retryPendingAutoMergeDisarms(db);

          expect(summary).toMatchObject({ checked: 2, disabled: 2 });
          expect(disables()).toHaveLength(2);
          expect(await disarmRecord(old.issueId)).toBeUndefined();
          expect(await disarmRecord(unchanged.issueId)).toBeUndefined();
          expect(await disarmRecord(young.issueId)).toMatchObject({ state: "in_flight" });
        });

        for (const [label, result] of [
          ["timed out", { success: false, error: "timeout after 10000ms", status: 0 }],
          ["failed on the network", { success: false, error: "network_error", status: 0 }],
          ["got a 502", { success: false, error: "HTTP 502", status: 502 }],
        ] as const) {
          it(`keeps the record when the enable call ${label}: the arm may be in force`, async () => {
            const { issueId } = await seedAuthorityCard();
            const guard = await createAuthorityGuard(db, companyId, issueId, { requireApprovedLadder: true, headSha: AUTH_HEAD });
            const opening = await openArmRecord(db, companyId, issueId, { owner: OWNER, repo: REPO, number: 125 }, "test", "PR_node_125", AUTH_HEAD, guard);
            if (!opening.ok) throw new Error(opening.message);

            await opening.settleEnable(result);

            expect(await disarmRecord(issueId)).toMatchObject({ state: "in_flight" });
          });
        }

        it("drops the record when GitHub refused the enable call", async () => {
          const { issueId } = await seedAuthorityCard();
          const guard = await createAuthorityGuard(db, companyId, issueId, { requireApprovedLadder: true, headSha: AUTH_HEAD });
          const opening = await openArmRecord(db, companyId, issueId, { owner: OWNER, repo: REPO, number: 125 }, "test", "PR_node_125", AUTH_HEAD, guard);
          if (!opening.ok) throw new Error(opening.message);

          await opening.settleEnable({ success: false, error: "Resource not accessible", status: 403 });

          expect(await disarmRecord(issueId)).toBeUndefined();
        });

        it("refuses a second arm while the card holds a record", async () => {
          const { issueId } = await seedAuthorityCard();
          await inFlightRecord(issueId, new Date().toISOString());
          mockGhFetch.mockImplementation(async () => okBody());

          const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certified(), { expectedHeadOid: AUTH_HEAD });

          expect(outcome.kind).toBe("skipped");
          expect(outcome.message).toContain("skipped:arm-in-progress");
          expect(enables()).toHaveLength(0);
        });

        it("refuses to arm at the backlog cap and still takes every recorded arm back", async () => {
          disarmBacklog.cap = 2;
          const waiting: string[] = [];
          for (let i = 0; i < 2; i++) {
            const { issueId } = await seedAuthorityCard(`SUP-${960 + i}`);
            await recordPendingAutoMergeDisarm(db, companyId, issueId, {
              owner: OWNER, repo: REPO, number: 300 + i, nodeId: `PR_node_${300 + i}`, headSha: AUTH_HEAD, reason: "test",
              since: new Date().toISOString(), attempts: 1, lastError: "x", lastAttemptAt: new Date().toISOString(), state: "pending",
            });
            waiting.push(issueId);
          }
          const { issueId } = await seedAuthorityCard();
          mockGhFetch.mockImplementation(async () => okBody());

          const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certified(), { expectedHeadOid: AUTH_HEAD });

          expect(outcome.kind).toBe("failed");
          expect(outcome.message).toContain("failed:disarm-backlog-full");
          expect(enables()).toHaveLength(0);
          mockGhFetch.mockReset();
          mockGhFetch.mockImplementation(async (url: string) => { if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`); return disableOk(); });
          const summary = await retryPendingAutoMergeDisarms(db);
          expect(summary).toMatchObject({ checked: 2, disabled: 2, pending: 2 });
          for (const id of waiting) expect(await disarmRecord(id)).toBeUndefined();
        });

        it("holds the cap under concurrent admissions and a default sweep tries every record at it", async () => {
          disarmBacklog.cap = 7;
          const cards: string[] = [];
          for (let i = 0; i < 20; i++) cards.push((await seedAuthorityCard(`SUP-${1100 + i}`)).issueId);
          const opened = await Promise.all(cards.map((issueId, i) => openArmInFlight(db, companyId, issueId, {
            owner: OWNER, repo: REPO, number: 500 + i, nodeId: `PR_node_${500 + i}`, headSha: AUTH_HEAD, reason: "arm in flight",
            since: new Date().toISOString(), attempts: 0, lastError: null, state: "in_flight", token: `t${i}`,
          })));
          expect(opened.filter((r) => r === "recorded")).toHaveLength(7);
          expect(opened.filter((r) => r === "full")).toHaveLength(13);
          disarmTiming.inFlightGraceMs = 0;
          mockGhFetch.mockImplementation(async (url: string) => { if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`); return disableOk(); });

          const summary = await retryPendingAutoMergeDisarms(db);

          expect(summary).toMatchObject({ checked: 7, disabled: 7, pending: 7 });
          for (const id of cards) expect(await disarmRecord(id)).toBeUndefined();
        });

        describe("a take-back GitHub never confirms", () => {
          afterEach(() => { disarmEscalation.afterMs = 15 * 60_000; });
          const refuse = () => mockGhFetch.mockImplementation(async (url: string) => {
            if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
            return { ok: false, status: 403, json: async () => ({ errors: [{ message: "Resource not accessible" }] }) } as unknown as Response;
          });

          it("is escalated once past the deadline, by the sweep, and no control-plane arm gets through meanwhile", async () => {
            disarmEscalation.afterMs = 60_000;
            const { issueId } = await seedAuthorityCard();
            await recordPendingAutoMergeDisarm(db, companyId, issueId, {
              owner: OWNER, repo: REPO, number: 125, nodeId: "PR_node_125", headSha: AUTH_HEAD, reason: "authority revoked",
              since: new Date(Date.now() - 10 * 60_000).toISOString(), attempts: 5, lastError: "x", lastAttemptAt: new Date().toISOString(), state: "pending",
            });
            refuse();

            await retryPendingAutoMergeDisarms(db);
            await retryPendingAutoMergeDisarms(db);

            expect(await disarmRecord(issueId)).toMatchObject({ state: "pending", attempts: 7, escalatedAt: expect.any(String) });
            const rows = await db.select({ action: activityLog.action, details: activityLog.details }).from(activityLog).where(eq(activityLog.action, "issue.merge_disarm_escalated"));
            expect(rows).toHaveLength(1);
            expect(rows[0]!.details).toMatchObject({ needsHuman: true });
            mockGhFetch.mockClear();
            const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certified(), { expectedHeadOid: AUTH_HEAD });
            expect(outcome.kind).toBe("failed");
            expect(outcome.message).toContain("failed:disarm-escalated");
            expect(enables()).toHaveLength(0);
          });

          it("refuses every arm past the deadline with no sweep having run at all, and is cleared by a confirmed disable", async () => {
            disarmEscalation.afterMs = 60_000;
            const { issueId } = await seedAuthorityCard();
            await recordPendingAutoMergeDisarm(db, companyId, issueId, {
              owner: OWNER, repo: REPO, number: 125, nodeId: "PR_node_125", headSha: AUTH_HEAD, reason: "authority revoked",
              since: new Date(Date.now() - 10 * 60_000).toISOString(), attempts: 1, lastError: "x", lastAttemptAt: new Date().toISOString(), state: "pending",
            });
            mockGhFetch.mockImplementation(async () => okBody());

            const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certified(), { expectedHeadOid: AUTH_HEAD });

            expect(outcome.message).toContain("failed:disarm-escalated");
            expect(enables()).toHaveLength(0);
            mockGhFetch.mockReset();
            mockGhFetch.mockImplementation(async (url: string) => { if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`); return disableOk(); });
            await retryPendingAutoMergeDisarms(db);
            expect(await disarmRecord(issueId)).toBeUndefined();
          });

          it("is not escalated before the deadline", async () => {
            const { issueId } = await seedAuthorityCard();
            await recordPendingAutoMergeDisarm(db, companyId, issueId, {
              owner: OWNER, repo: REPO, number: 125, nodeId: "PR_node_125", headSha: AUTH_HEAD, reason: "authority revoked",
              since: new Date(Date.now() - 60_000).toISOString(), attempts: 1, lastError: "x", lastAttemptAt: new Date().toISOString(), state: "pending",
            });
            refuse();

            await retryPendingAutoMergeDisarms(db);

            expect((await disarmRecord(issueId))?.escalatedAt).toBeFalsy();
            const rows = await db.select({ id: activityLog.id }).from(activityLog).where(eq(activityLog.action, "issue.merge_disarm_escalated"));
            expect(rows).toHaveLength(0);
          });
        });

        // Round 15 (R10-AUTH-DISABLE, persistent failure): while GitHub will not turn auto-merge off, the head's
        // paperclip/approved is set to failure over REST, a second route, so the armed PR cannot merge.
        describe("a take-back GitHub keeps refusing: the second route fences the head", () => {
          const statusPosts = () => mockGhFetch.mock.calls.filter(([url, init]) =>
            url !== GRAPHQL_URL && /\/statuses\//.test(String(url)) && (init as RequestInit | undefined)?.method === "POST");
          const created = () => ({ ok: true, status: 201, json: async () => ({ id: 555 }) }) as unknown as Response;
          const refusal = (status: number, message: string) => () =>
            ({ ok: false, status, json: async () => ({ errors: [{ message }], message }) }) as unknown as Response;
          const provider = (disable: () => Promise<Response> | Response, statuses: () => Response = created, pull?: () => Response) =>
            async (url: string, init?: RequestInit) => {
              if (url === GRAPHQL_URL) {
                if (String(JSON.parse(String(init?.body)).query).includes("disablePullRequestAutoMerge")) return disable();
                throw new Error("unexpected enable");
              }
              if (/\/statuses\//.test(url)) return statuses();
              if (pull && url.endsWith("/pulls/125")) return pull();
              throw new Error(`unexpected ghFetch URL: ${url}`);
            };
          const hang = () => new Promise<Response>(() => {});
          const revokedRecord = (issueId: string, extra: Record<string, unknown> = {}) => recordPendingAutoMergeDisarm(db, companyId, issueId, {
            owner: OWNER, repo: REPO, number: 125, nodeId: "PR_node_125", headSha: AUTH_HEAD, reason: "authority revoked",
            since: new Date().toISOString(), attempts: 1, lastError: "x", lastAttemptAt: new Date().toISOString(), state: "pending", ...extra,
          });
          afterEach(() => { disarmTiming.disableTimeoutMs = 10_000; disarmEscalation.afterMs = 15 * 60_000; });

          // The independent provider statuses the disable can answer with, each entered through the real sweep.
          for (const [label, answer, lastError] of [
            ["403", refusal(403, "Resource not accessible by integration"), "Resource not accessible by integration"],
            ["422", refusal(422, "Pull request is not in a mergeable state"), "Pull request is not in a mergeable state"],
            ["503", refusal(503, "Service Unavailable"), "Service Unavailable"],
            ["a request that never answers", hang, "timeout after 80ms"],
          ] as const) {
            it(`${label}: keeps the record, sets the head's paperclip/approved to failure once, and clears when GitHub recovers`, async () => {
              disarmTiming.disableTimeoutMs = 80;
              const { issueId } = await seedAuthorityCard();
              await revokedRecord(issueId);
              mockGhFetch.mockImplementation(provider(answer));

              const first = await retryPendingAutoMergeDisarms(db);
              const second = await retryPendingAutoMergeDisarms(db);

              expect(first).toMatchObject({ checked: 1, disabled: 0, stillArmed: 1 });
              expect(second).toMatchObject({ checked: 1, disabled: 0, stillArmed: 1 });
              expect(await disarmRecord(issueId)).toMatchObject({ state: "pending", attempts: 3, lastError, fencedAt: expect.any(String), fenceError: null });
              const posts = statusPosts();
              expect(posts).toHaveLength(1);
              expect(String(posts[0]![0])).toContain(`/statuses/${AUTH_HEAD}`);
              expect(JSON.parse(String((posts[0]![1] as RequestInit).body))).toMatchObject({ state: "failure", context: "paperclip/approved" });
              const fenced = (await db.select().from(activityLog)).filter((row) => row.action === "issue.merge_disarm_fenced");
              expect(fenced).toHaveLength(1);

              mockGhFetch.mockReset();
              mockGhFetch.mockImplementation(provider(disableOk));
              expect(await retryPendingAutoMergeDisarms(db)).toMatchObject({ checked: 1, disabled: 1 });
              expect(await disarmRecord(issueId)).toBeUndefined();
              expect(statusPosts()).toHaveLength(0);
            });
          }

          it("keeps trying the fence every round while the status route refuses too, and says so", async () => {
            const { issueId } = await seedAuthorityCard();
            await revokedRecord(issueId);
            mockGhFetch.mockImplementation(provider(refusal(403, "Resource not accessible by integration"), refusal(403, "statuses refused")));

            await retryPendingAutoMergeDisarms(db);
            const afterFirst = await disarmRecord(issueId);
            expect(afterFirst?.fencedAt).toBeFalsy();
            expect(afterFirst).toMatchObject({ attempts: 2, fenceError: expect.stringContaining("statuses refused") });
            await retryPendingAutoMergeDisarms(db);
            expect(statusPosts()).toHaveLength(2);

            mockGhFetch.mockReset();
            mockGhFetch.mockImplementation(provider(refusal(403, "Resource not accessible by integration")));
            await retryPendingAutoMergeDisarms(db);
            expect(await disarmRecord(issueId)).toMatchObject({ attempts: 4, fencedAt: expect.any(String), fenceError: null });
            const failedRows = (await db.select().from(activityLog)).filter((row) => row.action === "issue.merge_disarm_failed");
            expect(failedRows.some((row) => (row.details as Record<string, unknown>).fenced === false)).toBe(true);
          });

          it("reads the live head when the record has none", async () => {
            const { issueId } = await seedAuthorityCard();
            await revokedRecord(issueId, { headSha: null });
            const live = "f".repeat(40);
            mockGhFetch.mockImplementation(provider(refusal(503, "Service Unavailable"), created, () =>
              ({ ok: true, status: 200, json: async () => ({ head: { sha: live, ref: "SUP-42-branch" }, state: "open", draft: false, merged: false }) }) as unknown as Response));

            await retryPendingAutoMergeDisarms(db);

            expect(statusPosts().map(([url]) => String(url))).toEqual([expect.stringContaining(`/statuses/${live}`)]);
            expect(await disarmRecord(issueId)).toMatchObject({ fencedAt: expect.any(String) });
          });

          it("waits for the escalation deadline before fencing an arm that was only left in flight, then fences and alerts", async () => {
            disarmTiming.inFlightGraceMs = 0;
            const { issueId } = await seedAuthorityCard();
            await inFlightRecord(issueId, new Date(Date.now() - 60_000).toISOString());
            mockGhFetch.mockImplementation(provider(refusal(503, "Service Unavailable")));

            await retryPendingAutoMergeDisarms(db);

            expect(statusPosts()).toHaveLength(0);
            const beforeDeadline = await disarmRecord(issueId);
            expect(beforeDeadline?.fencedAt).toBeFalsy();
            expect(beforeDeadline).toMatchObject({ state: "pending" });
            disarmEscalation.afterMs = 30_000;
            await retryPendingAutoMergeDisarms(db);
            expect(statusPosts()).toHaveLength(1);
            expect(await disarmRecord(issueId)).toMatchObject({ fencedAt: expect.any(String), escalatedAt: expect.any(String) });
            const alerts = (await db.select().from(activityLog)).filter((row) => row.action === "issue.merge_disarm_escalated");
            expect(alerts).toHaveLength(1);
            expect(alerts[0]!.details).toMatchObject({ needsHuman: true, fenced: true });
          });

          it("fences inline, in the arming process, when the take-back right after a revoked arm is refused (no sweep, no scheduler)", async () => {
            const { issueId, reviewerId } = await seedAuthorityCard();
            mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
              if (/\/statuses\//.test(url)) return created();
              if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
              if (String(JSON.parse(String(init?.body)).query).includes("disablePullRequestAutoMerge")) return refusal(503, "Service Unavailable")();
              await revocations[0]![1]({ issueId, reviewerId });
              return okBody();
            });

            const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certified(), { expectedHeadOid: AUTH_HEAD });

            expect(outcome.message).toContain("STILL ENABLED");
            expect(outcome.message).toContain("set to failure");
            expect(statusPosts()).toHaveLength(1);
            expect(JSON.parse(String((statusPosts()[0]![1] as RequestInit).body))).toMatchObject({ state: "failure", context: "paperclip/approved" });
            expect(await disarmRecord(issueId)).toMatchObject({ state: "pending", fencedAt: expect.any(String) });
          });

          it("says when the inline fence could not be written either", async () => {
            const { issueId, reviewerId } = await seedAuthorityCard();
            mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
              if (/\/statuses\//.test(url)) return refusal(403, "statuses refused")();
              if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
              if (String(JSON.parse(String(init?.body)).query).includes("disablePullRequestAutoMerge")) return refusal(503, "Service Unavailable")();
              await revocations[0]![1]({ issueId, reviewerId });
              return okBody();
            });

            const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certified(), { expectedHeadOid: AUTH_HEAD });

            expect(outcome.message).toContain("could NOT be set to failure");
            const record = await disarmRecord(issueId);
            expect(record?.fencedAt).toBeFalsy();
            expect(record).toMatchObject({ fenceError: expect.stringContaining("statuses refused") });
          });
        });

        // Round 16 (R10-AUTH-DISABLE, both routes refused): the arm gate is written BEFORE the enable, while GitHub answers. When the
        // take-back (GraphQL) and every write made after the arm (REST) are refused, it is still there, the REAL enforcer script
        // refuses the head on merge_group, and the card is blocked until a disable is confirmed.
        describe("a take-back refused over both routes: the arm gate holds the head and the card", () => {
          const CONTROL_PLANE = { id: 317012809, login: "tea-core[bot]", type: "Bot" };
          const scriptPath = fileURLToPath(new URL("../../../scripts/ci/check-paperclip-approved.sh", import.meta.url));
          const repoRoot = path.resolve(path.dirname(scriptPath), "..", "..");
          const GH_SHIM = [
            "#!/usr/bin/env bash", "set -euo pipefail", 'url=""', 'jqfilter=""',
            'while [ "$#" -gt 0 ]; do', '  case "$1" in', "    api|--slurp|--paginate) ;;", "    -H) shift ;;", '    --jq|-q) shift; jqfilter="$1" ;;', '    *) [ -n "$url" ] || url="$1" ;;', "  esac", "  shift", "done",
            'case "$url" in', '  */statuses*) jq -r "$jqfilter" "$GH_SHIM_DIR/statuses.json" ;;', "  */pulls/*/reviews*) echo '[]' ;;", '  */pulls/*) cat "$GH_SHIM_DIR/pull.json" ;;', '  *) echo "gh shim: unexpected call: $url" >&2; exit 1 ;;', "esac", "",
          ].join("\n");
          // The statuses GitHub holds on the head, newest first, as the real script reads them: the stamp the arm stood on, then what the control plane wrote.
          const githubStatuses = () => [
            ...armGateFake.writes.filter((w) => w.accepted).reverse().map((w, i) => ({ id: 100 + i, context: w.context, state: w.state, description: w.description, creator: CONTROL_PLANE })),
            { id: 1, context: "paperclip/approved", state: "success", description: "approved via Paperclip", creator: CONTROL_PLANE },
          ];
          const enforcer = (statuses: unknown[]) => {
            const dir = mkdtempSync(path.join(tmpdir(), "pc-armgate-"));
            try {
              writeFileSync(path.join(dir, "pull.json"), JSON.stringify({ head: { sha: AUTH_HEAD, ref: "SUP-42-branch" }, title: "", body: "", labels: [], user: { login: "operator", type: "User" } }));
              writeFileSync(path.join(dir, "statuses.json"), JSON.stringify(statuses));
              mkdirSync(path.join(dir, "bin"));
              writeFileSync(path.join(dir, "bin", "gh"), GH_SHIM);
              chmodSync(path.join(dir, "bin", "gh"), 0o755);
              const queueRef = "refs/heads/gh-readonly-queue/fold/tea-patches-v2026.722.0/pr-4242-0123456789abcdef";
              return spawnSync("bash", [scriptPath, "merge_group"], {
                cwd: repoRoot, encoding: "utf8",
                env: { ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, GH_SHIM_DIR: dir, GH_REPO: `${OWNER}/${REPO}`, PAPERCLIP_APPROVED_STATUS_CREATOR_ID: String(CONTROL_PLANE.id), PAPERCLIP_APPROVED_STATUS_CREATOR_LOGIN: CONTROL_PLANE.login, GITHUB_REF: queueRef, GITHUB_REF_NAME: queueRef.replace("refs/heads/", "") },
              }).status;
            } finally { rmSync(dir, { recursive: true, force: true }); }
          };
          const refuseFrom = (state: string, status = 403) => {
            armGateFake.answer = (body) => body.state === state
              ? ({ ok: false, status, json: async () => ({ message: "Resource not accessible by integration" }) }) as unknown as Response
              : armGateFake.created();
          };
          const refusal = (status: number, message: string) => () => ({ ok: false, status, json: async () => ({ errors: [{ message }], message }) }) as unknown as Response;
          afterEach(() => { disarmTiming.disableTimeoutMs = 10_000; });

          // The arm is accepted without authority; GraphQL refuses the take-back; the REST fence is refused; the closing gate write is refused.
          const armUnderBothRefusals = async () => {
            const { issueId, reviewerId } = await seedAuthorityCard();
            refuseFrom("success");
            mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
              if (/\/statuses\//.test(url)) return refusal(403, "statuses refused")();
              if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
              if (String(JSON.parse(String(init?.body)).query).includes("disablePullRequestAutoMerge")) return refusal(503, "Service Unavailable")();
              await revocations[0]![1]({ issueId, reviewerId });
              return okBody();
            });
            const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certified(), { expectedHeadOid: AUTH_HEAD });
            expect(outcome.message).toContain("STILL ENABLED");
            return issueId;
          };

          for (const [label, answer, disableTimeoutMs] of [
            ["403", refusal(403, "Resource not accessible by integration"), 10_000],
            ["422", refusal(422, "Pull request is not in a mergeable state"), 10_000],
            ["503", refusal(503, "Service Unavailable"), 10_000],
            ["a request that never answers", () => new Promise<Response>(() => {}), 80],
          ] as const) {
            it(`${label}: the gate written before the arm is the newest status, the real enforcer refuses the head, and the card is blocked`, async () => {
              disarmTiming.disableTimeoutMs = disableTimeoutMs;
              const issueId = await armUnderBothRefusals();
              mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
                if (/\/statuses\//.test(url)) return refusal(403, "statuses refused")();
                if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
                if (String(JSON.parse(String(init?.body)).query).includes("disablePullRequestAutoMerge")) return answer();
                throw new Error("unexpected enable");
              });

              await retryPendingAutoMergeDisarms(db);
              await retryPendingAutoMergeDisarms(db);

              // The opening write is the only gate write: the arm never settled, so the closing success was never even tried.
              expect(armGateFake.writes[0]).toMatchObject({ state: "failure", context: "paperclip/arm-gate" });
              expect(armGateFake.writes.filter((w) => w.state === "success")).toEqual([]);
              expect(githubStatuses()[0]).toMatchObject({ context: "paperclip/arm-gate", state: "failure" });
              expect(enforcer(githubStatuses())).not.toBe(0);
              expect(await disarmRecord(issueId)).toMatchObject({ state: "pending" });
              // The card is blocked: nothing is published for it and no arm goes through.
              const published = await publishApprovalStatus(db, companyId, issueId, "SUP-42");
              expect(published.message).toContain("arm-unsettled");
              const second = await armMergeOnApproval(db, companyId, issueId, decide, certified(), { expectedHeadOid: AUTH_HEAD });
              expect(second.kind).not.toBe("armed");
              expect(enables()).toHaveLength(1);
            });
          }

          it("opens the gate again on recovery: a confirmed disable closes it, the record goes, the enforcer passes", async () => {
            const issueId = await armUnderBothRefusals();
            armGateFake.answer = armGateFake.created;
            mockGhFetch.mockImplementation(async (url: string) => { if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`); return disableOk(); });

            const summary = await retryPendingAutoMergeDisarms(db);

            expect(summary).toMatchObject({ checked: 1, disabled: 1 });
            expect(await disarmRecord(issueId)).toBeUndefined();
            expect(armGateFake.writes.at(-1)).toMatchObject({ state: "success", accepted: true });
            // The stamp the arm stood on is a success and the gate is closed: the real script passes it.
            expect(enforcer(githubStatuses())).toBe(0);
          });

          it("a PR closed before the take-back lands ends the record and closes the gate, so a reopened head passes the enforcer", async () => {
            const issueId = await armUnderBothRefusals();
            armGateFake.answer = armGateFake.created;
            mockGhFetch.mockImplementation(async (url: string) => { if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`); return refusal(422, "Pull request is closed")(); });

            const summary = await retryPendingAutoMergeDisarms(db);

            expect(summary).toMatchObject({ checked: 1 });
            expect(await disarmRecord(issueId)).toBeUndefined();
            expect(armGateFake.writes.at(-1)).toMatchObject({ context: "paperclip/arm-gate", state: "success", accepted: true });
            expect(enforcer(githubStatuses())).toBe(0);
          });

          it("keeps the record marked gateClosing when the closing write for a closed PR is refused, and the sweep closes it later", async () => {
            const issueId = await armUnderBothRefusals();
            refuseFrom("success");
            mockGhFetch.mockImplementation(async (url: string) => { if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`); return refusal(422, "Pull request is closed")(); });

            await retryPendingAutoMergeDisarms(db);

            expect(await disarmRecord(issueId)).toMatchObject({ gateClosing: true, state: "pending" });
            expect(enforcer(githubStatuses())).not.toBe(0);

            armGateFake.answer = armGateFake.created;
            await retryPendingAutoMergeDisarms(db);

            expect(await disarmRecord(issueId)).toBeUndefined();
            expect(enforcer(githubStatuses())).toBe(0);
          });

          it("an arm that stands with its authority closes the gate; if the closing write is refused the record stays and the sweep closes it", async () => {
            const { issueId } = await seedAuthorityCard();
            refuseFrom("success");
            mockGhFetch.mockImplementation(async (url: string) => { if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`); return okBody(); });

            const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certified(), { expectedHeadOid: AUTH_HEAD });

            expect(outcome.kind).toBe("armed");
            expect(await disarmRecord(issueId)).toMatchObject({ gateClosing: true, state: "pending" });
            expect(enforcer(githubStatuses())).not.toBe(0);

            armGateFake.answer = armGateFake.created;
            const summary = await retryPendingAutoMergeDisarms(db);

            expect(summary).toMatchObject({ checked: 1, disabled: 1 });
            expect(await disarmRecord(issueId)).toBeUndefined();
            expect(disables()).toHaveLength(0);
            const rows = (await db.select().from(activityLog)).filter((row) => row.action === "issue.merge_gate_closed");
            expect(rows).toHaveLength(1);
            expect(enforcer(githubStatuses())).toBe(0);
          });

          it("arms nothing when the gate cannot be written before the enable, and closes it later", async () => {
            const { issueId } = await seedAuthorityCard();
            refuseFrom("failure");
            mockGhFetch.mockImplementation(async (url: string) => { if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`); return okBody(); });

            const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certified(), { expectedHeadOid: AUTH_HEAD });

            expect(outcome.kind).toBe("failed");
            expect(outcome.message).toContain("failed:arm-gate-unavailable");
            expect(enables()).toHaveLength(0);
            expect(await disarmRecord(issueId)).toMatchObject({ gateClosing: true });
            armGateFake.answer = armGateFake.created;
            expect(await retryPendingAutoMergeDisarms(db)).toMatchObject({ checked: 1, disabled: 1 });
            expect(await disarmRecord(issueId)).toBeUndefined();
          });

          it("a process that dies after the gate was written leaves it open: the sweep takes the arm back, then closes the gate", async () => {
            disarmTiming.inFlightGraceMs = 0;
            const { issueId } = await seedAuthorityCard();
            await inFlightRecord(issueId, new Date(Date.now() - 60_000).toISOString());
            mockGhFetch.mockImplementation(async (url: string) => { if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`); return disableOk(); });

            expect(await retryPendingAutoMergeDisarms(db)).toMatchObject({ checked: 1, disabled: 1 });

            expect(armGateFake.writes.map((w) => w.state)).toEqual(["success"]);
            expect(await disarmRecord(issueId)).toBeUndefined();
          });
        });

        it("tries every record in a default sweep, including ones above the admission cap", async () => {
          disarmBacklog.cap = 3;
          const cards: string[] = [];
          for (let i = 0; i < 5; i++) cards.push((await seedAuthorityCard(`SUP-${1200 + i}`)).issueId);
          const opened: string[] = [];
          for (const [i, issueId] of cards.slice(0, 4).entries()) {
            opened.push(await openArmInFlight(db, companyId, issueId, {
              owner: OWNER, repo: REPO, number: 600 + i, nodeId: `PR_node_${600 + i}`, headSha: AUTH_HEAD, reason: "arm in flight",
              since: new Date().toISOString(), attempts: 0, lastError: null, state: "in_flight", token: `c${i}`,
            }));
          }
          expect(opened).toEqual(["recorded", "recorded", "recorded", "full"]);
          // Two more records land outside admission (a pending write, or a row an earlier version left).
          await recordPendingAutoMergeDisarm(db, companyId, cards[3]!, {
            owner: OWNER, repo: REPO, number: 603, nodeId: "PR_node_603", headSha: AUTH_HEAD, reason: "test", since: new Date().toISOString(), attempts: 1, lastError: "x", state: "pending",
          });
          await recordPendingAutoMergeDisarm(db, companyId, cards[4]!, {
            owner: OWNER, repo: REPO, number: 604, nodeId: "PR_node_604", headSha: AUTH_HEAD, reason: "test", since: new Date().toISOString(), attempts: 1, lastError: "x", state: "pending",
          });
          disarmTiming.inFlightGraceMs = 0;
          mockGhFetch.mockImplementation(async (url: string) => { if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`); return disableOk(); });

          const summary = await retryPendingAutoMergeDisarms(db);

          expect(summary).toMatchObject({ checked: 5, disabled: 5, pending: 5 });
          for (const id of cards) expect(await disarmRecord(id)).toBeUndefined();
        });

        // The paths this round added, entered through the real arm, with the provider and the database instrumented.
        describe("the enable-call deadline and the admission lock, entered through the real arm", () => {
          const ADMISSION_KEY = "paperclip:auto-merge-disarm-admission";
          const advisory = async (granted: boolean) =>
            Number(((await db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted = ${granted}`)) as unknown as Array<{ n: number }>)[0]?.n);
          afterEach(() => { enableTiming.attemptTimeoutMs = 10_000; });

          it("gives up on an enable request that never answers at the default deadline, aborts it, keeps the record and holds no lock", async () => {
            enableTiming.attemptTimeoutMs = 150;
            const { issueId } = await seedAuthorityCard();
            const signals: AbortSignal[] = [];
            mockGhFetch.mockImplementation((url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
              if (url !== GRAPHQL_URL) return reject(new Error(`unexpected ghFetch URL: ${url}`));
              signals.push(init!.signal!);
              init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }));
            const started = Date.now();

            const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certified(), { expectedHeadOid: AUTH_HEAD });

            expect(Date.now() - started).toBeLessThan(2000);
            expect(outcome.kind).toBe("failed");
            expect(outcome.message).toContain("timeout after 150ms");
            expect(enables()).toHaveLength(1);
            expect(signals).toHaveLength(1);
            expect(signals[0]!.aborted).toBe(true);
            expect(await disarmRecord(issueId)).toMatchObject({ state: "in_flight" });
            expect(await advisory(true)).toBe(0);
          });

          it("takes the admission lock: an arm waits behind a holder of it, writes nothing until it is released, and then arms", async () => {
            const { issueId } = await seedAuthorityCard();
            mockGhFetch.mockImplementation(async (url: string) => { if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`); return okBody(); });
            let unlock!: () => void;
            let locked!: () => void;
            const isLocked = new Promise<void>((resolve) => { locked = resolve; });
            const holder = db.transaction(async (tx) => {
              await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ADMISSION_KEY}))`);
              locked();
              await new Promise<void>((resolve) => { unlock = resolve; });
            });
            await isLocked;
            let arm: ReturnType<typeof armMergeOnApproval> | undefined;
            try {
              arm = armMergeOnApproval(db, companyId, issueId, decide, certified(), { expectedHeadOid: AUTH_HEAD });
              const until = Date.now() + 3000;
              while (Date.now() < until && (await advisory(false)) === 0) await new Promise((resolve) => setTimeout(resolve, 20));
              expect(await advisory(false)).toBe(1);
              expect(enables()).toHaveLength(0);
              expect(await disarmRecord(issueId)).toBeUndefined();
            } finally {
              unlock();
              await holder;
            }

            const outcome = await arm!;

            expect(outcome.kind).toBe("armed");
            expect(enables()).toHaveLength(1);
            expect(await advisory(true)).toBe(0);
            expect(await advisory(false)).toBe(0);
          });
        });

        it("a restart resumes the take-backs the last process left, at once and then with the prompt retries", async () => {
          disarmTiming.promptDelaysMs = [30, 30, 30];
          const now = await seedAuthorityCard("SUP-980");
          const later = await seedAuthorityCard("SUP-981");
          for (const [i, { issueId }] of [now, later].entries()) {
            await recordPendingAutoMergeDisarm(db, companyId, issueId, {
              owner: OWNER, repo: REPO, number: 400 + i, nodeId: `PR_node_${400 + i}`, headSha: AUTH_HEAD, reason: "test",
              since: new Date().toISOString(), attempts: 1, lastError: "x", lastAttemptAt: new Date().toISOString(), state: "pending",
            });
          }
          // PR 400 is turned off at once; PR 401 is refused at boot and accepted by the first prompt retry.
          const seenNodes: string[] = [];
          mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
            const query = String(JSON.parse(String(init?.body)).query);
            seenNodes.push(query.match(/PR_node_\d+/)![0]);
            const refused = query.includes("PR_node_401") && seenNodes.filter((node) => node === "PR_node_401").length <= 3;
            return refused ? forbidden() : disableOk();
          });

          const summary = await resumePendingAutoMergeDisarms(db);

          expect(summary).toMatchObject({ checked: 2, disabled: 1, stillArmed: 1 });
          expect(await disarmRecord(now.issueId)).toBeUndefined();
          const until = Date.now() + 5000;
          while (Date.now() < until && (await disarmRecord(later.issueId))) await new Promise((resolve) => setTimeout(resolve, 25));
          expect(await disarmRecord(later.issueId)).toBeUndefined();
          // The record is cleared first and the confirmation row follows: let it land before the test ends.
          const confirmations = async () => (await db.select().from(activityLog)).filter((row) => row.action === "issue.merge_disarm_confirmed").length;
          const rowBy = Date.now() + 3000;
          while (Date.now() < rowBy && (await confirmations()) < 2) await new Promise((resolve) => setTimeout(resolve, 25));
          expect(await confirmations()).toBe(2);
        });
      });

      // Round 13 (R10-AUTH-DISABLE): how long an accepted arm whose authority was revoked at the enable stays in force
      // before the inline take-back reaches the provider, against a provider that merges D ms after it accepts the arm.
      // GitHub has no compare-and-set on the application's authority, so a merge that comes first cannot be prevented; this measures
      // it. Real database and real arming code; the provider is a fake with a stated round-trip time per call.
      describe("the window from the provider accepting an arm to the take-back reaching it", () => {
        const evidence: Array<Record<string, unknown>> = [];
        afterAll(async () => {
          const dir = process.env.SUP_20772_EVIDENCE_DIR;
          if (!dir || evidence.length === 0) return;
          const { mkdir, writeFile } = await import("node:fs/promises");
          await mkdir(dir, { recursive: true });
          await writeFile(`${dir}/disarm-window.json`, `${JSON.stringify({ measuredAt: new Date().toISOString(), cells: evidence }, null, 2)}\n`);
        });
        for (const roundTripMs of [0, 150]) {
          for (const mergeAfterMs of [0, 50, 100, 1000, 5000]) {
            it(`provider round trip ${roundTripMs} ms, merges ${mergeAfterMs} ms after accepting`, async () => {
              const { issueId, reviewerId } = await seedAuthorityCard();
              const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
              let acceptedAt = 0;
              let disableAt = 0;
              let merged = false;
              mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
                if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
                await sleep(roundTripMs / 2);
                const query = String(JSON.parse(String(init?.body)).query);
                if (query.includes("disablePullRequestAutoMerge")) {
                  disableAt ||= Date.now();
                  await sleep(roundTripMs / 2);
                  return disableOk();
                }
                acceptedAt = Date.now();
                if (mergeAfterMs === 0) merged = true;
                else setTimeout(() => { if (!disableAt) merged = true; }, mergeAfterMs);
                await revocations[0]![1]({ issueId, reviewerId });
                await sleep(roundTripMs / 2);
                return okBody();
              });

              const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certified(), { expectedHeadOid: AUTH_HEAD });
              await sleep(Math.max(0, acceptedAt + mergeAfterMs + 100 - Date.now()));

              const latencyMs = disableAt - acceptedAt;
              evidence.push({ roundTripMs, mergeAfterMs, acceptToDisableRequestMs: latencyMs, mergedBeforeDisable: merged, outcome: outcome.message.slice(0, 80) });
              expect(outcome.kind).toBe("failed");
              expect(outcome.message).toContain("auto-merge was disabled again");
              expect(disableAt).toBeGreaterThan(0);
              // The take-back reaches the provider about one round trip plus the authority re-read after the accept.
              expect(latencyMs).toBeLessThan(roundTripMs / 2 + 1000);
              expect(merged).toBe(mergeAfterMs === 0 || latencyMs >= mergeAfterMs);
              if (mergeAfterMs >= 1000 && roundTripMs <= 150) expect(merged).toBe(false);
            }, 30_000);
          }
        }
        const certified = () => ({ ...certifiedPr, nodeId: "PR_node_125" }) as typeof certifiedPr;
        const disableOk = () => ({ ok: true, status: 200, json: async () => ({ data: { disablePullRequestAutoMerge: { clientMutationId: "m" } } }) }) as unknown as Response;
      });

      // Round 12 (R10-AUTH-DISABLE): the first retry does not wait for the first reconciler tick.
      it("retries a take-back that failed at once within seconds, without a reconciler tick", async () => {
        disarmTiming.promptDelaysMs = [30, 30, 30];
        const { issueId, reviewerId } = await seedAuthorityCard();
        let disableCalls = 0;
        mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
          if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
          const query = String(JSON.parse(String(init?.body)).query);
          if (query.includes("disablePullRequestAutoMerge")) {
            disableCalls += 1;
            // The in-request disable and the first prompt retry are refused; the second prompt retry is accepted.
            return disableCalls <= 2 ? forbidden() : ({ ok: true, status: 200, json: async () => ({ data: { disablePullRequestAutoMerge: { clientMutationId: "m" } } }) }) as unknown as Response;
          }
          await revocations[0]![1]({ issueId, reviewerId });
          return okBody();
        });

        const outcome = await armMergeOnApproval(db, companyId, issueId, decide, { ...certifiedPr, nodeId: "PR_node_125" } as typeof certifiedPr, { expectedHeadOid: AUTH_HEAD });

        expect(outcome.message).toContain("STILL ENABLED");
        expect(outcome.message).toContain("within seconds");
        const until = Date.now() + 5000;
        while (Date.now() < until && (await disarmRecord(issueId))) await new Promise((resolve) => setTimeout(resolve, 25));
        expect(await disarmRecord(issueId)).toBeUndefined();
        expect(disableCalls).toBe(3);
        // The record is cleared first and the confirmation row follows: wait for it.
        const confirmed = async () => (await db.select().from(activityLog)).some((row) => row.action === "issue.merge_disarm_confirmed");
        const rowBy = Date.now() + 3000;
        while (Date.now() < rowBy && !(await confirmed())) await new Promise((resolve) => setTimeout(resolve, 25));
        expect(await confirmed()).toBe(true);
      });

      it("tries the records least recently tried first, so refused ones cannot starve the rest", async () => {
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
          const { issueId } = await seedAuthorityCard(`SUP-${900 + i}`);
          await recordPendingAutoMergeDisarm(db, companyId, issueId, {
            owner: OWNER, repo: REPO, number: 200 + i, nodeId: `PR_node_${200 + i}`, headSha: AUTH_HEAD, reason: "test",
            since: new Date().toISOString(), attempts: 1, lastError: "x", lastAttemptAt: new Date(Date.now() - (3 - i) * 1000).toISOString(),
          });
          ids.push(issueId);
        }
        mockGhFetch.mockImplementation(async () => forbidden());

        const first = await retryPendingAutoMergeDisarms(db, { limit: 2 });
        const second = await retryPendingAutoMergeDisarms(db, { limit: 2 });

        expect(first).toMatchObject({ checked: 2, pending: 3 });
        const attempts = await Promise.all(ids.map(async (id) => (await disarmRecord(id))?.attempts));
        // Two sweeps of two cover all three, the one not reached by the first sweep first in the second.
        expect(attempts.sort()).toEqual([2, 2, 3].sort());
        expect(second.checked).toBe(2);
      });

      it("writes an activity row for a record GitHub keeps refusing only for its first three attempts and then every 12th", async () => {
        const { issueId } = await seedAuthorityCard();
        await recordPendingAutoMergeDisarm(db, companyId, issueId, {
          owner: OWNER, repo: REPO, number: 125, nodeId: "PR_node_125", headSha: AUTH_HEAD, reason: "test",
          since: new Date().toISOString(), attempts: 1, lastError: "x",
        });
        mockGhFetch.mockImplementation(async () => forbidden());

        for (let i = 0; i < 14; i++) await retryPendingAutoMergeDisarms(db);

        const rows = (await db.select().from(activityLog)).filter((row) => row.action === "issue.merge_disarm_failed");
        // attempts 2 and 3, then 12 (attempts 4-11 and 13-15 write none).
        expect(rows).toHaveLength(3);
        expect(await disarmRecord(issueId)).toMatchObject({ attempts: 15 });
      });

      it("ends the record, loudly, when the PR merged before auto-merge could be turned off", async () => {
        const { issueId, reviewerId } = await seedAuthorityCard();
        mockGhFetch.mockImplementation(failingDisable(() => revocations[0]![1]({ issueId, reviewerId }), forbidden));
        await armMergeOnApproval(db, companyId, issueId, decide, { ...certifiedPr, nodeId: "PR_node_125" } as typeof certifiedPr, { expectedHeadOid: AUTH_HEAD });
        mockGhFetch.mockReset();
        mockGhFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: "Pull request is already merged" }] }) }) as unknown as Response);

        const summary = await retryPendingAutoMergeDisarms(db);

        expect(summary.stillArmed).toBe(0);
        expect(await disarmRecord(issueId)).toBeUndefined();
        expect((await db.select().from(activityLog)).some((row) => row.action === "issue.merge_disarm_moot")).toBe(true);
      });

      it("arms a card whose authority did not change, and sends no disable", async () => {
        const { issueId } = await seedAuthorityCard();
        mockGhFetch.mockImplementation(async (url: string) => {
          if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
          return okBody();
        });

        const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certifiedPr, { expectedHeadOid: AUTH_HEAD });

        expect(outcome.kind).toBe("armed");
        expect(disables()).toEqual([]);
      });

      it.each(["running", "paused", "error", "idle"])("stays armed when the reviewer agent's status churns to %s while the enable call is in flight", async (churned) => {
        const { issueId, reviewerId } = await seedAuthorityCard();
        mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
          if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
          if (String(JSON.parse(String(init?.body)).query).includes("enablePullRequestAutoMerge")) {
            await db.update(agents).set({ status: churned }).where(eq(agents.id, reviewerId));
          }
          return okBody();
        });

        const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certifiedPr, { expectedHeadOid: AUTH_HEAD });

        expect(outcome.kind).toBe("armed");
        expect(enables()).toHaveLength(1);
        expect(disables()).toEqual([]);
      });

      // Round 10: the baseline the arm compares against is taken before the arm's own first read, so a
      // revocation that commits during its early lookups (delivery, owner, node id) is still a difference.
      it.each([2, 3, 4, 5, 6, 8, 10])("is refused when the certificate is removed during the arm's own read number %i", async (readNumber) => {
        const { issueId } = await seedAuthorityCard();
        let reads = 0;
        const removeCertificate = async () => {
          const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
          const state = row!.executionState as { approvalStatus: Record<string, unknown> };
          const { finalDelivery: _removed, ...rest } = state.approvalStatus;
          await db.update(issues).set({ executionState: { ...state, approvalStatus: rest } }).where(eq(issues.id, issueId));
        };
        const chain = (builder: any, fire: boolean): any => new Proxy(builder, {
          get(target, prop) {
            if (prop === "then") {
              return (resolve: any, reject: any) => (fire ? removeCertificate() : Promise.resolve()).then(() => target.then(resolve, reject));
            }
            const value = target[prop];
            return typeof value === "function" ? (...args: any[]) => chain(value.apply(target, args), fire) : value;
          },
        });
        const watched = new Proxy(db, {
          get(target, prop) {
            const value = (target as any)[prop];
            if (prop === "select") return (...args: any[]) => chain(value.apply(target, args), ++reads === readNumber);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        mockGhFetch.mockImplementation(async (url: string) => {
          if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
          return okBody();
        });

        const outcome = await armMergeOnApproval(watched as typeof db, companyId, issueId, decide, certifiedPr, { expectedHeadOid: AUTH_HEAD });

        expect(reads).toBeGreaterThanOrEqual(readNumber);
        expect(outcome.kind).not.toBe("armed");
        expect(enables().length === 0 || disables().length === 1).toBe(true);
      });

      it("takes the arm back when the card is reopened while the enable call is in flight", async () => {
        const { issueId } = await seedAuthorityCard();
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
        mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
          if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
          if (String(JSON.parse(String(init?.body)).query).includes("enablePullRequestAutoMerge")) {
            await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
          }
          return okBody();
        });

        const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certifiedPr, { expectedHeadOid: AUTH_HEAD });

        expect(outcome.kind).toBe("failed");
        expect(outcome.message).toContain("failed:authority-revoked");
        expect(disables()).toHaveLength(1);
      });

      it("takes the arm back when the post-arm recheck itself cannot be completed", async () => {
        const { issueId } = await seedAuthorityCard();
        let calls = 0;
        const flaky = { baseline: "b", requireApprovedLadder: true, headSha: AUTH_HEAD, stillHolds: async () => { calls += 1; if (calls >= 3) throw new Error("database unavailable"); return null; } };
        mockGhFetch.mockImplementation(async (url: string) => {
          if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
          return okBody();
        });

        const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certifiedPr, { expectedHeadOid: AUTH_HEAD, authorityGuard: flaky });

        expect(outcome.kind).toBe("failed");
        expect(outcome.message).toContain("could not be re-verified");
        expect(disables()).toHaveLength(1);
      });

      // Round 11: paused lapses only on a head the board released; an ordinary approval keeps arming.
      const confirmRelease = async (issueId: string) => {
        const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
        const state = row!.executionState as { approvalStatus: Record<string, unknown> };
        await db.update(issues).set({
          executionState: { ...state, approvalStatus: { ...state.approvalStatus, releaseConfirmation: { owner: OWNER, repo: REPO, number: 125, headSha: AUTH_HEAD, statusId: "9001" } } },
        }).where(eq(issues.id, issueId));
      };

      it("refuses a board-released head whose reviewer agent is paused before the call", async () => {
        const { issueId, reviewerId } = await seedAuthorityCard();
        await confirmRelease(issueId);
        await db.update(agents).set({ status: "paused" }).where(eq(agents.id, reviewerId));
        mockGhFetch.mockImplementation(async () => { throw new Error("no GitHub call expected"); });

        const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certifiedPr, { expectedHeadOid: AUTH_HEAD });

        expect(outcome.kind).toBe("skipped");
        expect(outcome.message).toContain("skipped:authority-changed");
        expect(mockGhFetch).not.toHaveBeenCalled();
      });

      it("takes the arm back when the reviewer of a board-released head is paused while the enable call is in flight", async () => {
        const { issueId, reviewerId } = await seedAuthorityCard();
        await confirmRelease(issueId);
        mockGhFetch.mockImplementation(async (url: string, init?: RequestInit) => {
          if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
          if (String(JSON.parse(String(init?.body)).query).includes("enablePullRequestAutoMerge")) {
            await db.update(agents).set({ status: "paused" }).where(eq(agents.id, reviewerId));
          }
          return okBody();
        });

        const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certifiedPr, { expectedHeadOid: AUTH_HEAD });

        expect(outcome.kind).toBe("failed");
        expect(outcome.message).toContain("failed:authority-revoked");
        expect(disables()).toHaveLength(1);
      });

      it("still arms an ordinary approval whose reviewer agent is paused", async () => {
        const { issueId, reviewerId } = await seedAuthorityCard();
        await db.update(agents).set({ status: "paused" }).where(eq(agents.id, reviewerId));
        mockGhFetch.mockImplementation(async (url: string) => {
          if (url !== GRAPHQL_URL) throw new Error(`unexpected ghFetch URL: ${url}`);
          return okBody();
        });

        const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certifiedPr, { expectedHeadOid: AUTH_HEAD });

        expect(outcome.kind).toBe("armed");
      });

      it("refuses a reviewer agent that was already terminated before the call, not only one that changes during it", async () => {
        const { issueId, reviewerId } = await seedAuthorityCard();
        await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, reviewerId));
        mockGhFetch.mockImplementation(async () => { throw new Error("no GitHub call expected"); });

        const outcome = await armMergeOnApproval(db, companyId, issueId, decide, certifiedPr, { expectedHeadOid: AUTH_HEAD });

        expect(outcome.kind).toBe("skipped");
        expect(outcome.message).toContain("no longer a current agent");
        expect(mockGhFetch).not.toHaveBeenCalled();
      });
    });

    it("returns skipped:no-approved-head when publishedHeadSha is null and does not call mergePullRequest", async () => {
      const issueId = await insertApprovedCardWithPublishedHead(null);

      let graphqlCalls = 0;
      mockGhFetch.mockImplementation(async (url: string) => {
        if (url === GRAPHQL_URL) {
          graphqlCalls += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              errors: [{ message: "Pull request Pull request is in clean status" }],
            }),
          } as unknown as Response;
        }
        throw new Error(`unmocked ghFetch URL: ${url}`);
      });

      const armingOutcome = await armMergeOnApproval(
        db,
        companyId,
        issueId,
        { stageId: "stage-a", stageType: "review", outcome: "approved", body: "LGTM" },
        certifiedPr,
      );

      expect(armingOutcome.kind).toBe("skipped");
      expect(armingOutcome.message).toContain("skipped:no-approved-head");
      // Only the enablePullRequestAutoMerge call was made; no mergePullRequest.
      expect(graphqlCalls).toBe(1);
    });

    it("returns the unchanged failed:<error> for a non-clean-status provider error without attempting a merge", async () => {
      const issueId = await insertApprovedCardWithPublishedHead(PUBLISHED_HEAD);

      let graphqlCalls = 0;
      mockGhFetch.mockImplementation(async (url: string) => {
        if (url === GRAPHQL_URL) {
          graphqlCalls += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              errors: [{ message: "Repository not found" }],
            }),
          } as unknown as Response;
        }
        throw new Error(`unmocked ghFetch URL: ${url}`);
      });

      const armingOutcome = await armMergeOnApproval(
        db,
        companyId,
        issueId,
        { stageId: "stage-a", stageType: "review", outcome: "approved", body: "LGTM" },
        certifiedPr,
      );

      expect(armingOutcome.kind).toBe("failed");
      expect(armingOutcome.message).toBe("failed:Repository not found");
      // Only enablePullRequestAutoMerge was called; no fallback merge.
      expect(graphqlCalls).toBe(1);
    });

    it("returns failed:direct_merge:<error> when mergePullRequest is rejected for a moved head", async () => {
      const issueId = await insertApprovedCardWithPublishedHead(PUBLISHED_HEAD);

      let graphqlCalls = 0;
      mockGhFetch.mockImplementation(async (url: string) => {
        if (url === GRAPHQL_URL) {
          graphqlCalls += 1;
          if (graphqlCalls === 1) {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                errors: [{ message: "Pull request Pull request is in clean status" }],
              }),
            } as unknown as Response;
          }
          // mergePullRequest → head moved since approval
          return {
            ok: true,
            status: 200,
            json: async () => ({
              errors: [{ message: "Head is not an ancestor of the branch" }],
            }),
          } as unknown as Response;
        }
        if (url === REPO_URL) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ default_merge_method: "merge" }),
          } as unknown as Response;
        }
        throw new Error(`unmocked ghFetch URL: ${url}`);
      });

      const armingOutcome = await armMergeOnApproval(
        db,
        companyId,
        issueId,
        { stageId: "stage-a", stageType: "review", outcome: "approved", body: "LGTM" },
        certifiedPr,
      );

      expect(armingOutcome.kind).toBe("failed");
      expect(armingOutcome.message).toBe("failed:direct_merge:Head is not an ancestor of the branch");
      expect(graphqlCalls).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ADR-091 D1 / SUP-14783: shared_workspace delivery identity.
  //
  // A shared execution-workspace row belongs to the PARENT issue and carries
  // exactly one branch_name. Every OTHER card on that row was therefore being
  // compared against a sibling's branch, so the gate refused structurally and
  // no first-publish recovery was possible for any of them. These tests pin
  // both halves: the recovery now works, AND every laundering vector D1 exists
  // to block is still blocked on that same shared row.
  // ─────────────────────────────────────────────────────────────────────────
  describe("shared_workspace delivery identity (SUP-14783)", () => {
    const PARENT_BRANCH = "SUP-1-parent-architecture-review";

    async function insertSharedCard(overrides: { identifier?: string } = {}) {
      const ownerIssueId = await insertIssue({ identifier: "SUP-1" });
      return insertIssue({
        identifier: overrides.identifier ?? "SUP-42",
        sharedWorkspaceOwnerIssueId: ownerIssueId,
        branchName: PARENT_BRANCH,
      });
    }

    it("resolves the head for a card whose PR carries its own identifier prefix on a shared workspace", async () => {
      const issueId = await insertSharedCard();
      // The card's real delivery: branch named for THIS card, on the project repo.
      await insertMention(issueId, { number: 42, headRefName: "SUP-42-adr-074-alarm-pin-tamper" });
      installRoutes([{ url: PR_URL, body: prHeadBody(APPROVED_HEAD) }]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("resolved");
      if (result.kind === "resolved") {
        expect(result.headSha).toBe(APPROVED_HEAD);
      }
    });

    it("still refuses a PR the shared card merely CITED (another card's identifier prefix)", async () => {
      const issueId = await insertSharedCard();
      await insertMention(issueId, { number: 42, headRefName: "SUP-99-other-card-branch" });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toMatch(/^not_delivered:/);
        expect(result.reason).toContain("does not carry this card's identifier prefix SUP-42-");
        // The refusal must NOT tell an operator to match the sibling's branch.
        expect(result.reason).not.toContain("is not this card's delivery branch");
      }
    });

    it("still refuses the PARENT's own PR — a child must not stamp the branch it merely shares a worktree with", async () => {
      const issueId = await insertSharedCard();
      await insertMention(issueId, { number: 42, headRefName: PARENT_BRANCH });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toMatch(/^not_delivered:/);
      }
    });

    it("keeps D5 cross-repo closure: a correctly-prefixed branch in ANOTHER repo is still refused", async () => {
      const issueId = await insertSharedCard();
      await insertMention(issueId, {
        number: 42,
        headRefName: "SUP-42-adr-074-alarm-pin-tamper",
        owner: "other-org",
        repo: "other-repo",
      });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toContain("is not this card's delivery repo");
        expect(result.reason).toContain("ADR-091 D5");
      }
    });

    it("fails closed when the head ref is unreadable on a shared workspace", async () => {
      const ownerIssueId = await insertIssue({ identifier: "SUP-1" });
      const issueId = await insertIssue({
        identifier: "SUP-42",
        sharedWorkspaceOwnerIssueId: ownerIssueId,
        branchName: PARENT_BRANCH,
      });
      const [externalObj] = await db
        .insert(externalObjects)
        .values({
          companyId,
          providerKey: "github",
          objectType: "pull_request",
          externalId: `${OWNER}/${REPO}#pull/42`,
          data: { state: "open", draft: false, title: "no head ref anywhere" },
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
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toMatch(/^not_delivered:/);
      }
    });

    // CodeRabbit on PR #473: the fail-closed branch previously reported "no
    // delivery branch recorded", which is false for a shared-workspace card -
    // a branch IS recorded, it just belongs to another issue. The refusal must
    // name the identifier as the missing thing, or it sends an operator to
    // inspect the workspace instead of the card.
    it("names the MISSING IDENTIFIER, not a missing branch, when a shared card has no identifier", async () => {
      const ownerIssueId = await insertIssue({ identifier: "SUP-1" });
      const issueId = await insertIssue({
        identifier: "SUP-42",
        sharedWorkspaceOwnerIssueId: ownerIssueId,
        branchName: PARENT_BRANCH,
      });
      // Strip the identifier so ownership is disproven AND no prefix exists.
      await db.update(issues).set({ identifier: null }).where(eq(issues.id, issueId));
      await insertMention(issueId, { number: 42, headRefName: "SUP-42-adr-074-alarm-pin-tamper" });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toMatch(/^delivery_identity_unresolved:/);
        expect(result.reason).toContain("no readable identifier to authorize against");
        expect(result.reason).not.toContain("no delivery branch recorded");
      }
    });

    it("an ISOLATED card is untouched — exact-branch matching still governs and its refusal text is unchanged", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId, { number: 42, headRefName: "SUP-42-some-other-branch" });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);

      // Shares this card's identifier prefix, but the card owns its workspace,
      // so the strict branch check still applies and still refuses.
      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toBe(
          `not_delivered: ${OWNER}/${REPO}#42 head ${OWNER}/${REPO}:SUP-42-some-other-branch is not this card's delivery branch SUP-42-branch`,
        );
      }
    });
  });

  describe("ADR-091 D1 SUP-14824: recorded delivery identity", () => {
    // SUP-15909 negative control: a recorded identity whose branch does NOT match
    // the card's control-plane delivery branch is unusable. It fails closed instead
    // of (a) stamping the foreign branch, or (b) silently falling back to the
    // workspace row. This is the card-boundary half D1 exists to close: a card can
    // no longer record a same-repo branch it never delivered on.
    it("refuses a recorded identity whose branch is not the card's control-plane delivery branch (SUP-15909)", async () => {
      const issueId = await insertIssue(); // execution-workspace row branch "SUP-42-branch"
      await db.update(issues).set({
        executionState: {
          delivery: {
            repo: { owner: OWNER, repo: REPO },
            branch: "SUP-999-foreign-branch",
            headSha: "aaa111bbb222ccc333ddd444eee555fff6660000",
            recordedByRunId: randomUUID(),
            recordedAt: "2026-09-01T00:00:00.000Z",
          },
        },
      }).where(eq(issues.id, issueId));

      // A PR sitting on the card's OWN control-plane branch. Even though the card
      // actually delivered here, the recorded identity names a foreign branch, so
      // the gate refuses to stamp on it and does not fall back to the row.
      await insertMention(issueId, { number: 42, headRefName: "SUP-42-branch" });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);
      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toBe(
          "delivery_identity_unresolved: recorded delivery identity's branch does not match this card's control-plane delivery branch; refusing to stamp a PR this card cannot be proven to have delivered (ADR-091 D4, fail closed)",
        );
      }
    });

    // SUP-15909 positive control (own branch): a recorded identity naming the card's
    // own control-plane branch still narrows against it — the legitimate deliver.sh
    // shape is unchanged.
    it("arms when the recorded identity names the card's own control-plane branch (SUP-15909)", async () => {
      const issueId = await insertIssue(); // execution-workspace row branch "SUP-42-branch"
      await db.update(issues).set({
        executionState: {
          delivery: {
            repo: { owner: OWNER, repo: REPO },
            branch: "SUP-42-branch",
            headSha: "aaa111bbb222ccc333ddd444eee555fff6660000",
            recordedByRunId: randomUUID(),
            recordedAt: "2026-09-01T00:00:00.000Z",
          },
        },
      }).where(eq(issues.id, issueId));
      await insertMention(issueId, { number: 42, headRefName: "SUP-42-branch" });
      installRoutes([{ url: PR_URL, body: prHeadBody(APPROVED_HEAD) }]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);
      expect(result.kind).toBe("resolved");
      if (result.kind === "resolved") {
        expect(result.headSha).toBe(APPROVED_HEAD);
      }
    });

    // SUP-15909 carrier positive control: an ADR-083 carrier child records its
    // owner's carrier branch (the shared row's branch_name) and still arms via the
    // identifier-prefix predicate — proving the recorded path resolves branchIsOwn
    // from the control plane instead of hard-coding true.
    it("arms a carrier child that records its owner's carrier branch via the prefix predicate (SUP-15909)", async () => {
      const ownerIssueId = await insertIssue({ identifier: "SUP-1" });
      const CARRIER_BRANCH = "SUP-1-carrier-branch";
      const issueId = await insertIssue({
        identifier: "SUP-42",
        // ADR-091 D1: the owner must be a genuine strict ancestor (the card's
        // parent) for the shared-workspace carrier row to be legitimate.
        parentId: ownerIssueId,
        sharedWorkspaceOwnerIssueId: ownerIssueId,
        branchName: CARRIER_BRANCH,
      });
      await db.update(issues).set({
        executionState: {
          delivery: {
            repo: { owner: OWNER, repo: REPO },
            branch: CARRIER_BRANCH,
            headSha: "aaa111bbb222ccc333ddd444eee555fff6660000",
            recordedByRunId: randomUUID(),
            recordedAt: "2026-09-01T00:00:00.000Z",
          },
        },
      }).where(eq(issues.id, issueId));
      // The child's delivery: a head ref carrying THIS card's identifier prefix.
      await insertMention(issueId, { number: 42, headRefName: "SUP-42-carrier-fork" });
      installRoutes([{ url: PR_URL, body: prHeadBody(APPROVED_HEAD) }]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);
      expect(result.kind).toBe("resolved");
      if (result.kind === "resolved") {
        expect(result.headSha).toBe(APPROVED_HEAD);
      }
    });

    // SUP-16896 positive control: a carrier child whose ADR-083 owner is still live
    // (in_review) resolves the shared branch as legitimate — the normal carrier
    // shape my terminal-owner guard must not break.
    it("resolves a live carrier owner's branch as legitimate (SUP-16896 positive control)", async () => {
      const ownerIssueId = await insertIssue({ identifier: "SUP-1" }); // status: in_review (live)
      const CARRIER_BRANCH = "SUP-1-carrier-branch";
      const issueId = await insertIssue({
        identifier: "SUP-42",
        parentId: ownerIssueId,
        sharedWorkspaceOwnerIssueId: ownerIssueId,
        branchName: CARRIER_BRANCH,
      });
      const ownership = await resolveCardDeliveryBranchOwnership(db, companyId, issueId);
      expect(ownership.carrier).toBe(true);
      expect(ownership.branchIsOwn).toBe(false);
      expect(ownership.legitimate).toBe(true);
      expect(ownership.ownerIssueId).toBe(ownerIssueId);
      expect(ownership.refusalReason).toBeNull();
    });

    // SUP-16896 regression: a carrier child whose ADR-083 owner has already closed
    // (done) must NOT resolve the shared branch as legitimate — a terminal owner can
    // never stamp or promote the carrier, so the delivery is refused fail-closed.
    // This is the live PR #746 fault: the branch's card closed before the carrier
    // PR could be stamped/promoted, leaving it ownerless and undraftable.
    it("refuses a carrier delivery when the ADR-083 owner is already done (SUP-16896)", async () => {
      const ownerIssueId = await insertIssue({ identifier: "SUP-1" });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, ownerIssueId));
      const CARRIER_BRANCH = "SUP-1-carrier-branch";
      const issueId = await insertIssue({
        identifier: "SUP-42",
        parentId: ownerIssueId,
        sharedWorkspaceOwnerIssueId: ownerIssueId,
        branchName: CARRIER_BRANCH,
      });
      const ownership = await resolveCardDeliveryBranchOwnership(db, companyId, issueId);
      expect(ownership.carrier).toBe(true);
      expect(ownership.branchIsOwn).toBe(false);
      expect(ownership.legitimate).toBe(false);
      expect(ownership.ownerIssueId).toBe(ownerIssueId);
      expect(ownership.refusalReason).toContain("SUP-1");
      expect(ownership.refusalReason).toContain("done");
    });

    // SUP-15909 negative control (unrelated owner): the laundering vector D1 closes
    // is a card whose execution-workspace row is borrowed from an issue that is NOT
    // its ADR-083 carrier owner. Even when the recorded identity EXACTLY names that
    // foreign branch, the card must not arm on it — the branch is not provably one
    // this card delivered. This is the approval-time half of the ancestor check.
    it("refuses approval when the recorded branch is owned by an unrelated (non-ancestor) issue (SUP-15909)", async () => {
      const ownerIssueId = await insertIssue({ identifier: "SUP-1" });
      const FOREIGN_BRANCH = "SUP-1-carrier-branch";
      // No ancestor: the "owner" is NOT an ancestor of the card, so the shared row
      // is an unrelated owner — the shape D1 must refuse.
      const issueId = await insertIssue({
        identifier: "SUP-42",
        sharedWorkspaceOwnerIssueId: ownerIssueId,
        sharedWorkspaceOwnerUnrelated: true,
        branchName: FOREIGN_BRANCH,
      });
      await db.update(issues).set({
        executionState: {
          delivery: {
            repo: { owner: OWNER, repo: REPO },
            branch: FOREIGN_BRANCH,
            headSha: "aaa111bbb222ccc333ddd444eee555fff6660000",
            recordedByRunId: randomUUID(),
            recordedAt: "2026-09-01T00:00:00.000Z",
          },
        },
      }).where(eq(issues.id, issueId));
      // A PR really sitting on that foreign branch — but the card may not arm on it.
      await insertMention(issueId, { number: 42, headRefName: FOREIGN_BRANCH });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);
      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toBe(
          "delivery_identity_unresolved: this card's execution-workspace branch is owned by another issue that is not its ADR-083 carrier owner (not a strict ancestor passing the carrier gate); refusing to arm on a branch this card cannot be proven to have delivered (ADR-091 D1); refusing to stamp a PR this card cannot be proven to have delivered (ADR-091 D4, fail closed)",
        );
      }
    });

    it("fails closed when the recorded identity has no resolvable repo (AC3)", async () => {
      const issueId = await insertIssue();
      await db.update(issues).set({
        executionState: {
          delivery: {
            repo: { owner: "", repo: "" },
            branch: "RECORDED-BRANCH",
            headSha: "aaa111bbb222ccc333ddd444eee555fff6660000",
            recordedByRunId: randomUUID(),
            recordedAt: "2026-09-01T00:00:00.000Z",
          },
        },
      }).where(eq(issues.id, issueId));
      await insertMention(issueId, { number: 42, headRefName: "RECORDED-BRANCH" });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);
      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toBe(
          "delivery_identity_unresolved: recorded delivery identity has no resolvable repo; refusing to stamp a PR this card cannot be proven to have delivered (ADR-091 D4, fail closed)",
        );
      }
    });

    it("fails closed when the recorded identity has no branch (AC3)", async () => {
      const issueId = await insertIssue();
      await db.update(issues).set({
        executionState: {
          delivery: {
            repo: { owner: OWNER, repo: REPO },
            branch: "",
            headSha: "aaa111bbb222ccc333ddd444eee555fff6660000",
            recordedByRunId: randomUUID(),
            recordedAt: "2026-09-01T00:00:00.000Z",
          },
        },
      }).where(eq(issues.id, issueId));
      await insertMention(issueId, { number: 42, headRefName: "RECORDED-BRANCH" });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);
      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toBe(
          "delivery_identity_unresolved: recorded delivery identity has no branch; refusing to stamp a PR this card cannot be proven to have delivered (ADR-091 D4, fail closed)",
        );
      }
    });

    it("fails closed when the recorded identity has no headSha (AC3)", async () => {
      const issueId = await insertIssue();
      await db.update(issues).set({
        executionState: {
          delivery: {
            repo: { owner: OWNER, repo: REPO },
            branch: "RECORDED-BRANCH",
            headSha: "",
            recordedByRunId: randomUUID(),
            recordedAt: "2026-09-01T00:00:00.000Z",
          },
        },
      }).where(eq(issues.id, issueId));
      await insertMention(issueId, { number: 42, headRefName: "RECORDED-BRANCH" });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);
      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toBe(
          "delivery_identity_unresolved: recorded delivery identity has no headSha; refusing to stamp a PR this card cannot be proven to have delivered (ADR-091 D4, fail closed)",
        );
      }
    });

    it("surfaces the recorded-unusable reason from publishApprovalStatus (AC3)", async () => {
      const issueId = await insertIssue();
      await db.update(issues).set({
        executionState: {
          delivery: {
            repo: { owner: "bad", repo: "" },
            branch: "BR",
            headSha: "sha",
            recordedByRunId: randomUUID(),
            recordedAt: "2026-09-01T00:00:00.000Z",
          },
        },
      }).where(eq(issues.id, issueId));
      await insertMention(issueId, { number: 42, headRefName: "SUP-42-branch" });
      installRoutes([]);

      const outcome = await publishApprovalStatus(db, companyId, issueId, "SUP-42", {
        enforceDeliveryIdentity: true,
      });
      expect(outcome.kind).toBe("skipped");
      expect(outcome.message).toBe(
        "status:skipped:delivery_identity_unresolved: recorded delivery identity has no resolvable repo; refusing to stamp a PR this card cannot be proven to have delivered (ADR-091 D4, fail closed)",
      );
    });

    // SUP-14824 F1: the recorded identity names a SIBLING repo. The repo half is
    // always the card's project repo (a control-plane fact), never the record's —
    // so a recorded repo that differs from the project repo is unusable and both
    // stamp paths fail closed. This is the D5-axis gap the original card missed.
    it("fails closed when the recorded repo does not match the card's project repo (F1)", async () => {
      const issueId = await insertIssue();
      await db.update(issues).set({
        executionState: {
          delivery: {
            repo: { owner: "OTHER", repo: "other-repo" },
            branch: "RECORDED-BRANCH",
            headSha: "aaa111bbb222ccc333ddd444eee555fff6660000",
            recordedByRunId: randomUUID(),
            recordedAt: "2026-09-01T00:00:00.000Z",
          },
        },
      }).where(eq(issues.id, issueId));
      // A PR cited in that sibling repo (the laundering shape). The recorded repo
      // disagrees with the project-bound repo, so the identity is unusable before
      // the PR is ever matched.
      await insertMention(issueId, { number: 42, headRefName: "RECORDED-BRANCH", owner: "OTHER", repo: "other-repo" });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);
      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toBe(
          "delivery_identity_unresolved: recorded delivery identity's repo does not match this card's project repo; refusing to stamp a PR this card cannot be proven to have delivered (ADR-091 D4, fail closed)",
        );
      }
    });

    it("surfaces the recorded-repo-mismatch reason from publishApprovalStatus (F1)", async () => {
      const issueId = await insertIssue();
      await db.update(issues).set({
        executionState: {
          delivery: {
            repo: { owner: "OTHER", repo: "other-repo" },
            branch: "RECORDED-BRANCH",
            headSha: "sha",
            recordedByRunId: randomUUID(),
            recordedAt: "2026-09-01T00:00:00.000Z",
          },
        },
      }).where(eq(issues.id, issueId));
      await insertMention(issueId, { number: 42, headRefName: "RECORDED-BRANCH", owner: "OTHER", repo: "other-repo" });
      installRoutes([]);

      const outcome = await publishApprovalStatus(db, companyId, issueId, "SUP-42", {
        enforceDeliveryIdentity: true,
      });
      expect(outcome.kind).toBe("skipped");
      expect(outcome.message).toBe(
        "status:skipped:delivery_identity_unresolved: recorded delivery identity's repo does not match this card's project repo; refusing to stamp a PR this card cannot be proven to have delivered (ADR-091 D4, fail closed)",
      );
    });

    // SUP-14824 F3: a recorded identity that is present but NOT an object (e.g. a
    // string) is the record being unusable — it fails closed instead of silently
    // falling back to the workspace row.
    it("fails closed when the recorded identity is present but not an object (F3)", async () => {
      const issueId = await insertIssue();
      await db.update(issues).set({
        executionState: {
          delivery: "not-an-object",
        },
      }).where(eq(issues.id, issueId));
      await insertMention(issueId, { number: 42, headRefName: "SUP-42-branch" });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);
      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toBe(
          "delivery_identity_unresolved: recorded delivery identity is not a usable object; refusing to stamp a PR this card cannot be proven to have delivered (ADR-091 D4, fail closed)",
        );
      }
    });

    // AC2: byte-identical regression — pin the existing refusal strings when
    // no recorded identity is present.
    it("byte-identical: isolated-workspace match resolves the delivered PR", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId, { number: 42, headRefName: "SUP-42-branch" });
      installRoutes([{ url: PR_URL, body: prHeadBody(APPROVED_HEAD) }]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);
      expect(result.kind).toBe("resolved");
      if (result.kind === "resolved") {
        expect(result.headSha).toBe(APPROVED_HEAD);
        expect(result.displayName).toBe(`${OWNER}/${REPO}#42`);
      }
    });

    it("byte-identical: isolated-workspace mismatch refuses with not_delivered", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId, { number: 42, headRefName: "SUP-99-other-branch" });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);
      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toBe(
          `not_delivered: ${OWNER}/${REPO}#42 head ${OWNER}/${REPO}:SUP-99-other-branch is not this card's delivery branch SUP-42-branch`,
        );
      }
    });

    it("byte-identical: shared-workspace carrier (head == row branch_name) resolves", async () => {
      // A card on a shared workspace: the row's branchName is the shared branch,
      // and the PR head equals that branch. Without a recorded identity, this
      // path still works (the workspace row IS the identity).
      const issueId = await insertIssue();
      // The execution workspace row has branchName "SUP-42-branch" (from insertIssue default).
      await insertMention(issueId, { number: 42, headRefName: "SUP-42-branch" });
      installRoutes([{ url: PR_URL, body: prHeadBody(APPROVED_HEAD) }]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);
      expect(result.kind).toBe("resolved");
    });

    it("byte-identical: shared-workspace own-branch (identifier prefix) refuses when no prefix match", async () => {
      const issueId = await insertIssue();
      await insertMention(issueId, { number: 42, headRefName: "some-unrelated-branch" });
      installRoutes([]);

      const result = await resolveApprovalDecisionHead(db, companyId, issueId, "SUP-42", true);
      expect(result.kind).toBe("unresolvable");
      if (result.kind === "unresolvable") {
        expect(result.reason).toBe(
          `not_delivered: ${OWNER}/${REPO}#42 head ${OWNER}/${REPO}:some-unrelated-branch is not this card's delivery branch SUP-42-branch`,
        );
      }
    });
  });

});

// ============================================================================
// runApprovalMergeArming pre-publish guards: record every outcome (SUP-16081 fix
// #2). Relocated from the deleted server/src/__tests__/merge-arming-guard-outcome.test.ts
// per the SUP-16140 scope-compliance redo. Drives the POST .../board-decision route
// (which calls runApprovalMergeArming post-commit) with a controlled
// evaluateStageIntegrity to fire each pre-publish guard, then reads the persisted
// card back to prove the named approvalStatus record landed:
//   - stage-integrity finding  -> publishSkipped (status:skipped:stage_integrity:*)
//   - stage-integrity throw    -> publishFailure (status:failed:stage_integrity_check_threw:*)
//   - non-terminal ladder      -> publishSkipped (status:skipped:non-terminal-ladder:*)
// The two anchor-before-publish cases additionally prove the approval anchor
// (approvedHeadSha/approvedAt) is written durably before the first publish attempt
// and survives a failing/throwing publish (SUP-16081 comment a78bf2d2).
// ============================================================================
const describeGuardRoute = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

describeGuardRoute(
  "runApprovalMergeArming pre-publish guards record every outcome (SUP-16081 fix #2, SUP-16140 relocation)",
  () => {
    // issue_execution_decisions.stage_id is a uuid column, so stage ids must be
    // valid UUIDs (they are also the JSONB keys shared with
    // executionPolicy.stages / executionState.completedStageIds).
    const STAGE_A = "22222222-2222-4222-8222-222222222222";
    const STAGE_B = "33333333-3333-4333-8333-333333333333";
    const USER_ID = "board-user-1";

    let db: Db;
    let app: express.Express;
    let currentActor: Express.Request["actor"];
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
    let previousSchedulingSuppression: string | undefined;
    let previousBoardOverride: string | undefined;

    beforeAll(async () => {
      previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
      process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
      previousBoardOverride = process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE;
      process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE = "true";
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-merge-arming-guard-");
      db = createDb(tempDb.connectionString);
      app = createApp();
    }, 60_000);

    afterAll(async () => {
      guardRouteControl.active = false;
      await tempDb?.cleanup();
      if (previousSchedulingSuppression === undefined) {
        delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
      } else {
        process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = previousSchedulingSuppression;
      }
      if (previousBoardOverride === undefined) {
        delete process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE;
      } else {
        process.env.PAPERCLIP_BOARD_STAGE_OVERRIDE = previousBoardOverride;
      }
    });

    beforeEach(async () => {
      guardRouteControl.active = true;
      guardRouteControl.stageIntegrity = "pass";
      guardRouteControl.publishMode = "fail";
      await db.delete(issueExecutionDecisions);
      await db.delete(issues);
      await db.delete(executionWorkspaces);
      await db.delete(projectWorkspaces);
      await db.delete(projects);
      await db.delete(activityLog);
      // The board-decision route enqueues an assignment wakeup referencing the card's
      // assignee agent; clear it before the agent rows it references.
      await db.delete(agentWakeupRequests);
      await db.delete(agents);
      await db.delete(companyMemberships);
      await db.delete(companies);
    });

    afterEach(() => {
      guardRouteControl.active = false;
    });

    function createApp() {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.actor = currentActor;
        next();
      });
      app.use("/api", issueRoutes(db, {} as never));
      app.use(errorHandler);
      return app;
    }

    function boardActor(companyId: string): Express.Request["actor"] {
      return {
        type: "board",
        userId: USER_ID,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
      } as unknown as Express.Request["actor"];
    }

    /**
     * Seed a live card in `in_review` sitting on stage A of a review ladder, with a
     * declared return assignee DISTINCT from the stage participant (so the board
     * self-approval gate passes — the board user is neither the return assignee nor
     * a delivery author). `twoStages` appends stage B so the ladder is non-terminal
     * after approving A.
     */
    async function seedLiveCard(opts: { twoStages?: boolean } = {}) {
      const companyId = randomUUID();
      const reviewerAgentId = randomUUID();
      const returnAssigneeAgentId = randomUUID();
      const issueId = randomUUID();
      const executionWorkspaceId = randomUUID();
      const projectId = randomUUID();
      const projectWorkspaceId = randomUUID();
      const now = new Date();

      await db.insert(companies).values({
        id: companyId,
        name: "Guard Outcome Co",
        issuePrefix: "SUP",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: USER_ID,
        status: "active",
        membershipRole: "owner",
        updatedAt: now,
      });
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Guard Outcome/paperclip",
        status: "in_progress",
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Primary",
        cwd: "/tmp/test",
        isPrimary: true,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(agents).values({
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(agents).values({
        id: returnAssigneeAgentId,
        companyId,
        name: "Return Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        mode: "isolated",
        strategyType: "git_worktree",
        name: "card-workspace",
        status: "active",
        branchName: "SUP-16081-delivery",
        repoUrl: "https://github.com/TEA-Core/paperclip",
        createdAt: now,
        updatedAt: now,
      });

      const participant = { type: "agent" as const, agentId: reviewerAgentId };
      await db.insert(issues).values({
        id: issueId,
        companyId,
        identifier: "SUP-16081-1",
        issueNumber: 1,
        title: "Guard outcome card",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: reviewerAgentId,
        createdByUserId: USER_ID,
        projectId,
        projectWorkspaceId,
        executionWorkspaceId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          returnAssigneeAgentId,
          stages: [
            { id: STAGE_A, type: "review", approvalsNeeded: 1, participants: [participant] },
            ...(opts.twoStages
              ? [{ id: STAGE_B, type: "review", approvalsNeeded: 1, participants: [participant] }]
              : []),
          ],
        },
        executionState: {
          status: "pending",
          currentStageId: STAGE_A,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: participant,
          returnAssignee: { type: "agent", agentId: returnAssigneeAgentId },
          completedStageIds: [],
          skippedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          monitor: null,
          changesRequestedCount: 0,
        },
      });

      return { companyId, issueId };
    }

    async function readApprovalStatus(issueId: string) {
      const [row] = await db
        .select({ executionState: issues.executionState, status: issues.status })
        .from(issues)
        .where(eq(issues.id, issueId));
      expect(row).toBeTruthy();
      return (row!.executionState ?? {}) as Record<string, unknown>;
    }

    it("records a stage-integrity finding refusal as a publishSkipped record (guard refusal)", async () => {
      guardRouteControl.stageIntegrity = "finding";
      const { companyId, issueId } = await seedLiveCard();
      currentActor = boardActor(companyId);

      const res = await request(app)
        .post(`/api/issues/${issueId}/execution-stage/board-decision`)
        .send({ decision: "approved", comment: "Approved by board" });

      expect(res.status).toBe(200);
      // The guard refusal happens post-commit: the decision still succeeds (the card
      // is never refused to close — ADR-073 D3 / ADR-092 D5), only the stamp/arm is
      // skipped.
      expect(res.body.outcome).toBe("approved");

      const executionState = await readApprovalStatus(issueId);
      const approvalStatus = executionState.approvalStatus as Record<string, unknown> | undefined;
      // The total-record contract: the key is PRESENT and names the refusal.
      expect(approvalStatus).toBeDefined();
      const skipped = approvalStatus!.publishSkipped as Record<string, unknown> | undefined;
      expect(skipped).toBeDefined();
      expect(String(skipped!.reason)).toMatch(/^status:skipped:stage_integrity:/);
      expect(String(skipped!.reason)).toContain("guard-c:test-finding");
      expect(skipped!.headSha).toBeNull();
    });

    it("records an injected stage-integrity guard throw as a publishFailure record (guard exception)", async () => {
      guardRouteControl.stageIntegrity = "throw";
      const { companyId, issueId } = await seedLiveCard();
      currentActor = boardActor(companyId);

      const res = await request(app)
        .post(`/api/issues/${issueId}/execution-stage/board-decision`)
        .send({ decision: "approved", comment: "Approved by board" });

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe("approved");

      const executionState = await readApprovalStatus(issueId);
      const approvalStatus = executionState.approvalStatus as Record<string, unknown> | undefined;
      expect(approvalStatus).toBeDefined();
      const failure = approvalStatus!.publishFailure as Record<string, unknown> | undefined;
      expect(failure).toBeDefined();
      expect(String(failure!.reason)).toMatch(/^status:failed:stage_integrity_check_threw:/);
      expect(String(failure!.reason)).toContain("injected stage-integrity guard exception");
      expect(failure!.headSha).toBeNull();
    });

    it("records a non-terminal-ladder refusal as a publishSkipped record (ladder not terminal)", async () => {
      guardRouteControl.stageIntegrity = "pass";
      // Two stages: approving A leaves B outstanding, so the ladder is not terminally
      // approved and the first publish is refused as a skip (not a failure).
      const { companyId, issueId } = await seedLiveCard({ twoStages: true });
      currentActor = boardActor(companyId);

      const res = await request(app)
        .post(`/api/issues/${issueId}/execution-stage/board-decision`)
        .send({ decision: "approved", comment: "Approved by board" });

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe("approved");

      const executionState = await readApprovalStatus(issueId);
      const approvalStatus = executionState.approvalStatus as Record<string, unknown> | undefined;
      expect(approvalStatus).toBeDefined();
      const skipped = approvalStatus!.publishSkipped as Record<string, unknown> | undefined;
      expect(skipped).toBeDefined();
      expect(String(skipped!.reason)).toMatch(/^status:skipped:non-terminal-ladder:/);
      expect(skipped!.headSha).toBeNull();
    });

    // SUP-16081 (comment a78bf2d2): the approval anchor (approvedHeadSha +
    // approvedAt) must be written durably BEFORE the first-publish status write is
    // attempted. On SUP-16041 a dropped/failed publish left approvedHeadSha absent,
    // so both recovery paths (backfill D-B fallback, merge-arming/republish) were
    // structurally unable to run. Stubbing the status write to fail must still leave
    // a real anchor on the card.
    it("a failing first publish still leaves the approval anchor on the card (a78bf2d2: anchor before publish)", async () => {
      guardRouteControl.stageIntegrity = "pass";
      guardRouteControl.publishMode = "fail";
      const { companyId, issueId } = await seedLiveCard();
      currentActor = boardActor(companyId);

      const res = await request(app)
        .post(`/api/issues/${issueId}/execution-stage/board-decision`)
        .send({ decision: "approved", comment: "Approved by board" });

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe("approved");

      const executionState = await readApprovalStatus(issueId);
      const approvalStatus = executionState.approvalStatus as Record<string, unknown> | undefined;
      expect(approvalStatus).toBeDefined();
      // The anchor was written BEFORE the publish attempt and survived its failure.
      expect(approvalStatus!.approvedHeadSha).toBe(guardRouteControl.headSha);
      expect(typeof approvalStatus!.approvedAt).toBe("string");
      // The failed publish is recorded as a named failure, not silently dropped.
      const failure = approvalStatus!.publishFailure as Record<string, unknown> | undefined;
      expect(failure).toBeDefined();
      expect(String(failure!.reason)).toMatch(/^status:failed:/);
      expect(failure!.headSha).toBe(guardRouteControl.headSha);
      // No published head — the stamp never landed.
      expect(approvalStatus!.publishedHeadSha).toBeUndefined();
    });

    it("a throwing first publish still leaves the approval anchor on the card (a78bf2d2: hard-kill backstop)", async () => {
      guardRouteControl.stageIntegrity = "pass";
      guardRouteControl.publishMode = "throw";
      const { companyId, issueId } = await seedLiveCard();
      currentActor = boardActor(companyId);

      const res = await request(app)
        .post(`/api/issues/${issueId}/execution-stage/board-decision`)
        .send({ decision: "approved", comment: "Approved by board" });

      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe("approved");

      const executionState = await readApprovalStatus(issueId);
      const approvalStatus = executionState.approvalStatus as Record<string, unknown> | undefined;
      expect(approvalStatus).toBeDefined();
      // The pre-publish anchor write ran before the throw; the catch backstop
      // rewrites the same head, so approvedHeadSha is present either way.
      expect(approvalStatus!.approvedHeadSha).toBe(guardRouteControl.headSha);
      expect(typeof approvalStatus!.approvedAt).toBe("string");
      const failure = approvalStatus!.publishFailure as Record<string, unknown> | undefined;
      expect(failure).toBeDefined();
      expect(String(failure!.reason)).toMatch(/^status:failed:internal:/);
      expect(String(failure!.reason)).toContain("injected first-publish exception");
    });

    // ==========================================================================
    // SUP-17163: the review round-cap escalation-accept door is the 4th
    // decision-writer that records an approved review decision. Before this fix
    // it alone never ran runApprovalMergeArming, so an accepted escalation on a
    // fully-approved ladder stamped no head and armed no merge.
    // ==========================================================================

    /**
     * Seed a card sitting at the review round cap with a PENDING review-escalation
     * interaction — the exact shape the escalation-accept/reject doors resolve.
     * The company has merge arming enabled so the hook's actuator branch runs.
     */
    async function seedEscalatedRoundCapCard() {
      const companyId = randomUUID();
      const reviewerAgentId = randomUUID();
      const returnAssigneeAgentId = randomUUID();
      const issueId = randomUUID();
      const executionWorkspaceId = randomUUID();
      const projectId = randomUUID();
      const projectWorkspaceId = randomUUID();
      const interactionId = randomUUID();
      const now = new Date();

      await db.insert(companies).values({
        id: companyId,
        name: "Escalation Door Co",
        issuePrefix: "SUP",
        requireBoardApprovalForNewAgents: false,
        mergeArmingEnabled: true,
      });
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: USER_ID,
        status: "active",
        membershipRole: "owner",
        updatedAt: now,
      });
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Escalation Door/paperclip",
        status: "in_progress",
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Primary",
        cwd: "/tmp/test",
        isPrimary: true,
        createdAt: now,
        updatedAt: now,
      });
      await db.insert(agents).values({
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(agents).values({
        id: returnAssigneeAgentId,
        companyId,
        name: "Return Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        mode: "isolated",
        strategyType: "git_worktree",
        name: "card-workspace",
        status: "active",
        branchName: "SUP-17163-escalation",
        repoUrl: "https://github.com/TEA-Core/paperclip",
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(issues).values({
        id: issueId,
        companyId,
        identifier: "SUP-17163-1",
        issueNumber: 1,
        title: "Escalated round-cap card",
        status: "in_review",
        priority: "medium",
        assigneeUserId: USER_ID,
        createdByUserId: USER_ID,
        projectId,
        projectWorkspaceId,
        executionWorkspaceId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          returnAssigneeAgentId,
          stages: [
            {
              id: STAGE_A,
              type: "review",
              approvalsNeeded: 1,
              participants: [{ type: "agent", agentId: reviewerAgentId }],
            },
          ],
        },
        executionState: {
          status: "pending",
          currentStageId: STAGE_A,
          currentStageIndex: 0,
          currentStageType: "review",
          // The reviewer agents exhausted their rounds; the escalated human is now
          // the current participant (the shape the round-cap escalation mints).
          currentParticipant: { type: "user", userId: USER_ID },
          returnAssignee: { type: "agent", agentId: returnAssigneeAgentId },
          completedStageIds: [],
          skippedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          monitor: null,
          changesRequestedCount: 3,
        },
      });
      await db.insert(issueThreadInteractions).values({
        id: interactionId,
        companyId,
        issueId,
        kind: "request_confirmation",
        status: "pending",
        continuationPolicy: "wake_assignee",
        requestedResolverPolicy: "human_only",
        effectiveResolverPolicy: "human_only",
        createdByUserId: USER_ID,
        idempotencyKey: `review-escalation:${issueId}:${STAGE_A}:3:0123456789abcdef`,
        payload: {
          version: 1,
          prompt: "Approve this review, or request further changes (round cap reached).",
          acceptLabel: "Approve & advance",
        },
      });

      return { companyId, issueId, interactionId };
    }

    it("SUP-17163 AC#3: accepting a round-cap escalation runs the merge-arming hook (stamp + arm)", async () => {
      guardRouteControl.stageIntegrity = "pass";
      guardRouteControl.publishMode = "armed";
      guardRouteControl.armMode = "armed";
      const { companyId, issueId, interactionId } = await seedEscalatedRoundCapCard();
      currentActor = boardActor(companyId);

      const res = await request(app)
        .post(`/api/issues/${issueId}/interactions/${interactionId}/accept`)
        .send({});

      expect(res.status).toBe(200);

      const executionState = await readApprovalStatus(issueId);
      const approvalStatus = executionState.approvalStatus as Record<string, unknown> | undefined;
      expect(approvalStatus).toBeDefined();
      // The hook stamped the approved head...
      expect(approvalStatus!.publishedHeadSha).toBe(guardRouteControl.headSha);
      // ...and recorded the actuator's arm outcome on the card.
      const armOutcome = approvalStatus!.armOutcome as Record<string, unknown> | undefined;
      expect(armOutcome).toBeDefined();
      expect(armOutcome!.kind).toBe("armed");

      // A [Merge-arming] comment exists (the hook's durable on-card trace).
      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId));
      expect(comments.some((c) => c.body.startsWith("[Merge-arming]"))).toBe(true);
    });

    it("SUP-17163 AC#4: rejecting a round-cap escalation does NOT stamp or arm", async () => {
      // A publish posture that WOULD arm if the hook ran — proves the refusal
      // direction never invokes the hook, rather than merely a publishing no-op.
      guardRouteControl.stageIntegrity = "pass";
      guardRouteControl.publishMode = "armed";
      guardRouteControl.armMode = "armed";
      const { companyId, issueId, interactionId } = await seedEscalatedRoundCapCard();
      currentActor = boardActor(companyId);

      const res = await request(app)
        .post(`/api/issues/${issueId}/interactions/${interactionId}/reject`)
        .send({ reason: "Needs more edge-case tests before approval." });

      expect(res.status).toBe(200);

      const executionState = await readApprovalStatus(issueId);
      const approvalStatus = executionState.approvalStatus as Record<string, unknown> | undefined;
      // No stamp, no arm: the hook is not invoked on the changes_requested door.
      expect(approvalStatus?.publishedHeadSha).toBeUndefined();
      expect(approvalStatus?.armOutcome).toBeUndefined();

      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId));
      expect(comments.some((c) => c.body.startsWith("[Merge-arming]"))).toBe(false);
    });
  },
);


describe("enableAutoMerge deadline (SUP-20772 round 14)", () => {
  beforeEach(() => { mockGhFetch.mockReset(); });

  it("gives up on a request that never answers, aborts it, and reports no answer (status 0, so the take-back record stays)", async () => {
    const signals: AbortSignal[] = [];
    mockGhFetch.mockImplementation((_url: string, init?: RequestInit) => { signals.push(init!.signal as AbortSignal); return new Promise(() => {}); });
    const started = Date.now();

    const result = await enableAutoMerge("t", "PR_node_1", { attemptTimeoutMs: 60, maxAttempts: 3, retryDelayMs: 5 });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(result).toMatchObject({ success: false, status: 0 });
    expect(result.error).toContain("timeout");
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
  });

  it("applies its default deadline when no option is given", async () => {
    vi.useFakeTimers();
    try {
      mockGhFetch.mockImplementation(() => new Promise(() => {}));
      const pending = enableAutoMerge("t", "PR_node_1");
      await vi.advanceTimersByTimeAsync(ENABLE_ATTEMPT_TIMEOUT_MS + 1);
      await expect(pending).resolves.toMatchObject({ success: false, status: 0, error: `timeout after ${ENABLE_ATTEMPT_TIMEOUT_MS}ms` });
    } finally {
      vi.useRealTimers();
    }
  });

  it("is over, in the worst case, well before the in-flight record is settled", () => {
    expect(ENABLE_WORST_CASE_MS).toBeLessThan(disarmTiming.inFlightGraceMs / 2);
  });
});

describe("disableAutoMerge (SUP-20772 round 10)", () => {
  const NODE = "PR_node_1";
  const answer = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;
  beforeEach(() => { mockGhFetch.mockReset(); });

  it("gives up on a call that never answers, within its bound, and says auto-merge is not off", async () => {
    mockGhFetch.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();

    const result = await disableAutoMerge("t", NODE, { timeoutMs: 80, attempts: 2, retryDelayMs: 10 });

    expect(Date.now() - started).toBeLessThan(1500);
    expect(result.success).toBe(false);
    expect(result.error).toContain("timeout");
    expect(mockGhFetch).toHaveBeenCalledTimes(2);
  });

  it("aborts the request it gave up on", async () => {
    const signals: AbortSignal[] = [];
    mockGhFetch.mockImplementation((_url: string, init?: RequestInit) => { signals.push(init!.signal as AbortSignal); return new Promise(() => {}); });

    await disableAutoMerge("t", NODE, { timeoutMs: 50, attempts: 1 });

    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
  });

  it("retries a transient failure and reports the disable that went through", async () => {
    mockGhFetch.mockResolvedValueOnce(answer(502)).mockResolvedValueOnce(answer(200, { data: {} }));

    const result = await disableAutoMerge("t", NODE, { retryDelayMs: 5 });

    expect(result).toEqual({ success: true, error: null });
    expect(mockGhFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry a refusal a retry cannot clear", async () => {
    mockGhFetch.mockResolvedValue(answer(403, { errors: [{ message: "Resource not accessible" }] }));

    const result = await disableAutoMerge("t", NODE, { retryDelayMs: 5 });

    expect(result.success).toBe(false);
    expect(mockGhFetch).toHaveBeenCalledTimes(1);
  });

  it("counts 'auto-merge is not enabled' as off, but not 'already merged'", async () => {
    mockGhFetch.mockResolvedValueOnce(answer(200, { errors: [{ message: "Pull request Auto merge is not enabled" }] }));
    expect((await disableAutoMerge("t", NODE)).success).toBe(true);

    mockGhFetch.mockResolvedValueOnce(answer(200, { errors: [{ message: "Pull request is already merged" }] }));
    const merged = await disableAutoMerge("t", NODE);
    expect(merged.success).toBe(false);
    expect(merged.error).toContain("already merged");
  });
});
