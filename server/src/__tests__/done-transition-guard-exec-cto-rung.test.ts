import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  agents as agentsTable,
  issueExecutionDecisions as issueExecutionDecisionsTable,
  issueLabels as issueLabelsTable,
  issueRelations as issueRelationsTable,
  issues as issuesTable,
  labels as labelsTable,
} from "@paperclipai/db";
import {
  evaluateDoneTransitionGuard,
  findMissingAdr072CloseLadderStages,
} from "../services/done-transition-guard.js";
import { evaluateStageIntegrity } from "../services/approval-status-reconciler.js";
import { logActivity } from "../services/activity-log.js";
import {
  applyExecutionPolicyReArm,
  rearmExecutionPolicyPointer,
} from "../services/issue-execution-policy.js";

const mockDb = {
  select: vi.fn(),
} as unknown as Parameters<typeof evaluateDoneTransitionGuard>[0];

const issue = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "SUP-15650",
  projectId: "project-1",
  projectWorkspaceId: "pw-1",
  executionWorkspaceId: "ew-1",
};

/**
 * Build the shared `db` mock. Selects are dispatched by table identity when the
 * matching `rows.<table>` is seeded; otherwise every `select().from().where()`
 * resolves to the executionWorkspaces rows exactly as the legacy positional
 * chain did, so the default (empty) configuration resolves to [] for the
 * GitHub / repo-context reads the guard performs on the allowed path.
 */
function setupDbMock(rows: {
  executionWorkspaces?: Record<string, unknown>[];
  projectWorkspaces?: Record<string, unknown>[];
  projects?: Record<string, unknown>[];
  issues?: Record<string, unknown>[];
  blockedByIssues?: Record<string, unknown>[];
  issueRelations?: Record<string, unknown>[];
  agents?: Record<string, unknown>[];
  issueExecutionDecisions?: Record<string, unknown>[];
  labels?: Record<string, unknown>[];
  issueLabels?: Record<string, unknown>[];
}) {
  const issuesChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows.issues ?? []),
    then: vi.fn().mockResolvedValue(rows.issues ?? []),
  };
  const blockedByIssuesChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows.blockedByIssues ?? []),
    then: vi.fn().mockResolvedValue(rows.blockedByIssues ?? []),
  };
  const relationsChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows.issueRelations ?? []),
    then: vi.fn().mockResolvedValue(rows.issueRelations ?? []),
  };
  const agentsChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows.agents ?? []),
    then: vi.fn().mockResolvedValue(rows.agents ?? []),
  };
  const decisionsChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows.issueExecutionDecisions ?? []),
    then: vi.fn().mockResolvedValue(rows.issueExecutionDecisions ?? []),
  };
  const labelsChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows.labels ?? []),
    then: vi.fn().mockResolvedValue(rows.labels ?? []),
  };
  const issueLabelsChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows.issueLabels ?? []),
    then: vi.fn().mockResolvedValue(rows.issueLabels ?? []),
  };
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows.executionWorkspaces ?? []),
    then: vi.fn().mockResolvedValue(rows.executionWorkspaces ?? []),
  };
  const selectChain2 = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue(rows.projectWorkspaces ?? []),
  };
  const selectChain3 = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue(rows.projects ?? []),
  };
  const selectChain4 = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue(rows.projectWorkspaces ?? []),
  };
  let issuesCallCount = 0;
  (mockDb.select as any).mockImplementation((_cols?: any) => {
    let callCount = 0;
    const chains = [selectChain, selectChain2, selectChain3, selectChain4];
    return {
      from: function (table: unknown) {
        if (table === issueRelationsTable) return relationsChain;
        if (
          table === issuesTable &&
          (rows.issues !== undefined || rows.blockedByIssues !== undefined)
        ) {
          issuesCallCount++;
          return issuesCallCount === 1 ? issuesChain : blockedByIssuesChain;
        }
        if (table === agentsTable && rows.agents !== undefined) return agentsChain;
        if (table === issueExecutionDecisionsTable) return decisionsChain;
        if (table === labelsTable) return labelsChain;
        if (table === issueLabelsTable) return issueLabelsChain;
        const chain = chains[callCount] ?? selectChain;
        callCount++;
        return chain;
      },
      where: function () {
        const chain = chains[callCount] ?? selectChain;
        callCount++;
        return chain;
      },
      then: function () {
        const chain = chains[callCount] ?? selectChain;
        callCount++;
        return chain;
      },
    };
  });
}

vi.mock("../services/github-fetch.js", () => ({
  ghFetch: vi.fn(),
  gitHubApiBase: (hostname: string) =>
    hostname === "github.com" || hostname === "www.github.com"
      ? "https://api.github.com"
      : `https://${hostname}/api/v3`,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    getByName: vi.fn().mockResolvedValue({ id: "secret-1", name: "GITHUB_TOKEN" }),
    resolveSecretValue: vi.fn().mockResolvedValue("test-token"),
  }),
}));

