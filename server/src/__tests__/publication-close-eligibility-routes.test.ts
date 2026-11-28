import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@paperclipai/db";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  externalObjectMentions,
  externalObjects,
  issueDeliveryReceipts,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { parseIssueExecutionState } from "../services/issue-execution-policy.js";
import { resolveLinkedPullRequests } from "../services/merge-arming.js";
import { readPublicationCloseEligibility } from "../services/publication-close-eligibility.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { buildOpenApiDocument } from "../routes/openapi.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping publication close eligibility route tests: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const ALL_FALSE = {
  deliveryIdentity: false,
  deliveryReceipt: false,
  cachedLinkedPullRequest: false,
  cachedLinkedPullRequestFetchedAt: null,
};

function idleExecutionState(delivery?: unknown) {
  return {
    status: "idle" as const,
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: null,
    lastDecisionId: null,
    lastDecisionOutcome: null,
    ...(delivery === undefined ? {} : { delivery }),
  };
}

const RECORDED_DELIVERY = {
  repo: { owner: "TEA-Core", repo: "paperclip" },
  branch: "SUP-24933-delivery",
  headSha: "a".repeat(40),
};

function triggerCount(result: unknown): number {
  const row = Array.isArray(result)
    ? result[0]
    : result && typeof result === "object" && "rows" in result && Array.isArray(result.rows)
      ? result.rows[0]
      : null;
  if (!row || typeof row !== "object" || !("installed" in row)) return 0;
  const installed = row.installed;
  return typeof installed === "number" ? installed : Number(installed);
}

