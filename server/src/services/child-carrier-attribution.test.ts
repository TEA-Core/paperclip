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
  childCarrierCommits,
  classifyAncestorCarrierHead,
  resolveChildCarrierDecisionHead,
} from "./child-carrier-attribution.js";
import { publishApprovalStatus } from "./merge-arming.js";

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
});