const mockResolveGitHubToken = vi.hoisted(() => vi.fn());
vi.mock("../services/github-credential.js", () => ({
  resolveGitHubToken: mockResolveGitHubToken,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockResolveLinkedPullRequestsWithState = vi.hoisted(() => vi.fn());
const mockFetchOpenPullRequests = vi.hoisted(() => vi.fn());
vi.mock("../services/merge-arming.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/merge-arming.js")>();
  return {
    ...actual,
    resolveLinkedPullRequestsWithState: mockResolveLinkedPullRequestsWithState,
    fetchOpenPullRequests: mockFetchOpenPullRequests,
  };
});

const mockExecFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

import { ghFetch } from "../services/github-fetch.js";
import { resolveGitHubToken } from "../services/github-credential.js";

const ghFetchMock = vi.mocked(ghFetch);

function mockGitProbe(aheadCount: string, attributableCount: string, statusOutput = " M server/src/x.ts") {
  mockExecFile.mockImplementation(
    (_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      if (args.includes("status")) {
        cb(null, statusOutput);
        return;
      }
      cb(null, args.includes("--grep") ? attributableCount : aheadCount);
    },
  );
}

const supportQaeId = "aaaaaaa1-0000-4000-8000-000000000001";
const coderLeId = "bbbbbbb2-0000-4000-8000-000000000002";
const execCtoId = "ccccccc3-0000-4000-8000-000000000003";
const supportCrId = "ddddddd4-0000-4000-8000-000000000004";
const stage1 = "10000000-0000-4000-8000-000000000001";
const stage2 = "20000000-0000-4000-8000-000000000002";
const stage3 = "30000000-0000-4000-8000-000000000003";

const agents = [
  { id: supportQaeId, name: "support-QAE", role: "support" },
  { id: coderLeId, name: "coder-LE", role: "engineer" },
  { id: execCtoId, name: "exec-CTO", role: "executive" },
];

/** A completed execution state over the given stage ids (ladder satisfied). */
const satisfiedState = (stageIds: string[]) => ({
  status: "completed",
  currentStageId: null,
  currentStageIndex: null,
  currentStageType: null,
  currentParticipant: null,
  returnAssignee: null,
  deliveryAuthor: null,
  completedStageIds: stageIds,
  skippedStageIds: [],
  lastDecisionId: null,
  lastDecisionOutcome: null,
});

/**
 * A completed execution state whose gated principal is a given agent: both
 * `returnAssignee` and `deliveryAuthor` resolve to that agent (the standard
 * shape of an architecture-review ruling that spawns corrective children).
 */
const principalState = (stageIds: string[], principalAgentId: string) => ({
  status: "completed",
  currentStageId: null,
  currentStageIndex: null,
  currentStageType: null,
  currentParticipant: null,
  returnAssignee: { type: "agent", agentId: principalAgentId },
  deliveryAuthor: { type: "agent", agentId: principalAgentId },
  completedStageIds: stageIds,
  skippedStageIds: [],
  lastDecisionId: null,
  lastDecisionOutcome: null,
});

/** One laddered child: a satisfied single-stage ladder under `identifier`. */
const ladderedChild = (identifier: string, childStageId: string) => ({
  identifier,
  executionPolicy: { stages: [{ id: childStageId, type: "review" }] },
  executionState: satisfiedState([childStageId]),
});

const twoLadderedChildren = [
  ladderedChild("SUP-9001", "40000000-0000-4000-8000-000000000001"),
  ladderedChild("SUP-9002", "50000000-0000-4000-8000-000000000002"),
];

describe("SUP-15650 ADR-072 close-ladder shape: re-seat the principal's rung", () => {
  beforeEach(() => {
    ghFetchMock.mockReset();
    mockResolveLinkedPullRequestsWithState.mockReset();
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([]);
    mockFetchOpenPullRequests.mockReset();
    mockFetchOpenPullRequests.mockResolvedValue({ ok: true, status: 200, message: null, items: [] });
    mockResolveGitHubToken.mockReset();
    mockResolveGitHubToken.mockResolvedValue({ token: "test-token", scope: "company", secretName: "GITHUB_TOKEN" });
    vi.mocked(logActivity).mockClear();
    mockExecFile.mockReset();
    mockGitProbe("0", "0");
    setupDbMock({});
  });

  it("AC2: re-seats the exec-CTO rung to an independent approval when the gated principal is exec-CTO — allowed", async () => {
    // The exec-CTO is the deliverer (gated principal). The terminal approval
    // rung is held by support-QAE (independent), so the re-seated rung is
    // satisfied: mechanism D reports no missing stage and the close is allowed.
    const executionPolicy = {
      stages: [
        { id: stage1, type: "review", participants: [{ type: "agent", agentId: supportQaeId }] },
        { id: stage2, type: "review", participants: [{ type: "agent", agentId: coderLeId }] },
        { id: stage3, type: "approval", participants: [{ type: "agent", agentId: supportQaeId }] },
      ],
    };
    setupDbMock({ issues: twoLadderedChildren, agents });
    const result = await evaluateDoneTransitionGuard(
      mockDb,
      {
        ...issue,
        parentId: null,
        executionPolicy,
        executionState: principalState([stage1, stage2, stage3], execCtoId),
      },
      null,
    );
    expect(result.allowed).toBe(true);
    expect(logActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.done_transition_ladder_shape_refused" }),
    );
  });

  it("AC3: still reports approval:exec-CTO missing when the only approval participant is the exec-CTO principal — refused", async () => {
    // Same card, but the terminal approval stage's ONLY participant is the
    // exec-CTO, which is also the gated principal. A self-held rung is not a
    // rung: the re-seated rung is unsatisfied and mechanism D refuses.
    const executionPolicy = {
      stages: [
        { id: stage1, type: "review", participants: [{ type: "agent", agentId: supportQaeId }] },
        { id: stage2, type: "review", participants: [{ type: "agent", agentId: coderLeId }] },
        { id: stage3, type: "approval", participants: [{ type: "agent", agentId: execCtoId }] },
      ],
    };
    setupDbMock({ issues: twoLadderedChildren, agents });
    const result = await evaluateDoneTransitionGuard(
      mockDb,
      {
        ...issue,
        parentId: null,
        executionPolicy,
        executionState: principalState([stage1, stage2, stage3], execCtoId),
      },
      null,
    );
    expect(result.allowed).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.reason).toContain("Mechanism D");
    expect(result.reason).toContain("ADR-072 close-ladder shape");
    // The two review rungs are present; only the self-held approval rung is missing.
    expect(result.reason).toContain("approval:exec-CTO");
    expect(result.reason).not.toContain("review:support-QAE");
    expect(result.reason).not.toContain("review:coder-LE");
    // Fail closed before any external probe.
    expect(ghFetchMock).not.toHaveBeenCalled();
    expect(mockResolveLinkedPullRequestsWithState).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.done_transition_ladder_shape_refused",
        details: expect.objectContaining({
          reason: "adr072_close_ladder_shape_incomplete",
          missingStageLabels: ["approval:exec-CTO"],
          ladderedChildCount: 2,
        }),
      }),
    );
  });

  it("AC4: when the gated principal is a coder, all three ADR-072 labels remain required verbatim", async () => {
    // Ordinary card whose gated principal is a coder. The only review stage is
    // held by the principal itself, so none of the three rungs is satisfied:
    // the re-seat does NOT drop the coder rung (its only participant is the
    // principal), and the two other rungs are still required verbatim.
    const executionPolicy = {
      stages: [
        { id: stage1, type: "review", participants: [{ type: "agent", agentId: coderLeId }] },
      ],
    };
    setupDbMock({ issues: twoLadderedChildren, agents });
    const result = await evaluateDoneTransitionGuard(
      mockDb,
      {
        ...issue,
        parentId: null,
        executionPolicy,
        executionState: principalState([stage1], coderLeId),
      },
      null,
    );
    expect(result.allowed).toBe(false);
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.done_transition_ladder_shape_refused",
        details: expect.objectContaining({
          reason: "adr072_close_ladder_shape_incomplete",
          // All three labels, verbatim — the re-seat renamed nothing.
          missingStageLabels: ["review:support-QAE", "review:coder-LE", "approval:exec-CTO"],
        }),
      }),
    );
  });
});

