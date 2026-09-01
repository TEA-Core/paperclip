import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
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
});
