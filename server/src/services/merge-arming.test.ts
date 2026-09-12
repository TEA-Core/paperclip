import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  createDb,
  executionWorkspaces,
  externalObjectMentions,
  externalObjects,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { GITHUB_APP_PRIVATE_KEY_SECRET_NAME, GITHUB_TOKEN_SECRET_NAMES } from "./github-credential.js";
import {
  armMergeOnApproval,
  ladderIsTerminallyApproved,
  publishApprovalStatus,
  resolveApprovalDecisionHead,
  resolveCardPullRequest,
  type NoPrBranchAnchor,
} from "./merge-arming.js";

const mockResolveSecretValue = vi.hoisted(() => vi.fn());
const mockGetByName = vi.hoisted(() => vi.fn());
const mockGhFetch = vi.hoisted(() => vi.fn());

vi.mock("./secrets.js", () => ({
  secretService: () => ({
    getByName: mockGetByName,
    resolveSecretValue: mockResolveSecretValue,
  }),
}));

vi.mock("./github-fetch.js", () => ({
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

// SUP-15459: the ladder-terminality predicate gates every paperclip/approved
// write. It is pure (no I/O), so these run even where embedded Postgres is
// absent — no DB fixtures required.
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

function prHeadBody(sha: string) {
  return { state: "open", merged: false, head: { ref: "SUP-42-branch", sha } };
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
       * SUP-14783: make the card's execution-workspace row a `shared_workspace`
       * OWNED BY ANOTHER ISSUE, carrying that owner's branch — the shape every
       * TSP child card has. Default undefined leaves the row's sourceIssueId
       * null, which is the pre-existing fixture and must keep its verdicts.
       */
      sharedWorkspaceOwnerIssueId?: string;
      branchName?: string;
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
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test Issue",
      status: "in_review",
      identifier: overrides.identifier ?? "SUP-42",
      projectId,
      executionWorkspaceId,
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
