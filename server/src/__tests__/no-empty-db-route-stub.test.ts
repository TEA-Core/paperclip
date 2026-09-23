import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { makeRouteDbStub } from "./helpers/route-db-stub.js";

/**
 * Ratchet guard (SUP-17284): no new route suite may pass an empty object
 * literal as the db argument to a `*Routes(...)` factory.
 *
 * A suite that does so hands its routes a db that has no `select` surface at
 * all. The moment any PR adds a new `db` read to a shared route path, the
 * suite answers it with a bare 500:
 *
 *   - `TypeError: db.select is not a function`
 *     (`countLadderedChildren`, `done-transition-guard.ts`)
 *   - `TypeError: db.select is not a function`
 *     (`resolveSummaryGenerationReturnAssignee`, `summary-slots.ts`)
 *   - `TypeError: db.select(...).from(...).where(...).then is not a function`
 *     (same function, a stub whose `where()` returned a non-thenable)
 *
 * That is what cost three attempt-1 CI failures (runs 35782699852,
 * 35777871815, 34627265042) across two branches in ~2 weeks — each one also
 * mis-reported upstream as the fleet-wide `vi.doMock` mock-race regression
 * that PR #618 closed. SUP-17284 established these were the same
 * deterministic defect, not the mock race.
 *
 * New suites must use `makeRouteDbStub()` from `helpers/route-db-stub.ts`
 * (or a stub that mirrors its surface) instead of `{} as any` / `{} as never`.
 *
 * The 43 suites that already pass an empty object as the db argument are
 * frozen in the allowlist below. The allowlist is a ratchet: it may only
 * shrink. When a suite is migrated to a real stub, remove its entry here in
 * the same PR; never add one. Migrating the 43 was deliberately out of scope
 * for SUP-17288.
 *
 * Count note: SUP-17284's exposure census of 42 was line-based and missed one
 * multi-line offender — `plugin-scoped-api-routes.test.ts` passes its `{}` on
 * the line after `pluginRoutes(`. This guard's scanner handles the call across
 * lines, so its seed is the full current set of 43.
 *
 * Like `no-concurrent-module-imports.test.ts` this scanner is deliberately
 * text-based rather than AST-aware, so a commented-out offender still gets
 * caught. It matches `*Routes({}` — an empty object literal as the FIRST
 * argument of a call to a `*Routes` factory — so the shape is:
 *
 *   app.use("/api", issueRoutes({} as any, {} as any));
 *                              ^^^^^^^^ first argument, empty object
 *
 * and is independent of the cast (`as any`, `as never`, or none).
 */
const testsDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Frozen allowlist of the 43 pre-existing offenders, repo-relative paths.
 * Ratchet: may only shrink — one suite migrated, one entry removed, same PR.
 */
const ALLOWED_EMPTY_DB_SUITE_FILES: readonly string[] = [
  "server/src/__tests__/activity-routes.test.ts",
  "server/src/__tests__/adapter-auth-signal-routes.test.ts",
  "server/src/__tests__/adapter-model-refresh-routes.test.ts",
  "server/src/__tests__/agent-cross-tenant-authz-routes.test.ts",
  "server/src/__tests__/agent-device-login-routes.test.ts",
  "server/src/__tests__/agent-test-environment-routes.test.ts",
  "server/src/__tests__/artifact-review-document-routes.test.ts",
  "server/src/__tests__/assets.test.ts",
  "server/src/__tests__/base-repo-rescue-reset-route.test.ts",
  "server/src/__tests__/board-chat-route-feature-flag.test.ts",
  "server/src/__tests__/built-in-agent-routes.test.ts",
  "server/src/__tests__/companies-route-cross-company-authz.test.ts",
  "server/src/__tests__/companies-route-path-guard.test.ts",
  "server/src/__tests__/company-artifacts-service.test.ts",
  "server/src/__tests__/company-branding-route.test.ts",
  "server/src/__tests__/company-cloud-floor.test.ts",
  "server/src/__tests__/company-import-cloud-floor.test.ts",
  "server/src/__tests__/company-portability-routes.test.ts",
  "server/src/__tests__/company-search-extract-routes.test.ts",
  "server/src/__tests__/company-search-rate-limit-routes.test.ts",
  "server/src/__tests__/company-skills-routes.test.ts",
  "server/src/__tests__/dispatch-quiesce-routes.test.ts",
  "server/src/__tests__/document-annotation-routes.test.ts",
  "server/src/__tests__/environment-custom-image-routes.test.ts",
  "server/src/__tests__/environment-selection-route-guards.test.ts",
  "server/src/__tests__/folders-routes.test.ts",
  "server/src/__tests__/issue-agent-default-workspace-pair-routes.test.ts",
  "server/src/__tests__/issue-attachment-routes.test.ts",
  "server/src/__tests__/issue-feedback-routes.test.ts",
  "server/src/__tests__/llms-routes.test.ts",
  "server/src/__tests__/plugin-scoped-api-routes.test.ts",
  "server/src/__tests__/plugin-ui-static.test.ts",
  "server/src/__tests__/project-goal-telemetry-routes.test.ts",
  "server/src/__tests__/project-routes-env.test.ts",
  "server/src/__tests__/project-workspace-managed-sandbox-routes.test.ts",
  "server/src/__tests__/routine-document-annotation-routes.test.ts",
  "server/src/__tests__/routines-routes.test.ts",
  "server/src/__tests__/secrets-routes.test.ts",
  "server/src/__tests__/sidebar-preferences-routes.test.ts",
  "server/src/__tests__/summary-slot-routes.test.ts",
  "server/src/__tests__/teams-catalog-routes.test.ts",
  "server/src/__tests__/workspace-runtime-routes-authz.test.ts",
  "server/src/__tests__/write-path-membership.test.ts",
];

