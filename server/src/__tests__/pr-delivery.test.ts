import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  companies,
  createDb,
  issueWorkProducts,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { prDeliveryService } from "../services/pr-delivery.js";
import { prDeliverySignature } from "../routes/issues.js";

describe("prDeliverySignature (unit)", () => {
  it("returns null for non-pull_request types", () => {
    expect(prDeliverySignature({ type: "artifact", url: "https://github.com/o/r/pull/1", metadata: {} })).toBeNull();
  });

  it("resolves both from metadata when they form a complete valid pair", () => {
    const result = prDeliverySignature({
      type: "pull_request",
      url: "https://github.com/other/repo/pull/999",
      metadata: { repository: "TEA-Core/paperclip", prNumber: 438 },
    });
    expect(result).toEqual({ repository: "TEA-Core/paperclip", prNumber: 438, externalId: "TEA-Core/paperclip#438" });
  });

  it("resolves both from URL when metadata is a mixed source (repository valid, prNumber absent)", () => {
    const result = prDeliverySignature({
      type: "pull_request",
      url: "https://github.com/TEA-Core/Trading-Signal-Platform/pull/3417",
      metadata: { repository: "TEA-Core/paperclip" },
    });
    expect(result).toEqual({ repository: "TEA-Core/Trading-Signal-Platform", prNumber: 3417, externalId: "TEA-Core/Trading-Signal-Platform#3417" });
  });

  it("resolves both from URL when metadata is a mixed source (prNumber valid, repository absent)", () => {
    const result = prDeliverySignature({
      type: "pull_request",
      url: "https://github.com/TEA-Core/Trading-Signal-Platform/pull/3417",
      metadata: { prNumber: 999 },
    });
    expect(result).toEqual({ repository: "TEA-Core/Trading-Signal-Platform", prNumber: 3417, externalId: "TEA-Core/Trading-Signal-Platform#3417" });
  });

  it("resolves both from URL when metadata has no valid fields", () => {
    const result = prDeliverySignature({
      type: "pull_request",
      url: "https://github.com/TEA-Core/paperclip/pull/438",
      metadata: { foo: "bar" },
    });
    expect(result).toEqual({ repository: "TEA-Core/paperclip", prNumber: 438, externalId: "TEA-Core/paperclip#438" });
  });

  it("returns null when neither metadata nor URL yields a complete pair", () => {
    expect(
      prDeliverySignature({
        type: "pull_request",
        url: "https://example.com/not-a-github-url",
        metadata: { repository: "only/repo" },
      }),
    ).toBeNull();
  });

  it("returns null when metadata pair is incomplete and URL is null", () => {
    expect(
      prDeliverySignature({
        type: "pull_request",
        url: null,
        metadata: { repository: "TEA-Core/paperclip" },
      }),
    ).toBeNull();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres PR-delivery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const REPOSITORY = "TEA-Core/Trading-Signal-Platform";
const PR_NUMBER = 3417;
const EXTERNAL_ID = `${REPOSITORY}#${PR_NUMBER}`;
const PR_URL = `https://github.com/${REPOSITORY}/pull/${PR_NUMBER}`;

describeEmbeddedPostgres("prDeliveryService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let sourceIssueId!: string;
  let childIds!: string[];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pr-delivery-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Carrier Co",
      issuePrefix: "SUP",
      requireBoardApprovalForNewAgents: false,
    });

    // Four-child single-carrier shape: one source issue with four descendants.
    sourceIssueId = randomUUID();
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Carrier source",
      status: "done",
    });
    childIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const childId of childIds) {
      await db.insert(issues).values({
        id: childId,
        companyId,
        title: "Carrier child",
        status: "done",
        parentId: sourceIssueId,
      });
    }
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(activityLog);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function input() {
    return {
      companyId,
      sourceIssueId,
      repository: REPOSITORY,
      prNumber: PR_NUMBER,
      headRef: "carrier-branch",
      baseRef: "main",
      headSha: "abc123",
      url: PR_URL,
    };
  }

  async function readRows() {
    return db
      .select()
      .from(issueWorkProducts)
      .where(
        and(
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.type, "pull_request"),
        ),
      );
  }

  async function readActivity() {
    return db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
  }

  it("fans a ready_for_review row out to every issue in the carrier tree at PR-open", async () => {
    const service = prDeliveryService(db);
    const result = await service.recordAtOpen(input());

    expect(result.writtenIssueIds.sort()).toEqual([sourceIssueId, ...childIds].sort());
    expect(result.status).toBe("ready_for_review");
    expect(result.metadata).toMatchObject({
      prNumber: PR_NUMBER,
      repository: REPOSITORY,
      headRef: "carrier-branch",
      baseRef: "main",
      headSha: "abc123",
    });

    const rows = await readRows();
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.status).toBe("ready_for_review");
      expect(row.provider).toBe("github");
      expect(row.externalId).toBe(EXTERNAL_ID);
      expect(row.url).toBe(PR_URL);
      expect((row.metadata as Record<string, unknown>).prNumber).toBe(PR_NUMBER);
      expect((row.metadata as Record<string, unknown>).repository).toBe(REPOSITORY);
    }
  });

  it("is idempotent: re-recording does not create duplicate rows", async () => {
    const service = prDeliveryService(db);
    await service.recordAtOpen(input());
    await service.recordAtOpen(input());

    const rows = await readRows();
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.issueId)).size).toBe(5);
  });

  it("refresh stamps every row merged with mergedAt + mergeCommitSha sourced from GitHub", async () => {
    const service = prDeliveryService(db, {
      resolvePullRequestDetails: vi.fn(async () => ({
        state: "merged",
        headRef: "carrier-branch",
        headSha: "abc123",
        mergedAt: "2026-08-31T17:26:58Z",
        mergeCommitSha: "3fc37fe91c6190ab695a651224ad057db0a38aba",
      })),
    });
    await service.recordAtOpen(input());

    const refreshed = await service.refreshMergeState(input());
    expect(refreshed.merged).toBe(true);
    expect(refreshed.mergedAt).toBe("2026-08-31T17:26:58Z");
    expect(refreshed.mergeCommitSha).toBe("3fc37fe91c6190ab695a651224ad057db0a38aba");

    const rows = await readRows();
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.status).toBe("merged");
      const metadata = row.metadata as Record<string, unknown>;
      expect(metadata.mergedAt).toBe("2026-08-31T17:26:58Z");
      expect(metadata.mergeCommitSha).toBe("3fc37fe91c6190ab695a651224ad057db0a38aba");
      // open-time metadata is preserved alongside the merge stamp
      expect(metadata.prNumber).toBe(PR_NUMBER);
      expect(metadata.headRef).toBe("carrier-branch");
    }
  });

  it("never merges an open PR: rows stay ready_for_review with no mergedAt", async () => {
    const service = prDeliveryService(db, {
      resolvePullRequestDetails: vi.fn(async () => ({
        state: "open",
        headRef: "carrier-branch",
        headSha: "abc123",
      })),
    });
    await service.recordAtOpen(input());

    const refreshed = await service.refreshMergeState(input());
    expect(refreshed.merged).toBe(false);
    expect(refreshed.mergedAt).toBeNull();

    const rows = await readRows();
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.status).toBe("ready_for_review");
      expect((row.metadata as Record<string, unknown>).mergedAt).toBeUndefined();
      expect((row.metadata as Record<string, unknown>).mergeCommitSha).toBeUndefined();
    }
  });

  it("refresh is a no-op for issues that never recorded a delivery row", async () => {
    const service = prDeliveryService(db, {
      resolvePullRequestDetails: vi.fn(async () => ({
        state: "merged",
        headRef: "carrier-branch",
        headSha: "abc123",
        mergedAt: "2026-08-31T17:26:58Z",
        mergeCommitSha: "3fc37fe91c6190ab695a651224ad057db0a38aba",
      })),
    });
    // No recordAtOpen first: refresh must not fabricate rows.
    const refreshed = await service.refreshMergeState(input());
    expect(refreshed.merged).toBe(true);
    expect(refreshed.rows.every((row) => row.found === false)).toBe(true);
    expect(await readRows()).toHaveLength(0);
  });

  it("recordCarrierFanOut mirrors the source row onto every descendant, never the source", async () => {
    const service = prDeliveryService(db);
    const result = await service.recordCarrierFanOut({
      companyId,
      sourceIssueId,
      externalId: EXTERNAL_ID,
      url: PR_URL,
      title: `PR #${PR_NUMBER} ${REPOSITORY}`,
      status: "ready_for_review",
      reviewState: "none",
      metadata: { prNumber: PR_NUMBER, repository: REPOSITORY },
    });

    // Four children, not the source, written.
    expect(result.writtenIssueIds.sort()).toEqual(childIds.sort());
    const rows = await readRows();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.issueId).not.toBe(sourceIssueId);
      expect(row.externalId).toBe(EXTERNAL_ID);
      expect(row.status).toBe("ready_for_review");
      expect(row.isPrimary).toBe(false);
      expect(row.url).toBe(PR_URL);
    }
  });

  it("recordCarrierFanOut is idempotent: re-fanning does not duplicate descendant rows", async () => {
    const service = prDeliveryService(db);
    const fanIn = {
      companyId,
      sourceIssueId,
      externalId: EXTERNAL_ID,
      url: PR_URL,
      title: `PR #${PR_NUMBER} ${REPOSITORY}`,
      status: "ready_for_review",
      reviewState: "none",
      metadata: { prNumber: PR_NUMBER, repository: REPOSITORY },
    };
    await service.recordCarrierFanOut(fanIn);
    await service.recordCarrierFanOut(fanIn);

    const rows = await readRows();
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((row) => row.issueId)).size).toBe(4);
  });

  it("sweepMergeState flips every delivery row to merged with mergedAt + mergeCommitSha", async () => {
    const service = prDeliveryService(db, {
      resolvePullRequestDetails: vi.fn(async () => ({
        state: "merged",
        headRef: "carrier-branch",
        headSha: "abc123",
        mergedAt: "2026-08-31T17:26:58Z",
        mergeCommitSha: "3fc37fe91c6190ab695a651224ad057db0a38aba",
      })),
    });
    await service.recordAtOpen(input());
    expect((await readRows()).every((row) => row.status === "ready_for_review")).toBe(true);

    const swept = await service.sweepMergeState();
    expect(swept.checked).toBe(5);
    expect(swept.flipped).toBe(5);

    const rows = await readRows();
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.status).toBe("merged");
      const metadata = row.metadata as Record<string, unknown>;
      expect(metadata.mergedAt).toBe("2026-08-31T17:26:58Z");
      expect(metadata.mergeCommitSha).toBe("3fc37fe91c6190ab695a651224ad057db0a38aba");
      expect(metadata.prNumber).toBe(PR_NUMBER);
      expect(metadata.mergeStateCheckedAt).toBeTruthy();
    }
  });

  it("sweepMergeState never merges an open PR and stamps a cooldown marker", async () => {
    const service = prDeliveryService(db, {
      resolvePullRequestDetails: vi.fn(async () => ({
        state: "open",
        headRef: "carrier-branch",
        headSha: "abc123",
      })),
    });
    await service.recordAtOpen(input());

    const swept = await service.sweepMergeState();
    expect(swept.flipped).toBe(0);

    const rows = await readRows();
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.status).toBe("ready_for_review");
      expect((row.metadata as Record<string, unknown>).mergeStateCheckedAt).toBeTruthy();
      expect((row.metadata as Record<string, unknown>).mergedAt).toBeUndefined();
    }
  });

  it("sweepMergeState honors the cooldown: a just-checked row is not re-resolved", async () => {
    const resolve = vi.fn(async () => ({
      state: "open",
      headRef: "carrier-branch",
      headSha: "abc123",
    }));
    const service = prDeliveryService(db, { resolvePullRequestDetails: resolve });
    await service.recordAtOpen(input());

    expect((await service.sweepMergeState()).checked).toBe(5);
    // Within the 5-minute cooldown window the same rows are skipped; the live
    // resolver is not called again.
    expect((await service.sweepMergeState()).checked).toBe(0);
    expect(resolve).toHaveBeenCalledTimes(5);
  });

  it("recordAtOpen + recordCarrierFanOut never downgrade a merged row on re-delivery", async () => {
    const service = prDeliveryService(db, {
      resolvePullRequestDetails: vi.fn(async () => ({
        state: "merged",
        headRef: "carrier-branch",
        headSha: "abc123",
        mergedAt: "2026-08-31T17:26:58Z",
        mergeCommitSha: "3fc37fe91c6190ab695a651224ad057db0a38aba",
      })),
    });
    await service.recordAtOpen(input());
    await service.refreshMergeState(input());

    // Simulate a re-delivery: the live route re-records the open row on the
    // source and the fan-out re-mirrors it onto the descendants.
    await service.recordAtOpen(input());
    await service.recordCarrierFanOut({
      companyId,
      sourceIssueId,
      externalId: EXTERNAL_ID,
      url: PR_URL,
      title: `PR #${PR_NUMBER} ${REPOSITORY}`,
      status: "ready_for_review",
      reviewState: "none",
      metadata: { prNumber: PR_NUMBER, repository: REPOSITORY },
    });

    const rows = await readRows();
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      // A recorded merge must stay merged; the merge marker is not clobbered
      // by the open-time reset (the false-`unknown` this card prevents).
      expect(row.status).toBe("merged");
      const metadata = row.metadata as Record<string, unknown>;
      expect(metadata.mergedAt).toBe("2026-08-31T17:26:58Z");
      expect(metadata.mergeCommitSha).toBe("3fc37fe91c6190ab695a651224ad057db0a38aba");
    }
  });

  it("sweepMergeState continues past a row whose resolver throws", async () => {
    let threwOnce = false;
    const service = prDeliveryService(db, {
      resolvePullRequestDetails: vi.fn(async () => {
        if (!threwOnce) {
          threwOnce = true;
          throw new Error("transient GitHub API failure");
        }
        return {
          state: "merged",
          headRef: "carrier-branch",
          headSha: "abc123",
          mergedAt: "2026-08-31T17:26:58Z",
          mergeCommitSha: "3fc37fe91c6190ab695a651224ad057db0a38aba",
        };
      }),
    });
    await service.recordAtOpen(input());

    const swept = await service.sweepMergeState();
    // One row's resolution threw and was caught; the remaining four still
    // flipped — the failure did not abort the sweep and strand later rows.
    expect(swept.checked).toBe(5);
    expect(swept.flipped).toBe(4);

    const rows = await readRows();
    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => row.status === "merged")).toHaveLength(4);
    expect(rows.filter((row) => row.status === "ready_for_review")).toHaveLength(1);
    // pr-delivery-sweep-catch-no-cooldown-stamp: the row whose resolver threw
    // must still carry the cooldown marker, so it cools down instead of being
    // re-selected every tick under NULLS FIRST.
    const failedRow = rows.find((row) => row.status === "ready_for_review")!;
    expect((failedRow.metadata as Record<string, unknown>).mergeStateCheckedAt).toBeTruthy();
  });

  it("carrier fan-out is scoped to the source issue's company", async () => {
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other Co",
      issuePrefix: "OTH",
      requireBoardApprovalForNewAgents: false,
    });
    // A descendant whose parent is the carrier source but that lives in a
    // different company: it must NOT be part of the fan-out tree.
    const outsiderId = randomUUID();
    await db.insert(issues).values({
      id: outsiderId,
      companyId: otherCompanyId,
      title: "Outsider child",
      status: "done",
      parentId: sourceIssueId,
    });

    const service = prDeliveryService(db);
    const tree = await service.listCarrierIssueIds(companyId, sourceIssueId);
    expect(tree).not.toContain(outsiderId);
    expect(tree.sort()).toEqual([sourceIssueId, ...childIds].sort());

    await service.recordAtOpen(input());
    // Exactly the five in-company issues carry the row; the outsider got none.
    const all = await db
      .select()
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.externalId, EXTERNAL_ID));
    expect(all).toHaveLength(5);
    expect(all.every((row) => row.companyId === companyId)).toBe(true);
  });

  it("logs a created activity entry on every carrier issue at PR-open", async () => {
    const service = prDeliveryService(db);
    await service.recordAtOpen(input());

    const activity = await readActivity();
    expect(activity).toHaveLength(5);
    for (const entry of activity) {
      expect(entry.action).toBe("issue.work_product_created");
      expect(entry.entityType).toBe("issue");
      expect(entry.actorType).toBe("system");
      const details = entry.details as Record<string, unknown>;
      expect(details.type).toBe("pull_request");
      expect(details.externalId).toBe(EXTERNAL_ID);
      expect(details.status).toBe("ready_for_review");
      expect(details.workProductId).toBeTruthy();
    }
    expect(activity.map((entry) => entry.entityId).sort()).toEqual([sourceIssueId, ...childIds].sort());
  });

  it("logs a created activity entry on every descendant for the carrier fan-out", async () => {
    const service = prDeliveryService(db);
    await service.recordCarrierFanOut({
      companyId,
      sourceIssueId,
      externalId: EXTERNAL_ID,
      url: PR_URL,
      title: `PR #${PR_NUMBER} ${REPOSITORY}`,
      status: "ready_for_review",
      reviewState: "none",
      metadata: { prNumber: PR_NUMBER, repository: REPOSITORY },
    });

    const activity = await readActivity();
    expect(activity).toHaveLength(4);
    for (const entry of activity) {
      expect(entry.action).toBe("issue.work_product_created");
      expect(entry.entityId).not.toBe(sourceIssueId);
      const details = entry.details as Record<string, unknown>;
      expect(details.externalId).toBe(EXTERNAL_ID);
      expect(details.carrierFanOut).toBe(true);
    }
    expect(activity.map((entry) => entry.entityId).sort()).toEqual(childIds.sort());
  });

  it("logs an updated activity entry when refresh flips every row to merged", async () => {
    const service = prDeliveryService(db, {
      resolvePullRequestDetails: vi.fn(async () => ({
        state: "merged",
        headRef: "carrier-branch",
        headSha: "abc123",
        mergedAt: "2026-08-31T17:26:58Z",
        mergeCommitSha: "3fc37fe91c6190ab695a651224ad057db0a38aba",
      })),
    });
    await service.recordAtOpen(input());
    await db.delete(activityLog);
    await service.refreshMergeState(input());

    const activity = await readActivity();
    expect(activity).toHaveLength(5);
    for (const entry of activity) {
      expect(entry.action).toBe("issue.work_product_updated");
      const details = entry.details as Record<string, unknown>;
      expect(details.status).toBe("merged");
      expect(details.mergedAt).toBe("2026-08-31T17:26:58Z");
      expect(details.mergeCommitSha).toBe("3fc37fe91c6190ab695a651224ad057db0a38aba");
    }
  });

  it("logs no activity when a refresh resolves the PR as open (no row mutation)", async () => {
    const service = prDeliveryService(db, {
      resolvePullRequestDetails: vi.fn(async () => ({
        state: "open",
        headRef: "carrier-branch",
        headSha: "abc123",
      })),
    });
    await service.recordAtOpen(input());
    await db.delete(activityLog);
    await service.refreshMergeState(input());

    expect(await readActivity()).toHaveLength(0);
  });

  it("logs an updated activity entry when the sweep flips a row to merged", async () => {
    const service = prDeliveryService(db, {
      resolvePullRequestDetails: vi.fn(async () => ({
        state: "merged",
        headRef: "carrier-branch",
        headSha: "abc123",
        mergedAt: "2026-08-31T17:26:58Z",
        mergeCommitSha: "3fc37fe91c6190ab695a651224ad057db0a38aba",
      })),
    });
    await service.recordAtOpen(input());
    await db.delete(activityLog);
    const swept = await service.sweepMergeState();

    expect(swept.flipped).toBe(5);
    const activity = await readActivity();
    expect(activity).toHaveLength(5);
    for (const entry of activity) {
      expect(entry.action).toBe("issue.work_product_updated");
      expect(entry.actorType).toBe("system");
      const details = entry.details as Record<string, unknown>;
      expect(details.externalId).toBe(EXTERNAL_ID);
      expect(details.status).toBe("merged");
      expect(details.mergedAt).toBe("2026-08-31T17:26:58Z");
    }
  });
});
