import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  goals,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { buildIssueBlockersResolvedWakeIdempotencyKey } from "../services/issue-dependency-wakeups.js";
import {
  createMergedOperatorMergeCardPullRequestResolver,
  createMergedOperatorMergeCardSweepService,
  MERGED_OPERATOR_MERGE_CARDS_ACTOR_ID,
  MERGED_OPERATOR_MERGE_CARDS_CLOSED_ACTION,
  type MergedOperatorMergeCardPullRequestEvidence,
} from "../services/merged-operator-merge-cards.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const credentialMock = vi.hoisted(() => ({
  tokenForTest: null as string | null,
}));
vi.mock("../services/github-credential.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/github-credential.js")>();
  return {
    ...actual,
    resolveGitHubTokenForRepo: async () =>
      credentialMock.tokenForTest
        ? { token: credentialMock.tokenForTest, scope: "company", secretName: "GITHUB_TOKEN" }
        : { token: null, reason: "no GitHub token bound in fixture" },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type SweepFixture = {
  companyId: string;
  goalId: string;
  agentId: string;
  cardId: string;
  dependentId: string;
};

async function seedCompany(db: ReturnType<typeof createDb>) {
  const companyId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "Paperclip",
    issuePrefix: "MOC",
    requireBoardApprovalForNewAgents: false,
  });
  const goalId = randomUUID();
  await db.insert(goals).values({
    id: goalId,
    companyId,
    title: "Ship safely",
    level: "task",
    status: "active",
  });
  const agentId = randomUUID();
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Coder",
    role: "engineer",
    status: "active",
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  return { companyId, goalId, agentId };
}

async function seedOperatorCard(
  db: ReturnType<typeof createDb>,
  fixture: { companyId: string; goalId: string; agentId: string },
  opts: {
    cardTitle: string;
    cardDescription?: string | null;
    cardStatus?: string;
    cardAssigneeAgentId?: string | null;
    dependentStatus?: string;
    dependentAssigneeAgentId?: string | null;
    withBlockingRelation?: boolean;
  },
): Promise<SweepFixture> {
  const cardId = randomUUID();
  const dependentId = randomUUID();
  await db.insert(issues).values([
    {
      id: cardId,
      companyId: fixture.companyId,
      goalId: fixture.goalId,
      title: opts.cardTitle,
      description: opts.cardDescription ?? null,
      status: opts.cardStatus ?? "todo",
      priority: "high",
      assigneeAgentId: opts.cardAssigneeAgentId ?? null,
      assigneeUserId: opts.cardAssigneeAgentId ? null : "operator-1",
    },
    {
      id: dependentId,
      companyId: fixture.companyId,
      goalId: fixture.goalId,
      title: "Dependent control-plane work",
      status: opts.dependentStatus ?? "blocked",
      priority: "medium",
      assigneeAgentId: opts.dependentAssigneeAgentId ?? fixture.agentId,
    },
  ]);
  if (opts.withBlockingRelation ?? true) {
    await db.insert(issueRelations).values({
      companyId: fixture.companyId,
      issueId: cardId,
      relatedIssueId: dependentId,
      type: "blocks",
    });
  }
  return { ...fixture, cardId, dependentId };
}

const MERGED_EVIDENCE: MergedOperatorMergeCardPullRequestEvidence = {
  state: "merged",
  mergeCommitSha: "c0cd56e43f9a81f360532f7b92fbf176798016ad",
  mergedAt: "2026-08-29T00:11:06Z",
};

