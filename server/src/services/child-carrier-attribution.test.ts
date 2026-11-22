import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  companies,
  createDb,
  executionWorkspaces,
  externalObjectMentions,
  externalObjects,
  issueChildCarrierAttributions,
  issueExecutionDecisions,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  CHILD_CARRIER_OWNER_GATE_SKIP,
  CHILD_CARRIER_STAMP_SKIP,
  carrierArmBlock,
  carrierOwnerChildAttributionBlock,
  childCarrierStampBlock,
  childCarrierCommits,
  classifyAncestorCarrierHead,
  recordChildCarrierDecision,
  resolveChildCarrierDecisionHead,
} from "./child-carrier-attribution.js";
import { publishApprovalStatus, resolveApprovalDecisionHead } from "./merge-arming.js";

const github = vi.hoisted(() => vi.fn());
vi.mock("./github-fetch.js", () => ({
  ghFetch: (...args: unknown[]) => github(...args),
  gitHubApiBase: () => "https://api.github.com",
}));
vi.mock("./github-credential.js", () => ({
  resolveGitHubTokenCandidatesForRepo: async () => [{ token: "sandbox-token", scope: "company", secretName: "GITHUB_TOKEN" }],
  resolveGitHubTokenForRepo: async () => ({ token: "sandbox-token", scope: "company", secretName: "GITHUB_TOKEN" }),
  isGitHubTokenResolution: () => true,
}));
vi.mock("./secrets.js", () => ({
  secretService: () => ({ getByName: async () => null, resolveSecretValue: async () => "sandbox-token" }),
}));
const realEnumerate = childCarrierCommits.enumerate;

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;
const HEAD = "e90a7225470a8d98c10a85d6dc14f7946838cf28";
const COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OWNER = "TEA-Core";
const REPO = "paperclip";
const CARRIER_BRANCH = "SUP-22864-carrier";
const CHILD_BRANCH = "SUP-22878-redo-enforce-one-date-report-composition-and-capture-date-guard";

function livePr(overrides: Record<string, unknown> = {}) {
  return {
    state: "open",
    draft: false,
    merged: false,
    head: {
      ref: CARRIER_BRANCH,
      sha: HEAD,
      repo: { full_name: `${OWNER}/${REPO}` },
    },
    base: { ref: "fold/tea-patches-v2026.722.0" },
    ...overrides,
  };
}

type CompareFault = "truncate" | "base" | "next" | null;

function mockCommitSources(carrierShas = [COMMIT, HEAD], childShas = [COMMIT]) {
  const baseSha = "f".repeat(40);
  const controls = {
    carrierShas, childShas,
    carrierFault: null as CompareFault,
    childFault: null as CompareFault,
    namedBaseMoved: false,
    comparisons: [] as Array<{ base: string; head: string; page: number }>,
  };
  github.mockImplementation(async (url: unknown) => {
    const target = new URL(String(url));
    const page = Number(target.searchParams.get("page") ?? 1);
    let body: unknown;
    let next = false;
    if (target.pathname.endsWith("/pulls/653/commits")) {
      body = controls.carrierShas.slice(0, 250).slice((page - 1) * 100, page * 100).map((sha) => ({ sha }));
    } else if (target.pathname.includes("/commits/")) {
      const ref = decodeURIComponent(target.pathname.split("/commits/")[1]!);
      const moved = controls.namedBaseMoved && controls.comparisons.some(({ head }) => head === HEAD);
      body = { sha: ref === CHILD_BRANCH ? controls.childShas.at(-1) ?? baseSha : moved ? "d".repeat(40) : baseSha };
    } else if (target.pathname.includes("/compare/")) {
      const [base, head] = decodeURIComponent(target.pathname.split("/compare/")[1]!).split("...");
      const carrier = head === HEAD;
      const source = carrier ? controls.carrierShas : controls.childShas;
      const fault = carrier ? controls.carrierFault : controls.childFault;
      controls.comparisons.push({ base: base!, head: head!, page });
      const paged = target.searchParams.has("per_page");
      const rows = paged ? source.slice((page - 1) * 100, page * 100) : source.slice(0, 250);
      if (fault === "truncate" && page === Math.ceil(source.length / 100)) rows.pop();
      const moved = !carrier && controls.namedBaseMoved && base !== baseSha;
      body = {
        base_commit: { sha: moved || (fault === "base" && page === Math.min(2, Math.ceil(source.length / 100))) ? "d".repeat(40) : baseSha },
        total_commits: moved ? 0 : source.length,
        commits: moved ? [] : rows.map((sha) => ({ sha })),
      };
      next = fault === "next" || (paged && page * 100 < source.length);
    } else {
      body = livePr();
    }
    return {
      ok: true, status: 200,
      headers: { get: () => next ? '<https://api.github.com/next>; rel="next"' : null },
      json: async () => body,
    };
  });
  return controls;
}