describe("SUP-16532 ADR-072 close-ladder shape: ordered forward scan (ADR-102 M3)", () => {
  beforeEach(() => {
    ghFetchMock.mockReset();
    mockResolveLinkedPullRequestsWithState.mockReset();
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([]);
    mockFetchOpenPullRequests.mockReset();
    mockFetchOpenPullRequests.mockResolvedValue({ ok: true, status: 200, message: null, items: [] });
    mockResolveGitHubToken.mockReset();
    mockResolveGitHubToken.mockResolvedValue({ token: "test-token", scope: "company", secretName: "GITHUB_TOKEN" });
    vi.mocked(logActivity).mockClear();
    mockExecFile.mockReset();
    mockGitProbe("0", "0");
    setupDbMock({});
  });

  it("refuses a complete ladder where approval:exec-CTO lands before review:coder-LE as an ordering violation (AC1)", async () => {
    // All three ADR-072 rungs are present, but the terminal approval sits
    // between the two reviews — the final approver signs off before the coder-LE
    // Definition-of-Done gate runs. The ordered scan refuses this as an
    // ordering violation, distinct from a missing rung.
    const executionPolicy = {
      stages: [
        { id: stage1, type: "review", participants: [{ type: "agent", agentId: supportQaeId }] },
        { id: stage3, type: "approval", participants: [{ type: "agent", agentId: execCtoId }] },
        { id: stage2, type: "review", participants: [{ type: "agent", agentId: coderLeId }] },
      ],
    };
    setupDbMock({ issues: twoLadderedChildren, agents });
    const result = await evaluateDoneTransitionGuard(
      mockDb,
      {
        ...issue,
        parentId: null,
        executionPolicy,
        executionState: satisfiedState([stage1, stage2, stage3]),
      },
      null,
    );
    expect(result.allowed).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.reason).toContain("Mechanism D");
    expect(result.reason).toContain("ADR-072 close-ladder shape");
    // The ordering violation is named distinctly from a missing rung.
    expect(result.reason).toContain("out of order");
    expect(result.reason).toContain("approval:exec-CTO");
    expect(result.reason).not.toContain("missing the ADR-072 close-ladder stage");
    // Fail closed before any external probe.
    expect(ghFetchMock).not.toHaveBeenCalled();
    expect(mockResolveLinkedPullRequestsWithState).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.done_transition_ladder_shape_refused",
        details: expect.objectContaining({
          reason: "adr072_close_ladder_shape_incomplete",
          missingStageLabels: [],
          outOfOrderStageLabels: ["approval:exec-CTO"],
          ladderedChildCount: 2,
        }),
      }),
    );
  });

  it("refuses a complete ladder where approval:exec-CTO leads, naming the ordering violation (AC1b)", async () => {
    // The approver signs FIRST, before either review. Both reviews still land in
    // their relative order, but the approval's position is an ordering
    // violation, so the close is refused — not because a rung is missing.
    const executionPolicy = {
      stages: [
        { id: stage3, type: "approval", participants: [{ type: "agent", agentId: execCtoId }] },
        { id: stage1, type: "review", participants: [{ type: "agent", agentId: supportQaeId }] },
        { id: stage2, type: "review", participants: [{ type: "agent", agentId: coderLeId }] },
      ],
    };
    setupDbMock({ issues: twoLadderedChildren, agents });
    const result = await evaluateDoneTransitionGuard(
      mockDb,
      {
        ...issue,
        parentId: null,
        executionPolicy,
        executionState: satisfiedState([stage1, stage2, stage3]),
      },
      null,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("out of order");
    expect(result.reason).toContain("approval:exec-CTO");
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.done_transition_ladder_shape_refused",
        details: expect.objectContaining({
          missingStageLabels: [],
          outOfOrderStageLabels: ["approval:exec-CTO"],
        }),
      }),
    );
  });

  it("still closes a ladder in the ratified ADR-072 order (AC2)", async () => {
    // review:support-QAE -> review:coder-LE -> approval:exec-CTO, in order:
    // every rung lands before any later-required stage, so the close is allowed.
    const executionPolicy = {
      stages: [
        { id: stage1, type: "review", participants: [{ type: "agent", agentId: supportQaeId }] },
        { id: stage2, type: "review", participants: [{ type: "agent", agentId: coderLeId }] },
        { id: stage3, type: "approval", participants: [{ type: "agent", agentId: execCtoId }] },
      ],
    };
    setupDbMock({ issues: twoLadderedChildren, agents });
    const result = await evaluateDoneTransitionGuard(
      mockDb,
      {
        ...issue,
        parentId: null,
        executionPolicy,
        executionState: satisfiedState([stage1, stage2, stage3]),
      },
      null,
    );
    expect(result.allowed).toBe(true);
    expect(logActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.done_transition_ladder_shape_refused" }),
    );
  });

  it("keeps the ordering violation when a later duplicate eventually matches in order (AC1c)", async () => {
    // support-QAE -> exec-CTO -> coder-LE -> exec-CTO. The first exec-CTO lands
    // before coder-LE (out of order), but the trailing duplicate exec-CTO then
    // matches the cursor in order. The earlier sighting is a permanent
    // violation and must not be erased by the later match, or the terminal
    // approver would be allowed to sign off before the DoD gate ran.
    const stage4 = "40000000-0000-4000-8000-000000000004";
    const executionPolicy = {
      stages: [
        { id: stage1, type: "review", participants: [{ type: "agent", agentId: supportQaeId }] },
        { id: stage3, type: "approval", participants: [{ type: "agent", agentId: execCtoId }] },
        { id: stage2, type: "review", participants: [{ type: "agent", agentId: coderLeId }] },
        { id: stage4, type: "approval", participants: [{ type: "agent", agentId: execCtoId }] },
      ],
    };
    setupDbMock({ issues: twoLadderedChildren, agents });
    const result = await evaluateDoneTransitionGuard(
      mockDb,
      {
        ...issue,
        parentId: null,
        executionPolicy,
        executionState: satisfiedState([stage1, stage2, stage3, stage4]),
      },
      null,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("out of order");
    expect(result.reason).toContain("approval:exec-CTO");
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.done_transition_ladder_shape_refused",
        details: expect.objectContaining({
          reason: "adr072_close_ladder_shape_incomplete",
          missingStageLabels: [],
          outOfOrderStageLabels: ["approval:exec-CTO"],
        }),
      }),
    );
  });
});

