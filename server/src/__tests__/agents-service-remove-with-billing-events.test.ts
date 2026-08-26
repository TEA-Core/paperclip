import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  costEvents,
  createDb,
  financeEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent remove billing event tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service remove with billing events (SUP-14056)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-remove-billing-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("deletes an agent that has cost and finance events, keeping the billing rows", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Disposable Lane",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "succeeded",
      finishedAt: new Date("2026-08-26T00:01:00.000Z"),
    });

    const [costEvent] = await db
      .insert(costEvents)
      .values({
        companyId,
        agentId,
        heartbeatRunId: runId,
        provider: "anthropic",
        biller: "anthropic",
        model: "claude-opus-4",
        costCents: 42,
        occurredAt: new Date("2026-08-26T00:01:30.000Z"),
      })
      .returning();

    const [financeEvent] = await db
      .insert(financeEvents)
      .values({
        companyId,
        agentId,
        heartbeatRunId: runId,
        costEventId: costEvent.id,
        eventKind: "cost",
        biller: "anthropic",
        amountCents: 42,
        occurredAt: new Date("2026-08-26T00:01:30.000Z"),
      })
      .returning();

    const removed = await agentService(db).remove(agentId);

    expect(removed).toMatchObject({ id: agentId });

    const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(agentRow).toBeUndefined();

    const [runRow] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(runRow).toBeUndefined();

    const [costRow] = await db.select().from(costEvents).where(eq(costEvents.id, costEvent.id));
    expect(costRow).toMatchObject({
      id: costEvent.id,
      companyId,
      costCents: 42,
      agentId: null,
      heartbeatRunId: null,
    });

    const [financeRow] = await db
      .select()
      .from(financeEvents)
      .where(eq(financeEvents.id, financeEvent.id));
    expect(financeRow).toMatchObject({
      id: financeEvent.id,
      companyId,
      amountCents: 42,
      costEventId: costEvent.id,
      agentId: null,
      heartbeatRunId: null,
    });
  });
});
