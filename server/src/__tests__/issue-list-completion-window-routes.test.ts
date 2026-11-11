import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { issues } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import {
  describeEmbeddedPostgres,
  resetCompanyIssueFixtures,
  routeApp,
  seedCompanyWithBoardAccess,
  useEmbeddedPostgres,
} from "./helpers/route-test-harness.js";

/**
 * Completion-window census coverage for the company issue list route.
 *
 * A close-out census (`completedAfter`/`completedBefore`/`sortField=completed`)
 * must return every completed issue in the window — including plugin-operation
 * and routine-execution rows — without requiring unrelated filters, keep a
 * deterministic order across repeated reads, and hold exact inclusive bounds.
 * Ordinary reads keep the default plugin-operation drop, disclosed via a
 * response header, and unknown query parameters are rejected instead of
 * silently dropping to an unfiltered page.
 */

const PLUGIN_OPERATION_ORIGIN_KIND = "plugin:paperclip.missions:operation";

describeEmbeddedPostgres("issue list completion window", () => {
  const ctx = useEmbeddedPostgres("paperclip-issue-completion-window-", {
    resetEach: resetCompanyIssueFixtures,
  });

  async function seedCensusFixtures() {
    const company = await seedCompanyWithBoardAccess(ctx.db, "Completion window");
    const companyId = company.companyId;
    const earlyDoneId = randomUUID();
    const tieAId = randomUUID();
    const tieBId = randomUUID();
    const laterDoneId = randomUUID();
    const openId = randomUUID();
    const pluginDoneId = randomUUID();
    const routineDoneId = randomUUID();
    await ctx.db.insert(issues).values([
      {
        id: earlyDoneId,
        companyId,
        title: "Early done",
        status: "done",
        priority: "medium",
        completedAt: new Date("2026-07-01T10:00:00.000Z"),
      },
      {
        id: tieAId,
        companyId,
        title: "Tie A",
        status: "done",
        priority: "medium",
        completedAt: new Date("2026-07-02T10:00:00.000Z"),
      },
      {
        id: tieBId,
        companyId,
        title: "Tie B",
        status: "done",
        priority: "medium",
        completedAt: new Date("2026-07-02T10:00:00.000Z"),
      },
      {
        id: laterDoneId,
        companyId,
        title: "Later done",
        status: "done",
        priority: "medium",
        completedAt: new Date("2026-07-03T10:00:00.000Z"),
      },
      {
        id: openId,
        companyId,
        title: "Still open",
        status: "in_progress",
        priority: "medium",
      },
      {
        id: pluginDoneId,
        companyId,
        title: "Plugin operation done",
        status: "done",
        priority: "medium",
        originKind: PLUGIN_OPERATION_ORIGIN_KIND,
        completedAt: new Date("2026-07-02T12:00:00.000Z"),
      },
      {
        id: routineDoneId,
        companyId,
        title: "Routine execution done",
        status: "done",
        priority: "medium",
        originKind: "routine_execution",
        completedAt: new Date("2026-07-02T14:00:00.000Z"),
      },
    ]);
    return {
      app: () => routeApp(ctx.db, company.actor, issueRoutes),
      companyId,
      earlyDoneId,
      tieAId,
      tieBId,
      laterDoneId,
      openId,
      pluginDoneId,
      routineDoneId,
    };
  }

  it("sortField=completed orders ascending with deterministic id tie-break and nulls last", async () => {
    const f = await seedCensusFixtures();
    const res = await request(f.app())
      .get(`/api/companies/${f.companyId}/issues?sortField=completed&sortDir=asc&limit=100`)
      .expect(200);
    const ids = (res.body as { id: string }[]).map((issue) => issue.id);
    expect(ids).toEqual([
      f.earlyDoneId,
      ...[f.tieAId, f.tieBId].sort(),
      f.pluginDoneId,
      f.routineDoneId,
      f.laterDoneId,
      f.openId,
    ]);
  });

  it("sortField=completed orders descending with nulls last and is stable across repeated reads", async () => {
    const f = await seedCensusFixtures();
    const read = async () => {
      const res = await request(f.app())
        .get(`/api/companies/${f.companyId}/issues?sortField=completed&sortDir=desc&limit=100`)
        .expect(200);
      return (res.body as { id: string }[]).map((issue) => issue.id);
    };
    const first = await read();
    expect(first).toEqual([
      f.laterDoneId,
      f.routineDoneId,
      f.pluginDoneId,
      ...[f.tieAId, f.tieBId].sort().reverse(),
      f.earlyDoneId,
      f.openId,
    ]);
    expect(await read()).toEqual(first);
  });

  it("completion window returns plugin-operation and routine-execution rows without unrelated filters", async () => {
    const f = await seedCensusFixtures();
    const res = await request(f.app())
      .get(
        `/api/companies/${f.companyId}/issues?completedAfter=2026-07-02T00:00:00.000Z&completedBefore=2026-07-02T23:59:59.999Z&limit=100`,
      )
      .expect(200);
    const ids = (res.body as { id: string }[]).map((issue) => issue.id);
    expect(ids.sort()).toEqual(
      [f.tieAId, f.tieBId, f.pluginDoneId, f.routineDoneId].sort(),
    );
    expect(res.headers["x-paperclip-plugin-operations-excluded"]).toBeUndefined();
  });

  it("completion bounds are exact and inclusive", async () => {
    const f = await seedCensusFixtures();
    const res = await request(f.app())
      .get(
        `/api/companies/${f.companyId}/issues?completedAfter=2026-07-01T10:00:00.000Z&completedBefore=2026-07-01T10:00:00.000Z`,
      )
      .expect(200);
    expect((res.body as { id: string }[]).map((issue) => issue.id)).toEqual([
      f.earlyDoneId,
    ]);
  });

  it("completion window excludes rows outside the bounds", async () => {
    const f = await seedCensusFixtures();
    const res = await request(f.app())
      .get(
        `/api/companies/${f.companyId}/issues?completedBefore=2026-07-01T23:59:59.999Z&limit=100`,
      )
      .expect(200);
    expect((res.body as { id: string }[]).map((issue) => issue.id)).toEqual([
      f.earlyDoneId,
    ]);
  });

  it("ordinary reads still drop plugin-operation rows by default and disclose it via header", async () => {
    const f = await seedCensusFixtures();
    const res = await request(f.app())
      .get(`/api/companies/${f.companyId}/issues?limit=100`)
      .expect(200);
    const ids = (res.body as { id: string }[]).map((issue) => issue.id);
    expect(ids).not.toContain(f.pluginDoneId);
    expect(ids).toContain(f.routineDoneId);
    expect(res.headers["x-paperclip-plugin-operations-excluded"]).toBe("true");
  });

  it("sortField=completed alone counts as a census query and includes plugin-operation rows", async () => {
    const f = await seedCensusFixtures();
    const res = await request(f.app())
      .get(`/api/companies/${f.companyId}/issues?sortField=completed&limit=100`)
      .expect(200);
    const ids = (res.body as { id: string }[]).map((issue) => issue.id);
    expect(ids).toContain(f.pluginDoneId);
    expect(res.headers["x-paperclip-plugin-operations-excluded"]).toBeUndefined();
  });

  it("rejects a malformed completedAfter", async () => {
    const f = await seedCensusFixtures();
    const res = await request(f.app())
      .get(`/api/companies/${f.companyId}/issues?completedAfter=not-a-timestamp`)
      .expect(400);
    expect(res.body.error).toContain("completedAfter");
  });

  it("rejects a malformed completedBefore", async () => {
    const f = await seedCensusFixtures();
    const res = await request(f.app())
      .get(`/api/companies/${f.companyId}/issues?completedBefore=yesterday`)
      .expect(400);
    expect(res.body.error).toContain("completedBefore");
  });

  it("rejects an inverted completion window", async () => {
    const f = await seedCensusFixtures();
    const res = await request(f.app())
      .get(
        `/api/companies/${f.companyId}/issues?completedAfter=2026-07-03T00:00:00.000Z&completedBefore=2026-07-01T00:00:00.000Z`,
      )
      .expect(400);
    expect(res.body.error).toContain("completedAfter");
  });

  it("rejects an unknown query parameter instead of silently returning an unfiltered page", async () => {
    const f = await seedCensusFixtures();
    const res = await request(f.app())
      .get(`/api/companies/${f.companyId}/issues?completedAfer=2026-07-01T00:00:00.000Z`)
      .expect(400);
    expect(res.body.error).toContain("completedAfer");
    expect(res.body.error).toContain("unknown query parameter");
    expect(Array.isArray(res.body.supportedQueryParameters)).toBe(true);
  });

  it("rejects the historical snake_case close-window probe shapes and names the canonical parameters", async () => {
    const f = await seedCensusFixtures();
    for (const query of [
      "completed_after=2026-07-01T00:00:00.000Z&completed_before=2026-07-03T00:00:00.000Z",
      "sort=completed&order=desc",
    ]) {
      const res = await request(f.app())
        .get(`/api/companies/${f.companyId}/issues?${query}`)
        .expect(400);
      expect(res.body.error).toContain("unknown query parameter");
      expect(res.body.supportedQueryParameters).toEqual(
        expect.arrayContaining([
          "completedAfter",
          "completedBefore",
          "sortField",
          "sortDir",
        ]),
      );
    }
  });

  it("rejects sortField values outside the supported set", async () => {
    const f = await seedCensusFixtures();
    const res = await request(f.app())
      .get(`/api/companies/${f.companyId}/issues?sortField=completedd`)
      .expect(400);
    expect(res.body.error).toContain("sortField");
  });

  it("rejects completion window filters combined with attention=blocked instead of silently ignoring them", async () => {
    const f = await seedCensusFixtures();
    const res = await request(f.app())
      .get(
        `/api/companies/${f.companyId}/issues?attention=blocked&completedAfter=2026-07-01T00:00:00.000Z&completedBefore=2026-07-02T00:00:00.000Z`,
      )
      .expect(400);
    expect(res.body.error).toContain("attention=blocked");
    expect(res.body.error).toContain("completion window");
  });

  it("rejects sortField=completed combined with attention=blocked", async () => {
    const f = await seedCensusFixtures();
    const res = await request(f.app())
      .get(`/api/companies/${f.companyId}/issues?attention=blocked&sortField=completed`)
      .expect(400);
    expect(res.body.error).toContain("attention=blocked");
  });

  it("rejects a non-ISO completedAfter that Date parsing would accept", async () => {
    const f = await seedCensusFixtures();
    const res = await request(f.app())
      .get(`/api/companies/${f.companyId}/issues?completedAfter=July 1, 2026`)
      .expect(400);
    expect(res.body.error).toContain("completedAfter");
  });

  it("rejects a normalized calendar date such as February 30", async () => {
    const f = await seedCensusFixtures();
    const res = await request(f.app())
      .get(
        `/api/companies/${f.companyId}/issues?completedBefore=2026-02-30T00:00:00.000Z`,
      )
      .expect(400);
    expect(res.body.error).toContain("completedBefore");
  });

  it("accepts a strict ISO timestamp with a numeric UTC offset", async () => {
    const f = await seedCensusFixtures();
    const res = await request(f.app())
      .get(
        `/api/companies/${f.companyId}/issues?completedAfter=2026-07-02T05:30:00%2B05:30&completedBefore=2026-07-02T15:30:00%2B05:30`,
      )
      .expect(200);
    expect((res.body as { id: string }[]).map((issue) => issue.id).sort()).toEqual(
      [f.tieAId, f.tieBId].sort(),
    );
  });
});
