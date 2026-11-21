import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { agents, companies, createDb, heartbeatRuns, issues, issueRecoveryActions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { conversationRecoveryActionPredicate, getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { runBoundToIssueId } from "./execution-identity.js";
import { deliverExecutionStatuses } from "./execution-status-delivery.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping execution identity regressions: ${support.reason}`);

type Fixture = { companyId: string; agentId: string; issueId: string; otherIssueId: string };

describePostgres("execution identity query contracts", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("execution-identity-");
    db = createDb(database.connectionString);
  }, 20_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  async function fixture(): Promise<Fixture> {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), otherIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Identity", issuePrefix: `I${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "codex_local" });
    await db.insert(issues).values([{ id: issueId, companyId, title: "Target" }, { id: otherIssueId, companyId, title: "Other" }]);
    return { companyId, agentId, issueId, otherIssueId };
  }
  async function run(f: Fixture, context: Record<string, unknown> | null, nativeIssueId: string | null = null, pid: number | null = null) {
    const [row] = await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: f.agentId, nativeIssueId, status: "interrupted", runtimeMode: "legacy",
      contextSnapshot: context, processPid: pid,
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
    }).returning();
    return row;
  }

  /** The predicate the card GET shipped with before it was split into indexable arms. */
  const legacyCoalesceForm = (issueId: string) =>
    sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issueId}`;

  async function idsMatching(f: Fixture, predicate: SQL) {
    const rows = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, f.companyId), predicate));
    return rows.map((row) => row.id).sort();
  }

  /** Captures the statement the service issues without executing it. */
  async function captureOwnershipQuery(f: Fixture, issueId: string) {
    let captured: { sql: string; params: unknown[] } | undefined;
    const stop = new Error("captured");
    const proxy = new Proxy(db, {
      get(target, key) {
        if (key !== "select") return Reflect.get(target, key);
        return (...fields: Parameters<Db["select"]>) => {
          const builder = target.select(...fields);
          const from = builder.from.bind(builder);
          builder.from = ((...args: Parameters<typeof from>) => {
            const selection = from(...args);
            selection.execute = async () => {
              captured = selection.toSQL();
              throw stop;
            };
            return selection;
          }) as typeof builder.from;
          return builder;
        };
      },
    });
    await getConversationOwnershipBlocker(proxy, f.companyId, issueId).catch((error) => {
      if (error !== stop) throw error;
    });
    expect(captured).toBeDefined();
    return captured!;
  }

  it("selects exactly the same runs as the old coalesce form for every identity case", async () => {
    const f = await fixture(), foreign = await fixture();
    const expected = {
      nativeAndContextMatch: await run(f, { issueId: f.issueId }, f.issueId),
      nativeMatchContextOther: await run(f, { issueId: f.otherIssueId }, f.issueId),
      nativeMatchNoContext: await run(f, null, f.issueId),
      nativeOtherContextMatch: await run(f, { issueId: f.issueId }, f.otherIssueId),
      nullNativeContextMatch: await run(f, { issueId: f.issueId }),
      nullNativeContextOther: await run(f, { issueId: f.otherIssueId }),
      nullNativeNoContext: await run(f, null),
      nullNativeEmptyContext: await run(f, {}),
      nullNativeUppercaseContext: await run(f, { issueId: f.issueId.toUpperCase() }),
      nullNativeMalformedContext: await run(f, { issueId: "bad" }),
      nullNativeEmptyStringContext: await run(f, { issueId: "" }),
      nullNativeNumericContext: await run(f, { issueId: 42 }),
      nullNativeArrayContext: await run(f, { issueId: [f.issueId] }),
      nullNativeBracedContext: await run(f, { issueId: `{${f.issueId}}` }),
      nullNativeUndashedContext: await run(f, { issueId: f.issueId.replaceAll("-", "") }),
      foreignCompanyRun: await run(foreign, { issueId: f.issueId }, f.issueId),
    };
    const probes = [
      f.issueId, f.otherIssueId, f.issueId.toUpperCase(), randomUUID(), "bad", "", " ", "42",
      `{${f.issueId}}`, f.issueId.replaceAll("-", ""), ` ${f.issueId}`, `${f.issueId}\n`,
    ];
    for (const probe of probes) {
      const before = await idsMatching(f, legacyCoalesceForm(probe));
      const after = await idsMatching(f, runBoundToIssueId(probe));
      expect(after, `probe ${JSON.stringify(probe)}`).toEqual(before);
    }
    // The probes above must not be vacuous: pin what each interesting case selects.
    const owned = await idsMatching(f, runBoundToIssueId(f.issueId));
    expect(owned).toEqual([
      expected.nativeAndContextMatch.id,
      expected.nativeMatchContextOther.id,
      expected.nativeMatchNoContext.id,
      expected.nullNativeContextMatch.id,
    ].sort());
    expect(await idsMatching(f, runBoundToIssueId("bad"))).toEqual([expected.nullNativeMalformedContext.id]);
    expect(await idsMatching(f, runBoundToIssueId(f.issueId.toUpperCase()))).toEqual([expected.nullNativeUppercaseContext.id]);
  });

  it("does not throw on a non-uuid issue id and keeps the legacy-context match", async () => {
    const f = await fixture();
    const malformed = await run(f, { issueId: "bad" }, null, process.pid);
    expect(await getConversationOwnershipBlocker(db, f.companyId, "bad")).toMatchObject({ runId: malformed.id });
    expect(await getConversationOwnershipBlocker(db, f.companyId, "")).toBeNull();
    expect(await getConversationOwnershipBlocker(db, f.companyId, "not-a-uuid-at-all")).toBeNull();
  });

  it("preserves native issue precedence and does not broaden legacy spellings", async () => {
    const f = await fixture();
    await run(f, { issueId: f.issueId }, f.otherIssueId, process.pid);
    const uppercase = await run(f, { issueId: f.issueId.toUpperCase() }, null, process.pid);
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toBeNull();
    const native = await run(f, { issueId: f.otherIssueId }, f.issueId, process.pid);
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: native.id, cause: "execution_owner_active" });
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId.toUpperCase())).toMatchObject({ runId: uppercase.id });
  });

  it("retains legacy ownership holds and releases only after ownership ends", async () => {
    const f = await fixture();
    const legacy = await run(f, { issueId: f.issueId }, null, process.pid);
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toMatchObject({ runId: legacy.id });
    await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, legacy.id));
    expect(await getConversationOwnershipBlocker(db, f.companyId, f.issueId)).toBeNull();
  });

  describe("ownership statement shape", () => {
    it("pins the two-arm predicate and never rebuilds the coalesce expression", async () => {
      const rendered = new PgDialect().sqlToQuery(runBoundToIssueId("ISSUE"));
      expect(rendered.sql).toBe(
        `("heartbeat_runs"."native_issue_id" = case when $1::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'\n` +
        `    then ($2::text)::uuid end or ("heartbeat_runs"."native_issue_id" is null and "heartbeat_runs"."context_snapshot"->>'issueId' = $3))`,
      );
    });

    it("issues the pinned predicate from getConversationOwnershipBlocker without selecting run payloads", async () => {
      const f = await fixture();
      const query = await captureOwnershipQuery(f, f.issueId);
      const text = query.sql.toLowerCase();
      expect(text).not.toContain("coalesce(");
      expect(text).not.toMatch(/native_issue_id"::text/);
      // The service issues exactly the pinned predicate, with positional parameters renumbered.
      const positional = (value: string) => value.replace(/\$\d+/g, "$?");
      expect(positional(query.sql)).toContain(positional(new PgDialect().sqlToQuery(runBoundToIssueId(f.issueId)).sql));
      const selectList = query.sql.slice(0, query.sql.indexOf(' from "heartbeat_runs"'));
      expect(selectList).not.toContain('"context_snapshot"');
      expect(selectList).not.toContain('"runner_profile_json"');
      expect(selectList).not.toContain('"result_json"');
    });

    it("lets the planner use the existing native and context indexes", async () => {
      const f = await fixture();
      for (let i = 0; i < 40; i++) await run(f, { issueId: randomUUID() });
      await db.$client.unsafe("ANALYZE heartbeat_runs");
      const query = await captureOwnershipQuery(f, f.issueId);
      const plan = await db.$client.begin(async (tx) => {
        await tx.unsafe("SET LOCAL enable_seqscan = off");
        const rows = await tx.unsafe(`EXPLAIN ${query.sql}`, query.params as never[]);
        return rows.map((row) => String(row["QUERY PLAN"])).join("\n");
      });
      expect(plan.toLowerCase()).not.toContain("coalesce(");
      expect(plan).toMatch(/heartbeat_runs_company_native_issue_contract_id_uq|heartbeat_runs_company_ctx_issue_created_idx/);
    });
  });

  it("matches only canonical evidence IDs and keeps source issue and company scope", async () => {
    const f = await fixture(), foreign = await fixture();
    const ours = await run(f, { issueId: f.issueId });
    const elsewhere = await run(f, { issueId: f.otherIssueId });
    const foreignRun = await run(foreign, { issueId: f.issueId });
    const nativeOnly = await run(f, { issueId: f.otherIssueId }, f.issueId);
    const ids: unknown[] = [
      ours.id, ours.id.toUpperCase(), ours.id.replaceAll("-", ""), `{${ours.id}}`, "bad", "", null, 42, {}, [ours.id],
      elsewhere.id, foreignRun.id, nativeOnly.id,
    ];
    const actions = await db.insert(issueRecoveryActions).values(ids.map((runId, index) => ({
      companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog", status: "resolved", ownerType: "board",
      cause: "legacy_execution_requires_reconciliation", fingerprint: `fixture-${index}`, evidence: { runId }, nextAction: "Fixture",
    }))).returning();
    const matches = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
      .where(and(eq(issueRecoveryActions.companyId, f.companyId), conversationRecoveryActionPredicate()));
    expect(matches.map((row) => row.id).sort()).toEqual([actions[0].id, actions[12].id].sort());
  });

  it("delivers canonical same-company task IDs and keeps malformed IDs private", async () => {
    const f = await fixture(), foreign = await fixture();
    const contexts: unknown[] = [f.issueId, f.issueId.toUpperCase(), "bad", `{${f.issueId}}`, f.issueId.replaceAll("-", ""), null, 42, {}, [f.issueId], foreign.issueId];
    const expected = new Map<string, string | null>();
    for (const [index, issueId] of contexts.entries()) {
      const row = await run(f, { issueId });
      await db.update(heartbeatRuns).set({ executionStatusDeliveryId: randomUUID() }).where(eq(heartbeatRuns.id, row.id));
      expected.set(row.id, index === 0 ? f.issueId : null);
    }
    const native = await run(f, { issueId: f.otherIssueId }, f.issueId);
    await db.update(heartbeatRuns).set({ executionStatusDeliveryId: randomUUID() }).where(eq(heartbeatRuns.id, native.id));
    expected.set(native.id, f.issueId);
    const seen = new Map<string, string | null>();
    const result = await deliverExecutionStatuses(db, {
      publish: (event) => {
        seen.set(event.payload!.runId as string, event.payload!.issueId as string | null);
        return { ...event, id: 0, payload: event.payload ?? {}, createdAt: new Date().toISOString() };
      },
    });
    expect(result.delivered).toBe(expected.size);
    expect(seen).toEqual(expected);
    expect(await deliverExecutionStatuses(db, { publish: () => { throw new Error("duplicate delivery"); } })).toEqual({ scanned: 0, delivered: 0 });
  });
});