function pullRequestBody(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Builds the opt-in `Merge-gate:` marker line naming the gating pull request(s).
 * The sweep only closes cards that carry this marker; a PR cited anywhere else
 * in the body is prose and must not make the card a candidate (SUP-14588).
 */
function mergeGateMarker(numbers: number[]): string {
  return `Merge-gate: ${numbers.map((number) => `TEA-Core/paperclip#${number}`).join(", ")}\n`;
}

describeEmbeddedPostgres.sequential("merged operator merge-card sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-merged-operator-cards-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("closes a card whose named pull request merged, records evidence, and wakes the dependent", async () => {
    const { companyId, goalId, agentId } = await seedCompany(db);
    const fixture = await seedOperatorCard(db, { companyId, goalId, agentId }, {
      cardTitle: "Merge approved PR TEA-Core/paperclip#404 into fold/tea-patches-v2026.722.0",
      cardDescription:
        "**Operator card — merge an approved PR. No agent executes this.**\n\nMerge https://github.com/TEA-Core/paperclip/pull/404 into `fold/tea-patches-v2026.722.0`.\n\n" +
        mergeGateMarker([404]),
    });

    const resolvePullRequest = vi.fn(async () => ({ ...MERGED_EVIDENCE }));
    const enqueueWakeup = vi.fn(async () => ({ id: "wake-1" }));
    const service = createMergedOperatorMergeCardSweepService(db, {
      resolvePullRequest,
      enqueueWakeup,
    });

    await expect(service.sweepMergedOperatorMergeCards()).resolves.toEqual({
      checked: 1,
      candidates: 1,
      closed: 1,
      woken: 1,
    });

    const card = await db
      .select({ id: issues.id, status: issues.status, completedAt: issues.completedAt })
      .from(issues)
      .where(eq(issues.id, fixture.cardId))
      .then((rows) => rows[0] ?? null);
    expect(card?.status).toBe("done");
    expect(card?.completedAt).toBeInstanceOf(Date);

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, fixture.cardId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.authorType).toBe("system");
    expect(comments[0]!.body).toContain("TEA-Core/paperclip#404");
    expect(comments[0]!.body).toContain("c0cd56e43f9a81f360532f7b92fbf176798016ad");
    expect(comments[0]!.body).toContain("2026-08-29T00:11:06Z");
    expect(comments[0]!.body).toContain(MERGED_OPERATOR_MERGE_CARDS_ACTOR_ID);

    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({
      reason: "issue_blockers_resolved",
      idempotencyKey: buildIssueBlockersResolvedWakeIdempotencyKey({
        dependentIssueId: fixture.dependentId,
        resolvedBlockerIssueId: fixture.cardId,
      }),
      requestedByActorType: "system",
      requestedByActorId: MERGED_OPERATOR_MERGE_CARDS_ACTOR_ID,
      contextSnapshot: expect.objectContaining({
        issueId: fixture.dependentId,
        resolvedBlockerIssueId: fixture.cardId,
      }),
    }));

    const audit = await db.select().from(activityLog);
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorType: "system",
        actorId: MERGED_OPERATOR_MERGE_CARDS_ACTOR_ID,
        action: MERGED_OPERATOR_MERGE_CARDS_CLOSED_ACTION,
        entityId: fixture.cardId,
        details: expect.objectContaining({
          pullRequests: ["TEA-Core/paperclip#404"],
          mergeCommits: {
            "TEA-Core/paperclip#404": {
              mergeCommitSha: MERGED_EVIDENCE.mergeCommitSha,
              mergedAt: MERGED_EVIDENCE.mergedAt,
            },
          },
          dependentsWoken: 1,
        }),
      }),
      expect.objectContaining({
        action: "issue.blockers_resolved_wake_emitted",
        entityId: fixture.dependentId,
      }),
    ]));
  });

  it("is idempotent: a second pass over the closed card produces no writes", async () => {
    const { companyId, goalId, agentId } = await seedCompany(db);
    const fixture = await seedOperatorCard(db, { companyId, goalId, agentId }, {
      cardTitle: "Merge https://github.com/TEA-Core/paperclip/pull/404",
      cardDescription: mergeGateMarker([404]),
    });

    const resolvePullRequest = vi.fn(async () => ({ ...MERGED_EVIDENCE }));
    const enqueueWakeup = vi.fn(async () => ({ id: "wake-1" }));
    const service = createMergedOperatorMergeCardSweepService(db, {
      resolvePullRequest,
      enqueueWakeup,
    });

    await service.sweepMergedOperatorMergeCards();
    const secondPass = await service.sweepMergedOperatorMergeCards();
    expect(secondPass).toEqual({ checked: 0, candidates: 0, closed: 0, woken: 0 });

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, fixture.cardId));
    expect(comments).toHaveLength(1);
    expect(resolvePullRequest).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("leaves cards naming open or closed-unmerged pull requests untouched", async () => {
    const { companyId, goalId, agentId } = await seedCompany(db);
    const openCard = await seedOperatorCard(db, { companyId, goalId, agentId }, {
      cardTitle: "Merge https://github.com/TEA-Core/paperclip/pull/41",
      cardDescription: mergeGateMarker([41]),
    });
    const closedCard = await seedOperatorCard(db, { companyId, goalId, agentId }, {
      cardTitle: "Merge https://github.com/TEA-Core/paperclip/pull/42",
      cardDescription: mergeGateMarker([42]),
    });

    const resolvePullRequest = vi.fn(async (_companyId: string, reference: { number: number }) =>
      reference.number === 41
        ? { state: "open" as const, mergeCommitSha: null, mergedAt: null }
        : { state: "closed" as const, mergeCommitSha: null, mergedAt: null }
    );
    const enqueueWakeup = vi.fn(async () => ({ id: "wake-1" }));
    const service = createMergedOperatorMergeCardSweepService(db, {
      resolvePullRequest,
      enqueueWakeup,
    });

    await expect(service.sweepMergedOperatorMergeCards()).resolves.toEqual({
      checked: 2,
      candidates: 2,
      closed: 0,
      woken: 0,
    });

    const statuses = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(eq(issues.companyId, companyId));
    expect(new Map(statuses.map((row) => [row.id, row.status]))).toEqual(
      new Map([
        [openCard.cardId, "todo"],
        [closedCard.cardId, "todo"],
        [openCard.dependentId, "blocked"],
        [closedCard.dependentId, "blocked"],
      ]),
    );

    const comments = await db.select().from(issueComments);
    expect(comments).toEqual([]);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("leaves agent-assigned cards untouched", async () => {
    const { companyId, goalId, agentId } = await seedCompany(db);
    const fixture = await seedOperatorCard(db, { companyId, goalId, agentId }, {
      cardTitle: "Merge https://github.com/TEA-Core/paperclip/pull/404",
      cardAssigneeAgentId: agentId,
    });

    const resolvePullRequest = vi.fn(async () => ({ ...MERGED_EVIDENCE }));
    const enqueueWakeup = vi.fn(async () => ({ id: "wake-1" }));
    const service = createMergedOperatorMergeCardSweepService(db, {
      resolvePullRequest,
      enqueueWakeup,
    });

    await expect(service.sweepMergedOperatorMergeCards()).resolves.toEqual({
      checked: 0,
      candidates: 0,
      closed: 0,
      woken: 0,
    });
    expect(resolvePullRequest).not.toHaveBeenCalled();
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const card = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, fixture.cardId))
      .then((rows) => rows[0] ?? null);
    expect(card?.status).toBe("todo");
  });

  it("leaves cards that block nothing untouched", async () => {
    const { companyId, goalId, agentId } = await seedCompany(db);
    const fixture = await seedOperatorCard(db, { companyId, goalId, agentId }, {
      cardTitle: "Merge https://github.com/TEA-Core/paperclip/pull/404",
      withBlockingRelation: false,
    });

    const resolvePullRequest = vi.fn(async () => ({ ...MERGED_EVIDENCE }));
    const enqueueWakeup = vi.fn(async () => ({ id: "wake-1" }));
    const service = createMergedOperatorMergeCardSweepService(db, {
      resolvePullRequest,
      enqueueWakeup,
    });

    await expect(service.sweepMergedOperatorMergeCards()).resolves.toEqual({
      checked: 1,
      candidates: 0,
      closed: 0,
      woken: 0,
    });
    expect(resolvePullRequest).not.toHaveBeenCalled();

    const card = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, fixture.cardId))
      .then((rows) => rows[0] ?? null);
    expect(card?.status).toBe("todo");
  });

  it("leaves cards naming two pull requests when only one has merged", async () => {
    const { companyId, goalId, agentId } = await seedCompany(db);
    const fixture = await seedOperatorCard(db, { companyId, goalId, agentId }, {
      cardTitle: "Merge both pull requests",
      cardDescription:
        "Merge both once CI is green.\n\n" + mergeGateMarker([40, 41]),
    });

    const resolvePullRequest = vi.fn(async (_companyId: string, reference: { number: number }) =>
      reference.number === 40
        ? { ...MERGED_EVIDENCE }
        : { state: "open" as const, mergeCommitSha: null, mergedAt: null }
    );
    const enqueueWakeup = vi.fn(async () => ({ id: "wake-1" }));
    const service = createMergedOperatorMergeCardSweepService(db, {
      resolvePullRequest,
      enqueueWakeup,
    });

    await expect(service.sweepMergedOperatorMergeCards()).resolves.toEqual({
      checked: 1,
      candidates: 1,
      closed: 0,
      woken: 0,
    });
    expect(resolvePullRequest).toHaveBeenCalledTimes(2);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const card = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, fixture.cardId))
      .then((rows) => rows[0] ?? null);
    expect(card?.status).toBe("todo");
  });

  it("replays the SUP-14337 shape: operator prose around one deduplicated pull-request reference", async () => {
    const { companyId, goalId, agentId } = await seedCompany(db);
    const fixture = await seedOperatorCard(db, { companyId, goalId, agentId }, {
      cardTitle: "Merge approved PR TEA-Core/paperclip#404 (SUP-14301) into fold/tea-patches-v2026.722.0",
      cardDescription: [
        "**Operator card — merge an approved PR. No agent executes this; the merge is a platform-repo operator action (company merge-arming did not arm auto-merge on this PR).**",
        "",
        "## Action",
        "",
        "Merge https://github.com/TEA-Core/paperclip/pull/404 into `fold/tea-patches-v2026.722.0`.",
        "",
        "Merge-gate: TEA-Core/paperclip#404",
        "",
        "## State at filing (2026-08-28 ~23:45 UTC, fresh)",
        "",
        "- Card: **SUP-14301** — status `done`, review stage completed, verdict `approved`.",
        "- PR #404: `state: OPEN`, head `4e9dfb632c0a95a8b07992101c39eab63014755f`, `mergeStateStatus: CLEAN`, `mergeable: MERGEABLE`, `mergedAt: null`.",
        "- `autoMergeRequest: null` — GitHub auto-merge is NOT enabled.",
        "",
        "## Why this matters",
        "",
        "Two in-progress control-plane cards are consume-blocked on this merge:",
        "",
        "- **SUP-14302** (inbox-lite execution-lease surface) — now `blocked` on this card.",
        "- **SUP-14303** (write-path duplicate-run refusal) — same gate.",
        "",
        "Once #404 is merged, the `issue_blockers_resolved` wake fires for SUP-14302 and work resumes.",
        "",
        "## Verify after merging",
        "",
        "```bash",
        "gh pr view 404 --repo TEA-Core/paperclip --json state,mergedAt",
        "```",
      ].join("\n"),
    });

    const resolvePullRequest = vi.fn(async () => ({ ...MERGED_EVIDENCE }));
    const enqueueWakeup = vi.fn(async () => ({ id: "wake-1" }));
    const service = createMergedOperatorMergeCardSweepService(db, {
      resolvePullRequest,
      enqueueWakeup,
    });

    await expect(service.sweepMergedOperatorMergeCards()).resolves.toEqual({
      checked: 1,
      candidates: 1,
      closed: 1,
      woken: 1,
    });

    // The URL and the owner/repo#N shorthand in the title must dedupe to one reference.
    expect(resolvePullRequest).toHaveBeenCalledTimes(1);
    expect(resolvePullRequest).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ owner: "TEA-Core", repo: "paperclip", number: 404 }),
    );
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("SUP-14580: a card citing a merged PR only in Out-of-scope prose is not a candidate and survives", async () => {
    const { companyId, goalId, agentId } = await seedCompany(db);
    // Mirrors the shape of the card that was wrongly closed in 111s: a merged
    // PR cited purely as background context, with no opt-in marker.
    const fixture = await seedOperatorCard(db, { companyId, goalId, agentId }, {
      cardTitle: "OPERATOR: enable data_checksums on paperclip-db-1",
      cardDescription: [
        "**Operator card — enable data_checksums on paperclip-db-1. No agent executes this.**",
        "",
        "## Action",
        "",
        "Enable `data_checksums` on paperclip-db-1.",
        "",
        "## Out of scope",
        "",
        "- This card is **not** about the TEA-Core/paperclip#399 checksum migration; that PR is cited only as background.",
      ].join("\n"),
    });

    // Even though the cited PR is merged, the card must NOT be treated as a
    // merge-card candidate because it carries no Merge-gate marker.
    const resolvePullRequest = vi.fn(async () => ({ ...MERGED_EVIDENCE }));
    const enqueueWakeup = vi.fn(async () => ({ id: "wake-1" }));
    const service = createMergedOperatorMergeCardSweepService(db, {
      resolvePullRequest,
      enqueueWakeup,
    });

    await expect(service.sweepMergedOperatorMergeCards()).resolves.toEqual({
      checked: 1,
      candidates: 0,
      closed: 0,
      woken: 0,
    });

    const card = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(eq(issues.id, fixture.cardId))
      .then((rows) => rows[0] ?? null);
    expect(card?.status).toBe("todo");

    expect(resolvePullRequest).not.toHaveBeenCalled();
    expect(enqueueWakeup).not.toHaveBeenCalled();
    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, fixture.cardId));
    expect(comments).toEqual([]);
  });

  it("closes only on the marker PRs and ignores a merged PR cited elsewhere in prose", async () => {
    const { companyId, goalId, agentId } = await seedCompany(db);
    // The card opts in on #450 via the marker. A *different*, still-open PR
    // (#399) is cited in the body prose. A whole-body scan would see #399 open
    // and defer; the marker-scoped scan must resolve only #450 and close.
    const fixture = await seedOperatorCard(db, { companyId, goalId, agentId }, {
      cardTitle: "OPERATOR: merge approved PR TEA-Core/paperclip#450",
      cardDescription: [
        "Merge the approved PR into `fold/tea-patches-v2026.722.0`.",
        "",
        mergeGateMarker([450]).trim(),
        "",
        "Prior art (unrelated gate): TEA-Core/paperclip#399 was a different card.",
      ].join("\n"),
    });

    const resolvePullRequest = vi.fn(async (_cid: string, reference: { number: number }) =>
      reference.number === 450
        ? { ...MERGED_EVIDENCE }
        : { state: "open" as const, mergeCommitSha: null, mergedAt: null }
    );
    const enqueueWakeup = vi.fn(async () => ({ id: "wake-1" }));
    const service = createMergedOperatorMergeCardSweepService(db, {
      resolvePullRequest,
      enqueueWakeup,
    });

    await expect(service.sweepMergedOperatorMergeCards()).resolves.toEqual({
      checked: 1,
      candidates: 1,
      closed: 1,
      woken: 1,
    });

    // Only the marker-named PR is consulted; the prose-cited open PR is not.
    expect(resolvePullRequest).toHaveBeenCalledTimes(1);
    expect(resolvePullRequest).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ owner: "TEA-Core", repo: "paperclip", number: 450 }),
    );
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);

    const card = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, fixture.cardId))
      .then((rows) => rows[0] ?? null);
    expect(card?.status).toBe("done");
  });

  it("does not re-enqueue a wake that already exists in an idempotent status", async () => {
    const { companyId, goalId, agentId } = await seedCompany(db);
    const fixture = await seedOperatorCard(db, { companyId, goalId, agentId }, {
      cardTitle: "Merge https://github.com/TEA-Core/paperclip/pull/404",
      cardDescription: mergeGateMarker([404]),
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      status: "completed",
      idempotencyKey: buildIssueBlockersResolvedWakeIdempotencyKey({
        dependentIssueId: fixture.dependentId,
        resolvedBlockerIssueId: fixture.cardId,
      }),
    });

    const resolvePullRequest = vi.fn(async () => ({ ...MERGED_EVIDENCE }));
    const enqueueWakeup = vi.fn(async () => ({ id: "wake-1" }));
    const service = createMergedOperatorMergeCardSweepService(db, {
      resolvePullRequest,
      enqueueWakeup,
    });

    await expect(service.sweepMergedOperatorMergeCards()).resolves.toEqual({
      checked: 1,
      candidates: 1,
      closed: 1,
      woken: 0,
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const card = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, fixture.cardId))
      .then((rows) => rows[0] ?? null);
    expect(card?.status).toBe("done");
  });

  it("defers a card whose pull-request evidence is unmeasurable instead of closing it", async () => {
    const { companyId, goalId, agentId } = await seedCompany(db);
    const fixture = await seedOperatorCard(db, { companyId, goalId, agentId }, {
      cardTitle: "Merge https://github.com/TEA-Core/paperclip/pull/404",
      cardDescription: mergeGateMarker([404]),
    });

    const resolvePullRequest = vi.fn(async () => ({
      state: "unknown" as const,
      mergeCommitSha: null,
      mergedAt: null,
    }));
    const enqueueWakeup = vi.fn(async () => ({ id: "wake-1" }));
    const service = createMergedOperatorMergeCardSweepService(db, {
      resolvePullRequest,
      enqueueWakeup,
    });

    await expect(service.sweepMergedOperatorMergeCards()).resolves.toEqual({
      checked: 1,
      candidates: 1,
      closed: 0,
      woken: 0,
    });

    const card = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, fixture.cardId))
      .then((rows) => rows[0] ?? null);
    expect(card?.status).toBe("todo");
  });

  it("caches merged evidence within the TTL and re-checks after it expires", async () => {
    const { companyId, goalId, agentId } = await seedCompany(db);
    const fixture = await seedOperatorCard(db, { companyId, goalId, agentId }, {
      cardTitle: "Merge both pull requests",
      cardDescription:
        "Merge both once CI is green.\n\n" + mergeGateMarker([40, 41]),
    });

    let nowMs = Date.parse("2026-08-29T00:00:00Z");
    const resolvePullRequest = vi.fn(async (_companyId: string, reference: { number: number }) =>
      reference.number === 40
        ? { ...MERGED_EVIDENCE }
        : { state: "unknown" as const, mergeCommitSha: null, mergedAt: null }
    );
    const service = createMergedOperatorMergeCardSweepService(db, {
      resolvePullRequest,
      now: () => new Date(nowMs),
      pullRequestCacheTtlMs: 60_000,
    });

    // Pass 1 resolves both references; #41 is unmeasurable so the card defers.
    await service.sweepMergedOperatorMergeCards();
    // Pass 2 (30s later): #40 comes from the cache, #41 is re-checked.
    nowMs += 30_000;
    await service.sweepMergedOperatorMergeCards();
    expect(resolvePullRequest).toHaveBeenCalledTimes(3);
    expect(resolvePullRequest).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({ number: 40 }),
    );

    // Pass 3 (past the TTL): #40 is re-checked; #41 was never cached because
    // unmeasurable evidence is deliberately not cached.
    nowMs += 5 * 60_000;
    await service.sweepMergedOperatorMergeCards();
    expect(resolvePullRequest).toHaveBeenCalledTimes(5);

    const card = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, fixture.cardId))
      .then((rows) => rows[0] ?? null);
    expect(card?.status).toBe("todo");
  });

  describe("default pull-request evidence resolver", () => {
    it("resolves merged evidence from a live GitHub pull-request payload", async () => {
      const { companyId } = await seedCompany(db);
      const seenUrls: string[] = [];
      const fetchImpl = async (url: string) => {
        seenUrls.push(url);
        return pullRequestBody({
          state: "closed",
          merged: true,
          merged_at: "2026-08-29T00:11:06Z",
          merge_commit_sha: MERGED_EVIDENCE.mergeCommitSha,
        });
      };
      const resolver = createMergedOperatorMergeCardPullRequestResolver(db, fetchImpl);

      await expect(
        resolver(companyId, { host: "github.com", owner: "TEA-Core", repo: "paperclip", number: 404 }),
      ).resolves.toEqual(MERGED_EVIDENCE);
      expect(seenUrls).toEqual([
        "https://api.github.com/repos/TEA-Core/paperclip/pulls/404",
      ]);
    });

    it("classifies open and closed-unmerged pull requests without merge evidence", async () => {
      const { companyId } = await seedCompany(db);
      const fetchImpl = async (url: string) =>
        url.endsWith("/pulls/41")
          ? pullRequestBody({ state: "open", merged: false })
          : pullRequestBody({ state: "closed", merged: false });
      const resolver = createMergedOperatorMergeCardPullRequestResolver(db, fetchImpl);

      await expect(
        resolver(companyId, { host: "github.com", owner: "TEA-Core", repo: "paperclip", number: 41 }),
      ).resolves.toEqual({ state: "open", mergeCommitSha: null, mergedAt: null });
      await expect(
        resolver(companyId, { host: "github.com", owner: "TEA-Core", repo: "paperclip", number: 42 }),
      ).resolves.toEqual({ state: "closed", mergeCommitSha: null, mergedAt: null });
    });

    it("treats a merged_at timestamp as merged evidence even when the merged flag is absent", async () => {
      const { companyId } = await seedCompany(db);
      const fetchImpl = async () =>
        pullRequestBody({ state: "closed", merged_at: "2026-08-29T00:11:06Z" });
      const resolver = createMergedOperatorMergeCardPullRequestResolver(db, fetchImpl);

      await expect(
        resolver(companyId, { host: "github.com", owner: "TEA-Core", repo: "paperclip", number: 404 }),
      ).resolves.toEqual({
        state: "merged",
        mergeCommitSha: null,
        mergedAt: "2026-08-29T00:11:06Z",
      });
    });

    it("defers (unknown) on 404, non-JSON bodies, and network failures", async () => {
      const { companyId } = await seedCompany(db);
      const reference = { host: "github.com" as const, owner: "TEA-Core", repo: "paperclip", number: 404 };

      const notFound = createMergedOperatorMergeCardPullRequestResolver(
        db,
        async () => pullRequestBody({}, 404),
      );
      await expect(notFound(companyId, reference)).resolves.toEqual({
        state: "unknown",
        mergeCommitSha: null,
        mergedAt: null,
      });

      const badBody = createMergedOperatorMergeCardPullRequestResolver(
        db,
        async () => new Response("not json", { status: 200 }),
      );
      await expect(badBody(companyId, reference)).resolves.toEqual({
        state: "unknown",
        mergeCommitSha: null,
        mergedAt: null,
      });

      const networkDown = createMergedOperatorMergeCardPullRequestResolver(
        db,
        async () => {
          throw new Error("network unreachable");
        },
      );
      await expect(networkDown(companyId, reference)).resolves.toEqual({
        state: "unknown",
        mergeCommitSha: null,
        mergedAt: null,
      });
    });

    it("retries anonymously when a bound token is rejected with 401", async () => {
      const { companyId } = await seedCompany(db);
      credentialMock.tokenForTest = "gh-test-token";
      try {
        const calls: Array<{ url: string; auth: string | null }> = [];
        const fetchImpl = async (url: string, init?: RequestInit) => {
          const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
          calls.push({ url, auth });
          if (auth) return pullRequestBody({}, 401);
          return pullRequestBody({
            state: "closed",
            merged: true,
            merged_at: MERGED_EVIDENCE.mergedAt,
            merge_commit_sha: MERGED_EVIDENCE.mergeCommitSha,
          });
        };
        const resolver = createMergedOperatorMergeCardPullRequestResolver(db, fetchImpl);

        await expect(
          resolver(companyId, { host: "github.com", owner: "TEA-Core", repo: "paperclip", number: 404 }),
        ).resolves.toEqual(MERGED_EVIDENCE);
        expect(calls).toEqual([
          { url: "https://api.github.com/repos/TEA-Core/paperclip/pulls/404", auth: "Bearer gh-test-token" },
          { url: "https://api.github.com/repos/TEA-Core/paperclip/pulls/404", auth: null },
        ]);
      } finally {
        credentialMock.tokenForTest = null;
      }
    });
  });
});
