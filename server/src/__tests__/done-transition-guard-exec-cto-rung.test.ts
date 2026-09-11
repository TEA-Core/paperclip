import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  agents as agentsTable,
  issueExecutionDecisions as issueExecutionDecisionsTable,
  issueLabels as issueLabelsTable,
  issueRelations as issueRelationsTable,
  issues as issuesTable,
  labels as labelsTable,
} from "@paperclipai/db";
import { evaluateDoneTransitionGuard } from "../services/done-transition-guard.js";
import { evaluateStageIntegrity } from "../services/approval-status-reconciler.js";
import { logActivity } from "../services/activity-log.js";

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