describe("SUP-15650 regression: Guard B and mechanism D agree on one gated principal", () => {
  beforeEach(() => {
    vi.mocked(logActivity).mockClear();
    mockExecFile.mockReset();
    mockGitProbe("0", "0");
    setupDbMock({});
  });

  it("AC5: evaluateStageIntegrity returns null for a support-QAE decision when the principal is exec-CTO", async () => {
    // The terminal approval stage is completed and its latest decision was
    // made by support-QAE — an independent agent, NOT the exec-CTO principal.
    // Guard B must not flag this as a decision-by-return-assignee, which is
    // exactly the decision mechanism D's re-seated approval rung now relies on.
    const row = {
      id: "issue-1",
      companyId: "company-1",
      identifier: "SUP-15650",
      createdByAgentId: null,
      createdByUserId: null,
      assigneeAgentId: null,
      assigneeUserId: null,
      executionState: principalState([stage3], execCtoId),
      executionPolicy: {
        stages: [{ id: stage3, type: "approval", participants: [{ type: "agent", agentId: supportQaeId }] }],
      },
    };
    setupDbMock({
      issueExecutionDecisions: [
        {
          id: "dec-1",
          stageId: stage3,
          outcome: "approved",
          actorAgentId: supportQaeId,
          actorUserId: null,
          createdAt: new Date("2026-09-10T12:00:00Z"),
        },
      ],
    });
    const verdict = await evaluateStageIntegrity(mockDb, row);
    expect(verdict).toBeNull();
  });

  it("AC5 contrast: the same card flags a decision made BY the exec-CTO principal", async () => {
    // The contrast that proves the principal is exec-CTO: when the terminal
    // decision actor IS the gated principal, Guard B refuses.
    const row = {
      id: "issue-1",
      companyId: "company-1",
      identifier: "SUP-15650",
      createdByAgentId: null,
      createdByUserId: null,
      assigneeAgentId: null,
      assigneeUserId: null,
      executionState: principalState([stage3], execCtoId),
      executionPolicy: {
        stages: [{ id: stage3, type: "approval", participants: [{ type: "agent", agentId: execCtoId }] }],
      },
    };
    setupDbMock({
      issueExecutionDecisions: [
        {
          id: "dec-2",
          stageId: stage3,
          outcome: "approved",
          actorAgentId: execCtoId,
          actorUserId: null,
          createdAt: new Date("2026-09-10T12:00:00Z"),
        },
      ],
    });
    const verdict = await evaluateStageIntegrity(mockDb, row);
    expect(verdict).not.toBeNull();
    expect(verdict?.reason).toBe("guard-b:decision-by-return-assignee");
  });
});

