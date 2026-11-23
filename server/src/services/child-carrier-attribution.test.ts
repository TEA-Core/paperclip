import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
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
  type ChildCarrierResolution,
} from "./child-carrier-attribution.js";
import { publishApprovalStatus, resolveApprovalDecisionHead } from "./merge-arming.js";
import { issueService } from "./issues.js";

const github = vi.hoisted(() => vi.fn());
const credentialCandidates = vi.hoisted(() => vi.fn());
vi.mock("./github-fetch.js", () => ({
  ghFetch: (...args: unknown[]) => github(...args),
  gitHubApiBase: () => "https://api.github.com",
}));
vi.mock("./github-credential.js", () => ({
  resolveGitHubTokenCandidatesForRepo: (...args: unknown[]) => credentialCandidates(...args),
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

type CompareFault = "truncate" | "base" | "next" | "oversize" | "short" | "duplicate" | "total" | null;

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
      let rows = paged ? source.slice((page - 1) * 100, page * 100) : source.slice(0, 250);
      if (fault === "truncate" && page === Math.ceil(source.length / 100)) rows.pop();
      if (fault === "oversize" && page === 1) rows = source.slice();
      if (fault === "short") {
        const start = page === 1 ? 0 : (page - 1) * 100 - 1;
        rows = source.slice(start, start + (page === 1 ? 99 : 100));
      }
      if (fault === "duplicate" && rows.length > 1) rows[1] = rows[0]!;
      const moved = !carrier && controls.namedBaseMoved && base !== baseSha;
      body = {
        base_commit: { sha: moved || (fault === "base" && page === Math.min(2, Math.ceil(source.length / 100))) ? "d".repeat(40) : baseSha },
        total_commits: moved ? 0 : source.length + (fault === "total" && page === 1 ? 1 : 0),
        commits: moved ? [] : rows.map((sha) => ({ sha })),
      };
      next = fault === "next" || (paged && page * 100 < source.length);
      if (fault === "oversize" && page === 1) next = false;
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
    credentialCandidates.mockReset().mockResolvedValue([{ token: "sandbox-token", scope: "company", secretName: "GITHUB_TOKEN" }]);
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

    await approveChild(childId);
    await recordChildCarrierDecision(db, companyId, childId);
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

  it.each(["oversize", "short", "duplicate", "total"] as const)("refuses a %s comparison response without relying on a bad tip or missing child", async (fault) => {
    const carrier = [COMMIT, ...Array.from({ length: 249 }, (_, i) => (i + 1).toString(16).padStart(40, "0")), HEAD];
    const controls = mockCommitSources(carrier);
    const input = { token: "sandbox-token", owner: OWNER, repo: REPO, pullRequestNumber: 653, headSha: HEAD, baseRef: "main", childBranch: CHILD_BRANCH };
    expect(await realEnumerate(input)).toEqual({ ok: true, shas: [COMMIT] });

    controls.carrierFault = fault;
    expect((await realEnumerate(input)).ok).toBe(false);
  });

  it("keeps an over-limit proof refusal independent of an unavailable later page", async () => {
    const carrier = [COMMIT, ...Array.from({ length: 1_999 }, (_, i) => (i + 1).toString(16).padStart(40, "0")), HEAD];
    mockCommitSources(carrier);
    const input = { token: "sandbox-token", owner: OWNER, repo: REPO, pullRequestNumber: 653, headSha: HEAD, baseRef: "main", childBranch: CHILD_BRANCH };
    const overLimit = await realEnumerate(input);
    expect(overLimit.ok).toBe(false);

    const transport = github.getMockImplementation()!;
    github.mockImplementation(async (url: unknown) => {
      const target = new URL(String(url));
      if (target.pathname.includes("/compare/") && Number(target.searchParams.get("page") ?? 1) > 1) {
        return { ok: false, status: 403, json: async () => ({ message: "later page is not readable" }) };
      }
      return transport(url);
    });
    expect(await realEnumerate(input)).toEqual(overLimit);
  });

  it("classifies malformed provider JSON as invalid proof rather than transport loss", async () => {
    const input = { token: "sandbox-token", owner: OWNER, repo: REPO, pullRequestNumber: 653, headSha: HEAD, baseRef: "main", childBranch: CHILD_BRANCH };
    mockCommitSources(["not-a-sha", HEAD]);
    const invalidCommits = await realEnumerate(input);
    expect(invalidCommits.ok).toBe(false);

    mockCommitSources();
    const transport = github.getMockImplementation()!;
    github.mockImplementation(async (url: unknown) => {
      const response = await transport(url);
      return String(url).includes("/compare/") ? { ...response, json: async () => null } : response;
    });
    const malformed = await realEnumerate(input);
    github.mockRejectedValue(new Error("provider is unreachable"));
    const unavailable = await realEnumerate(input);

    expect(unavailable.ok).toBe(false);
    expect(malformed).toEqual(invalidCommits);
    expect(malformed).not.toEqual(unavailable);
  });

  it("refuses an empty comparison while the contributing child's approved system attribution is still current", async () => {
    const { ownerId, childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    await approveChild(childId);
    await recordChildCarrierDecision(db, companyId, childId);
    const pr = { owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH };
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, pr)).toBeNull();

    childCarrierCommits.enumerate = realEnumerate;
    mockCommitSources([COMMIT, HEAD], []);
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, pr)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    const [row] = await db.select().from(issueChildCarrierAttributions);
    expect(row).toMatchObject({ state: "current", writtenByActorType: "system", commitShas: [COMMIT] });
  });

  it("refuses a case-only caller carrier reference with a valid final child approval", async () => {
    const { ownerId, childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    await approveChild(childId);
    await recordChildCarrierDecision(db, companyId, childId);
    const pr = { owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH };
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, pr)).toBeNull();
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      ...pr, headRef: CARRIER_BRANCH.toLowerCase(),
    })).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
  });

  it.each(["head SHA", "carrier branch", "commit set"] as const)("refuses a changed stored %s after valid child approval", async (field) => {
    const { ownerId, childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    await approveChild(childId);
    await recordChildCarrierDecision(db, companyId, childId);
    const [child] = await db.select().from(issues).where(eq(issues.id, childId));
    await db.update(issues).set({ executionState: {
      ...child!.executionState,
      childCarrierClaim: { prNumber: 653, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653` },
    } }).where(eq(issues.id, childId));
    const pr = { owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH };
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, pr)).toBeNull();

    await db.update(issueChildCarrierAttributions).set(
      field === "head SHA" ? { headSha: "b".repeat(40) }
        : field === "carrier branch" ? { branchName: "other-carrier" } : { commitShas: ["b".repeat(40)] },
    ).where(eq(issueChildCarrierAttributions.childIssueId, childId));
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, pr)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
  });

  it("keeps a detached descendant's governed obligation until its work is cancelled", async () => {
    const { ownerId, childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    const decisionId = await approveChild(childId);
    await recordChildCarrierDecision(db, companyId, childId);
    await issueService(db).update(childId, { parentId: null });
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH,
    })).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    const [row] = await db.select().from(issueChildCarrierAttributions);
    expect(row).toMatchObject({ state: "current", childDecisionId: decisionId, ancestorIssueId: ownerId });
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, childId));
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH,
    })).toBeNull();
  });

  it("still blocks the owner when the live head ref differs only by case", async () => {
    const { ownerId, childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    await approveChild(childId);
    await recordChildCarrierDecision(db, companyId, childId);
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH,
    })).toBeNull();
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
    const decisionId = await approveChild(childId);
    const [child] = await db.select().from(issues).where(eq(issues.id, childId));
    const state = { ...child!.executionState! };
    const claim = state.childCarrierClaim;
    delete state.childCarrierClaim;
    await db.update(issues).set({ executionState: state }).where(eq(issues.id, childId));
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

    await db.update(issues).set({ executionState: { ...state, childCarrierClaim: claim } }).where(eq(issues.id, childId));
    await recordChildCarrierDecision(db, companyId, childId);
    const [attached] = await db.select().from(issueChildCarrierAttributions);
    expect(attached!.childDecisionId).toBe(decisionId);
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH,
    })).toBeNull();
  });

  it("refuses a mismatched claim head and clears approval when the commit proof changes", async () => {
    const { ownerId, childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    const decisionId = await approveChild(childId);
    const [child] = await db.select().from(issues).where(eq(issues.id, childId));
    const state = child!.executionState!;
    await db.update(issues).set({ executionState: {
      ...state, childCarrierClaim: {
        prNumber: 653, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653`, headSha: "d".repeat(40),
      },
    } }).where(eq(issues.id, childId));
    await recordChildCarrierDecision(db, companyId, childId);
    const [unbound] = await db.select().from(issueChildCarrierAttributions);
    expect(unbound!.childDecisionId).toBeNull();
    await db.update(issues).set({ executionState: state }).where(eq(issues.id, childId));
    await recordChildCarrierDecision(db, companyId, childId);
    const target = { owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH };
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBeNull();
    expect((await db.select().from(issueChildCarrierAttributions))[0]!.childDecisionId).toBe(decisionId);

    childCarrierCommits.enumerate = async () => ({ ok: true, shas: [COMMIT, "e".repeat(40)] });
    expect((await resolveChildCarrierDecisionHead(db, companyId, childId)).kind).toBe("unresolvable");
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    // A new verified request records the changed proof, never the old approval.
    expect((await resolveChildCarrierDecisionHead(db, companyId, childId)).kind).toBe("resolved");
    const [refreshed] = await db.select().from(issueChildCarrierAttributions).where(eq(issueChildCarrierAttributions.state, "current"));
    expect(refreshed!.childDecisionId).toBeNull();
    expect(refreshed!.commitShas).toEqual([COMMIT, "e".repeat(40)].sort());
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
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
    })).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);

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
        lastDecisionId: decision!.id, lastDecisionOutcome: "approved", childCarrierClaim: { prNumber: proof.pullRequestNumber, prUrl: `https://github.com/${OWNER}/${REPO}/pull/${proof.pullRequestNumber}`, headSha: proof.headSha },
        approvalStatus: { finalDelivery: {
          decisionId: decision!.id, owner: OWNER, repo: REPO, number: proof.pullRequestNumber, headSha: proof.headSha,
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
    const interception: ProxyHandler<Db> = {
      get(target, key, receiver) {
        if (key === "transaction") {
          return (callback: (tx: Db) => Promise<unknown>) =>
            target.transaction((tx) => callback(new Proxy(tx as unknown as Db, interception)));
        }
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
    };
    const racingDb = new Proxy(db, interception);
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
    const { ownerId, childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    await approveChild(childId);
    await recordChildCarrierDecision(db, companyId, childId);
    await db.update(issueChildCarrierAttributions).set({ state });
    const replacement = [COMMIT, "b".repeat(40)];
    let decisionId: string | undefined;
    childCarrierCommits.enumerate = async () => {
      childCarrierCommits.enumerate = async () => ({ ok: true, shas: replacement });
      if (state === "current") {
        expect((await resolveChildCarrierDecisionHead(db, companyId, childId)).kind).toBe("unresolvable");
      }
      expect((await resolveChildCarrierDecisionHead(db, companyId, childId)).kind).toBe("resolved");
      decisionId = await approveChild(childId);
      await recordChildCarrierDecision(db, companyId, childId);
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
        owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH,
      })).toBeNull();
      return { ok: true, shas: [COMMIT] };
    };
    expect((await resolveChildCarrierDecisionHead(db, companyId, childId)).kind).toBe("unresolvable");
    const [row] = await db.select().from(issueChildCarrierAttributions);
    expect(row!.commitShas).toEqual(replacement);
    expect(row!.childDecisionId).toBe(decisionId);
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH,
    })).toBeNull();
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

  it.each(["carrier", "child"] as const)("refuses a %s comparison whose returned base differs from the pinned base", async (side) => {
    const controls = mockCommitSources();
    const input = { token: "sandbox-token", owner: OWNER, repo: REPO, pullRequestNumber: 653, headSha: HEAD, baseRef: "main", childBranch: CHILD_BRANCH };
    expect(await realEnumerate(input)).toEqual({ ok: true, shas: [COMMIT] });
    controls[side === "carrier" ? "carrierFault" : "childFault"] = "base";
    expect((await realEnumerate(input)).ok).toBe(false);
    controls[side === "carrier" ? "carrierFault" : "childFault"] = null;
    expect(await realEnumerate(input)).toEqual({ ok: true, shas: [COMMIT] });
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

  it.each(["stored head", "commits"])("does not invalidate newer approved proof after a stale %s read", async (reason) => {
    const { childId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
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

  it("does not attach a valid decision while its claim selects another immutable carrier head", async () => {
    const { childId, ownerId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    const decisionId = await approveChild(childId);
    const [child] = await db.select().from(issues).where(eq(issues.id, childId));
    const state = { ...child!.executionState };
    delete state.delivery;
    const claim = {
      prNumber: 653, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653`, headSha: "d".repeat(40),
    };
    state.childCarrierClaim = claim;
    await db.update(issues).set({ executionState: state }).where(eq(issues.id, childId));
    await recordChildCarrierDecision(db, companyId, childId);
    const [refused] = await db.select().from(issueChildCarrierAttributions);
    expect(refused!.childDecisionId).toBeNull();

    claim.headSha = HEAD;
    await db.update(issues).set({ executionState: state }).where(eq(issues.id, childId));
    await recordChildCarrierDecision(db, companyId, childId);
    const [attached] = await db.select().from(issueChildCarrierAttributions);
    expect(attached!.childDecisionId).toBe(decisionId);
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
      owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH,
    })).toBeNull();
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

  it("does not count an old attached approval after the current child review proof is cleared", async () => {
    const { childId, ownerId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    await approveChild(childId);
    await recordChildCarrierDecision(db, companyId, childId);
    const pr = { owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH };
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, pr)).toBeNull();
    const [child] = await db.select().from(issues).where(eq(issues.id, childId));
    await db.update(issues).set({
      status: "in_progress",
      executionState: { status: "active", childCarrierClaim: child!.executionState!.childCarrierClaim },
    }).where(eq(issues.id, childId));
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, pr)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
  });

  it("requires the new final child decision to attach before an older approval can be superseded", async () => {
    const { childId, ownerId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    await approveChild(childId);
    await recordChildCarrierDecision(db, companyId, childId);
    const newDecision = await approveChild(childId);
    const pr = { owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH };
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, pr)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    await recordChildCarrierDecision(db, companyId, childId);
    const [row] = await db.select().from(issueChildCarrierAttributions);
    expect(row!.childDecisionId).toBe(newDecision);
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, pr)).toBeNull();
  });

  it("does not revive a revoked final child approval after only an intermediate stage approves", async () => {
    const { childId, ownerId } = await seedPair();
    await resolveChildCarrierDecisionHead(db, companyId, childId);
    const oldDecisionId = await approveChild(childId);
    await recordChildCarrierDecision(db, companyId, childId);
    const [oldDecision] = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.id, oldDecisionId));
    const [rejected] = await db.insert(issueExecutionDecisions).values({
      companyId, issueId: childId, stageId: oldDecision!.stageId, stageType: "approval",
      outcome: "changes_requested", body: "Final approval revoked for review",
    }).returning();
    const [child] = await db.select().from(issues).where(eq(issues.id, childId));
    const claim = child!.executionState!.childCarrierClaim;
    await db.update(issues).set({ status: "in_progress", executionState: {
      status: "active", currentStageId: oldDecision!.stageId,
      lastDecisionId: rejected!.id, lastDecisionOutcome: "changes_requested", childCarrierClaim: claim,
    } }).where(eq(issues.id, childId));
    const pr = { owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH };
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, pr)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    const [intermediate] = await db.insert(issueExecutionDecisions).values({
      companyId, issueId: childId, stageId: randomUUID(), stageType: "approval",
      outcome: "approved", body: "Intermediate stage approved; final review remains pending",
    }).returning();
    await db.update(issues).set({ executionState: {
      status: "active", currentStageId: oldDecision!.stageId,
      lastDecisionId: intermediate!.id, lastDecisionOutcome: "approved", childCarrierClaim: claim,
    } }).where(eq(issues.id, childId));
    expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, pr)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
  });

  describe("governed proof identity and stale writers", () => {
    const target = { owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH };

    function afterInitialChildSnapshot(afterRead: () => Promise<void>): Db {
      let read = false;
      return new Proxy(db, { get(base, key, receiver) {
        if (key !== "select") return Reflect.get(base, key, receiver);
        return (...args: Parameters<Db["select"]>) => {
          const selected = base.select(...args);
          const fields = args[0] as Record<string, unknown> | undefined;
          if (!fields || !("identifier" in fields) || !("executionState" in fields)) return selected;
          return new Proxy(selected, { get(selection, member, selectionReceiver) {
            if (member !== "from") return Reflect.get(selection, member, selectionReceiver);
            return (...tables: Parameters<typeof selected.from>) => {
              const query = selection.from(...tables);
              if (tables[0] !== issues) return query;
              return new Proxy(query, { get(builder, method, builderReceiver) {
                if (method !== "then") return Reflect.get(builder, method, builderReceiver);
                return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
                  query.then(async (rows) => {
                    if (!read) { read = true; await afterRead(); }
                    return rows;
                  }).then(resolve, reject);
              } });
            };
          } });
        };
      } });
    }

    it.each([
      ["repository owner", "current"], ["repository owner", "invalidated"],
      ["repository", "current"], ["repository", "invalidated"],
      ["ancestor", "current"], ["ancestor", "invalidated"],
    ] as const)("preserves historical %s identity on a %s proof collision", async (field, state) => {
      const { ownerId, childId } = await seedPair();
      const first = await resolveChildCarrierDecisionHead(db, companyId, childId);
      expect(first.kind).toBe("resolved");
      expect(await resolveChildCarrierDecisionHead(db, companyId, childId)).toEqual(first);
      if (state === "invalidated") {
        await db.update(issueChildCarrierAttributions).set({ state, invalidatedAt: new Date() });
      }
      const before = await db.select().from(issueChildCarrierAttributions);
      if (field === "ancestor") {
        const [owner] = await db.select().from(issues).where(eq(issues.id, ownerId));
        const nextOwner = randomUUID();
        await db.insert(issues).values({
          id: nextOwner, companyId, projectId: owner!.projectId, title: "Replacement carrier owner",
          status: "in_review", identifier: "SUP-22865",
        });
        await db.update(executionWorkspaces).set({ branchName: "retired-carrier" })
          .where(eq(executionWorkspaces.sourceIssueId, ownerId));
        const [workspace] = await db.insert(executionWorkspaces).values({
          companyId, projectId: owner!.projectId!, sourceIssueId: nextOwner,
          mode: "isolated_workspace", strategyType: "git_worktree", name: "replacement carrier",
          status: "active", branchName: CARRIER_BRANCH, repoUrl: `https://github.com/${OWNER}/${REPO}`,
        }).returning();
        await db.update(issues).set({ executionWorkspaceId: workspace!.id }).where(eq(issues.id, nextOwner));
        await issueService(db).update(childId, { parentId: nextOwner });
      } else {
        const owner = field === "repository owner" ? "other-owner" : OWNER;
        const repo = field === "repository" ? "other-repository" : REPO;
        await db.update(executionWorkspaces).set({ repoUrl: `https://github.com/${owner}/${repo}` })
          .where(eq(executionWorkspaces.companyId, companyId));
        await db.update(issues).set({ executionState: { childCarrierClaim: {
          prNumber: 653, headSha: HEAD, prUrl: `https://github.com/${owner}/${repo}/pull/653`,
        } } }).where(eq(issues.id, childId));
        github.mockImplementation(async () => ({ ok: true, status: 200, json: async () => livePr({
          head: { ref: CARRIER_BRANCH, sha: HEAD, repo: { full_name: `${owner}/${repo}` } },
        }) }));
      }
      expect((await resolveChildCarrierDecisionHead(db, companyId, childId)).kind).toBe("unresolvable");
      expect(await db.select().from(issueChildCarrierAttributions)).toEqual(before);
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it.each([
      ["current", "in_review"], ["invalidated", "in_review"],
      ["current", "cancelled"], ["invalidated", "cancelled"],
    ] as const)("refuses ancestor deletion with %s proof even when the owner is %s", async (state, ownerStatus) => {
      const { ownerId, childId } = await seedPair();
      await resolveChildCarrierDecisionHead(db, companyId, childId);
      if (state === "invalidated") await db.update(issueChildCarrierAttributions).set({ state, invalidatedAt: new Date() });
      await issueService(db).update(childId, { parentId: null });
      await db.update(issues).set({ status: ownerStatus }).where(eq(issues.id, ownerId));
      await expect(issueService(db).remove(ownerId)).rejects.toMatchObject({ status: 409 });
      expect(await db.select().from(issues).where(eq(issues.id, ownerId))).toHaveLength(1);
      expect(await db.select().from(issueChildCarrierAttributions)).toHaveLength(1);
      await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, childId));
      expect(await issueService(db).remove(ownerId)).toMatchObject({ id: ownerId });
    });

    it.each(["head", "commit set", "identical proof"] as const)("does not let a stale enumerator replace a newer approved %s", async (field) => {
      const { ownerId, childId } = await seedPair();
      const olderHead = field === "head" ? "d".repeat(40) : HEAD;
      const newerShas = field === "commit set" ? [COMMIT, "b".repeat(40)] : [COMMIT];
      await db.update(issues).set({ executionState: { childCarrierClaim: {
        prNumber: 653, headSha: olderHead, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653`,
      } } }).where(eq(issues.id, childId));
      github.mockImplementation(async () => ({ ok: true, status: 200, json: async () => livePr({
        head: { ref: CARRIER_BRANCH, sha: olderHead, repo: { full_name: `${OWNER}/${REPO}` } },
      }) }));
      let entered!: () => void;
      let resume!: () => void;
      const enumerating = new Promise<void>((resolve) => { entered = resolve; });
      const released = new Promise<void>((resolve) => { resume = resolve; });
      let first = true;
      childCarrierCommits.enumerate = async () => {
        if (first) { first = false; entered(); await released; return { ok: true, shas: [COMMIT] }; }
        return { ok: true, shas: newerShas };
      };
      const older = resolveChildCarrierDecisionHead(db, companyId, childId);
      await enumerating;
      let newerDecision: string;
      let refused!: ChildCarrierResolution;
      try {
        github.mockImplementation(async () => ({ ok: true, status: 200, json: async () => livePr() }));
        await db.update(issues).set({ executionState: { childCarrierClaim: {
          prNumber: 653, headSha: HEAD, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653`,
        } } }).where(eq(issues.id, childId));
        expect((await resolveChildCarrierDecisionHead(db, companyId, childId)).kind).toBe("resolved");
        newerDecision = await approveChild(childId);
        await recordChildCarrierDecision(db, companyId, childId);
        expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBeNull();
      } finally {
        resume();
        refused = await older;
      }
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBeNull();
      expect(refused.kind).toBe(field === "identical proof" ? "resolved" : "unresolvable");
      const [current] = await db.select().from(issueChildCarrierAttributions).where(eq(issueChildCarrierAttributions.state, "current"));
      expect(current).toMatchObject({ headSha: HEAD, commitShas: newerShas, childDecisionId: newerDecision! });
    });

    it("refuses an older claim without invalidating the already approved live head", async () => {
      const { ownerId, childId } = await seedPair();
      await resolveChildCarrierDecisionHead(db, companyId, childId);
      const decisionId = await approveChild(childId);
      await recordChildCarrierDecision(db, companyId, childId);
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBeNull();
      const [child] = await db.select().from(issues).where(eq(issues.id, childId));
      await db.update(issues).set({ executionState: {
        ...child!.executionState, childCarrierClaim: {
          prNumber: 653, headSha: "d".repeat(40), prUrl: `https://github.com/${OWNER}/${REPO}/pull/653`,
        },
      } }).where(eq(issues.id, childId));
      const refused = await resolveChildCarrierDecisionHead(db, companyId, childId);
      expect(refused.kind).toBe("unresolvable");
      const [current] = await db.select().from(issueChildCarrierAttributions);
      expect(current).toMatchObject({ state: "current", headSha: HEAD, childDecisionId: decisionId });
      await db.update(issues).set({ executionState: child!.executionState }).where(eq(issues.id, childId));
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBeNull();
    });

    it("does not invalidate proof installed while an older provider read is in flight", async () => {
      const { ownerId, childId } = await seedPair();
      const olderHead = "d".repeat(40);
      await db.update(issues).set({ executionState: { childCarrierClaim: {
        prNumber: 653, headSha: olderHead, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653`,
      } } }).where(eq(issues.id, childId));
      let newerDecision: string | undefined;
      github.mockImplementationOnce(async () => {
        github.mockImplementation(async () => ({ ok: true, status: 200, json: async () => livePr() }));
        await db.update(issues).set({ executionState: { childCarrierClaim: {
          prNumber: 653, headSha: HEAD, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653`,
        } } }).where(eq(issues.id, childId));
        expect((await resolveChildCarrierDecisionHead(db, companyId, childId)).kind).toBe("resolved");
        newerDecision = await approveChild(childId);
        await recordChildCarrierDecision(db, companyId, childId);
        expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBeNull();
        return { ok: true, status: 200, json: async () => livePr({
          head: { ref: CARRIER_BRANCH, sha: olderHead, repo: { full_name: `${OWNER}/${REPO}` } },
        }) };
      });
      expect((await resolveChildCarrierDecisionHead(db, companyId, childId)).kind).toBe("unresolvable");
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBeNull();
      const [current] = await db.select().from(issueChildCarrierAttributions).where(eq(issueChildCarrierAttributions.state, "current"));
      expect(current).toMatchObject({ headSha: HEAD, childDecisionId: newerDecision });
    });

    it("does not let an older attachment replace a newer current decision", async () => {
      const { ownerId, childId } = await seedPair();
      await resolveChildCarrierDecisionHead(db, companyId, childId);
      await approveChild(childId);
      await recordChildCarrierDecision(db, companyId, childId);
      let newerDecision: string | undefined;
      const stale = afterInitialChildSnapshot(async () => {
        newerDecision = await approveChild(childId);
        await recordChildCarrierDecision(db, companyId, childId);
        expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBeNull();
      });
      await recordChildCarrierDecision(stale, companyId, childId);
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBeNull();
      const [current] = await db.select().from(issueChildCarrierAttributions);
      expect(current!.childDecisionId).toBe(newerDecision);
    });
  });

  describe("independent owner authority boundaries", () => {
    const target = { owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH };

    async function approvedPair() {
      const pair = await seedPair();
      await resolveChildCarrierDecisionHead(db, companyId, pair.childId);
      const decisionId = await approveChild(pair.childId);
      await recordChildCarrierDecision(db, companyId, pair.childId);
      expect(await carrierOwnerChildAttributionBlock(db, companyId, pair.ownerId, target)).toBeNull();
      return { ...pair, decisionId };
    }

    async function childState(childId: string) {
      const [child] = await db.select().from(issues).where(eq(issues.id, childId));
      return child!.executionState!;
    }

    async function addSibling(ownerId: string) {
      const [owner] = await db.select().from(issues).where(eq(issues.id, ownerId));
      const childId = randomUUID();
      await db.insert(issues).values({
        id: childId, companyId, projectId: owner!.projectId, parentId: ownerId,
        identifier: "SUP-22879", title: "Second child", status: "in_review",
        executionState: { childCarrierClaim: { prNumber: 653, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653` } },
      });
      const [workspace] = await db.insert(executionWorkspaces).values({
        companyId, projectId: owner!.projectId!, sourceIssueId: childId,
        mode: "isolated_workspace", strategyType: "git_worktree", name: "second child",
        status: "active", branchName: "second-child", repoUrl: `https://github.com/${OWNER}/${REPO}`,
      }).returning();
      await db.update(issues).set({ executionWorkspaceId: workspace!.id }).where(eq(issues.id, childId));
      return childId;
    }

    function afterProofRead(afterRead: () => void, refuseLaterReads = false): Db {
      let read = false;
      return new Proxy(db, { get(base, key, receiver) {
        if (key !== "select") return Reflect.get(base, key, receiver);
        return (...args: Parameters<Db["select"]>) => {
          if (read && refuseLaterReads) throw new Error("Issue reader became unavailable after proof fetch");
          const selected = base.select(...args);
          return new Proxy(selected, { get(selection, member, selectionReceiver) {
            if (member !== "from") return Reflect.get(selection, member, selectionReceiver);
            return (...tables: Parameters<typeof selected.from>) => {
              const query = selection.from(...tables);
              if (tables[0] !== issueChildCarrierAttributions || args.length > 0) return query;
              return new Proxy(query, { get(builder, method, builderReceiver) {
                if (method !== "then") return Reflect.get(builder, method, builderReceiver);
                return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
                  query.then((rows) => {
                    read = true;
                    afterRead();
                    return rows;
                  }).then(resolve, reject);
              } });
            };
          } });
        };
      } });
    }

    it.each(["owner", "repo"] as const)("refuses caller %s drift after the scoped attribution query completes", async (field) => {
      const { ownerId } = await approvedPair();
      const requested = { ...target };
      const racingDb = afterProofRead(() => { requested[field] = `other-${field}`; });
      expect(await carrierOwnerChildAttributionBlock(racingDb, companyId, ownerId, requested)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it("refuses pending child approval without depending on a later issue-state read", async () => {
      const { ownerId, childId } = await seedPair();
      await resolveChildCarrierDecisionHead(db, companyId, childId);
      const unavailableAfterProof = afterProofRead(() => {}, true);
      expect(await carrierOwnerChildAttributionBlock(unavailableAfterProof, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it.each(["owner", "child"] as const)("leaves an unclassified %s workspace without recorded attribution to normal delivery identity", async (which) => {
      const { ownerId, childId } = await seedPair();
      await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, which === "owner" ? ownerId : childId));
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBeNull();
    });

    it.each(["owner", "child"] as const)("keeps recorded child lifecycle authority after the %s workspace is unlinked", async (which) => {
      const { ownerId, childId } = await seedPair();
      await resolveChildCarrierDecisionHead(db, companyId, childId);
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
      await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, which === "owner" ? ownerId : childId));
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
      const [proof] = await db.select().from(issueChildCarrierAttributions);
      expect(proof).toMatchObject({ childIssueId: childId, state: "current", childDecisionId: null });
    });

    it.each(["owner", "child"] as const)("keeps recorded child lifecycle authority after the %s repository changes", async (which) => {
      const { ownerId, childId } = await seedPair();
      await resolveChildCarrierDecisionHead(db, companyId, childId);
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
      await db.update(executionWorkspaces).set({ repoUrl: `https://github.com/${OWNER}/other-repository` })
        .where(eq(executionWorkspaces.sourceIssueId, which === "owner" ? ownerId : childId));
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it("does not erase recorded child lifecycle authority by rebinding its workspace to the carrier source", async () => {
      const { ownerId, childId } = await seedPair();
      await resolveChildCarrierDecisionHead(db, companyId, childId);
      await db.update(executionWorkspaces).set({ sourceIssueId: ownerId })
        .where(eq(executionWorkspaces.sourceIssueId, childId));
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it.each(["current", "invalidated"] as const)("preserves recorded child lifecycle authority when production deletion sees %s attribution", async (state) => {
      const { ownerId, childId } = await seedPair();
      await resolveChildCarrierDecisionHead(db, companyId, childId);
      if (state === "invalidated") {
        await db.update(issueChildCarrierAttributions).set({ state, invalidatedAt: new Date() });
      }
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
      let deletionError: unknown;
      try {
        await issueService(db).remove(childId);
      } catch (error) {
        deletionError = error;
      }
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
      expect(deletionError).toMatchObject({ status: 409 });
      expect(await db.select().from(issues).where(eq(issues.id, childId))).toHaveLength(1);
      expect(await db.select().from(issueChildCarrierAttributions)).toHaveLength(1);
    });

    it("allows production deletion of a cancelled child only after it no longer constrains the owner", async () => {
      const { ownerId, childId } = await seedPair();
      await resolveChildCarrierDecisionHead(db, companyId, childId);
      await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, childId));
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBeNull();
      expect(await issueService(db).remove(childId)).toMatchObject({ id: childId });
      expect(await db.select().from(issueChildCarrierAttributions)).toHaveLength(0);
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBeNull();
    });

    it("preserves recorded child lifecycle authority when proof commits while production deletion waits", async () => {
      const { ownerId, childId } = await seedPair();
      let proofWritten!: () => void;
      let releaseProof!: () => void;
      const written = new Promise<void>((resolve) => { proofWritten = resolve; });
      const release = new Promise<void>((resolve) => { releaseProof = resolve; });
      const writer = db.transaction(async (tx) => {
        await resolveChildCarrierDecisionHead(tx as unknown as Db, companyId, childId);
        proofWritten();
        await release;
      });
      await written;
      const removal = issueService(db).remove(childId).then(
        (removed) => ({ removed, error: null }),
        (error: unknown) => ({ removed: null, error }),
      );
      try {
        await vi.waitFor(async () => {
          const rows = await db.execute(sql`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()
                AND wait_event_type = 'Lock'
            ) AS waiting
          `);
          expect((rows as unknown as Array<{ waiting: boolean }>)[0]?.waiting).toBe(true);
        }, { timeout: 5_000, interval: 25 });
      } finally {
        releaseProof();
        await writer;
      }
      const outcome = await removal;
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
      expect(outcome.error).toMatchObject({ status: 409 });
      expect(outcome.removed).toBeNull();
      expect(await db.select().from(issueChildCarrierAttributions)).toHaveLength(1);
    }, 10_000);

    it("keeps recorded carrier authority when a different branch hint still names its exact PR", async () => {
      const { ownerId } = await approvedPair();
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
        ...target, headRef: "other-carrier",
      })).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it.each(["repository owner", "repository"] as const)("leaves a caller's different %s outside this carrier owner's gate", async (field) => {
      const { ownerId } = await approvedPair();
      const other = field === "repository owner" ? { ...target, owner: "other-owner" } : { ...target, repo: "other-repository" };
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, other)).toBeNull();
    });

    it.each(["repository owner", "repository"] as const)("does not make a foreign child %s depend on the carrier provider being available", async (field) => {
      const { ownerId } = await seedPair();
      await db.update(executionWorkspaces).set({
        repoUrl: field === "repository owner" ? `https://github.com/other-owner/${REPO}` : `https://github.com/${OWNER}/other-repository`,
      }).where(eq(executionWorkspaces.branchName, CHILD_BRANCH));
      github.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBeNull();
    });

    it("refuses an unreadable live carrier instead of throwing or admitting its approved child", async () => {
      const { ownerId } = await approvedPair();
      github.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it.each([true, false])("refuses an approved historical branch after its owner's workspace changes only case (caller ref: %s)", async (withCallerRef) => {
      const { ownerId } = await approvedPair();
      await db.update(executionWorkspaces).set({ branchName: CARRIER_BRANCH.toLowerCase() })
        .where(eq(executionWorkspaces.sourceIssueId, ownerId));
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, {
        ...target, headRef: withCallerRef ? target.headRef : undefined,
      })).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it.each([undefined, null])("accepts a verified live head when the caller head is %s", async (headSha) => {
      const { ownerId } = await approvedPair();
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, { ...target, headSha })).toBeNull();
    });

    it("refuses an unreadable carrier head even when the child comparison is empty", async () => {
      const { ownerId } = await seedPair();
      github.mockResolvedValue({
        ok: true, status: 200,
        json: async () => livePr({ head: { ref: CARRIER_BRANCH, sha: null, repo: { full_name: `${OWNER}/${REPO}` } } }),
      });
      childCarrierCommits.enumerate = async () => ({ ok: true, shas: [] });
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it("refuses malformed enumerated commits instead of treating them as noncontributing", async () => {
      const { ownerId } = await seedPair();
      childCarrierCommits.enumerate = async () => ({ ok: true, shas: ["not-a-sha"] });
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it.each(["company", "ancestor"] as const)("does not accept an approved attribution from another %s", async (field) => {
      const { ownerId } = await approvedPair();
      const foreignId = randomUUID();
      if (field === "company") {
        await db.insert(companies).values({ id: foreignId, name: "Other company", issuePrefix: "OTH" });
      } else {
        await db.insert(issues).values({ id: foreignId, companyId, title: "Other carrier", identifier: "SUP-900", status: "backlog" });
      }
      await db.update(issueChildCarrierAttributions).set(field === "company" ? { companyId: foreignId } : { ancestorIssueId: foreignId });
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it("ignores another repository owner's historical row for a completely disjoint child", async () => {
      const { ownerId } = await approvedPair();
      await db.update(issueChildCarrierAttributions).set({ owner: "other-owner" });
      childCarrierCommits.enumerate = async () => ({ ok: true, shas: [] });
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBeNull();
    });

    it("does not borrow a fully certified child contribution from another exact PR", async () => {
      const { ownerId, childId } = await seedPair();
      await db.update(issues).set({ executionState: {
        ...await childState(childId), childCarrierClaim: { prNumber: 654, prUrl: `https://github.com/${OWNER}/${REPO}/pull/654` },
      } }).where(eq(issues.id, childId));
      await resolveChildCarrierDecisionHead(db, companyId, childId);
      await approveChild(childId);
      await recordChildCarrierDecision(db, companyId, childId);
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, { ...target, number: 654 })).toBeNull();
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it("admits both contributing children only with each child's own approved attribution", async () => {
      const { ownerId } = await approvedPair();
      const secondId = await addSibling(ownerId);
      await resolveChildCarrierDecisionHead(db, companyId, secondId);
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
      await approveChild(secondId);
      await recordChildCarrierDecision(db, companyId, secondId);
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBeNull();
    });

    it("refuses malformed stored commits instead of throwing through owner publication", async () => {
      const { ownerId } = await approvedPair();
      await db.update(issueChildCarrierAttributions).set({ commitShas: ["not-a-sha"] });
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it.each(["decision ID", "outcome", "missing certificate", "certificate ID"] as const)("independently refuses a changed protected child %s", async (field) => {
      const { ownerId, childId } = await approvedPair();
      const state = { ...await childState(childId) };
      const approval = state.approvalStatus as { finalDelivery: Record<string, unknown> };
      if (field === "decision ID") {
        const [next] = await db.insert(issueExecutionDecisions).values({
          companyId, issueId: childId, stageId: randomUUID(), stageType: "approval", outcome: "approved", body: "New decision",
        }).returning();
        state.lastDecisionId = next!.id;
      } else if (field === "outcome") state.lastDecisionOutcome = "changes_requested";
      else if (field === "missing certificate") state.approvalStatus = {};
      else state.approvalStatus = { ...approval, finalDelivery: { ...approval.finalDelivery, decisionId: randomUUID() } };
      await db.update(issues).set({ executionState: state }).where(eq(issues.id, childId));
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it.each(["repository", "branch"] as const)("refuses a conflicting delivery binding %s even with a valid child claim", async (field) => {
      const { ownerId, childId } = await approvedPair();
      await db.update(issues).set({ executionState: {
        ...await childState(childId), delivery: {
          prNumber: 653, headSha: HEAD,
          prUrl: field === "repository" ? `https://github.com/${OWNER}/other-repository/pull/653` : `https://github.com/${OWNER}/${REPO}/pull/653`,
          branch: field === "branch" ? "other-carrier" : CARRIER_BRANCH,
        },
      } }).where(eq(issues.id, childId));
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it.each(["missing", "pull request", "head"] as const)("refuses a %s child claim independently of the approved stored proof", async (field) => {
      const { ownerId, childId } = await approvedPair();
      const state = { ...await childState(childId) };
      if (field === "missing") delete state.childCarrierClaim;
      else state.childCarrierClaim = field === "pull request"
        ? { prNumber: 654, prUrl: `https://github.com/${OWNER}/${REPO}/pull/654`, headSha: HEAD }
        : { prNumber: 653, prUrl: `https://github.com/${OWNER}/${REPO}/pull/653`, headSha: "b".repeat(40) };
      await db.update(issues).set({ executionState: state }).where(eq(issues.id, childId));
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it.each(["no latest", "other issue", "other company"] as const)("refuses a foreign decision reference with %s authority", async (scope) => {
      const { ownerId, childId, decisionId } = await approvedPair();
      let decisionCompanyId = companyId;
      if (scope === "other company") {
        const [foreignCompany] = await db.insert(companies).values({ name: "Other decision company", issuePrefix: "OTH" }).returning();
        decisionCompanyId = foreignCompany!.id;
      }
      const [foreign] = await db.insert(issueExecutionDecisions).values({
        companyId: decisionCompanyId, issueId: scope === "other company" ? childId : ownerId,
        stageId: randomUUID(), stageType: "approval", outcome: "approved", body: "Foreign decision",
      }).returning();
      await db.update(issueChildCarrierAttributions).set({ childDecisionId: foreign!.id });
      const state = await childState(childId);
      const approval = state.approvalStatus as { finalDelivery: Record<string, unknown> };
      await db.update(issues).set({ executionState: {
        ...state, lastDecisionId: foreign!.id,
        approvalStatus: { ...approval, finalDelivery: { ...approval.finalDelivery, decisionId: foreign!.id } },
      } }).where(eq(issues.id, childId));
      if (scope === "no latest") await db.delete(issueExecutionDecisions).where(eq(issueExecutionDecisions.id, decisionId));
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it.each(["same child", "other issue", "other company"] as const)("uses only the latest rejection for the %s scope", async (scope) => {
      const { ownerId, childId, decisionId } = await approvedPair();
      const [approved] = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.id, decisionId));
      let decisionCompanyId = companyId;
      if (scope === "other company") {
        const [foreignCompany] = await db.insert(companies).values({ name: "Other decision company", issuePrefix: "OTH" }).returning();
        decisionCompanyId = foreignCompany!.id;
      }
      await db.insert(issueExecutionDecisions).values({
        companyId: decisionCompanyId, issueId: scope === "other issue" ? ownerId : childId,
        stageId: randomUUID(), stageType: "approval", outcome: "changes_requested", body: "New rejection",
        createdAt: new Date(approved!.createdAt.getTime() + 1_000),
      });
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target))
        .toBe(scope === "same child" ? CHILD_CARRIER_OWNER_GATE_SKIP : null);
    });

    it("refuses a rejected attached decision even when a newer decision approves", async () => {
      const { ownerId, childId, decisionId } = await approvedPair();
      const [attached] = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.id, decisionId));
      await db.update(issueExecutionDecisions).set({ outcome: "changes_requested" }).where(eq(issueExecutionDecisions.id, decisionId));
      await db.insert(issueExecutionDecisions).values({
        companyId, issueId: childId, stageId: randomUUID(), stageType: "approval", outcome: "approved", body: "New approval",
        createdAt: new Date(attached!.createdAt.getTime() + 1_000),
      });
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it("refuses protected state that moves to another company during enumeration", async () => {
      const { ownerId, childId } = await approvedPair();
      const [foreignCompany] = await db.insert(companies).values({ name: "New issue company", issuePrefix: "OTH" }).returning();
      childCarrierCommits.enumerate = async () => {
        await db.update(issues).set({ companyId: foreignCompany!.id }).where(eq(issues.id, childId));
        return { ok: true, shas: [COMMIT] };
      };
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it("does not erase an unapproved child contribution when the named base moves", async () => {
      const { ownerId } = await seedPair();
      childCarrierCommits.enumerate = realEnumerate;
      const controls = mockCommitSources();
      controls.namedBaseMoved = true;
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });
  });
  describe("owner gate with an unreadable descendant branch", () => {
    const target = { owner: OWNER, repo: REPO, number: 653, headSha: HEAD, headRef: CARRIER_BRANCH };
    const OWN_PR = 700;
    const OWN_HEAD = "9".repeat(40);
    const LATER_COMMIT = "b".repeat(40);

    async function terminalChild(childId: string, status = "done") {
      await db.update(issues).set({
        status,
        executionState: { delivery: {
          branch: CHILD_BRANCH,
          headSha: OWN_HEAD,
          prNumber: OWN_PR,
          prUrl: `https://github.com/${OWNER}/${REPO}/pull/${OWN_PR}`,
          repo: { owner: OWNER, repo: REPO },
        } },
      }).where(eq(issues.id, childId));
    }

    function mockUnreadableChild(opts: {
      childStatus?: number;
      childBody?: unknown;
      laterCommit?: boolean;
      deleted?: boolean;
      restoreAfterMissing?: boolean;
      firstCredentialOnly?: boolean;
    } = {}) {
      childCarrierCommits.enumerate = realEnumerate;
      const controls = mockCommitSources(
        opts.laterCommit ? [LATER_COMMIT, HEAD] : [COMMIT, HEAD],
        opts.laterCommit ? [LATER_COMMIT] : [COMMIT],
      );
      const sources = github.getMockImplementation()!;
      let deleted = opts.deleted ?? true;
      github.mockImplementation(async (url: unknown, ...rest: unknown[]) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith(`/pulls/${OWN_PR}`)) {
          return {
            ok: true, status: 200,
            json: async () => livePr({
              state: "closed", merged: true,
              head: { ref: CHILD_BRANCH, sha: OWN_HEAD, repo: { full_name: `${OWNER}/${REPO}` } },
            }),
          };
        }
        const headers = new Headers((rest[0] as { headers?: HeadersInit } | undefined)?.headers);
        const hidden = !opts.firstCredentialOnly || headers.get("authorization") === "Bearer sandbox-token";
        if (deleted && hidden && path.endsWith(`/commits/${encodeURIComponent(CHILD_BRANCH)}`)) {
          const status = opts.childStatus ?? 404;
          if (opts.restoreAfterMissing) deleted = false;
          return { ok: status < 400, status, headers: { get: () => null }, json: async () => opts.childBody ?? {} };
        }
        return sources(url, ...rest);
      });
      return { controls, deleteBranch: () => { deleted = true; }, restoreBranch: () => { deleted = false; } };
    }

    it.each(["done", "in_review"])("refuses a %s child with an exact merged own PR and a deleted branch", async (status) => {
      const { ownerId, childId } = await seedPair();
      await terminalChild(childId, status);
      mockUnreadableChild();
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it("does not lose later child B on the carrier when its branch is deleted after merged own PR A", async () => {
      const { ownerId, childId } = await seedPair();
      await terminalChild(childId);
      const branch = mockUnreadableChild({ laterCommit: true, deleted: false });
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
      branch.deleteBranch();
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it("refuses the missing-branch observation even if the branch reappears before the gate returns", async () => {
      const { ownerId, childId } = await seedPair();
      await terminalChild(childId);
      mockUnreadableChild({ laterCommit: true, restoreAfterMissing: true });
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
      expect(await realEnumerate({
        token: "sandbox-token", owner: OWNER, repo: REPO, pullRequestNumber: 653,
        headSha: HEAD, baseRef: "fold/tea-patches-v2026.722.0", childBranch: CHILD_BRANCH,
      })).toEqual({ ok: true, shas: [LATER_COMMIT] });
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it("refuses a first-credential child-ref 404 instead of inferring no contribution", async () => {
      const { ownerId, childId } = await seedPair();
      await terminalChild(childId);
      credentialCandidates.mockResolvedValue([
        { token: "sandbox-token", scope: "company", secretName: "GITHUB_TOKEN" },
        { token: "sandbox-visible", scope: "company", secretName: "OTHER_TOKEN" },
      ]);
      mockUnreadableChild({ laterCommit: true, firstCredentialOnly: true });
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
      expect(await realEnumerate({
        token: "sandbox-visible", owner: OWNER, repo: REPO, pullRequestNumber: 653,
        headSha: HEAD, baseRef: "fold/tea-patches-v2026.722.0", childBranch: CHILD_BRANCH,
      })).toEqual({ ok: true, shas: [LATER_COMMIT] });
    });

    it("allows a restored branch only after complete enumeration proves it disjoint", async () => {
      const { ownerId, childId } = await seedPair();
      await terminalChild(childId);
      const branch = mockUnreadableChild();
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
      branch.controls.childShas = [];
      branch.restoreBranch();
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBeNull();
    });

    it.each([403, 429, 500, 503])("refuses a done child with a merged own PR when its branch lookup is HTTP %s", async (childStatus) => {
      const { ownerId, childId } = await seedPair();
      await terminalChild(childId);
      mockUnreadableChild({ childStatus });
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it("refuses a malformed child branch lookup", async () => {
      const { ownerId, childId } = await seedPair();
      await terminalChild(childId);
      mockUnreadableChild({ childStatus: 200, childBody: { sha: "not-a-sha" } });
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it("refuses when the comparison base cannot be read", async () => {
      const { ownerId, childId } = await seedPair();
      await terminalChild(childId);
      mockUnreadableChild();
      const inner = github.getMockImplementation()!;
      github.mockImplementation(async (url: unknown, ...rest: unknown[]) => {
        const path = new URL(String(url)).pathname;
        if (path.includes("/commits/") && !path.endsWith(`/commits/${encodeURIComponent(CHILD_BRANCH)}`)) {
          return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) };
        }
        return inner(url, ...rest);
      });
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });

    it("refuses a deleted branch even when a current attribution row exists", async () => {
      const { ownerId, childId } = await seedPair();
      await resolveChildCarrierDecisionHead(db, companyId, childId);
      await terminalChild(childId);
      mockUnreadableChild();
      expect(await carrierOwnerChildAttributionBlock(db, companyId, ownerId, target)).toBe(CHILD_CARRIER_OWNER_GATE_SKIP);
    });
  });
});
