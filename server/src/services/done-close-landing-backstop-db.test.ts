import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, issues, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { buildDiscoveryQuery, selectLandingCandidates } from "./done-close-landing-backstop.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping blocked draft discovery test: ${support.reason ?? "embedded Postgres unavailable"}`);
}

describeEmbeddedPostgres("blocked draft discovery against Postgres", () => {
  let db!: Db;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-draft-retry-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("rediscovers this sweep's blocked draft park after the done lookback, but not other parks", async () => {
    const companyId = randomUUID();
    const ownId = randomUUID();
    const unrelatedId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Draft retry", issuePrefix: "SUP" });
    await db.insert(issues).values([
      {
        id: ownId, companyId, identifier: "SUP-13326", title: "Stranded draft", status: "blocked",
        unblockDescriptor: {
          owner: "board",
          action: "Run gh pr ready 3158 for paperclipai/paperclip#3158, then republish approval at the ready head via the board merge-arming/republish action",
        },
      },
      {
        id: unrelatedId, companyId, identifier: "SUP-13327", title: "Unrelated blocker", status: "blocked",
        unblockDescriptor: { owner: "board", action: "Review blocker" },
      },
    ]);
    const oldCloseAt = new Date("2026-08-16T00:00:00Z");
    await db.insert(activityLog).values([ownId, unrelatedId].map((id) => ({
      companyId, actorId: "system:done-transition-guard", action: "issue.done_transition_guard_skipped",
      entityType: "issue", entityId: id, createdAt: oldCloseAt,
      details: { reason: "open_linked_prs_decision_carried:1" },
    })));

    const windowStart = new Date("2026-08-25T00:00:00Z");
    const discoveryCutoff = new Date("2026-08-31T00:00:00Z");
    const rows = await buildDiscoveryQuery(db, windowStart, discoveryCutoff);
    expect(selectLandingCandidates(rows, windowStart, discoveryCutoff).map((row) => row.issue.id)).toEqual([ownId]);
  });
});