describeEmbeddedPostgres("GET /api/issues/:id/publication-close-eligibility", () => {
  let db!: Db;
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let app!: express.Express;
  let currentActor!: Express.Request["actor"];
  let previousSchedulingSuppression: string | undefined;

  beforeAll(async () => {
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-publication-close-eligibility-");
    db = createDb(tempDb.connectionString, { maxConnections: 4 });
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = currentActor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as never));
    app.use(errorHandler);
  }, 60_000);

  afterAll(async () => {
    if (db) await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    await tempDb?.cleanup();
    if (previousSchedulingSuppression === undefined) {
      delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    } else {
      process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = previousSchedulingSuppression;
    }
  }, 60_000);

  function boardActor(companyId: string, userId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId,
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    };
  }

  function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
    return {
      type: "agent",
      companyId,
      agentId,
      source: "agent_key",
    };
  }

  async function seedCompany() {
    const companyId = randomUUID();
    const userId = `user-${randomUUID()}`;
    await db.insert(companies).values({
      id: companyId,
      name: `eligibility-${companyId.slice(0, 8)}`,
      issuePrefix: companyId.replaceAll("-", "").slice(0, 12),
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "member",
    });
    const [agent] = await db.insert(agents).values({
      companyId,
      name: "Standard reader",
      role: "engineer",
      adapterType: "process",
    }).returning({ id: agents.id });
    currentActor = boardActor(companyId, userId);
    return { companyId, userId, agentId: agent!.id };
  }

  async function seedIssue(
    companyId: string,
    executionState: Record<string, unknown> | null = null,
  ) {
    const [issue] = await db.insert(issues).values({
      companyId,
      title: `Publication card ${randomUUID()}`,
      executionState,
    }).returning({ id: issues.id, updatedAt: issues.updatedAt });
    return issue!;
  }

  async function insertReceipt(companyId: string, issueId: string, state: "ready" | "claimed" | "consumed" | "invalidated") {
    await db.insert(issueDeliveryReceipts).values({
      companyId,
      sourceIssueId: issueId,
      provider: "github",
      owner: "TEA-Core",
      repo: "paperclip",
      pullRequestNumber: 24933,
      headSha: "b".repeat(40),
      branchName: "SUP-24933-delivery",
      sourceDeliveryRecord: { fixture: true },
      recoveryReason: "eligibility fixture",
      authorizedByActorType: "user",
      authorizedByActorId: "eligibility-fixture",
      idempotencyKey: `eligibility-${issueId}-${state}`,
      state,
    });
  }

  async function linkPullRequest(
    companyId: string,
    issueId: string,
    data: { state: "open" | "closed"; draft: boolean },
    options: { number?: number; lastResolvedAt?: Date | null } = {},
  ) {
    const number = options.number ?? (data.draft ? 704 : 705);
    await linkExternalObject(companyId, issueId, {
      externalId: `TEA-Core/paperclip#pull/${number}`,
      data: {
        state: data.state,
        draft: data.draft,
        node_id: `eligibility-${issueId}-${number}`,
        title: "Eligibility fixture",
      },
      lastResolvedAt: options.lastResolvedAt === undefined ? new Date() : options.lastResolvedAt,
    });
  }

  async function linkExternalObject(
    companyId: string,
    issueId: string,
    row: {
      externalId: string;
      data: Record<string, unknown>;
      providerKey?: string;
      objectType?: string;
      lastResolvedAt?: Date | null;
    },
  ) {
    const providerKey = row.providerKey ?? "github";
    const objectType = row.objectType ?? "pull_request";
    const [object] = await db.insert(externalObjects).values({
      companyId,
      providerKey,
      objectType,
      externalId: row.externalId,
      data: row.data,
      lastResolvedAt: row.lastResolvedAt ?? null,
    }).returning({ id: externalObjects.id });
    await db.insert(externalObjectMentions).values({
      companyId,
      sourceIssueId: issueId,
      sourceKind: "comment",
      objectId: object!.id,
      objectType,
      providerKey,
    });
  }

  async function readEligibility(issueId: string) {
    return request(app).get(`/api/issues/${issueId}/publication-close-eligibility`);
  }

  it("returns three false booleans when the card has no close-blocking binding", async () => {
    const { companyId } = await seedCompany();
    const issue = await seedIssue(companyId, idleExecutionState());
    const res = await readEligibility(issue.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(ALL_FALSE);
    for (const key of ["deliveryIdentity", "deliveryReceipt", "cachedLinkedPullRequest"]) {
      expect(typeof res.body[key]).toBe("boolean");
    }
    expect(res.body).not.toHaveProperty("linkedPullRequest");
  });

  it("sets only deliveryIdentity when a parsed delivery block is present", async () => {
    const { companyId } = await seedCompany();
    const issue = await seedIssue(companyId, idleExecutionState(RECORDED_DELIVERY));
    const res = await readEligibility(issue.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ...ALL_FALSE, deliveryIdentity: true });
  });

  it("keeps deliveryIdentity false when delivery is null or the state does not parse", async () => {
    const { companyId } = await seedCompany();
    const nullDelivery = await seedIssue(companyId, idleExecutionState(null));
    const unparsed = await seedIssue(companyId, { delivery: RECORDED_DELIVERY });
    expect(parseIssueExecutionState({ delivery: RECORDED_DELIVERY })).toBeNull();

    const nullRes = await readEligibility(nullDelivery.id);
    const unparsedRes = await readEligibility(unparsed.id);
    expect(nullRes.status, JSON.stringify(nullRes.body)).toBe(200);
    expect(unparsedRes.status, JSON.stringify(unparsedRes.body)).toBe(200);
    expect(nullRes.body).toEqual(ALL_FALSE);
    expect(unparsedRes.body).toEqual(ALL_FALSE);
  });

  it("sets only deliveryReceipt for a receipt in any state, including invalidated", async () => {
    const { companyId } = await seedCompany();
    const issue = await seedIssue(companyId, idleExecutionState());
    await insertReceipt(companyId, issue.id, "invalidated");
    const res = await readEligibility(issue.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ...ALL_FALSE, deliveryReceipt: true });
  });

  it("ignores a delivery receipt that belongs to another issue", async () => {
    const { companyId } = await seedCompany();
    const issue = await seedIssue(companyId, idleExecutionState());
    const other = await seedIssue(companyId, idleExecutionState());
    await insertReceipt(companyId, other.id, "consumed");
    const res = await readEligibility(issue.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(ALL_FALSE);
  });

  it("sets only cachedLinkedPullRequest for a cached draft pull request and reports its fetch time", async () => {
    const { companyId } = await seedCompany();
    const issue = await seedIssue(companyId, idleExecutionState());
    const fetchedAt = new Date("2026-11-20T08:00:00.000Z");
    await linkPullRequest(companyId, issue.id, { state: "open", draft: true }, { lastResolvedAt: fetchedAt });
    const res = await readEligibility(issue.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      ...ALL_FALSE,
      cachedLinkedPullRequest: true,
      cachedLinkedPullRequestFetchedAt: fetchedAt.toISOString(),
    });
  });

  it("ignores a cached closed pull request but still reports when that cache was fetched", async () => {
    const { companyId } = await seedCompany();
    const issue = await seedIssue(companyId, idleExecutionState());
    const fetchedAt = new Date("2026-11-21T09:30:00.000Z");
    await linkPullRequest(companyId, issue.id, { state: "closed", draft: false }, { lastResolvedAt: fetchedAt });
    const res = await readEligibility(issue.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ...ALL_FALSE, cachedLinkedPullRequestFetchedAt: fetchedAt.toISOString() });
  });

  // RA F1: the done-close guard refreshes linked pull requests from GitHub and
  // discovers pull requests that no comment mentions. This read route must not
  // call GitHub, so it reports the cached value under a cached name, with the
  // fetch time of the oldest cached row. A stale cached "open" row whose pull
  // request has since merged reads true here, and the old fetch time shows the
  // value is stale. A pull request that only live discovery can find reads false
  // with a null fetch time, which means no cached evidence exists.
  it("labels a stale cached open pull request as cached and exposes how old the cache is", async () => {
    const { companyId } = await seedCompany();
    const stale = await seedIssue(companyId, idleExecutionState());
    const staleFetchedAt = new Date("2026-01-02T03:04:05.000Z");
    await linkPullRequest(companyId, stale.id, { state: "open", draft: false }, { lastResolvedAt: staleFetchedAt });

    const staleRes = await readEligibility(stale.id);
    expect(staleRes.status, JSON.stringify(staleRes.body)).toBe(200);
    expect(staleRes.body).toEqual({
      ...ALL_FALSE,
      cachedLinkedPullRequest: true,
      cachedLinkedPullRequestFetchedAt: staleFetchedAt.toISOString(),
    });
    expect(staleRes.body).not.toHaveProperty("linkedPullRequest");

    const unmentioned = await seedIssue(companyId, idleExecutionState());
    const unmentionedRes = await readEligibility(unmentioned.id);
    expect(unmentionedRes.status, JSON.stringify(unmentionedRes.body)).toBe(200);
    expect(unmentionedRes.body).toEqual(ALL_FALSE);
  });

  it("reports the oldest fetch time across the card's cached pull requests, and null when one was never fetched", async () => {
    const { companyId } = await seedCompany();
    const issue = await seedIssue(companyId, idleExecutionState());
    const older = new Date("2026-10-01T00:00:00.000Z");
    const newer = new Date("2026-11-01T00:00:00.000Z");
    await linkPullRequest(companyId, issue.id, { state: "open", draft: false }, { number: 801, lastResolvedAt: newer });
    await linkPullRequest(companyId, issue.id, { state: "closed", draft: false }, { number: 802, lastResolvedAt: older });
    const res = await readEligibility(issue.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      ...ALL_FALSE,
      cachedLinkedPullRequest: true,
      cachedLinkedPullRequestFetchedAt: older.toISOString(),
    });

    await linkPullRequest(companyId, issue.id, { state: "open", draft: false }, { number: 803, lastResolvedAt: null });
    const unfetchedRes = await readEligibility(issue.id);
    expect(unfetchedRes.status, JSON.stringify(unfetchedRes.body)).toBe(200);
    expect(unfetchedRes.body).toEqual({ ...ALL_FALSE, cachedLinkedPullRequest: true });
  });

  // RA F2: the boolean comes from a scoped existence query, not from loading
  // every linked pull-request row. The SQL predicate must keep the shared
  // resolver's filter exactly, so the accept path and this read agree.
  it("matches the shared cached resolver for every cached row shape", async () => {
    const { companyId } = await seedCompany();
    const otherCompany = await seedCompany();
    const shapes: Array<{ name: string; rows: Array<Parameters<typeof linkExternalObject>[2]> }> = [
      { name: "no rows", rows: [] },
      { name: "open", rows: [{ externalId: "TEA-Core/paperclip#pull/1", data: { state: "open" } }] },
      { name: "open draft", rows: [{ externalId: "TEA-Core/paperclip#pull/2", data: { state: "open", draft: true } }] },
      { name: "state key missing", rows: [{ externalId: "TEA-Core/paperclip#pull/3", data: {} }] },
      { name: "state null", rows: [{ externalId: "TEA-Core/paperclip#pull/4", data: { state: null } }] },
      { name: "closed", rows: [{ externalId: "TEA-Core/paperclip#pull/5", data: { state: "closed" } }] },
      { name: "merged", rows: [{ externalId: "TEA-Core/paperclip#pull/6", data: { state: "closed", merged: true } }] },
      { name: "issues path", rows: [{ externalId: "TEA-Core/paperclip#issues/7", data: { state: "open" } }] },
      { name: "bad external id", rows: [{ externalId: "TEA-Core/paperclip#pull/0", data: { state: "open" } }] },
      { name: "extra path segment", rows: [{ externalId: "a/b/c#pull/8", data: { state: "open" } }] },
      { name: "other provider", rows: [{ externalId: "TEA-Core/paperclip#pull/9", data: { state: "open" }, providerKey: "gitlab" }] },
      { name: "other object type", rows: [{ externalId: "TEA-Core/paperclip#pull/10", data: { state: "open" }, objectType: "issue" }] },
      {
        name: "closed row before open row",
        rows: [
          { externalId: "TEA-Core/paperclip#pull/11", data: { state: "closed" } },
          { externalId: "TEA-Core/paperclip#pull/12", data: { state: "open" } },
        ],
      },
    ];
    for (const shape of shapes) {
      const issue = await seedIssue(companyId, idleExecutionState());
      for (const row of shape.rows) await linkExternalObject(companyId, issue.id, row);
      const expected = (await resolveLinkedPullRequests(db, companyId, issue.id, { includeDrafts: true })).length > 0;
      const actual = await readPublicationCloseEligibility(db, { id: issue.id, companyId });
      expect(actual.cachedLinkedPullRequest, shape.name).toBe(expected);
    }

    const foreign = await seedIssue(otherCompany.companyId, idleExecutionState());
    await linkExternalObject(otherCompany.companyId, foreign.id, {
      externalId: "TEA-Core/paperclip#pull/13",
      data: { state: "open" },
    });
    const crossCompany = await readPublicationCloseEligibility(db, { id: foreign.id, companyId });
    expect(crossCompany.cachedLinkedPullRequest).toBe(false);
    expect(crossCompany.cachedLinkedPullRequestFetchedAt).toBeNull();
  });

  it("reads linked pull requests with bounded queries that never load cached payloads", async () => {
    const { companyId } = await seedCompany();
    const issue = await seedIssue(companyId, idleExecutionState());
    for (let number = 900; number < 925; number += 1) {
      await linkPullRequest(companyId, issue.id, { state: "closed", draft: false }, { number });
    }
    await linkPullRequest(companyId, issue.id, { state: "open", draft: false }, { number: 925 });

    const logged: string[] = [];
    const loggedDb = drizzle(db.$client, {
      schema,
      logger: { logQuery: (query) => { logged.push(query); } },
    }) as unknown as Db;
    const result = await readPublicationCloseEligibility(loggedDb, { id: issue.id, companyId });
    expect(result.cachedLinkedPullRequest).toBe(true);

    const pullRequestReads = logged.filter((query) => query.includes('"external_object_mentions"'));
    expect(pullRequestReads.length).toBeGreaterThan(0);
    for (const query of pullRequestReads) {
      expect(query).toMatch(/limit \$\d+$|limit 1$/i);
      expect(query).not.toMatch(/"external_objects"\."data"\s*(,|from)/i);
    }
  });

  it("returns 404 for an unknown issue id", async () => {
    const { companyId, userId } = await seedCompany();
    currentActor = boardActor(companyId, userId);
    const res = await readEligibility(randomUUID());
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Issue not found" });
  });

  it("returns 403 for an actor without issue:read and 200 for a non-board agent that has it", async () => {
    const { companyId, agentId } = await seedCompany();
    const issue = await seedIssue(companyId, idleExecutionState());
    const [boundaryProject] = await db.insert(projects).values({
      companyId,
      name: "Contained project",
    }).returning({ id: projects.id });
    const [outsider] = await db.insert(agents).values({
      companyId,
      name: "Low-trust outsider",
      role: "engineer",
      adapterType: "process",
      permissions: {
        authorizationPolicy: {
          trustPreset: LOW_TRUST_REVIEW_PRESET,
          trustBoundary: {
            mode: LOW_TRUST_REVIEW_PRESET,
            companyId,
            projectIds: [boundaryProject!.id],
          },
        },
      },
    }).returning({ id: agents.id });

    currentActor = agentActor(companyId, outsider!.id);
    const denied = await readEligibility(issue.id);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body.error).toBe("Issue is outside this actor's authorization boundary");

    currentActor = agentActor(companyId, agentId);
    const allowed = await readEligibility(issue.id);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(allowed.body).toEqual(ALL_FALSE);
  });

  it("performs zero writes while reporting every binding at once", async () => {
    const { companyId } = await seedCompany();
    const issue = await seedIssue(companyId, idleExecutionState(RECORDED_DELIVERY));
    await insertReceipt(companyId, issue.id, "claimed");
    await linkPullRequest(companyId, issue.id, { state: "open", draft: true });
    const [before] = await db.select({ updatedAt: issues.updatedAt }).from(issues).where(sql`${issues.id} = ${issue.id}`);

    await db.execute(sql`
      CREATE OR REPLACE FUNCTION publication_close_eligibility_forbid_write()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RAISE EXCEPTION 'publication-close-eligibility wrote % on %', TG_OP, TG_TABLE_NAME;
      END;
      $$
    `);
    await db.execute(sql`
      DO $$
      DECLARE target record;
      BEGIN
        FOR target IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
          EXECUTE format(
            'CREATE TRIGGER zz_no_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION publication_close_eligibility_forbid_write()',
            target.tablename
          );
        END LOOP;
      END $$
    `);
    const installed = await db.execute(sql`
      SELECT count(*)::int AS installed
      FROM pg_trigger
      WHERE tgname = 'zz_no_write' AND NOT tgisinternal
    `);
    expect(triggerCount(installed)).toBeGreaterThan(0);

    try {
      const res = await readEligibility(issue.id);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({
        deliveryIdentity: true,
        deliveryReceipt: true,
        cachedLinkedPullRequest: true,
      });
      const [after] = await db.select({ updatedAt: issues.updatedAt }).from(issues).where(sql`${issues.id} = ${issue.id}`);
      expect(after!.updatedAt).toEqual(before!.updatedAt);
    } finally {
      await db.execute(sql`
        DO $$
        DECLARE target record;
        BEGIN
          FOR target IN
            SELECT c.relname AS tablename
            FROM pg_trigger t
            JOIN pg_class c ON c.oid = t.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE t.tgname = 'zz_no_write' AND n.nspname = 'public' AND NOT t.tgisinternal
          LOOP
            EXECUTE format('DROP TRIGGER IF EXISTS zz_no_write ON public.%I', target.tablename);
          END LOOP;
        END $$
      `);
      await db.execute(sql`DROP FUNCTION IF EXISTS publication_close_eligibility_forbid_write()`);
    }
  });

  it("documents the read in OpenAPI as agent-callable with required booleans and a cached fetch time", () => {
    const spec = buildOpenApiDocument();
    const operation = spec.paths?.["/api/issues/{id}/publication-close-eligibility"]?.get;
    expect(operation).toBeDefined();
    expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board_or_agent" });
    expect(operation.description).toContain("cached");
    expect(operation.description).toContain("advisory");
    const responseSchema = operation.responses["200"].content["application/json"].schema;
    const properties = responseSchema.properties ?? responseSchema;
    expect(responseSchema.required).toEqual(expect.arrayContaining([
      "deliveryIdentity",
      "deliveryReceipt",
      "cachedLinkedPullRequest",
      "cachedLinkedPullRequestFetchedAt",
    ]));
    expect(properties).not.toHaveProperty("linkedPullRequest");
    for (const name of ["deliveryIdentity", "deliveryReceipt", "cachedLinkedPullRequest"]) {
      expect(properties[name]).toMatchObject({ type: "boolean" });
      expect(properties[name].nullable).not.toBe(true);
    }
    expect(properties.cachedLinkedPullRequestFetchedAt).toMatchObject({ type: "string", format: "date-time" });
    expect(properties.cachedLinkedPullRequestFetchedAt.nullable).toBe(true);
  });
});
