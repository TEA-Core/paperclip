import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  issues,
  releaseAssuranceEvents,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { releaseDecisionRoutes } from "../routes/release-decisions.js";
import type { LivePullRequest } from "../services/release-assurance.js";

const mockGhFetch = vi.hoisted(() => vi.fn());
vi.mock("../services/github-fetch.js", () => ({
  ghFetch: mockGhFetch,
  gitHubApiBase: () => "https://api.github.com",
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

const USER_ID = "board-user-1";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const DIGEST = "c".repeat(64);
const PR = { owner: "TEA-Core", repo: "paperclip", number: 4242 };

/**
 * SUP-20771: release-assurance control plane in SHADOW mode. The ledger is
 * append-only and head-bound, the decision API refuses a stale head, and no
 * release-assurance/approved status is ever written or admitted.
 */
describeEmbeddedPostgres("release-assurance control plane (shadow mode)", () => {
  let db: Db;
  let app: express.Express;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let actor: Express.Request["actor"];
  let live: LivePullRequest;
  let linked: Array<{ owner: string; repo: string; number: number }>;
  let companyId: string;
  let issueId: string;
  let raAgentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-release-assurance-");
    db = createDb(tempDb.connectionString);
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", releaseDecisionRoutes(db, {
      linkedPullRequests: async () => linked,
      readLivePullRequest: async () => live,
    }));
    app.use(errorHandler);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function boardActor(role: "owner" | "member" = "owner"): Express.Request["actor"] {
    return {
      type: "board",
      userId: USER_ID,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: role, status: "active" }],
      source: "cloud_tenant",
    } as unknown as Express.Request["actor"];
  }

  beforeEach(async () => {
    mockGhFetch.mockReset();
    await db.delete(releaseAssuranceEvents);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    companyId = randomUUID();
    issueId = randomUUID();
    raAgentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "RA Co", issuePrefix: "SUP", requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: USER_ID, status: "active", membershipRole: "owner",
    });
    await db.insert(agents).values({
      id: raAgentId, companyId, name: "RA", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "Ship it", status: "in_review", identifier: "SUP-20771-T" });
    actor = boardActor();
    linked = [PR];
    live = { ok: true, open: true, headSha: HEAD_A };
  });

  const enrollBody = (over: Record<string, unknown> = {}) => ({
    eventId: randomUUID(), owner: PR.owner, repo: PR.repo, pullRequestNumber: PR.number, raAgentId, reason: "release hold", ...over,
  });
  const goBody = (over: Record<string, unknown> = {}) => ({
    decision: "go", eventId: randomUUID(), headSha: HEAD_A, evidenceDigest: DIGEST, ciRunIds: [20, 10], reason: "all checks satisfied", ...over,
  });
  const noGoBody = (over: Record<string, unknown> = {}) => ({
    decision: "no_go", eventId: randomUUID(), headSha: HEAD_A, reason: "open finding", ...over,
  });
  const enroll = (body = enrollBody()) => request(app).post(`/api/issues/${issueId}/release-assurance/enroll`).send(body);
  const decide = (body: Record<string, unknown>) => request(app).post(`/api/issues/${issueId}/release-decisions`).send(body);
  const rows = () => db.select().from(releaseAssuranceEvents);

  it("enrolls idempotently: replay is a no-op, a reused event id with another payload or a second enrollment is 409", async () => {
    const body = enrollBody();
    const first = await enroll(body);
    expect(first.status).toBe(201);
    expect(first.body.event).toMatchObject({ kind: "hold", headSha: null, owner: "tea-core", publicationMode: "shadow" });

    const replay = await enroll(body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, event: { id: first.body.event.id } });

    expect((await enroll({ ...body, reason: "different" })).status).toBe(409);
    expect((await enroll(enrollBody())).status).toBe(409);
    expect(await rows()).toHaveLength(1);
  });

  it("refuses an enrollment for an unlinked PR or a seat outside the company", async () => {
    linked = [];
    expect((await enroll()).status).toBe(409);
    linked = [PR];
    expect((await enroll(enrollBody({ raAgentId: randomUUID() }))).status).toBe(409);
    expect(await rows()).toHaveLength(0);
  });

  it("is board owner/admin only and records nothing for a refused caller", async () => {
    actor = boardActor("member");
    await db.update(companyMemberships).set({ membershipRole: "member" });
    expect((await enroll()).status).toBe(403);
    actor = { type: "agent", agentId: raAgentId, companyId, source: "agent_key" } as unknown as Express.Request["actor"];
    expect((await enroll()).status).toBe(403);
    expect(await rows()).toHaveLength(0);
  });

  it("rejects a decision for a card that is not enrolled", async () => {
    expect((await decide(goBody())).status).toBe(409);
    expect(await rows()).toHaveLength(0);
  });

  it("rejects a decision for a stale head and an unreadable or closed PR, recording nothing", async () => {
    await enroll();
    live = { ok: true, open: true, headSha: HEAD_B };
    const stale = await decide(goBody());
    expect(stale.status).toBe(409);
    expect(stale.body.details).toMatchObject({ liveHeadSha: HEAD_B });
    expect((await decide(noGoBody())).status).toBe(409);
    live = { ok: false, message: "boom" };
    expect((await decide(goBody())).status).toBe(409);
    live = { ok: true, open: false, headSha: HEAD_A };
    expect((await decide(goBody())).status).toBe(409);
    expect((await rows()).map((row) => row.kind)).toEqual(["hold"]);
  });

  it("records a head-bound GO in shadow mode: planned status only, nothing sent to GitHub", async () => {
    await enroll();
    const body = goBody();
    const res = await decide(body);
    expect(res.status).toBe(201);
    expect(res.body.verdict).toBe("go");
    expect(res.body.event).toMatchObject({ kind: "go", headSha: HEAD_A, ciRunIds: [10, 20], publicationMode: "shadow" });
    expect(res.body.publication).toEqual({
      kind: "shadow",
      planned: {
        context: "release-assurance/approved", state: "success", sha: HEAD_A,
        description: `released by release-assurance for ${HEAD_A}`, targetUrl: `/api/issues/${issueId}/release-decisions`,
      },
    });
    expect(mockGhFetch).not.toHaveBeenCalled();

    const read = await request(app).get(`/api/issues/${issueId}/release-decisions`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ publicationMode: "shadow", enrolled: true, verdicts: { [HEAD_A]: "go" } });
    expect(read.body.events).toHaveLength(2);
  });

  it("replays an identical decision from the ledger even after the head moved, and refuses a conflicting reuse", async () => {
    await enroll();
    const body = goBody();
    const first = await decide(body);
    live = { ok: true, open: true, headSha: HEAD_B };
    const replay = await decide(body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, event: { id: first.body.event.id } });
    expect((await decide({ ...body, reason: "changed" })).status).toBe(409);
    expect((await decide(goBody())).status).toBe(409); // different event id, head is no longer live
    live = { ok: true, open: true, headSha: HEAD_A };
    expect((await decide(goBody())).status).toBe(409); // a second GO for the same head
    expect(await rows()).toHaveLength(2);
  });

  it("keeps a NO-GO sticky for its head and requires a fresh GO for a new head", async () => {
    await enroll();
    const denied = await decide(noGoBody());
    expect(denied.status).toBe(201);
    expect(denied.body).toMatchObject({ verdict: "no_go", publication: { planned: { state: "failure" } } });
    expect((await decide(goBody())).status).toBe(409);

    live = { ok: true, open: true, headSha: HEAD_B };
    const next = await decide(goBody({ headSha: HEAD_B }));
    expect(next.body.verdict).toBe("go");
    const read = await request(app).get(`/api/issues/${issueId}/release-decisions`);
    expect(read.body.verdicts).toEqual({ [HEAD_A]: "no_go", [HEAD_B]: "go" });
  });

  it("rejects malformed decisions before touching the ledger", async () => {
    await enroll();
    expect((await decide(goBody({ evidenceDigest: undefined }))).status).toBe(400);
    expect((await decide(goBody({ ciRunIds: [] }))).status).toBe(400);
    expect((await decide(goBody({ headSha: "ABC" }))).status).toBe(400);
    expect((await decide({ ...noGoBody(), evidenceDigest: DIGEST })).status).toBe(400);
    expect(await rows()).toHaveLength(1);
  });

  it("only lets the database express shadow publication and head-bound decisions", async () => {
    await enroll();
    const [hold] = await rows();
    const insert = (cols: string) => db.execute(sql.raw(
      `insert into release_assurance_events (company_id, issue_id, event_id, kind, owner, repo, pull_request_number, reason, payload_digest, recorded_by_actor_type, recorded_by_actor_id${cols.split("|")[0]}) ` +
      `select company_id, issue_id, gen_random_uuid(), ${cols.split("|")[1]} from release_assurance_events where id = '${hold!.id}'`,
    ));
    await expect(insert(", publication_mode|'x', 'x', 1, 'r', 'd', 'user', 'u', 'live'")).rejects.toThrow();
    await expect(insert(", head_sha|'go', 'x', 'x', 1, 'r', 'd', 'user', 'u', '" + HEAD_A + "'")).rejects.toThrow(); // go without evidence
    await expect(insert(", head_sha|'no_go', 'x', 'x', 1, 'r', 'd', 'user', 'u', null")).rejects.toThrow(); // decision without head
  });
});
