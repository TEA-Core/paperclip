import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService } from "../services/heartbeat.ts";
import { logger } from "../middleware/logger.js";

const LEASE_RELEASE_LOG_MARKER = "terminalized on environment lease release";

// Log calls for a given pino level whose message carries the lease-release
// terminalization marker. The marker is only ever written to the log by the new
// success-path record in terminalizeRunOnLeaseRelease, so matching on it isolates
// that record from any other warn/info the service emits while tearing down.
function leaseReleaseLogCalls(method: "warn" | "info") {
  return vi.mocked(logger[method]).mock.calls.filter((call) =>
    call.some(
      (arg) => typeof arg === "string" && arg.includes(LEASE_RELEASE_LOG_MARKER),
    ),
  );
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres lease-release terminalization tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("heartbeat terminalizeRunOnLeaseRelease", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lease-release-terminal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // The lease-release terminalization now emits one container log line on the
  // normal path. Spy on the real logger (a full module mock would ripple through
  // the service's large import graph) so each test captures that record without
  // polluting stdout. Restored after every test so counts are per-test.
  beforeEach(() => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.mocked(logger.warn).mockRestore();
    vi.mocked(logger.info).mockRestore();
  });

  async function seed(input: {
    issueStatus?: string;
    runStatus: string;
    issueIdentifier?: string | null;
    withIssue?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = input.withIssue === false ? null : randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    if (issueId) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Terminalize on lease release",
        status: input.issueStatus ?? "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        ...(input.issueIdentifier ? { identifier: input.issueIdentifier } : {}),
      });
    }
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: input.runStatus,
      invocationSource: "manual",
      startedAt: new Date(),
      contextSnapshot: issueId ? { issueId } : {},
    });

    const run = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]!);

    return { companyId, agentId, issueId, runId, run };
  }

  it("forces a still-running run to succeeded when the issue already reached done", async () => {
    // This reproduces the defect: the agent PATCHed the issue to done, but the
    // teardown released the environment lease before the run-terminal write.
    const { issueId, runId, run } = await seed({ issueStatus: "done", runStatus: "running" });

    const heartbeat = heartbeatService(db);
    const terminal = await heartbeat.terminalizeRunOnLeaseRelease(run);

    expect(terminal.status).toBe("succeeded");

    const runStatus = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.status);
    expect(runStatus).toBe("succeeded");

    const issueStatus = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]?.status);
    expect(issueStatus).toBe("done");

    const event = await db
      .select({ message: heartbeatRunEvents.message, payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId))
      .then((rows) => rows[0]);
    expect(event?.message).toContain("lease release");
    expect((event?.payload as { terminalStatus?: string } | null)?.terminalStatus).toBe("succeeded");
  });

  it("forces a still-running run to interrupted when the issue is not terminal", async () => {
    const { runId, run } = await seed({ issueStatus: "in_progress", runStatus: "running" });

    const heartbeat = heartbeatService(db);
    const terminal = await heartbeat.terminalizeRunOnLeaseRelease(run);

    expect(terminal.status).toBe("interrupted");

    const row = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("interrupted");
    expect(row?.errorCode).toBe("lease_released_before_terminal");
  });

  it("forces a still-queued run to interrupted when the lease releases before it starts", async () => {
    // A queued run holds a lease but never reached "running". The teardown
    // released the lease, so the run must not stay queued and show a phantom
    // live run. A running-only update would miss it.
    const { runId, run } = await seed({ issueStatus: "in_progress", runStatus: "queued" });

    const heartbeat = heartbeatService(db);
    const terminal = await heartbeat.terminalizeRunOnLeaseRelease(run);

    expect(terminal.status).toBe("interrupted");

    const row = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("interrupted");
    expect(row?.errorCode).toBe("lease_released_before_terminal");
  });

  it("forces a still-queued run to succeeded when the issue already reached done", async () => {
    const { runId, run } = await seed({ issueStatus: "done", runStatus: "queued" });

    const heartbeat = heartbeatService(db);
    const terminal = await heartbeat.terminalizeRunOnLeaseRelease(run);

    expect(terminal.status).toBe("succeeded");

    const runStatus = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.status);
    expect(runStatus).toBe("succeeded");
  });

  it("keeps an already-terminal run authoritative and records no new event", async () => {
    const { runId, run } = await seed({ issueStatus: "done", runStatus: "failed" });

    const heartbeat = heartbeatService(db);
    const terminal = await heartbeat.terminalizeRunOnLeaseRelease(run);

    expect(terminal.status).toBe("failed");

    const runStatus = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.status);
    expect(runStatus).toBe("failed");

    const eventCount = await db
      .select({ id: heartbeatRunEvents.id })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId))
      .then((rows) => rows.length);
    expect(eventCount).toBe(0);
  });

  it("attributes the terminalized error and run event to the owning issue", async () => {
    const { issueId, runId, run } = await seed({
      issueStatus: "in_progress",
      runStatus: "running",
      issueIdentifier: "SUP-4242",
    });
    expect(issueId).toBeTruthy();

    const heartbeat = heartbeatService(db);
    const terminal = await heartbeat.terminalizeRunOnLeaseRelease(run);

    expect(terminal.status).toBe("interrupted");

    const row = await db
      .select({ error: heartbeatRuns.error, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(row?.errorCode).toBe("lease_released_before_terminal");
    expect(row?.error).toContain("(issue: SUP-4242");
    expect(row?.error).toContain(issueId!);

    const event = await db
      .select({ message: heartbeatRunEvents.message, payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId))
      .then((rows) => rows[0]);
    expect(event?.message).toContain("SUP-4242");
    const payload = (event?.payload ?? null) as
      | { issueId?: string; issueIdentifier?: string }
      | null;
    expect(payload?.issueId).toBe(issueId);
    expect(payload?.issueIdentifier).toBe("SUP-4242");
  });

  it("emits no issue attribution when the run has no owning issue", async () => {
    const { runId, run } = await seed({ runStatus: "running", withIssue: false });

    const heartbeat = heartbeatService(db);
    const terminal = await heartbeat.terminalizeRunOnLeaseRelease(run);

    expect(terminal.status).toBe("interrupted");

    const row = await db
      .select({ error: heartbeatRuns.error })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]);
    expect(row?.error).toBe(
      "run terminalized on environment lease release: heartbeat_runs.status was still running at teardown",
    );
    expect(row?.error).not.toContain("(issue:");

    // The success-path log still fires even without an owning issue; the issue
    // fields are simply absent and nothing renders the literal "undefined".
    const warnCalls = leaseReleaseLogCalls("warn");
    expect(warnCalls).toHaveLength(1);
    const fields = warnCalls[0]?.[0] as Record<string, unknown>;
    expect(fields).not.toHaveProperty("issueId");
    expect(fields).not.toHaveProperty("issueIdentifier");
    expect(typeof warnCalls[0]?.[1]).toBe("string");
    expect(String(warnCalls[0]?.[1])).not.toContain("undefined");
    expect(String(warnCalls[0]?.[1])).not.toContain("(issue:");
  });

  it("logs exactly one attributed warn record when a still-running run is cut short", async () => {
    const { issueId, runId, run } = await seed({
      issueStatus: "in_progress",
      runStatus: "running",
      issueIdentifier: "SUP-4242",
    });
    expect(issueId).toBeTruthy();

    const heartbeat = heartbeatService(db);
    const terminal = await heartbeat.terminalizeRunOnLeaseRelease(run);

    expect(terminal.status).toBe("interrupted");

    // Exactly one container log record on the normal path, at warn, carrying the
    // structured attribution and run/terminal/errorCode fields; the identifier
    // appears in the rendered message text.
    expect(leaseReleaseLogCalls("warn")).toHaveLength(1);
    expect(leaseReleaseLogCalls("info")).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        previousStatus: "running",
        terminalStatus: "interrupted",
        errorCode: "lease_released_before_terminal",
        issueId,
        issueIdentifier: "SUP-4242",
      }),
      expect.stringContaining("SUP-4242"),
    );
  });

  it("logs the lease-release terminalization at info, not warn, when the issue already reached done", async () => {
    const { issueId, runId, run } = await seed({
      issueStatus: "done",
      runStatus: "running",
      issueIdentifier: "SUP-4243",
    });

    const heartbeat = heartbeatService(db);
    const terminal = await heartbeat.terminalizeRunOnLeaseRelease(run);

    expect(terminal.status).toBe("succeeded");

    expect(leaseReleaseLogCalls("info")).toHaveLength(1);
    expect(leaseReleaseLogCalls("warn")).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        previousStatus: "running",
        terminalStatus: "succeeded",
        errorCode: null,
        issueId,
        issueIdentifier: "SUP-4243",
      }),
      expect.stringContaining("SUP-4243"),
    );
  });

  it("logs the lease-release terminalization at info, not warn, when the issue was cancelled", async () => {
    const { runId, run } = await seed({ issueStatus: "cancelled", runStatus: "queued" });

    const heartbeat = heartbeatService(db);
    const terminal = await heartbeat.terminalizeRunOnLeaseRelease(run);

    expect(terminal.status).toBe("cancelled");

    expect(leaseReleaseLogCalls("info")).toHaveLength(1);
    expect(leaseReleaseLogCalls("warn")).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        runId,
        previousStatus: "queued",
        terminalStatus: "cancelled",
        errorCode: null,
      }),
      expect.stringContaining(LEASE_RELEASE_LOG_MARKER),
    );
  });

  it("emits no lease-release log record when another path already finalized the run", async () => {
    const { runId, run } = await seed({ issueStatus: "in_progress", runStatus: "running" });

    // A competing path finalizes the run after our snapshot but before the
    // lease-release write, so the conditional update matches nothing and
    // terminalizeRunOnLeaseRelease must keep that outcome without logging.
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));

    const heartbeat = heartbeatService(db);
    const terminal = await heartbeat.terminalizeRunOnLeaseRelease(run);

    expect(terminal.status).toBe("succeeded");
    expect(leaseReleaseLogCalls("warn")).toHaveLength(0);
    expect(leaseReleaseLogCalls("info")).toHaveLength(0);
  });
});
