import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
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
  linkedPullRequest: false,
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
  ) {
    const number = data.draft ? 704 : 705;
    const [object] = await db.insert(externalObjects).values({
      companyId,
      providerKey: "github",
      objectType: "pull_request",
      externalId: `TEA-Core/paperclip#pull/${number}`,
      data: {
        state: data.state,
        draft: data.draft,
        node_id: `eligibility-${issueId}-${number}`,
        title: "Eligibility fixture",
      },
    }).returning({ id: externalObjects.id });
    await db.insert(externalObjectMentions).values({
      companyId,
      sourceIssueId: issueId,
      sourceKind: "comment",
      objectId: object!.id,
      objectType: "pull_request",
      providerKey: "github",
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
    expect(JSON.stringify(res.body)).not.toContain("null");
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

  it("sets only linkedPullRequest for a draft pull request", async () => {
    const { companyId } = await seedCompany();
    const issue = await seedIssue(companyId, idleExecutionState());
    await linkPullRequest(companyId, issue.id, { state: "open", draft: true });
    const res = await readEligibility(issue.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ ...ALL_FALSE, linkedPullRequest: true });
  });

  it("ignores a closed pull request mention", async () => {
    const { companyId } = await seedCompany();
    const issue = await seedIssue(companyId, idleExecutionState());
    await linkPullRequest(companyId, issue.id, { state: "closed", draft: false });
    const res = await readEligibility(issue.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(ALL_FALSE);
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
      expect(res.body).toEqual({
        deliveryIdentity: true,
        deliveryReceipt: true,
        linkedPullRequest: true,
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

  it("documents the read in OpenAPI as agent-callable with required booleans", () => {
    const spec = buildOpenApiDocument();
    const operation = spec.paths?.["/api/issues/{id}/publication-close-eligibility"]?.get;
    expect(operation).toBeDefined();
    expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board_or_agent" });
    const schema = operation.responses["200"].content["application/json"].schema;
    const properties = schema.properties ?? schema;
    expect(schema.required).toEqual(expect.arrayContaining([
      "deliveryIdentity",
      "deliveryReceipt",
      "linkedPullRequest",
    ]));
    for (const name of ["deliveryIdentity", "deliveryReceipt", "linkedPullRequest"]) {
      expect(properties[name]).toMatchObject({ type: "boolean", nullable: undefined });
      expect(properties[name].nullable).not.toBe(true);
    }
  });
});
