import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issues,
  issueRelations,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * SUP-16741 regression: list projections must not report the execution-ladder
 * columns as `null`.
 *
 * `issueListSelect` deliberately omits `executionPolicy`, `executionState` and
 * `executionWorkspaceSettings` for perf, but it used to project each one as the
 * SQL literal `null`. A row for an armed ladder therefore read exactly like a
 * row with no ladder at all — the two are indistinguishable to any consumer
 * that branches on `!= null`. The fix is to omit the keys entirely (runtime and
 * row type), so absence is honest: the field was not projected, not "this card
 * has no ladder".
 *
 * Single-issue reads are out of scope and must keep returning the real values.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const EXECUTION_FIELDS = [
  "executionPolicy",
  "executionState",
  "executionWorkspaceSettings",
] as const;

const ARMED_POLICY = { sentinel: "armed-ladder", stages: [{ type: "review" }] };
const ARMED_STATE = { sentinel: "armed-state", status: "pending" };
const ARMED_WORKSPACE_SETTINGS = { sentinel: "armed-workspace" };

describeEmbeddedPostgres("issue list execution-ladder projection (SUP-16741)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-list-exec-projection-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const operatorUserId = `user-${randomUUID()}`;
    const armedIssueId = randomUUID();
    const blockedArmedIssueId = randomUUID();
    const now = new Date();

    await db.insert(companies).values({
      id: companyId,
      name: `Execution projection ${companyId}`,
      issuePrefix: `EP${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(authUsers).values({
      id: operatorUserId,
      name: "Operator",
      email: `${operatorUserId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: operatorUserId,
      status: "active",
      membershipRole: "operator",
    });
    await db.insert(issues).values([
      {
        id: armedIssueId,
        companyId,
        identifier: "EP-ARMED",
        title: "Issue with an armed ladder",
        status: "in_review",
        priority: "medium",
        executionPolicy: ARMED_POLICY,
        executionState: ARMED_STATE,
        executionWorkspaceSettings: ARMED_WORKSPACE_SETTINGS,
      },
      {
        id: blockedArmedIssueId,
        companyId,
        identifier: "EP-BLOCKED",
        title: "Blocked issue with an armed ladder",
        status: "blocked",
        priority: "medium",
        executionPolicy: ARMED_POLICY,
        executionState: ARMED_STATE,
        executionWorkspaceSettings: ARMED_WORKSPACE_SETTINGS,
      },
    ]);

    return { companyId, operatorUserId, armedIssueId, blockedArmedIssueId };
  }

  function appFor(seeded: Awaited<ReturnType<typeof seed>>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        source: "session",
        userId: seeded.operatorUserId,
        companyIds: [seeded.companyId],
        memberships: [
          { companyId: seeded.companyId, membershipRole: "operator", status: "active" },
        ],
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
    return app;
  }

  function rowFor(body: unknown, id: string): Record<string, unknown> {
    const row = (Array.isArray(body) ? body : []).find(
      (entry) => (entry as { id?: unknown }).id === id,
    );
    expect(row).toBeTruthy();
    return row as Record<string, unknown>;
  }

  it("omits the execution-ladder keys from a list row instead of projecting null", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .expect(200);

    const row = rowFor(res.body, seeded.armedIssueId);
    for (const field of EXECUTION_FIELDS) {
      // Absent, not present-and-null: `"field" in row` must be false, because
      // `row.field === null` is exactly the ambiguity this regression is about.
      expect(Object.prototype.hasOwnProperty.call(row, field)).toBe(false);
      expect(row[field]).toBeUndefined();
    }
  });

  it("omits the execution-ladder keys from the blocked-attention list path too", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .get(`/api/companies/${seeded.companyId}/issues`)
      .query({ attention: "blocked" })
      .expect(200);

    const row = rowFor(res.body, seeded.blockedArmedIssueId);
    for (const field of EXECUTION_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(row, field)).toBe(false);
      expect(row[field]).toBeUndefined();
    }
  });

  it("still returns the real execution-ladder values on the single-issue endpoint", async () => {
    const seeded = await seed();
    const res = await request(appFor(seeded))
      .get(`/api/issues/${seeded.armedIssueId}`)
      .expect(200);

    expect(res.body.executionPolicy).toEqual(ARMED_POLICY);
    expect(res.body.executionState).toEqual(ARMED_STATE);
    expect(res.body.executionWorkspaceSettings).toEqual(ARMED_WORKSPACE_SETTINGS);
  });
});
