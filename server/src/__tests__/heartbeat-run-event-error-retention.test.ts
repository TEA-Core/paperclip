import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, heartbeatRunEvents, heartbeatRuns, agents, companies } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  boundHeartbeatRunEventPayloadForStorage,
  buildRunEventInsertValues,
} from "../services/heartbeat.ts";

// SUP-15309: the underlying Postgres/driver error must survive intact on
// heartbeat_run_events. The `error` field is written verbatim (only current-user
// identity redacted) and is intentionally NOT passed through the payload bounder,
// whose 16KB string bound is what truncated the error away during SUP-15254.
//
// The pure block below always runs (no DB) and exercises the exact insert-values
// builder that appendRunEvent persists. The embedded-Postgres block proves the
// 0245 migration applied and that a real recorded row retains a >16KB error.

const NOOP_REDACTION = { enabled: false } as const;
// 16 * 1024 is the payload string bound (MAX_RUN_EVENT_PAYLOAD_STRING_CHARS).
const PAYLOAD_STRING_BOUND = 16 * 1024;

describe("heartbeat_run_events error retention (appendRunEvent insert values)", () => {
  const run = {
    companyId: randomUUID(),
    id: randomUUID(),
    agentId: randomUUID(),
  };
  const bigDriverError = `driver-error:Failed query: INSERT INTO "heartbeat_run_events" ${"z".repeat(
    PAYLOAD_STRING_BOUND + 512,
  )}`;
  const bigPromptValue = "p".repeat(PAYLOAD_STRING_BOUND + 512);

  it("writes the error verbatim (no 16KB bound) while the payload is bounded", () => {
    const values = buildRunEventInsertValues({
      run,
      seq: 7,
      event: {
        eventType: "error",
        stream: "system",
        level: "error",
        message: "adapter execution failed",
        error: bigDriverError,
        payload: { prompt: bigPromptValue },
      },
      currentUserRedactionOptions: NOOP_REDACTION,
    });

    // The error is the full string, intact, with no truncation marker.
    expect(values.error).toBe(bigDriverError);
    expect(values.error!.length).toBeGreaterThan(PAYLOAD_STRING_BOUND);
    expect(values.error!.includes("[truncated")).toBe(false);

    // The same-length value in the payload IS bounded by the bounder.
    const boundedPayload = boundHeartbeatRunEventPayloadForStorage({ prompt: bigPromptValue });
    expect(typeof (boundedPayload as { prompt?: string }).prompt).toBe("string");
    expect((boundedPayload as { prompt: string }).prompt.length).toBeLessThan(bigPromptValue.length);
    expect(String((boundedPayload as { prompt: string }).prompt).includes("[truncated")).toBe(true);

    // The bounded payload is what lands in the `payload` field, not the error.
    expect((values.payload as { prompt: string }).prompt.length).toBeLessThan(bigPromptValue.length);

    // Non-error fields are preserved as before.
    expect(values.seq).toBe(7);
    expect(values.eventType).toBe("error");
    expect(values.message).toBe("adapter execution failed");
    expect(values.runId).toBe(run.id);
  });

  it("keeps a sub-16KB error intact and leaves error undefined when absent", () => {
    const small = buildRunEventInsertValues({
      run,
      seq: 1,
      event: { eventType: "error", level: "error", error: "connection refused: 127.0.0.1:5432" },
      currentUserRedactionOptions: NOOP_REDACTION,
    });
    expect(small.error).toBe("connection refused: 127.0.0.1:5432");

    const absent = buildRunEventInsertValues({
      run,
      seq: 2,
      event: { eventType: "lifecycle", level: "info", message: "run started" },
      currentUserRedactionOptions: NOOP_REDACTION,
    });
    expect(absent.error).toBeUndefined();
  });

  it("still redacts the current user's identity from the error, but does not truncate it", () => {
    const withUser = `driver-error: query failed as ${"paperclip-test-user"} ${"y".repeat(
      PAYLOAD_STRING_BOUND + 256,
    )}`;
    const values = buildRunEventInsertValues({
      run,
      seq: 3,
      event: { eventType: "error", level: "error", error: withUser },
      currentUserRedactionOptions: { enabled: true, userNames: ["paperclip-test-user"] },
    });
    expect(values.error!.includes("paperclip-test-user")).toBe(false);
    // Redaction swaps the username for a mask; length stays > the 16KB bound.
    expect(values.error!.length).toBeGreaterThan(PAYLOAD_STRING_BOUND);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat run-event error-retention tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("heartbeat_run_events error column (embedded Postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-run-event-error-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("applies the 0245 migration and adds a text error column", async () => {
    const columns = await db
      .select({ dataType: sql<string>`data_type` })
      .from(sql`information_schema.columns`)
      .where(
        and(
          eq(sql`table_name`, "heartbeat_run_events"),
          eq(sql`column_name`, "error"),
        ),
      );
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.some((column) => column.dataType === "text")).toBe(true);
  });

  it("retains a >16KB error verbatim on a recorded event row", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const bigError = `driver-error:${"k".repeat(PAYLOAD_STRING_BOUND + 768)}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      livenessState: "advanced",
      livenessReason: "run produced action evidence",
      continuationAttempt: 1,
      lastUsefulActionAt: new Date("2026-04-18T12:00:00Z"),
      nextAction: "continue implementation",
      contextSnapshot: { issueId: randomUUID() },
    });

    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId,
      agentId,
      seq: 1,
      eventType: "error",
      level: "error",
      message: "adapter execution failed",
      error: bigError,
      payload: { _truncated: true },
    });

    const [row] = await db
      .select({ error: heartbeatRunEvents.error })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    expect(row?.error).toBe(bigError);
    expect(row?.error!.length).toBeGreaterThan(PAYLOAD_STRING_BOUND);
  });
});