describe("SUP-16525 §4/§5 close path after re-arm: only a durable decision row discharges the re-armed rung", () => {
  // The ratified ADR-072 order. The coder-LE review is the rung the bypassed
  // policy change skipped, so it is the stage the authorized re-arm rewinds onto.
  const rearmPolicy = {
    mode: "normal" as const,
    commentRequired: true,
    stages: [
      {
        id: stage1,
        type: "review" as const,
        approvalsNeeded: 1 as const,
        participants: [{ id: "p1", type: "agent" as const, agentId: supportQaeId, userId: null }],
      },
      {
        id: stage2,
        type: "review" as const,
        approvalsNeeded: 1 as const,
        participants: [{ id: "p2", type: "agent" as const, agentId: coderLeId, userId: null }],
      },
      {
        id: stage3,
        type: "approval" as const,
        approvalsNeeded: 1 as const,
        participants: [{ id: "p3", type: "agent" as const, agentId: execCtoId, userId: null }],
      },
    ],
  };

  // The pre-repair projection: the pointer sits on the terminal approval while
  // the coder-LE rung never landed — exactly the shape INV-LADDER-1 now refuses.
  const bypassedState = {
    status: "pending" as const,
    currentStageId: stage3,
    currentStageIndex: 2,
    currentStageType: "approval" as const,
    currentParticipant: { type: "agent" as const, agentId: execCtoId, userId: null },
    returnAssignee: null,
    reviewRequest: null,
    deliveryAuthor: null,
    completedStageIds: [stage1],
    skippedStageIds: [] as string[],
    lastDecisionId: null,
    lastDecisionOutcome: null,
  };

  // The persisted re-arm patch, computed through the authorized writer.
  const rearmIssue = { ...issue, status: "in_review", assigneeAgentId: coderLeId, createdByAgentId: null };
  const rearmPatch = () =>
    applyExecutionPolicyReArm({ issue: rearmIssue, policy: rearmPolicy, executionState: bypassedState }).patch;
  const rearmedState = () => rearmPatch().executionState;

  const rearmedGuardInput = () => ({
    ...issue,
    parentId: null,
    executionPolicy: rearmPolicy,
    executionState: rearmedState(),
  });

  beforeEach(() => {
    ghFetchMock.mockReset();
    mockResolveLinkedPullRequestsWithState.mockReset();
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([]);
    mockFetchOpenPullRequests.mockReset();
    mockFetchOpenPullRequests.mockResolvedValue({ ok: true, status: 200, message: null, items: [] });
    mockResolveGitHubToken.mockReset();
    mockResolveGitHubToken.mockResolvedValue({ token: "test-token", scope: "company", secretName: "GITHUB_TOKEN" });
    vi.mocked(logActivity).mockClear();
    mockExecFile.mockReset();
    mockGitProbe("0", "0");
    setupDbMock({});
  });

  it("re-arm rewinds the pointer onto the skipped rung and lands it in NEITHER list (AC3)", () => {
    // The pure calculator names the re-armed stage...
    expect(
      rearmExecutionPolicyPointer({ policy: rearmPolicy, executionState: bypassedState }),
    ).toEqual({ currentStageId: stage2, currentStageIndex: 1 });

    // ...and the persisted writer turns it into a concrete patch: the re-armed
    // rung is pending, carries the completed set forward unchanged, and is an
    // explicit NON-completion (it is in neither completedStageIds nor skippedStageIds).
    const patch = rearmPatch();
    expect(patch.status).toBe("in_review");
    const state = patch.executionState as {
      currentStageId: string;
      completedStageIds: string[];
      skippedStageIds: string[];
    };
    expect(state.currentStageId).toBe(stage2);
    expect(state.completedStageIds).toEqual([stage1]);
    expect(state.skippedStageIds).toEqual([]);
    expect(state.completedStageIds).not.toContain(stage2);
    expect(state.skippedStageIds).not.toContain(stage2);
  });

  it("refuses done after the re-arm while the re-armed rung has no durable decision row (AC4)", async () => {
    // The post-re-arm close attempt: the projection still shows only stage 1
    // completed and no decision rows exist, so the re-armed rung is unsatisfied
    // and the guard fails closed in the pre-network zone.
    setupDbMock({ issues: twoLadderedChildren, agents });
    const result = await evaluateDoneTransitionGuard(mockDb, rearmedGuardInput(), null);
    expect(result.allowed).toBe(false);
    expect(result.ladderUnsatisfied).toBe(true);
    expect(result.reason).toContain("Review ladder unsatisfied");
    expect(result.reason).toContain("stage 2 of 3");
    expect(result.reason).toContain(stage2);
    expect(result.reason).toContain("neither completedStageIds nor skippedStageIds");
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.done_transition_ladder_refused",
        details: expect.objectContaining({ reason: `review_ladder_unsatisfied:${stage2}` }),
      }),
    );
    // Fail closed before any external probe.
    expect(ghFetchMock).not.toHaveBeenCalled();
    expect(mockResolveLinkedPullRequestsWithState).not.toHaveBeenCalled();
  });

  it("the re-armed rung opens only on a durable APPROVED row, then advances to the next rung (AC4)", async () => {
    // Fail closed: a non-approved latest decision supersedes nothing, so a
    // changes_requested row leaves the rung exactly as open as no row at all.
    const decision = (outcome: string) => ({
      id: `dec-${outcome}`,
      stageId: stage2,
      outcome,
      actorAgentId: coderLeId,
      actorUserId: null,
      createdAt: new Date("2026-09-10T12:00:00Z"),
    });
    setupDbMock({ issues: twoLadderedChildren, agents, issueExecutionDecisions: [decision("changes_requested")] });
    const refused = await evaluateDoneTransitionGuard(mockDb, rearmedGuardInput(), null);
    expect(refused.allowed).toBe(false);
    expect(refused.ladderUnsatisfied).toBe(true);
    expect(refused.reason).toContain(stage2);
    expect(refused.reason).toContain("stage 2 of 3");

    // The ONLY change now is the outcome of that one row: approved discharges
    // the re-armed rung, so the refusal moves on to the next unsatisfied rung —
    // proof that the row, not the projection, is what opens the ladder.
    setupDbMock({ issues: twoLadderedChildren, agents, issueExecutionDecisions: [decision("approved")] });
    const advanced = await evaluateDoneTransitionGuard(mockDb, rearmedGuardInput(), null);
    expect(advanced.allowed).toBe(false);
    expect(advanced.ladderUnsatisfied).toBe(true);
    expect(advanced.reason).not.toContain(stage2);
    expect(advanced.reason).toContain("stage 3 of 3");
    expect(advanced.reason).toContain(stage3);
  });

  it("closes only once every rung has a durable approved row, with the projection untouched (AC5)", async () => {
    // `executionState` is byte-for-byte the same as the refused attempt: the
    // close is allowed solely because the re-armed rung AND the terminal rung
    // now carry durable approved decision rows (SUP-14912 recovery). The
    // ratified ADR-072 order then satisfies mechanism D as well.
    setupDbMock({
      issues: twoLadderedChildren,
      agents,
      issueExecutionDecisions: [
        {
          id: "dec-1",
          stageId: stage2,
          outcome: "approved",
          actorAgentId: coderLeId,
          actorUserId: null,
          createdAt: new Date("2026-09-10T12:00:00Z"),
        },
        {
          id: "dec-2",
          stageId: stage3,
          outcome: "approved",
          actorAgentId: execCtoId,
          actorUserId: null,
          createdAt: new Date("2026-09-10T13:00:00Z"),
        },
      ],
    });
    const result = await evaluateDoneTransitionGuard(mockDb, rearmedGuardInput(), null);
    expect(result.allowed).toBe(true);
    expect(result.ladderUnsatisfied).toBeUndefined();
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.done_transition_ladder_recovered_from_decisions",
        details: expect.objectContaining({ reason: "review_ladder_recovered_from_decisions" }),
      }),
    );
    expect(logActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.done_transition_ladder_shape_refused" }),
    );
  });
});

