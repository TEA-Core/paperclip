import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
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
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  CARRIER_PROMOTION_READY_ACTION,
  createCarrierPromotionSweepService,
} from "../services/carrier-promotion-sweep.js";

const mockGhFetch = vi.hoisted(() => vi.fn());
vi.mock("../services/github-fetch.js", () => ({
  ghFetch: mockGhFetch,
  gitHubApiBase: (hostname: string) => hostname === "github.com" ? "https://api.github.com" : `https://${hostname}/api/v3`,
}));
const mockResolveCandidates = vi.hoisted(() => vi.fn());
vi.mock("../services/github-credential.js", () => ({
  resolveGitHubTokenCandidatesForRepo: mockResolveCandidates,
  resolveGitHubTokenForRepo: vi.fn(),
  isGitHubTokenResolution: vi.fn(),
}));
vi.mock("../services/issues.js", () => ({
  issueService: () => ({ getWakeableParentAfterChildCompletion: async () => null }),
}));

const BRANCH = "SUP-14093-carrier";
const PR_KEY = "TEA-Core/paperclip#400";
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const checkedAt = new Date("2026-09-01T00:00:00Z");
const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping carrier promotion concurrency test: ${support.reason ?? "embedded Postgres unavailable"}`);
}

describeEmbeddedPostgres("carrier promotion concurrency", () => {
  let db!: Db;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-carrier-promotion-race-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    mockGhFetch.mockReset();
    mockResolveCandidates.mockReset().mockResolvedValue([
      { token: "test-token", scope: "company", secretName: "github_org" },
    ]);
  });

  async function seedCarrier() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();
    const staleAt = new Date(checkedAt.getTime() - 4 * 24 * 60 * 60 * 1000);
    await db.insert(companies).values({
      id: companyId, name: "Carrier test", issuePrefix: "SUP", requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId, companyId, name: "Delivery", status: "active",
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId, companyId, projectId, mode: "isolated_workspace",
      strategyType: "git_worktree", name: BRANCH,
      repoUrl: "https://github.com/TEA-Core/paperclip", branchName: BRANCH,
    });
    await db.insert(issues).values({
      id: parentId, companyId, projectId, executionWorkspaceId: workspaceId,
      identifier: "SUP-14093", title: "Parent carrier", status: "done",
    });
    await db.insert(issues).values({
      id: childId, companyId, parentId, projectId,
      identifier: "SUP-14094", title: "Delivered child", status: "done",
    });
    const [object] = await db.insert(externalObjects).values({
      companyId, providerKey: "github", objectType: "pull_request",
      externalId: "TEA-Core/paperclip#pull/400",
      data: { state: "open", draft: true, headRef: BRANCH, headSha: SHA, created_at: staleAt.toISOString() },
    }).returning();
    await db.insert(externalObjectMentions).values({
      companyId, sourceIssueId: childId, sourceKind: "comment",
      objectId: object!.id, objectType: "pull_request", providerKey: "github",
      createdAt: staleAt,
    });
    return { companyId, parentId };
  }

  it("allows two simultaneous sweeps only one ready mutation and one persisted PR ledger row", async () => {
    const { companyId, parentId } = await seedCarrier();
    // The test runtime supports withResolvers; this workspace's TS lib target
    // has not yet included its ES2024 declaration.
    const deferred = Promise as PromiseConstructor & {
      withResolvers(): { promise: Promise<void>; resolve(): void };
    };
    const firstMutationStarted = deferred.withResolvers();
    const releaseFirstMutation = deferred.withResolvers();
    const secondCredentialRequest = deferred.withResolvers();
    let credentialRequests = 0;
    mockResolveCandidates.mockImplementation(async () => {
      if (++credentialRequests === 2) secondCredentialRequest.resolve();
      return [{ token: "test-token", scope: "company", secretName: "github_org" }];
    });
    let mutations = 0;
    mockGhFetch.mockImplementation(async (url: string) => {
      if (url === "https://api.github.com/graphql") {
        mutations += 1;
        if (mutations === 1) {
          firstMutationStarted.resolve();
          await releaseFirstMutation.promise;
        }
        return new Response(JSON.stringify({ data: { markPullRequestReadyForReview: { clientMutationId: "ready" } } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        node_id: "PR_node_400", state: "open", draft: true,
        head: { ref: BRANCH, sha: SHA, repo: { full_name: "TEA-Core/paperclip" } },
      }), { status: 200 });
    });
    const first = createCarrierPromotionSweepService(db, { now: () => checkedAt, sweepIntervalMs: 0 });
    const second = createCarrierPromotionSweepService(db, { now: () => checkedAt, sweepIntervalMs: 0 });
    const firstRun = first.sweep();
    await firstMutationStarted.promise;
    const secondRun = second.sweep();
    // The second contender has passed the old, unlocked ledger precheck;
    // release the first only once the race is guaranteed to be observable.
    await secondCredentialRequest.promise;
    releaseFirstMutation.resolve();
    const results = await Promise.all([firstRun, secondRun]);
    const rows = await db.select({ details: activityLog.details }).from(activityLog).where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.entityId, parentId),
      eq(activityLog.action, CARRIER_PROMOTION_READY_ACTION),
    ));
    expect(mutations).toBe(1);
    expect(rows.filter((row) => row.details?.pr === PR_KEY)).toHaveLength(1);
    expect(results.reduce((count, result) => count + result.promoted, 0)).toBe(1);
  });
});
