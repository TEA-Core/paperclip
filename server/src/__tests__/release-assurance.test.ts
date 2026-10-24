import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  issues,
  executionWorkspaces,
  projects,
  projectWorkspaces,
  releaseAssuranceEvents,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { HttpError } from "../errors.js";
import { companyService } from "../services/companies.js";
import { issueService } from "../services/issues.js";
import { releaseDecisionRoutes } from "../routes/release-decisions.js";
import { appTokenCache } from "../services/github-credential.js";
import { releaseAssuranceDeps, type LivePullRequest } from "../services/release-assurance.js";

const mockGhFetch = vi.hoisted(() => vi.fn());
const mockGetByName = vi.hoisted(() => vi.fn());
const mockResolveSecretValue = vi.hoisted(() => vi.fn());
vi.mock("../services/github-fetch.js", () => ({
  ghFetch: mockGhFetch,
  gitHubApiBase: () => "https://api.github.com",
}));
// The shadow live read must never touch a secret: resolving one stamps company_secrets.
vi.mock("../services/secrets.js", () => ({
  secretService: () => ({ getByName: mockGetByName, resolveSecretValue: mockResolveSecretValue }),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

const USER_ID = "board-user-1";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const DIGEST = "c".repeat(64);
const PR = { owner: "TEA-Core", repo: "paperclip", number: 4242, branch: "SUP-1-delivery" };
// A live PR that is exactly the card's delivery: same head branch, in the same repository.
const livePr = (over: Partial<Extract<LivePullRequest, { ok: true }>> = {}): LivePullRequest => ({
  ok: true, open: true, draft: false, headSha: HEAD_A, branch: PR.branch, headRepo: "TEA-Core/paperclip", ...over,
});

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
  let delivery: { owner: string; repo: string; number: number; branch: string } | null;
  // Lets a test change the recorded delivery between calls to model a read-to-append race.
  let deliverySequence: Array<typeof delivery> = [];
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
      recordedDelivery: async () => (deliverySequence.length ? deliverySequence.shift()! : delivery),
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
    mockGetByName.mockReset();
    mockResolveSecretValue.mockReset();
    appTokenCache.clear();
    await resetLedger();
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
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
    delivery = PR;
    deliverySequence = [];
    live = livePr({ open: true, draft: false, headSha: HEAD_A });
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
  // The append-only trigger rejects DELETE for every role. Clearing the table between tests is
  // the governed repair path: the owner disables the trigger for the repair and re-enables it.
  const resetLedger = () =>
    db.transaction(async (tx) => {
      await tx.execute(sql.raw("alter table release_assurance_events disable trigger release_assurance_events_append_only"));
      await tx.delete(releaseAssuranceEvents);
      await tx.execute(sql.raw("alter table release_assurance_events enable trigger release_assurance_events_append_only"));
    });
  // Walks the driver error chain for the Postgres SQLSTATE and violated constraint.
  const pgError = async (promise: PromiseLike<unknown>) => {
    let error: any = await Promise.resolve(promise).then(() => null, (err) => err);
    expect(error).not.toBeNull();
    for (let depth = 0; depth < 4 && error && !error.code; depth += 1) error = error.cause;
    return { code: error?.code as string | undefined, constraint: (error?.constraint ?? error?.constraint_name) as string | undefined, message: String(error?.message ?? "") };
  };

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

  it("refuses an enrollment for a PR that is not the card's recorded delivery, or a seat outside the company", async () => {
    delivery = null;
    expect((await enroll()).status).toBe(409);
    delivery = { ...PR, number: PR.number + 1 };
    expect((await enroll()).status).toBe(409);
    delivery = { ...PR, repo: "unrelated" };
    expect((await enroll()).status).toBe(409);
    delivery = PR;
    expect((await enroll(enrollBody({ raAgentId: randomUUID() }))).status).toBe(409);
    expect(await rows()).toHaveLength(0);
  });

  it("refuses to enroll a closed, merged or draft PR, and fails closed when the PR state is unreadable", async () => {
    live = livePr({ open: false, draft: false, headSha: HEAD_A });
    expect((await enroll()).status).toBe(409);
    live = livePr({ open: true, draft: true, headSha: HEAD_A });
    expect((await enroll()).status).toBe(409);
    live = { ok: false, message: "no warm credential" };
    expect((await enroll()).status).toBe(409);
    expect(await rows()).toHaveLength(0);
    live = livePr({ open: true, draft: false, headSha: HEAD_A });
    expect((await enroll()).status).toBe(201);
  });

  it("rechecks the recorded delivery inside the issue lock: a delivery that changes during enrollment records nothing", async () => {
    deliverySequence = [PR, { ...PR, number: PR.number + 1 }];
    expect((await enroll()).status).toBe(409);
    expect(await rows()).toHaveLength(0);
  });

  it("refuses to enroll a live PR whose head branch or head repository is not the card's recorded delivery", async () => {
    for (const mismatch of [
      livePr({ branch: "UNRELATED-branch" }),
      livePr({ branch: null }),
      livePr({ headRepo: "someone-else/paperclip" }),
      livePr({ headRepo: null }),
    ]) {
      live = mismatch;
      expect((await enroll()).status).toBe(409);
    }
    expect(await rows()).toHaveLength(0);
    // Git refs are case-sensitive: a branch that differs only in case is a different branch, here at another commit.
    live = livePr({ branch: PR.branch.toLowerCase(), headSha: HEAD_B });
    expect(PR.branch.toLowerCase()).not.toBe(PR.branch);
    expect((await enroll()).status).toBe(409);
    live = livePr({ branch: PR.branch.toUpperCase() });
    expect((await enroll()).status).toBe(409);
    expect(await rows()).toHaveLength(0);
    // Repository names are case-insensitive on GitHub, so only the repository comparison ignores case.
    live = livePr({ headRepo: "tea-core/PAPERCLIP" });
    expect((await enroll()).status).toBe(201);
  });

  it("refuses a GO whose live PR head branch is not the recorded delivery branch, but still records a NO-GO", async () => {
    await enroll();
    live = livePr({ branch: "UNRELATED-branch" });
    expect((await decide(goBody())).status).toBe(409);
    live = livePr({ headRepo: null });
    expect((await decide(goBody())).status).toBe(409);
    live = livePr({ branch: PR.branch.toLowerCase(), headSha: HEAD_B }); // case-distinct branch at another commit
    expect((await decide(goBody({ headSha: HEAD_B }))).status).toBe(409);
    live = livePr({ branch: PR.branch.toUpperCase() });
    expect((await decide(goBody())).status).toBe(409);
    expect((await rows()).map((row) => row.kind)).toEqual(["hold"]);
    live = livePr();
    expect((await decide(noGoBody())).status).toBe(201);
  });

  it("refuses a GO when the card's recorded delivery no longer matches the enrolled PR, but still records a NO-GO veto", async () => {
    await enroll();
    delivery = { ...PR, number: PR.number + 1 };
    expect((await decide(goBody())).status).toBe(409);
    expect((await rows()).map((row) => row.kind)).toEqual(["hold"]);
    expect((await decide(noGoBody())).status).toBe(201);
  });

  it("never grants a GO on a draft PR, but still records a NO-GO", async () => {
    await enroll();
    live = livePr({ open: true, draft: true, headSha: HEAD_A });
    expect((await decide(goBody())).status).toBe(409);
    const denied = await decide(noGoBody());
    expect(denied.status).toBe(201);
    expect(denied.body.verdict).toBe("no_go");
  });

  it("replays an identical enrollment from the ledger after the delivery record or seat changed", async () => {
    const body = enrollBody();
    const first = await enroll(body);
    delivery = null;
    await db.delete(agents).where(eq(agents.id, raAgentId));
    const replay = await enroll(body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, event: { id: first.body.event.id } });
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
    live = livePr({ open: true, draft: false, headSha: HEAD_B });
    const stale = await decide(goBody());
    expect(stale.status).toBe(409);
    expect(stale.body.details).toMatchObject({ liveHeadSha: HEAD_B });
    expect((await decide(noGoBody())).status).toBe(409);
    live = { ok: false, message: "boom" };
    expect((await decide(goBody())).status).toBe(409);
    live = livePr({ open: false, draft: false, headSha: HEAD_A });
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
    live = livePr({ open: true, draft: false, headSha: HEAD_B });
    const replay = await decide(body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, event: { id: first.body.event.id } });
    expect((await decide({ ...body, reason: "changed" })).status).toBe(409);
    expect((await decide(goBody())).status).toBe(409); // different event id, head is no longer live
    live = livePr({ open: true, draft: false, headSha: HEAD_A });
    expect((await decide(goBody())).status).toBe(409); // a second GO for the same head
    expect(await rows()).toHaveLength(2);
  });

  it("keeps a NO-GO sticky for its head and requires a fresh GO for a new head", async () => {
    await enroll();
    const denied = await decide(noGoBody());
    expect(denied.status).toBe(201);
    expect(denied.body).toMatchObject({ verdict: "no_go", publication: { planned: { state: "failure" } } });
    expect((await decide(goBody())).status).toBe(409);

    live = livePr({ open: true, draft: false, headSha: HEAD_B });
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

  it("survives issue deletion: the delete is refused with a 409 and every ledger row stays", async () => {
    await enroll();
    await decide(goBody());
    const error = await issueService(db).remove(issueId).catch((err) => err);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 409 });
    expect(await rows()).toHaveLength(2);
    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId))).toHaveLength(1);
  });

  it("survives company deletion: the delete is refused with a 409 and the company and ledger stay", async () => {
    await enroll();
    await decide(noGoBody());
    const error = await companyService(db).remove(companyId).catch((err) => err);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 409 });
    expect(await rows()).toHaveLength(2);
    expect(await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId))).toHaveLength(1);
  });

  it("keeps the enrolled RA seat identity in the record after the agent row is deleted", async () => {
    await enroll();
    await db.delete(agents).where(eq(agents.id, raAgentId));
    const [hold] = await rows();
    expect(hold).toMatchObject({ kind: "hold", raAgentId });
  });

  it("deletes a card that was never enrolled", async () => {
    await issueService(db).remove(issueId);
    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId))).toHaveLength(0);
  });

  const rawInsert = (over: Partial<Record<"kind" | "head" | "evidence" | "ci" | "mode" | "companyId" | "issueId", string | null>> = {}) => {
    const v = { kind: "no_go", head: HEAD_A, evidence: null, ci: null, mode: "shadow", companyId, issueId, ...over };
    return db.execute(sql`insert into release_assurance_events
      (company_id, issue_id, event_id, kind, owner, repo, pull_request_number, head_sha, evidence_digest, ci_run_ids,
       reason, payload_digest, recorded_by_actor_type, recorded_by_actor_id, publication_mode)
      values (${v.companyId}, ${v.issueId}, ${randomUUID()}, ${v.kind}, 'o', 'r', 1, ${v.head}, ${v.evidence}, ${v.ci}::jsonb,
       'r', 'd', 'user', 'u', ${v.mode})`);
  };

  it("lets the database express only shadow publication and head-bound decisions, each rejected by its own CHECK", async () => {
    await rawInsert(); // control: the statement shape is valid, so a rejection below is the constraint
    expect(await rows()).toHaveLength(1);
    await resetLedger();
    expect((await pgError(rawInsert({ mode: "live" }))).constraint).toBe("release_assurance_events_publication_mode_check");
    expect((await pgError(rawInsert({ kind: "go" }))).constraint).toBe("release_assurance_events_go_evidence_check");
    expect((await pgError(rawInsert({ head: null }))).constraint).toBe("release_assurance_events_head_binding_check");
    expect(await rows()).toHaveLength(0);
  });

  it("binds the issue to its company: a ledger row cannot pair an issue with another company", async () => {
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other Co", issuePrefix: "OTH", requireBoardApprovalForNewAgents: false });
    const error = await pgError(rawInsert({ companyId: otherCompanyId }));
    expect(error).toMatchObject({ code: "23503", constraint: "release_assurance_events_company_issue_fk" });
    expect(await rows()).toHaveLength(0);
  });

  it("is append-only for the real serving role: UPDATE, DELETE and TRUNCATE are refused", async () => {
    await enroll();
    await decide(noGoBody());
    const asServing = (statement: string) =>
      db.transaction(async (tx) => {
        await tx.execute(sql.raw("set local role paperclip_serving"));
        return tx.execute(sql.raw(statement));
      });
    const update = await pgError(asServing("update release_assurance_events set kind = 'go', evidence_digest = repeat('b', 64), ci_run_ids = '[1]'::jsonb where kind = 'no_go'"));
    const remove = await pgError(asServing("delete from release_assurance_events"));
    const truncate = await pgError(asServing("truncate release_assurance_events"));
    expect([update.code, remove.code, truncate.code]).toEqual(["42501", "42501", "42501"]);
    expect((await rows()).map((row) => row.kind)).toEqual(["hold", "no_go"]);
    // The serving role can still do the one thing it needs: append.
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw("set local role paperclip_serving"));
      await tx.execute(sql`insert into release_assurance_events (company_id, issue_id, event_id, kind, owner, repo, pull_request_number, head_sha, reason, payload_digest, recorded_by_actor_type, recorded_by_actor_id)
        values (${companyId}, ${issueId}, ${randomUUID()}, 'no_go', 'o', 'r', 1, ${HEAD_B}, 'r', 'd', 'user', 'u')`);
    });
    expect(await rows()).toHaveLength(3);
  });

  it("rejects UPDATE and DELETE for the owner too; only a trigger-disabling repair can remove rows", async () => {
    await enroll();
    await decide(noGoBody());
    const update = await pgError(db.execute(sql.raw("update release_assurance_events set reason = 'rewritten'")));
    const remove = await pgError(db.execute(sql.raw("delete from release_assurance_events where kind = 'no_go'")));
    expect([update.code, remove.code]).toEqual(["55000", "55000"]);
    expect(update.message).toContain("append-only");
    // The veto survives: the same head still refuses a GO.
    expect((await decide(goBody())).status).toBe(409);
    expect(await rows()).toHaveLength(2);
    await resetLedger(); // deliberate repair path
    expect(await rows()).toHaveLength(0);
    await enroll();
    expect((await pgError(db.execute(sql.raw("delete from release_assurance_events")))).code).toBe("55000"); // protection restored
  });

  it("does not map an unrelated foreign-key failure on company delete to the release-assurance 409", async () => {
    const { isForeignKeyViolation } = await import("../db-errors.js");
    const error = { code: "23503", message: "violates foreign key constraint \"inbox_dismissals_company_id_companies_id_fk\"", constraint: "inbox_dismissals_company_id_companies_id_fk" };
    expect(isForeignKeyViolation(error)).toBe(true);
    expect(isForeignKeyViolation(error, "release_assurance_events_")).toBe(false);
    expect(isForeignKeyViolation({ cause: { ...error, constraint: "release_assurance_events_company_issue_fk" } }, "release_assurance_events_")).toBe(true);
  });

  describe("shadow mode makes zero external writes (default dependencies)", () => {
    const target = { owner: "TEA-Core", repo: "paperclip", number: 4242 };
    const globalFetch = vi.fn();
    beforeEach(() => {
      globalFetch.mockReset();
      vi.stubGlobal("fetch", globalFetch);
    });
    afterAll(() => vi.unstubAllGlobals());

    it("refuses with a cold credential cache: no secret read, no token mint, no GitHub call, no secret mutation", async () => {
      const before = await db.execute(sql.raw("select id, updated_at, last_resolved_at from company_secrets order by id"));
      const live = await releaseAssuranceDeps(db).readLivePullRequest(companyId, target);
      expect(live).toMatchObject({ ok: false });
      expect(mockGetByName).not.toHaveBeenCalled();
      expect(mockResolveSecretValue).not.toHaveBeenCalled();
      expect(globalFetch).not.toHaveBeenCalled();
      expect(mockGhFetch).not.toHaveBeenCalled();
      expect(Array.from(await db.execute(sql.raw("select id, updated_at, last_resolved_at from company_secrets order by id")))).toEqual(Array.from(before));
    });

    it("reads the PR with an already-warm cached App token only, using one GET", async () => {
      appTokenCache.set(`${companyId}:4595159:tea-core:paperclip:`, { token: "warm-token", installationId: "1", expiresAt: Date.now() + 60 * 60 * 1000 });
      mockGhFetch.mockResolvedValue(new Response(JSON.stringify({ state: "open", merged: false, head: { sha: HEAD_A.toUpperCase(), ref: PR.branch, repo: { full_name: "TEA-Core/paperclip" } } }), { status: 200 }));
      const live = await releaseAssuranceDeps(db).readLivePullRequest(companyId, target);
      expect(live).toEqual(livePr());
      expect(mockGhFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockGhFetch.mock.calls[0]!;
      expect(url).toBe("https://api.github.com/repos/TEA-Core/paperclip/pulls/4242");
      expect(init.method ?? "GET").toBe("GET");
      expect(init.headers.authorization).toBe("Bearer warm-token");
      expect(mockGetByName).not.toHaveBeenCalled();
      expect(mockResolveSecretValue).not.toHaveBeenCalled();
      expect(globalFetch).not.toHaveBeenCalled();
    });

    it("never reuses an expired cached token", async () => {
      appTokenCache.set(`${companyId}:4595159:tea-core:paperclip:`, { token: "old", installationId: "1", expiresAt: Date.now() + 60_000 });
      expect(await releaseAssuranceDeps(db).readLivePullRequest(companyId, target)).toMatchObject({ ok: false });
      expect(mockGhFetch).not.toHaveBeenCalled();
    });
  });

  describe("binds enrollment to the card's authoritative recorded delivery (default dependencies)", () => {
    const BRANCH = "SUP-1-delivery";
    const record = (over: Record<string, unknown> = {}) => ({
      delivery: {
        branch: BRANCH, headSha: HEAD_A, prNumber: 4242, prUrl: "https://github.com/TEA-Core/paperclip/pull/4242",
        repo: { owner: "TEA-Core", repo: "paperclip" }, ...over,
      },
    });
    async function seedDeliveryCard(executionState: Record<string, unknown> | null, repoUrl = "https://github.com/TEA-Core/paperclip", branch = BRANCH) {
      const projectId = randomUUID();
      const projectWorkspaceId = randomUUID();
      const executionWorkspaceId = randomUUID();
      await db.insert(projects).values({ id: projectId, companyId, name: "paperclip", status: "in_progress" });
      await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId, projectId, name: "Primary", cwd: "/tmp/test", repoUrl, isPrimary: true });
      await db.insert(executionWorkspaces).values({ id: executionWorkspaceId, companyId, projectId, mode: "isolated", strategyType: "git_worktree", name: "card", status: "active", branchName: branch, repoUrl });
      await db.update(issues).set({ projectId, projectWorkspaceId, executionWorkspaceId, executionState }).where(eq(issues.id, issueId));
      return { projectWorkspaceId, executionWorkspaceId };
    }
    const resolve = () => releaseAssuranceDeps(db).recordedDelivery(db, companyId, issueId);

    it("returns repository, branch and PR number from the recorded delivery", async () => {
      await seedDeliveryCard(record());
      expect(await resolve()).toEqual({ owner: "TEA-Core", repo: "paperclip", number: 4242, branch: BRANCH });
    });

    it("returns nothing for a card without a recorded delivery, however many PRs it mentions", async () => {
      await seedDeliveryCard(null);
      expect(await resolve()).toBeNull();
      await db.update(issues).set({ description: "see https://github.com/foreign/unrelated/pull/99 and https://github.com/TEA-Core/paperclip/pull/4242" }).where(eq(issues.id, issueId));
      expect(await resolve()).toBeNull();
    });

    it("does not follow the workspace repository after the delivery was recorded", async () => {
      const { projectWorkspaceId, executionWorkspaceId } = await seedDeliveryCard(record());
      await db.update(projectWorkspaces).set({ repoUrl: "https://github.com/foreign/unrelated" }).where(eq(projectWorkspaces.id, projectWorkspaceId));
      await db.update(executionWorkspaces).set({ repoUrl: "https://github.com/foreign/unrelated" }).where(eq(executionWorkspaces.id, executionWorkspaceId));
      expect(await resolve()).toBeNull();
    });

    it("refuses a recorded repository, branch, PR url or head that is missing or inconsistent", async () => {
      await seedDeliveryCard(record({ repo: { owner: "foreign", repo: "unrelated" } }));
      expect(await resolve()).toBeNull();
      for (const over of [
        { branch: "someone-elses-branch" },
        { prUrl: "https://github.com/TEA-Core/paperclip/pull/99" },
        { prUrl: "https://github.com/foreign/unrelated/pull/4242" },
        { headSha: undefined },
        { prNumber: undefined },
        { repo: undefined },
      ]) {
        await db.update(issues).set({ executionState: record(over) }).where(eq(issues.id, issueId));
        expect(await resolve()).toBeNull();
      }
      await db.update(issues).set({ executionState: record() }).where(eq(issues.id, issueId));
      expect(await resolve()).toMatchObject({ number: 4242 });
    });

    it("resolves only github.com repositories, even when a recorded GitHub PR url names the same owner and repo", async () => {
      // The scout's probe: both workspaces point at a non-GitHub host, the recorded repo and PR url say github.com.
      await seedDeliveryCard(record(), "https://gitlab.example.com/TEA-Core/paperclip");
      expect(await resolve()).toBeNull();
      await seedDeliveryCard(record(), "https://github.example.com/TEA-Core/paperclip");
      expect(await resolve()).toBeNull();
    });

    it("matches the recorded branch and the card's workspace branch exactly, in both directions", async () => {
      // Git refs are case-sensitive: `Feature/X` is not `feature/x`, whichever side carries the alias.
      for (const [recorded, workspace] of [["Feature/X", "feature/x"], ["feature/x", "Feature/X"]] as const) {
        await seedDeliveryCard(record({ branch: recorded }), "https://github.com/TEA-Core/paperclip", workspace);
        expect(await resolve()).toBeNull();
        await db.update(issues).set({ projectId: null, projectWorkspaceId: null, executionWorkspaceId: null, executionState: null }).where(eq(issues.id, issueId));
        await db.delete(executionWorkspaces);
        await db.delete(projectWorkspaces);
        await db.delete(projects);
      }
      await seedDeliveryCard(record({ branch: "Feature/X" }), "https://github.com/TEA-Core/paperclip", "Feature/X");
      expect(await resolve()).toMatchObject({ branch: "Feature/X" });
    });

    it("refuses hold and go for a case-distinct recorded branch even when the live ref carries the same alias", async () => {
      const realApp = express();
      realApp.use(express.json());
      realApp.use((req, _res, next) => { req.actor = actor; next(); });
      realApp.use("/api", releaseDecisionRoutes(db, { ...releaseAssuranceDeps(db), readLivePullRequest: async () => live }));
      realApp.use(errorHandler);
      const hold = (body = enrollBody()) => request(realApp).post(`/api/issues/${issueId}/release-assurance/enroll`).send(body);
      const go = (body = goBody()) => request(realApp).post(`/api/issues/${issueId}/release-decisions`).send(body);

      // The card's workspace is `feature/x`; the stored record and the live PR both say `Feature/X`.
      const { executionWorkspaceId } = await seedDeliveryCard(record({ branch: "Feature/X" }), "https://github.com/TEA-Core/paperclip", "feature/x");
      live = livePr({ branch: "Feature/X" });
      expect((await hold()).status).toBe(409);
      expect(await rows()).toHaveLength(0);

      // Exact record: enrolls. Then a workspace-only case change before the GO is refused too.
      await db.update(executionWorkspaces).set({ branchName: "Feature/X" }).where(eq(executionWorkspaces.id, executionWorkspaceId));
      expect((await hold()).status).toBe(201);
      await db.update(executionWorkspaces).set({ branchName: "feature/x" }).where(eq(executionWorkspaces.id, executionWorkspaceId));
      expect((await go()).status).toBe(409);
      expect((await rows()).map((r) => r.kind)).toEqual(["hold"]);
    });

    it("refuses a non-GitHub project repository", async () => {
      await seedDeliveryCard(record({ repo: { owner: "a", repo: "b" }, prUrl: "https://gitlab.example.com/a/b/-/merge_requests/4242" }), "https://gitlab.example.com/a/b");
      expect(await resolve()).toBeNull();
    });
  });

  describe("shadow live read of the PR state (default dependencies)", () => {
    it("reports draft and open state from the warm-cache read and never contacts anything cold", async () => {
      const target = { owner: "TEA-Core", repo: "paperclip", number: 4242 };
      expect(await releaseAssuranceDeps(db).readLivePullRequest(companyId, target)).toMatchObject({ ok: false });
      expect(mockGhFetch).not.toHaveBeenCalled();
      appTokenCache.set(`${companyId}:4595159:tea-core:paperclip:`, { token: "warm", installationId: "1", expiresAt: Date.now() + 3_600_000 });
      mockGhFetch.mockResolvedValue(new Response(JSON.stringify({ state: "open", merged: false, draft: true, head: { sha: HEAD_A, ref: PR.branch, repo: { full_name: "TEA-Core/paperclip" } } }), { status: 200 }));
      expect(await releaseAssuranceDeps(db).readLivePullRequest(companyId, target)).toEqual(livePr({ draft: true }));
      mockGhFetch.mockResolvedValue(new Response(JSON.stringify({ state: "open", merged: false, head: { sha: HEAD_A, repo: null } }), { status: 200 }));
      expect(await releaseAssuranceDeps(db).readLivePullRequest(companyId, target)).toEqual(livePr({ branch: null, headRepo: null }));
    });
  });
});