/**
 * A `*Routes(` factory call whose first argument is an empty object literal.
 * The `{` must sit at the first argument position, so `issueRoutes(db, {})`
 * and `issueRoutes(db)` do not match.
 */
const EMPTY_DB_ROUTE_CALL = /[A-Za-z_$][A-Za-z0-9_$]*Routes\(\s*\{\s*\}/g;

/** 1-based line numbers of every empty-db route-factory call in `source`. */
export function findEmptyDbRouteStubCalls(source: string): number[] {
  const lines: number[] = [];
  for (const match of source.matchAll(EMPTY_DB_ROUTE_CALL)) {
    lines.push(source.slice(0, match.index!).split("\n").length);
  }
  return lines;
}

describe("makeRouteDbStub resolves every read to []", () => {
  it("resolves every terminal builder link to []", async () => {
    const stub = makeRouteDbStub();
    await expect(stub.select().from()).resolves.toEqual([]);
    await expect(stub.select().from().where("eq")).resolves.toEqual([]);
    await expect(stub.select().from().where("eq").limit(1)).resolves.toEqual([]);
    await expect(stub.select().from().where("eq").orderBy("asc")).resolves.toEqual([]);
    await expect(stub.select().from().for("update")).resolves.toEqual([]);
  });

  it("resolves .then(rows => rows[0] ?? null) to null at every depth", async () => {
    const stub = makeRouteDbStub();
    const pickFirst = (rows: unknown[]) => rows[0] ?? null;
    await expect(stub.select().from().then(pickFirst)).resolves.toBeNull();
    await expect(stub.select().from().where("eq").then(pickFirst)).resolves.toBeNull();
    await expect(stub.select().from().where("eq").limit(1).then(pickFirst)).resolves.toBeNull();
    await expect(
      stub.select().from().where("eq").orderBy("asc").then(pickFirst),
    ).resolves.toBeNull();
  });

  it("hands the transaction callback the same stub surface", async () => {
    const stub = makeRouteDbStub();
    let sawRows: unknown;
    await stub.transaction(async (tx) => {
      sawRows = await tx.select().from();
    });
    expect(sawRows).toEqual([]);
  });
});

describe("no suite passes an empty object as the db argument", () => {
  // This file is excluded from its own scan: the doc comment above quotes the
  // banned shape verbatim, and the scanner is deliberately text-based rather
  // than comment-aware so that a commented-out offender still gets caught.
  const selfName = path.basename(fileURLToPath(import.meta.url));
  const testFiles = readdirSync(testsDir)
    .filter((name) => name.endsWith(".test.ts") && name !== selfName)
    .sort();

  it("pins the frozen allowlist at exactly 43 entries", () => {
    expect(ALLOWED_EMPTY_DB_SUITE_FILES).toHaveLength(43);
  });

  it("finds the server test files to scan", () => {
    expect(testFiles.length).toBeGreaterThan(300);
  });

  // The scanner is the whole guard, so its own matcher is worth pinning. These
  // fixtures are strings rather than files so the shapes stay readable and this
  // file does not have to contain the pattern it bans at statement position.
  it("matches every empty-db stub shape, and nothing else", () => {
    // Offenders: the cast is irrelevant, whitespace is irrelevant, and the
    // empty object may sit on a later line.
    expect(findEmptyDbRouteStubCalls("app.use('/api', issueRoutes({} as any, db));")).toEqual([
      1,
    ]);
    expect(findEmptyDbRouteStubCalls("app.use('/api', agentRoutes({} as never));")).toEqual([
      1,
    ]);
    expect(findEmptyDbRouteStubCalls("const r = companyRoutes({} , db);")).toEqual([1]);
    expect(
      findEmptyDbRouteStubCalls("app.use('/api',\n  issueRoutes({}\n    as any, db));"),
    ).toEqual([2]);
    // Reports the line the call starts on, and finds more than one per file.
    expect(findEmptyDbRouteStubCalls("a\nissueRoutes({} as any);")).toEqual([2]);
    expect(
      findEmptyDbRouteStubCalls("issueRoutes({} as any);\ncompanyRoutes({} as never);"),
    ).toEqual([1, 2]);

    // Not offenders: a non-empty object, a variable in the db position, no
    // argument at all, and a factory name that does not end in `Routes`.
    expect(findEmptyDbRouteStubCalls("issueRoutes(db, {} as any);")).toEqual([]);
    expect(findEmptyDbRouteStubCalls("issueRoutes(db);")).toEqual([]);
    expect(findEmptyDbRouteStubCalls("issueRoutes();")).toEqual([]);
    expect(findEmptyDbRouteStubCalls("mount(issue({} as any));")).toEqual([]);
  });

  it("has no suite outside the allowlist passing an empty db object", () => {
    const allowed = new Set(ALLOWED_EMPTY_DB_SUITE_FILES);
    const offenders: string[] = [];
    for (const name of testFiles) {
      const repoPath = `server/src/__tests__/${name}`;
      if (allowed.has(repoPath)) continue;
      const source = readFileSync(path.join(testsDir, name), "utf-8");
      for (const line of findEmptyDbRouteStubCalls(source)) {
        offenders.push(`${repoPath}:${line}`);
      }
    }
    expect(
      offenders,
      "These suites pass an empty object literal as the db argument to a "
        + "`*Routes(...)` factory, so a new `db` read on a shared route path "
        + "answers a bare 500 (SUP-17284). Use `makeRouteDbStub()` from "
        + "`helpers/route-db-stub.ts` instead. The frozen allowlist at the top "
        + "of this file is a ratchet that may only shrink: migrate the suite, "
        + "then remove its entry in the same PR.",
    ).toEqual([]);
  });
});