describe("SUP-17647 ADR-072 close-ladder shape: a completed rung is discharged by the recorded decision actor, not a co-participant (SUP-17403)", () => {
  beforeEach(() => {
    ghFetchMock.mockReset();
    mockResolveLinkedPullRequestsWithState.mockReset();
    mockResolveLinkedPullRequestsWithState.mockResolvedValue([]);
    mockFetchOpenPullRequests.mockReset();
    mockFetchOpenPullRequests.mockResolvedValue({ ok: true, status: 200, message: null, items: [] });
    mockResolveGitHubToken.mockReset();
    mockResolveGitHubToken.mockResolvedValue({ token: "test-token", scope: "company", secretName: "GITHUB_TOKEN" });
    vi.mocked(logActivity).mockClear();
    mockExecFile.mockReset();
    mockGitProbe("0", "0");
    setupDbMock({});
  });

  // The SUP-17403 shape: the first review rung carries BOTH support-CR and
  // support-QAE as participants (approvalsNeeded: 1), so the required
  // support-QAE is a co-participant. What discharges the ratified
  // review:support-QAE rung is the ACTOR who recorded that stage's decision.
  const shape = {
    stages: [
      {
        id: stage1,
        type: "review",
        approvalsNeeded: 1,
        participants: [
          { type: "agent", agentId: supportCrId },
          { type: "agent", agentId: supportQaeId },
        ],
      },
      { id: stage2, type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: coderLeId }] },
      { id: stage3, type: "approval", approvalsNeeded: 1, participants: [{ type: "agent", agentId: execCtoId }] },
    ],
  };
  const allAgents = [...agents, { id: supportCrId, name: "support-CR", role: "support" }];

  it("refuses a completed rung whose co-participant includes the required agent but whose recorded actor is a different agent (AC1)", async () => {
    // support-CR — a co-participant, NOT the required support-QAE — recorded
    // stage 1's only decision. Under the old participation check support-QAE's
    // mere membership satisfied the rung and the close sailed through. After the
    // fix, the rung is judged by the recorded actor, so it is NOT satisfied and
    // mechanism D refuses, naming review:support-QAE.
    setupDbMock({
      issues: twoLadderedChildren,
      agents: allAgents,
      issueExecutionDecisions: [
        { id: "dec-1", stageId: stage1, outcome: "approved", actorAgentId: supportCrId, actorUserId: null, createdAt: new Date("2026-09-26T15:24:20Z") },
        { id: "dec-2", stageId: stage2, outcome: "approved", actorAgentId: coderLeId, actorUserId: null, createdAt: new Date("2026-09-26T15:25:00Z") },
        { id: "dec-3", stageId: stage3, outcome: "approved", actorAgentId: execCtoId, actorUserId: null, createdAt: new Date("2026-09-26T15:26:00Z") },
      ],
    });
    const result = await evaluateDoneTransitionGuard(
      mockDb,
      { ...issue, parentId: null, executionPolicy: shape, executionState: satisfiedState([stage1, stage2, stage3]) },
      null,
    );
    expect(result.allowed).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.reason).toContain("Mechanism D");
    expect(result.reason).toContain("review:support-QAE");
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.done_transition_ladder_shape_refused",
        details: expect.objectContaining({
          reason: "adr072_close_ladder_shape_incomplete",
          missingStageLabels: expect.arrayContaining(["review:support-QAE"]),
        }),
      }),
    );
    expect(ghFetchMock).not.toHaveBeenCalled();
  });

  it("discharges the same rung when the REQUIRED agent recorded the decision, even alongside a co-participant (AC2)", async () => {
    // Identical participants [support-CR, support-QAE], but support-QAE itself
    // recorded the decision. The recorded actor now matches the required agent,
    // so the rung is discharged and the close is allowed — the fix does not
    // over-refuse a rung the required agent actually acted on.
    setupDbMock({
      issues: twoLadderedChildren,
      agents: allAgents,
      issueExecutionDecisions: [
        { id: "dec-1", stageId: stage1, outcome: "approved", actorAgentId: supportQaeId, actorUserId: null, createdAt: new Date("2026-09-26T15:24:20Z") },
        { id: "dec-2", stageId: stage2, outcome: "approved", actorAgentId: coderLeId, actorUserId: null, createdAt: new Date("2026-09-26T15:25:00Z") },
        { id: "dec-3", stageId: stage3, outcome: "approved", actorAgentId: execCtoId, actorUserId: null, createdAt: new Date("2026-09-26T15:26:00Z") },
      ],
    });
    const result = await evaluateDoneTransitionGuard(
      mockDb,
      { ...issue, parentId: null, executionPolicy: shape, executionState: satisfiedState([stage1, stage2, stage3]) },
      null,
    );
    expect(result.allowed).toBe(true);
    expect(logActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.done_transition_ladder_shape_refused" }),
    );
  });

  it("a not-yet-run stage with no decision row keeps the participant-based shape check (AC3)", async () => {
    // Same two-reviewer participants [support-CR, support-QAE], but no decision
    // row has been recorded yet: the rung is not completed, so the unchanged
    // participation shape check still counts support-QAE's membership and the
    // close-ladder shape is complete. This is the unarmed-ladder advisory path —
    // untouched by SUP-17647.
    setupDbMock({ issues: twoLadderedChildren, agents: allAgents });
    const result = await evaluateDoneTransitionGuard(
      mockDb,
      { ...issue, parentId: null, executionPolicy: shape, executionState: satisfiedState([stage1, stage2, stage3]) },
      null,
    );
    expect(result.allowed).toBe(true);
    expect(logActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.done_transition_ladder_shape_refused" }),
    );
  });

  it("preserves the SUP-15650 re-seat on a completed stage: a principal-held rung is satisfied only by an independent recorded actor (AC4)", async () => {
    // exec-CTO is the gated principal, so the terminal approval rung re-seats to
    // an independent agent. The approval stage carries BOTH the principal and an
    // independent co-participant (support-QAE).
    const reseatPolicy = {
      stages: [
        { id: stage1, type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: supportQaeId }] },
        { id: stage2, type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: coderLeId }] },
        {
          id: stage3,
          type: "approval",
          approvalsNeeded: 1,
          participants: [
            { type: "agent", agentId: supportQaeId },
            { type: "agent", agentId: execCtoId },
          ],
        },
      ],
    };

    // An INDEPENDENT agent recorded the decision: the re-seated rung is
    // discharged and the close is allowed.
    setupDbMock({
      issues: twoLadderedChildren,
      agents,
      issueExecutionDecisions: [
        { id: "dec-1", stageId: stage1, outcome: "approved", actorAgentId: supportQaeId, actorUserId: null, createdAt: new Date("2026-09-26T15:24:20Z") },
        { id: "dec-2", stageId: stage2, outcome: "approved", actorAgentId: coderLeId, actorUserId: null, createdAt: new Date("2026-09-26T15:25:00Z") },
        { id: "dec-3", stageId: stage3, outcome: "approved", actorAgentId: supportQaeId, actorUserId: null, createdAt: new Date("2026-09-26T15:26:00Z") },
      ],
    });
    const allowed = await evaluateDoneTransitionGuard(
      mockDb,
      { ...issue, parentId: null, executionPolicy: reseatPolicy, executionState: principalState([stage1, stage2, stage3], execCtoId) },
      null,
    );
    expect(allowed.allowed).toBe(true);

    // The PRINCIPAL itself recorded the decision: a self-held rung is not a
    // rung, so mechanism D refuses, naming approval:exec-CTO.
    setupDbMock({
      issues: twoLadderedChildren,
      agents,
      issueExecutionDecisions: [
        { id: "dec-1", stageId: stage1, outcome: "approved", actorAgentId: supportQaeId, actorUserId: null, createdAt: new Date("2026-09-26T15:24:20Z") },
        { id: "dec-2", stageId: stage2, outcome: "approved", actorAgentId: coderLeId, actorUserId: null, createdAt: new Date("2026-09-26T15:25:00Z") },
        { id: "dec-3", stageId: stage3, outcome: "approved", actorAgentId: execCtoId, actorUserId: null, createdAt: new Date("2026-09-26T15:26:00Z") },
      ],
    });
    const refused = await evaluateDoneTransitionGuard(
      mockDb,
      { ...issue, parentId: null, executionPolicy: reseatPolicy, executionState: principalState([stage1, stage2, stage3], execCtoId) },
      null,
    );
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain("approval:exec-CTO");
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.done_transition_ladder_shape_refused",
        details: expect.objectContaining({
          missingStageLabels: expect.arrayContaining(["approval:exec-CTO"]),
        }),
      }),
    );
  });

  it("a PENDING stage bounced to changes_requested keeps the participant-based shape check even though it carries a decision row (AC1b)", async () => {
    // The pointer sits on stage 1 after support-CR bounced it: stage 1 is NOT
    // in completedStageIds, yet it carries a decision row whose latest outcome
    // is changes_requested and whose recorded actor is the co-participant
    // support-CR, not the required support-QAE. The actor-identity branch must
    // not fire for a pending stage: support-QAE's participation still satisfies
    // the review:support-QAE rung, so the close-ladder shape stays complete —
    // a new parent edge on this parent must not be refused on this shape.
    const bouncedState = {
      status: "pending",
      currentStageId: stage1,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: supportCrId },
      returnAssignee: null,
      deliveryAuthor: null,
      completedStageIds: [stage2, stage3],
      skippedStageIds: [],
      lastDecisionId: "dec-1",
      lastDecisionOutcome: "changes_requested",
    };
    setupDbMock({
      agents: allAgents,
      issueExecutionDecisions: [
        { id: "dec-1", stageId: stage1, outcome: "changes_requested", actorAgentId: supportCrId, actorUserId: null, createdAt: new Date("2026-09-26T15:24:20Z") },
        { id: "dec-2", stageId: stage2, outcome: "approved", actorAgentId: coderLeId, actorUserId: null, createdAt: new Date("2026-09-26T15:25:00Z") },
        { id: "dec-3", stageId: stage3, outcome: "approved", actorAgentId: execCtoId, actorUserId: null, createdAt: new Date("2026-09-26T15:26:00Z") },
      ],
    });
    const verdict = await findMissingAdr072CloseLadderStages(
      mockDb,
      "company-1",
      "issue-1",
      shape,
      bouncedState,
      null,
    );
    expect(verdict.missingStageLabels).toEqual([]);
    expect(verdict.outOfOrderStageLabels).toEqual([]);
  });
});
