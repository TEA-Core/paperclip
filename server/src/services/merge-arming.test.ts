import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  publishApprovalStatus,
  resolveApprovalDecisionHead,
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

});