describePg("child carrier attribution", () => {
  let db: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-child-carrier-attribution-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    github.mockReset();
    github.mockImplementation(async () => ({ ok: true, status: 200, json: async () => livePr() }));
    childCarrierCommits.enumerate = async () => ({ ok: true, shas: [COMMIT] });
    await db.delete(issueChildCarrierAttributions);
    await db.delete(issueExecutionDecisions);
    await db.delete(activityLog);
    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    const [company] = await db.insert(companies).values({
      name: "Child carrier",
      issuePrefix: "SUP",
      mergeArmingEnabled: true,
    }).returning();
    companyId = company!.id;
  });

  async function seedPair(opts: { ancestor?: boolean; childRepo?: string } = {}) {
    const ancestor = opts.ancestor !== false;
    const [project] = await db.insert(projects).values({
      id: randomUUID(),
      companyId,
      name: `${OWNER}/${REPO}`,
      status: "in_progress",
    }).returning();
    const ownerId = randomUUID();
    const childId = randomUUID();
    const ownerWorkspaceId = randomUUID();
    const childWorkspaceId = randomUUID();
    await db.insert(issues).values([
      {
        id: ownerId,
        companyId,
        projectId: project!.id,
        title: "Carrier owner",
        status: "in_review",
        identifier: "SUP-22864",
      },
      {
        id: childId,
        companyId,
        projectId: project!.id,
        parentId: ancestor ? ownerId : null,
        title: "Forked child",
        status: "in_review",
        identifier: "SUP-22878",
        executionState: { childCarrierClaim: { prNumber: 653, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653` } },
      },
    ]);
    await db.insert(executionWorkspaces).values([
      {
        id: ownerWorkspaceId,
        companyId,
        projectId: project!.id,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "owner",
        status: "active",
        branchName: CARRIER_BRANCH,
        repoUrl: `https://github.com/${OWNER}/${REPO}`,
        sourceIssueId: ownerId,
      },
      {
        id: childWorkspaceId,
        companyId,
        projectId: project!.id,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "child",
        status: "active",
        branchName: CHILD_BRANCH,
        repoUrl: `https://github.com/${opts.childRepo ?? OWNER}/${REPO}`,
        sourceIssueId: childId,
      },
    ]);
    await db.update(issues).set({ executionWorkspaceId: ownerWorkspaceId }).where(eq(issues.id, ownerId));
    await db.update(issues).set({ executionWorkspaceId: childWorkspaceId }).where(eq(issues.id, childId));
    return { ownerId, childId };
  }

  async function mention(issueId: string) {
    const [object] = await db.insert(externalObjects).values({
      companyId,
      providerKey: "github",
      objectType: "pull_request",
      externalId: `${OWNER}/${REPO}#pull/653`,
      data: { state: "open", draft: false, head: { ref: CARRIER_BRANCH }, title: "Carrier" },
    }).returning();
    await db.insert(externalObjectMentions).values({
      companyId,
      sourceIssueId: issueId,
      sourceKind: "comment",
      objectId: object!.id,
      objectType: "pull_request",
      providerKey: "github",
    });
  }

  it("admits the forked child and performs neither publication nor arming", async () => {
    const { childId } = await seedPair();
    await mention(childId);
    const resolved = await resolveChildCarrierDecisionHead(db, companyId, childId);
    expect(resolved.kind).toBe("resolved");
    const [row] = await db.select().from(issueChildCarrierAttributions);
    expect(row?.writtenByActorType).toBe("system");
    expect(row?.headSha).toBe(HEAD);
    expect(row?.commitShas).toEqual([COMMIT]);

    const published = await publishApprovalStatus(db, companyId, childId, "SUP-22878", {
      enforceDeliveryIdentity: true,
      expectedHeadSha: HEAD,
    });
    expect(published.kind).toBe("skipped");
    expect(published.message).toContain("child-carrier-attribution");
    const statusPosts = github.mock.calls.filter((call) => {
      const url = String(call[0]);
      const init = call[1] as RequestInit | undefined;
      return url.includes("/statuses/") && init?.method === "POST";
    });
    expect(statusPosts).toEqual([]);
    const armBlock = await carrierArmBlock(db, companyId, childId, {
      owner: OWNER,
      repo: REPO,
      number: 653,
      headSha: HEAD,
      headRef: CARRIER_BRANCH,
    });
    expect(armBlock).toBe(CHILD_CARRIER_STAMP_SKIP);
  });

  it("does not classify a shared-workspace child as a carrier claimant", async () => {
    const { ownerId, childId } = await seedPair();
    expect(await classifyAncestorCarrierHead(db, companyId, childId, CARRIER_BRANCH)).toBe("one");
    const [ownerRow] = await db.select({ w: issues.executionWorkspaceId }).from(issues).where(eq(issues.id, ownerId));
    await db.update(issues).set({ executionWorkspaceId: ownerRow!.w }).where(eq(issues.id, childId));
    expect(await classifyAncestorCarrierHead(db, companyId, childId, CARRIER_BRANCH)).toBe("absent");
  });

  it("refuses a moved head, a draft, a closed pull request, and a merged pull request", async () => {
    const { childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    github.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => livePr({ head: { ref: CARRIER_BRANCH, sha: "b".repeat(40), repo: { full_name: `${OWNER}/${REPO}` } } }),
    }));
    const moved = await resolveChildCarrierDecisionHead(db, companyId, childId);
    expect(moved.kind).toBe("unresolvable");
    if (moved.kind === "unresolvable") expect(moved.reason).toContain("head_moved");

    await db.delete(issueChildCarrierAttributions);
    github.mockImplementation(async () => ({ ok: true, status: 200, json: async () => livePr({ draft: true }) }));
    const draft = await resolveChildCarrierDecisionHead(db, companyId, childId);
    expect(draft.kind).toBe("unresolvable");
    if (draft.kind === "unresolvable") expect(draft.reason).toContain("head_draft");

    github.mockImplementation(async () => ({ ok: true, status: 200, json: async () => livePr({ state: "closed", merged: false }) }));
    const closed = await resolveChildCarrierDecisionHead(db, companyId, childId);
    expect(closed.kind).toBe("unresolvable");
    if (closed.kind === "unresolvable") expect(closed.reason).toContain("head_not_open");

    github.mockImplementation(async () => ({ ok: true, status: 200, json: async () => livePr({ state: "closed", merged: true }) }));
    const merged = await resolveChildCarrierDecisionHead(db, companyId, childId);
    expect(merged.kind).toBe("unresolvable");
    if (merged.kind === "unresolvable") expect(merged.reason).toContain("head_not_open");
  });

  it("refuses an empty, missing, or extra commit enumeration and a non-ancestor", async () => {
    const { childId } = await seedPair();
    childCarrierCommits.enumerate = async () => ({ ok: true, shas: [] });
    const empty = await resolveChildCarrierDecisionHead(db, companyId, childId);
    expect(empty.kind).toBe("unresolvable");

    childCarrierCommits.enumerate = async () => ({ ok: true, shas: [COMMIT] });
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    childCarrierCommits.enumerate = async () => ({ ok: true, shas: ["b".repeat(40)] });
    const extra = await resolveChildCarrierDecisionHead(db, companyId, childId);
    expect(extra.kind).toBe("unresolvable");
    if (extra.kind === "unresolvable") expect(extra.reason).toContain("missing or extra");

    await db.delete(issueChildCarrierAttributions);
    await db.update(issues).set({ parentId: null }).where(eq(issues.id, childId));
    childCarrierCommits.enumerate = async () => ({ ok: true, shas: [COMMIT] });
    const refused = await resolveChildCarrierDecisionHead(db, companyId, childId);
    expect(refused.kind).toBe("absent");
    expect(await db.select().from(issueChildCarrierAttributions)).toEqual([]);
  });

  it("keeps the owner gate closed until every required child attribution is approved and current", async () => {
    const { ownerId, childId } = await seedPair();
    childCarrierCommits.enumerate = async () => ({ ok: true, shas: [COMMIT] });
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    const pending = await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER,
      repo: REPO,
      number: 653,
      headSha: HEAD,
      headRef: CARRIER_BRANCH,
    });
    expect(pending).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);

    const [decision] = await db.insert(issueExecutionDecisions).values({
      id: randomUUID(),
      companyId,
      issueId: childId,
      stageId: randomUUID(),
      stageType: "approval",
      outcome: "approved",
      body: "approved",
    }).returning();
    await db.update(issueChildCarrierAttributions).set({ childDecisionId: decision!.id }).where(eq(issueChildCarrierAttributions.childIssueId, childId));
    const approved = await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER,
      repo: REPO,
      number: 653,
      headSha: HEAD,
      headRef: CARRIER_BRANCH,
    });
    expect(approved).toBeNull();

    const stale = await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER,
      repo: REPO,
      number: 653,
      headSha: "c".repeat(40),
      headRef: CARRIER_BRANCH,
    });
    expect(stale).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);

    const lonelyOwner = randomUUID();
    const lonelyWorkspace = randomUUID();
    const [project] = await db.insert(projects).values({
      id: randomUUID(),
      companyId,
      name: "lonely",
      status: "in_progress",
    }).returning();
    await db.insert(issues).values({
      id: lonelyOwner,
      companyId,
      projectId: project!.id,
      title: "No children",
      status: "in_review",
      identifier: "SUP-1",
    });
    await db.insert(executionWorkspaces).values({
      id: lonelyWorkspace,
      companyId,
      projectId: project!.id,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "lonely",
      status: "active",
      branchName: "SUP-1-own",
      repoUrl: `https://github.com/${OWNER}/${REPO}`,
      sourceIssueId: lonelyOwner,
    });
    await db.update(issues).set({ executionWorkspaceId: lonelyWorkspace }).where(eq(issues.id, lonelyOwner));
    const none = await carrierOwnerChildAttributionBlock(db, companyId, lonelyOwner, {
      owner: OWNER,
      repo: REPO,
      number: 9,
      headSha: HEAD,
      headRef: "SUP-1-own",
    });
    expect(none).toBeNull();
  });

  it("refuses a missing child commit, a short comparison page, and a list past the pinned head", async () => {
    const input = { token: "sandbox-token", owner: OWNER, repo: REPO, pullRequestNumber: 653, headSha: HEAD, baseRef: "main", childBranch: CHILD_BRANCH };
    mockCommitSources([COMMIT, HEAD], [COMMIT, "b".repeat(40)]);
    expect((await realEnumerate(input)).ok).toBe(false);
    const short = mockCommitSources();
    short.childFault = "truncate";
    expect((await realEnumerate(input)).ok).toBe(false);
    mockCommitSources([COMMIT, HEAD, "c".repeat(40)]);
    expect((await realEnumerate(input)).ok).toBe(false);
  });

  it("refuses a compare page that names a next link even when the visible commits are on the pull request", async () => {
    const controls = mockCommitSources();
    controls.childFault = "next";
    expect((await realEnumerate({
      token: "sandbox-token", owner: OWNER, repo: REPO, pullRequestNumber: 653, headSha: HEAD, baseRef: "main", childBranch: CHILD_BRANCH,
    })).ok).toBe(false);
  });

  it("still blocks the owner when the live head ref differs only by case", async () => {
    const { ownerId, childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    github.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => livePr({
        head: { ref: CARRIER_BRANCH.toLowerCase(), sha: HEAD, repo: { full_name: `${OWNER}/${REPO}` } },
      }),
    }));
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER,
      repo: REPO,
      number: 653,
      headSha: HEAD,
      headRef: CARRIER_BRANCH.toLowerCase(),
    })).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
  });

  it("does not attach or honor an approval after the carrier claim is deleted", async () => {
    const { ownerId, childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    const [decision] = await db.insert(issueExecutionDecisions).values({
      id: randomUUID(),
      companyId,
      issueId: childId,
      stageId: randomUUID(),
      stageType: "approval",
      outcome: "approved",
      body: "approved",
    }).returning();
    await db.update(issues).set({
      executionState: {
        lastDecisionId: decision!.id,
        lastDecisionOutcome: "approved",
        approvalStatus: { finalDelivery: { decisionId: decision!.id, owner: OWNER, repo: REPO, number: 653, headSha: HEAD } },
        delivery: { prNumber: 77, branch: CHILD_BRANCH },
      },
    }).where(eq(issues.id, childId));
    await recordChildCarrierDecision(db, companyId, childId);
    const [row] = await db.select().from(issueChildCarrierAttributions);
    expect(row?.childDecisionId).toBeNull();
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER,
      repo: REPO,
      number: 653,
      headSha: HEAD,
      headRef: CARRIER_BRANCH,
    })).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
  });

  it("refuses a mismatched claim head and clears approval when the commit proof changes", async () => {
    const { childId } = await seedPair();
    await db.update(issues).set({
      executionState: { childCarrierClaim: { prNumber: 653, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653`, headSha: HEAD } },
    }).where(eq(issues.id, childId));
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    const [decision] = await db.insert(issueExecutionDecisions).values({
      id: randomUUID(),
      companyId,
      issueId: childId,
      stageId: randomUUID(),
      stageType: "approval",
      outcome: "approved",
      body: "approved",
    }).returning();
    await db.update(issues).set({
      executionState: {
        lastDecisionId: decision!.id,
        lastDecisionOutcome: "approved",
        approvalStatus: { finalDelivery: { decisionId: decision!.id, owner: OWNER, repo: REPO, number: 653, headSha: HEAD } },
        childCarrierClaim: { prNumber: 653, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653`, headSha: "d".repeat(40) },
      },
    }).where(eq(issues.id, childId));
    await recordChildCarrierDecision(db, companyId, childId);
    const [unbound] = await db.select().from(issueChildCarrierAttributions);
    expect(unbound?.childDecisionId).toBeNull();

    await db.update(issueChildCarrierAttributions).set({ childDecisionId: decision!.id });
    childCarrierCommits.enumerate = async () => ({ ok: true, shas: [COMMIT, "e".repeat(40)] });
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    await db.update(issues).set({
      executionState: { childCarrierClaim: { prNumber: 653, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653`, headSha: HEAD } },
    }).where(eq(issues.id, childId));
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    const [refreshed] = await db.select().from(issueChildCarrierAttributions).where(eq(issueChildCarrierAttributions.state, "current"));
    expect(refreshed?.childDecisionId).toBeNull();
    expect(refreshed?.commitShas).toEqual([COMMIT, "e".repeat(40)].sort());
  });

  it("does not let another repository, a failed enumeration, or a departed child decide the owner gate", async () => {
    const { ownerId, childId } = await seedPair();
    await db.update(executionWorkspaces).set({ repoUrl: `https://github.com/${OWNER}/other` }).where(eq(executionWorkspaces.branchName, CHILD_BRANCH));
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER,
      repo: REPO,
      number: 653,
      headSha: HEAD,
      headRef: CARRIER_BRANCH,
    })).toBeNull();

    await db.update(executionWorkspaces).set({ repoUrl: `https://github.com/${OWNER}/${REPO}` }).where(eq(executionWorkspaces.branchName, CHILD_BRANCH));
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    const [decision] = await db.insert(issueExecutionDecisions).values({
      id: randomUUID(),
      companyId,
      issueId: childId,
      stageId: randomUUID(),
      stageType: "approval",
      outcome: "approved",
      body: "approved",
    }).returning();
    await db.update(issueChildCarrierAttributions).set({ childDecisionId: decision!.id });
    childCarrierCommits.enumerate = async () => ({ ok: false, reason: "child carrier commit enumeration failed: HTTP 503" });
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER,
      repo: REPO,
      number: 653,
      headSha: HEAD,
      headRef: CARRIER_BRANCH,
    })).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);

    childCarrierCommits.enumerate = async () => ({ ok: true, shas: [COMMIT] });
    await db.update(issues).set({ parentId: null }).where(eq(issues.id, childId));
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER,
      repo: REPO,
      number: 653,
      headSha: HEAD,
      headRef: CARRIER_BRANCH,
    })).toBeNull();

    const otherPr = await carrierArmBlock(db, companyId, childId, {
      owner: OWNER,
      repo: REPO,
      number: 23,
      headSha: HEAD,
      headRef: CHILD_BRANCH,
    });
    expect(otherPr).not.toBe(CHILD_CARRIER_STAMP_SKIP);
  });

  it("does not treat an ancestor workspace in another repository as the carrier", async () => {
    const { childId } = await seedPair();
    await db.update(executionWorkspaces).set({ repoUrl: `https://github.com/${OWNER}/tools` }).where(eq(executionWorkspaces.branchName, CARRIER_BRANCH));
    expect(await classifyAncestorCarrierHead(db, companyId, childId, CARRIER_BRANCH)).toBe("absent");
  });
  it.each([
    "https://notgithub.com/TEA-Core/paperclip",
    "https://example.com/github.com/TEA-Core/paperclip",
    "ssh://git@notgithub.com/TEA-Core/paperclip.git",
  ])("does not mint GitHub proof for workspace host %s", async (repoUrl) => {
    const { childId } = await seedPair();
    await db.update(executionWorkspaces).set({ repoUrl }).where(eq(executionWorkspaces.branchName, CHILD_BRANCH));
    expect(await resolveChildCarrierDecisionHead(db, companyId, childId)).toEqual({ kind: "absent" });
    expect(await db.select().from(issueChildCarrierAttributions)).toEqual([]);
    expect(github).not.toHaveBeenCalled();
  });

  it.each([
    "https://github.com/TEA-Core/paperclip.git",
    "git@github.com:TEA-Core/paperclip.git",
    "ssh://git@github.com/TEA-Core/paperclip.git",
  ])("accepts an exact GitHub workspace host in %s", async (repoUrl) => {
    const { childId } = await seedPair();
    await db.update(executionWorkspaces).set({ repoUrl }).where(eq(executionWorkspaces.branchName, CHILD_BRANCH));
    expect((await resolveChildCarrierDecisionHead(db, companyId, childId)).kind).toBe("resolved");
  });

  async function approveChild(childId: string) {
    const [proof] = await db.select().from(issueChildCarrierAttributions).where(eq(issueChildCarrierAttributions.childIssueId, childId)).limit(1);
    if (!proof) throw new Error("Approval fixture requires a verified attribution");
    const [decision] = await db.insert(issueExecutionDecisions).values({
      companyId, issueId: childId, stageId: randomUUID(), stageType: "approval", outcome: "approved", body: "approved",
    }).returning();
    await db.update(issues).set({
      executionState: {
        lastDecisionId: decision!.id, lastDecisionOutcome: "approved", childCarrierClaim: { prNumber: 653, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653`, headSha: HEAD },
        approvalStatus: { finalDelivery: {
          decisionId: decision!.id, owner: OWNER, repo: REPO, number: 653, headSha: HEAD,
          childCarrierProof: { attributionId: proof.id, ancestorIssueId: proof.ancestorIssueId, branchName: proof.branchName, commitShas: proof.commitShas },
        } },
      },
    }).where(eq(issues.id, childId));
    return decision!.id;
  }

  it("does not attach a decision when a concurrent writer replaces the same-head commit proof", async () => {
    const { childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    await approveChild(childId);
    const replacement = [COMMIT, "b".repeat(40)];
    // Pause only the final attachment UPDATE, after its reads. The competing
    // writer changes real persisted proof before the original predicate executes.
    const racingDb = new Proxy(db, {
      get(target, key, receiver) {
        if (key !== "update") return Reflect.get(target, key, receiver);
        return (...args: Parameters<Db["update"]>) => {
          const query = target.update(...args);
          return new Proxy(query, {
            get(builder, property, builderReceiver) {
              if (property !== "set") return Reflect.get(builder, property, builderReceiver);
              return (values: Parameters<typeof query.set>[0]) => {
                const filtered = query.set(values);
                return new Proxy(filtered, {
                  get(setter, clause, setterReceiver) {
                    if (clause !== "where") return Reflect.get(setter, clause, setterReceiver);
                    return async (...conditions: Parameters<typeof filtered.where>) => {
                      await db.update(issueChildCarrierAttributions).set({ commitShas: replacement, childDecisionId: null });
                      return filtered.where(...conditions);
                    };
                  },
                });
              };
            },
          });
        };
      },
    });
    await recordChildCarrierDecision(racingDb, companyId, childId);
    const [row] = await db.select().from(issueChildCarrierAttributions);
    expect(row?.commitShas).toEqual(replacement);
    expect(row?.childDecisionId).toBeNull();
  });

  it("ignores a verified noncontributing branch but refuses its empty child claim and a partial contribution", async () => {
    const { ownerId, childId } = await seedPair();
    childCarrierCommits.enumerate = realEnumerate;
    const controls = mockCommitSources([COMMIT, HEAD], ["b".repeat(40)]);
    const pr = { owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH };
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, pr)).toBeNull();
    expect((await resolveChildCarrierDecisionHead(db, companyId, childId)).kind).toBe("unresolvable");
    controls.childShas = [COMMIT, "b".repeat(40)];
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, pr)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
  });

  it("checks the live carrier branch without a caller headRef and admits only the acting approved owner", async () => {
    const { ownerId, childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    await approveChild(childId);
    await recordChildCarrierDecision(db, companyId, childId);
    const pr = { owner: OWNER, repo: REPO, number: 653, headSha: HEAD };
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, pr)).toBeNull();
    expect(await childCarrierStampBlock(db, companyId, pr, ownerId)).toBeNull();
    expect(await childCarrierStampBlock(db, companyId, pr, childId)).toBe(CHILD_CARRIER_STAMP_SKIP);
    for (const ref of ["other-carrier", null]) {
      github.mockImplementation(async () => ({
        ok: true, status: 200, json: async () => livePr({ head: { ref, sha: HEAD, repo: { full_name: `${OWNER}/${REPO}` } } }),
      }));
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, pr)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    }
  });

  it.each(["other-carrier", null])("refuses the owner's live branch %s when headRef was omitted", async (ref) => {
    const { ownerId, childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    await approveChild(childId);
    await recordChildCarrierDecision(db, companyId, childId);
    github.mockImplementation(async () => ({
      ok: true, status: 200, json: async () => livePr({ head: { ref, sha: HEAD, repo: { full_name: `${OWNER}/${REPO}` } } }),
    }));
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER, repo: REPO, number: 653, headSha: HEAD,
    })).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
  });
  it("attaches and honors the same immutable delivery-only proof accepted by the child resolver", async () => {
    const { ownerId, childId } = await seedPair();
    await db.update(issues).set({ executionState: { delivery: { prNumber: 653, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653`, branch: CARRIER_BRANCH, headSha: HEAD } } }).where(eq(issues.id, childId));
    expect((await resolveChildCarrierDecisionHead(db, companyId, childId)).kind).toBe("resolved");
    const decisionId = await approveChild(childId);
    const [approved] = await db.select().from(issues).where(eq(issues.id, childId));
    await db.update(issues).set({
      executionState: {
        lastDecisionId: decisionId, lastDecisionOutcome: "approved",
        delivery: { prNumber: 653, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653`, branch: CARRIER_BRANCH, headSha: HEAD },
        approvalStatus: approved!.executionState?.approvalStatus,
      },
    }).where(eq(issues.id, childId));
    expect((await resolveChildCarrierDecisionHead(db, companyId, childId)).kind).toBe("resolved");
    await recordChildCarrierDecision(db, companyId, childId);
    const [row] = await db.select().from(issueChildCarrierAttributions);
    expect(row?.childDecisionId).toBe(decisionId);
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH,
    })).toBeNull();
  });
  it("keeps the certified decision at its old head when claim and stored proof both move", async () => {
    const { childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    await approveChild(childId);
    const moved = "d".repeat(40);
    const [issue] = await db.select().from(issues).where(eq(issues.id, childId));
    await db.update(issues).set({ executionState: {
      ...issue!.executionState, childCarrierClaim: { prNumber: 653, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653`, headSha: moved },
    } }).where(eq(issues.id, childId));
    await db.update(issueChildCarrierAttributions).set({ headSha: moved, childDecisionId: null });
    await recordChildCarrierDecision(db, companyId, childId);
    const [row] = await db.select().from(issueChildCarrierAttributions);
    expect(row?.headSha).toBe(moved);
    expect(row?.childDecisionId).toBeNull();
  });

  it("refuses a delivery-only branch mismatch before returning child approval proof", async () => {
    const { childId } = await seedPair();
    await db.update(issues).set({ executionState: { delivery: {
      prNumber: 653, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653`, branch: "release-old", headSha: HEAD,
    } } }).where(eq(issues.id, childId));
    expect((await resolveChildCarrierDecisionHead(db, companyId, childId)).kind).toBe("unresolvable");
    expect((await resolveApprovalDecisionHead(db, companyId, childId, "SUP-22878", true)).kind).toBe("unresolvable");
    expect(await db.select().from(issueChildCarrierAttributions)).toEqual([]);
  });

  it.each(["current", "invalidated"] as const)("does not let a stale %s refresh overwrite a newly approved proof", async (state) => {
    const { childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    const decisionId = await approveChild(childId);
    await db.update(issueChildCarrierAttributions).set({ state, childDecisionId: null });
    let writes = 0;
    const replacement = [COMMIT, "b".repeat(40)];
    const racingDb = new Proxy(db, { get(target, key, receiver) {
      if (key !== "update") return Reflect.get(target, key, receiver);
      return (...args: Parameters<Db["update"]>) => {
        const query = target.update(...args);
        return new Proxy(query, { get(builder, property, builderReceiver) {
          if (property !== "set") return Reflect.get(builder, property, builderReceiver);
          return (values: Parameters<typeof query.set>[0]) => {
            const filtered = query.set(values);
            return new Proxy(filtered, { get(setter, clause, setterReceiver) {
              if (clause !== "where") return Reflect.get(setter, clause, setterReceiver);
              return (...conditions: Parameters<typeof filtered.where>) => {
                const run = async (returning?: Parameters<typeof filtered.returning>) => {
                  if (++writes === 2) await db.update(issueChildCarrierAttributions).set({
                    state: "current", commitShas: replacement, childDecisionId: decisionId,
                  });
                  const pending = filtered.where(...conditions);
                  return returning ? pending.returning(...returning) : pending;
                };
                return {
                  then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => run().then(resolve, reject),
                  returning: (...fields: Parameters<typeof filtered.returning>) => run(fields),
                };
              };
            } });
          };
        } });
      };
    } });
    expect((await resolveChildCarrierDecisionHead(racingDb, companyId, childId)).kind).toBe("unresolvable");
    const [row] = await db.select().from(issueChildCarrierAttributions);
    expect(row?.commitShas).toEqual(replacement);
    expect(row?.childDecisionId).toBe(decisionId);
  });

  it.each(["invalidated", "pending", "changed commits"])("refuses owner publication when remote enumeration outlives a proof becoming %s", async (change) => {
    const { ownerId, childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    await approveChild(childId);
    await recordChildCarrierDecision(db, companyId, childId);
    childCarrierCommits.enumerate = async () => {
      await db.update(issueChildCarrierAttributions).set(change === "invalidated" ? { state: "invalidated" }
        : change === "pending" ? { childDecisionId: null } : { commitShas: ["b".repeat(40)] });
      return { ok: true, shas: [COMMIT] };
    };
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH,
    })).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
  });

  it.each(["retry", "accepted write", "unconfirmed void", "lost response", "lost response unconfirmed void"])("does not retain an owner stamp when child approval changes during %s", async (moment) => {
    const { ownerId, childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    const decisionId = await approveChild(childId);
    await recordChildCarrierDecision(db, companyId, childId);
    await mention(ownerId);
    const states: string[] = [];
    github.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        const state = JSON.parse(String(init.body)).state as string;
        states.push(state);
        if (states.length === 1) {
          await db.update(issueExecutionDecisions).set({ outcome: "changes_requested" }).where(eq(issueExecutionDecisions.id, decisionId));
          if (moment === "retry") return { ok: false, status: 502, json: async () => ({}) };
          if (moment.startsWith("lost response")) throw new TypeError("response lost after accepting success");
        }
        if (state === "failure" && moment.includes("unconfirmed void")) return { ok: false, status: 403, json: async () => ({}) };
        return { ok: true, status: 201, json: async () => ({ id: 1 }) };
      }
      return { ok: true, status: 200, json: async () => livePr() };
    });
    const result = await publishApprovalStatus(db, companyId, ownerId, "SUP-22864", {
      enforceDeliveryIdentity: true, expectedHeadSha: HEAD,
    });
    expect(result.kind).not.toBe("armed");
    expect(states).toEqual(["success", "failure"]);
    if (moment.includes("unconfirmed void")) expect(result.message).toContain("void-unconfirmed");
  });

  it.each([1, 251])("verifies a complete large carrier with a %i-commit child and isolates each comparison refusal", async (childCount) => {
    const childTip = "c".repeat(40);
    const child = childCount === 1 ? [COMMIT] : [
      COMMIT, ...Array.from({ length: 249 }, (_, i) => (i + 1).toString(16).padStart(40, "0")), childTip,
    ];
    const carrier = childCount === 1
      ? [COMMIT, ...Array.from({ length: 249 }, (_, i) => (i + 1).toString(16).padStart(40, "0")), HEAD]
      : [...child, HEAD];
    const controls = mockCommitSources(carrier, child);
    const input = { token: "sandbox-token", owner: OWNER, repo: REPO, pullRequestNumber: 653, headSha: HEAD, baseRef: "main", childBranch: CHILD_BRANCH };
    expect(await realEnumerate(input)).toEqual({ ok: true, shas: [...child].sort() });
    for (const fault of ["truncate", "base"] as const) {
      controls.carrierFault = fault;
      expect((await realEnumerate(input)).ok).toBe(false);
      expect(controls.comparisons.at(-1)?.head).toBe(HEAD);
    }
    controls.carrierFault = null;
    if (childCount > 250) {
      for (const fault of ["truncate", "base"] as const) {
        controls.childFault = fault;
        expect((await realEnumerate(input)).ok).toBe(false);
        expect(controls.comparisons.at(-1)?.head).toBe(childTip);
      }
    }
  });

  it("keeps the contribution on one pinned base when the named base moves after the carrier read", async () => {
    const carrier = [COMMIT, ...Array.from({ length: 249 }, (_, i) => (i + 1).toString(16).padStart(40, "0")), HEAD];
    const controls = mockCommitSources(carrier);
    controls.namedBaseMoved = true;
    expect(await realEnumerate({
      token: "sandbox-token", owner: OWNER, repo: REPO, pullRequestNumber: 653, headSha: HEAD, baseRef: "main", childBranch: CHILD_BRANCH,
    })).toEqual({ ok: true, shas: [COMMIT] });
    expect(new Set(controls.comparisons.map(({ base }) => base))).toEqual(new Set(["f".repeat(40)]));
    expect(new Set(controls.comparisons.map(({ head }) => head))).toEqual(new Set([HEAD, COMMIT]));
  });

  it("refuses a small child comparison whose returned base differs from the pinned base", async () => {
    const controls = mockCommitSources();
    controls.childFault = "base";
    expect((await realEnumerate({
      token: "sandbox-token", owner: OWNER, repo: REPO, pullRequestNumber: 653, headSha: HEAD, baseRef: "main", childBranch: CHILD_BRANCH,
    })).ok).toBe(false);
  });

  it("does not attach an older decision to a restored larger commit set at the same carrier head", async () => {
    const { ownerId, childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    await approveChild(childId);
    childCarrierCommits.enumerate = async () => ({ ok: true, shas: [COMMIT, "b".repeat(40)] });
    expect((await resolveChildCarrierDecisionHead(db, companyId, childId)).kind).toBe("unresolvable");
    expect((await resolveChildCarrierDecisionHead(db, companyId, childId)).kind).toBe("resolved");
    await recordChildCarrierDecision(db, companyId, childId);
    const [row] = await db.select().from(issueChildCarrierAttributions);
    expect(row).toMatchObject({ state: "current", headSha: HEAD, commitShas: [COMMIT, "b".repeat(40)], childDecisionId: null });
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH,
    })).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
  });

  it("ignores a different-repository attribution for a disjoint child on the target PR", async () => {
    const { ownerId, childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    await db.update(issueChildCarrierAttributions).set({ repo: "old-repository" });
    childCarrierCommits.enumerate = async () => ({ ok: true, shas: [] });
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH,
    })).toBeNull();
  });

  it("does not combine disjoint child results from different carrier bases", async () => {
    const { ownerId } = await seedPair();
    const [owner] = await db.select().from(issues).where(eq(issues.id, ownerId));
    const secondId = randomUUID();
    const secondBranch = "second-child";
    const secondCommit = "b".repeat(40);
    await db.insert(issues).values({
      id: secondId, companyId, projectId: owner!.projectId, parentId: ownerId,
      title: "Second child", status: "in_review", identifier: "SUP-22879",
    });
    const [workspace] = await db.insert(executionWorkspaces).values({
      companyId, projectId: owner!.projectId!, sourceIssueId: secondId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "second",
      status: "active", branchName: secondBranch, repoUrl: `https://github.com/${OWNER}/${REPO}`,
    }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace!.id }).where(eq(issues.id, secondId));
    let currentChildBranch = "";
    childCarrierCommits.enumerate = (input) => { currentChildBranch = input.childBranch; return realEnumerate(input); };
    github.mockImplementation(async (url: string) => {
      const pathname = decodeURIComponent(new URL(url).pathname);
      let body: unknown;
      if (pathname.includes("/commits/")) {
        const ref = pathname.split("/commits/")[1];
        body = { sha: ref === CHILD_BRANCH ? COMMIT : ref === secondBranch ? secondCommit : currentChildBranch === CHILD_BRANCH ? COMMIT : secondCommit };
      } else if (pathname.includes("/compare/")) {
        const [base, head] = pathname.split("/compare/")[1]!.split("...");
        const shas = head === HEAD ? [base === COMMIT ? secondCommit : COMMIT, HEAD] : head === base ? [] : [head!];
        body = { base_commit: { sha: base }, total_commits: shas.length, commits: shas.map((sha) => ({ sha })) };
      } else body = livePr();
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
    });
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH,
    })).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
  });

  it.each([
    `https://github.com/${OWNER}/old-repository/pull/653`,
    `https://github.com/${OWNER}/${REPO}/pull/654`,
    `https://github.com.evil/${OWNER}/${REPO}/pull/653`,
    null,
  ])("does not certify a child claim with unproven recorded PR URL %s", async (prUrl) => {
    const { childId } = await seedPair();
    await db.update(issues).set({ executionState: { childCarrierClaim: { prNumber: 653, headSha: HEAD, prUrl } } })
      .where(eq(issues.id, childId));
    expect((await resolveChildCarrierDecisionHead(db, companyId, childId)).kind).toBe("unresolvable");
    expect(await db.select().from(issueChildCarrierAttributions)).toEqual([]);
  });

  it.each(["claim head", "stored head", "commits"])("does not invalidate newer approved proof after a stale %s read", async (reason) => {
    const { childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    if (reason === "claim head") {
      await db.update(issues).set({ executionState: { childCarrierClaim: {
        prNumber: 653, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653`, headSha: "d".repeat(40),
      } } }).where(eq(issues.id, childId));
    }
    if (reason === "stored head") {
      github.mockImplementation(async () => ({ ok: true, status: 200, json: async () => livePr({
        head: { ref: CARRIER_BRANCH, sha: "d".repeat(40), repo: { full_name: `${OWNER}/${REPO}` } },
      }) }));
    }
    const replacement = [COMMIT, "b".repeat(40)];
    if (reason === "commits") childCarrierCommits.enumerate = async () => ({ ok: true, shas: replacement });
    let replacementDecision: string | undefined;
    const racingDb = new Proxy(db, { get(target, key, receiver) {
      if (key !== "update") return Reflect.get(target, key, receiver);
      return (...args: Parameters<Db["update"]>) => {
        const query = target.update(...args);
        return new Proxy(query, { get(builder, property, builderReceiver) {
          if (property !== "set") return Reflect.get(builder, property, builderReceiver);
          return (values: Parameters<typeof query.set>[0]) => {
            const filtered = query.set(values);
            return new Proxy(filtered, { get(setter, clause, setterReceiver) {
              if (clause !== "where") return Reflect.get(setter, clause, setterReceiver);
              return async (...conditions: Parameters<typeof filtered.where>) => {
                if ("state" in values && values.state === "invalidated") {
                  await db.update(issueChildCarrierAttributions).set({ commitShas: replacement });
                  replacementDecision = await approveChild(childId);
                  await recordChildCarrierDecision(db, companyId, childId);
                }
                return filtered.where(...conditions);
              };
            } });
          };
        } });
      };
    } });
    expect((await resolveChildCarrierDecisionHead(racingDb, companyId, childId)).kind).toBe("unresolvable");
    const [row] = await db.select().from(issueChildCarrierAttributions);
    expect(row).toMatchObject({ state: "current", commitShas: replacement, childDecisionId: replacementDecision });
  });

  it.each([["claim", "attachment"], ["claim", "owner gate"], ["binding", "attachment"], ["binding", "owner gate"]])("rejects %s repository drift at the %s after preflight", async (source, site) => {
    const { childId, ownerId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    await approveChild(childId);
    const pr = { owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH };
    if (site === "owner gate") {
      await recordChildCarrierDecision(db, companyId, childId);
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, pr)).toBeNull();
    }
    const [child] = await db.select().from(issues).where(eq(issues.id, childId));
    const state = { ...child!.executionState };
    const identity = { prNumber: 653, headSha: HEAD, prUrl: `https://github.com/${OWNER}/old-repository/pull/653` };
    if (source === "claim") state.childCarrierClaim = identity;
    else {
      delete state.childCarrierClaim;
      state.delivery = { ...identity, branch: CARRIER_BRANCH };
    }
    await db.update(issues).set({ executionState: state }).where(eq(issues.id, childId));
    if (site === "attachment") {
      await recordChildCarrierDecision(db, companyId, childId);
      const [row] = await db.select().from(issueChildCarrierAttributions);
      expect(row!.childDecisionId).toBeNull();
    } else expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, pr)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
  });

  it.each([
    `https://github.com/${OWNER}/old-repository/pull/653`,
    `https://github.com/${OWNER}/${REPO}/pull/654`,
    `https://github.com.evil/${OWNER}/${REPO}/pull/653`,
    null,
  ])("does not certify a delivery-only binding with unproven recorded PR URL %s", async (prUrl) => {
    const { childId } = await seedPair();
    await db.update(issues).set({ executionState: { delivery: {
      prNumber: 653, headSha: HEAD, branch: CARRIER_BRANCH, prUrl,
    } } }).where(eq(issues.id, childId));
    expect((await resolveChildCarrierDecisionHead(db, companyId, childId)).kind).toBe("unresolvable");
    expect(await db.select().from(issueChildCarrierAttributions)).toEqual([]);
  });
});
