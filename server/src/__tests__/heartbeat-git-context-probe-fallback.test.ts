import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  heartbeatRunEvents,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
} from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateWithLockRetry } from "./helpers/truncate-with-lock-retry.js";
import { heartbeatService } from "../services/heartbeat.ts";

// TEA-Core fork (fold 2c, decision D3): executeRun keeps a host-mode run alive when upstream's
// Git-context probe fails, and keeps managed-mode probe failures fatal.

const adapterExecute = vi.hoisted(() =>
  vi.fn(async (_ctx: AdapterExecutionContext) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "Git context probe fallback test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  runningProcesses: new Map(),
}));

// The spread is mandatory: heartbeat imports the launcher and bridge functions from this module too.
vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    prepareGitHubExecutionEnvironment: vi.fn(actual.prepareGitHubExecutionEnvironment),
  };
});

const executionTarget = await import("@paperclipai/adapter-utils/execution-target");
const probe = vi.mocked(executionTarget.prepareGitHubExecutionEnvironment);
const realProbe = (await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
  "@paperclipai/adapter-utils/execution-target",
)).prepareGitHubExecutionEnvironment;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat Git-context probe fallback tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    "connection_grants",
    "tool_connection_installs",
    "tool_connections",
    "tool_applications",
    "company_memberships",
    "environment_leases",
    "environments",
    "activity_log",
    "heartbeat_run_events",
    "heartbeat_runs",
    "agent_wakeup_requests",
    "agent_runtime_state",
    "agents",
    "companies"
  RESTART IDENTITY CASCADE
`;

function timeoutError() {
  return Object.assign(new Error("Command failed: node -e const fs = require('node:fs') ..."), {
    killed: true,
    signal: "SIGTERM",
    code: null,
  });
}

describeEmbeddedPostgres("heartbeat Git-context probe fallback (D3)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "heartbeat-git-context-probe-fallback-secret");
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-git-context-probe-fallback-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    await truncateWithLockRetry(db, TRUNCATE_SQL);
    adapterExecute.mockClear();
    probe.mockReset();
    probe.mockImplementation(realProbe);
    vi.unstubAllEnvs();
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "heartbeat-git-context-probe-fallback-secret");
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await heartbeat.drainActiveRunExecutions();
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
  });

  async function waitForRunToFinish(runId: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run && !["queued", "running"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await heartbeat.getRun(runId);
  }

  async function seedAgent(opts: { withGitHubConnection?: boolean } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Git context probe",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    if (opts.withGitHubConnection) {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: "responsible-user",
        status: "active",
        membershipRole: "member",
      });
      const [application] = await db.insert(toolApplications).values({
        companyId,
        applicationKey: `github-${randomUUID().slice(0, 8)}`,
        name: "GitHub",
        type: "mcp_http",
        status: "active",
        metadata: { sourceTemplateKey: "github" },
      }).returning();
      const [connection] = await db.insert(toolConnections).values({
        companyId,
        applicationId: application!.id,
        name: "Dedicated GitHub",
        uid: `github/${randomUUID()}`,
        transport: "mcp_remote",
        credentialPolicy: "per_agent",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        config: {},
        transportConfig: { sourceTemplateKey: "github" },
      }).returning();
      await db.insert(toolConnectionInstalls).values({
        companyId,
        connectionId: connection!.id,
        targetType: "company",
        targetId: companyId,
      });
      await db.insert(connectionGrants).values({
        companyId,
        connectionId: connection!.id,
        kind: "agent",
        subjectAgentId: agentId,
        status: "active",
        isDefault: false,
      });
    }
    return { companyId, agentId };
  }

  async function probeFallbackEvents(runId: string) {
    const rows = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    return rows.filter((row) => (row.payload as Record<string, unknown> | null)?.code === "git_context_probe_failed");
  }

  it("a host-mode local run whose Git-context probe times out still dispatches the adapter", async () => {
    const { agentId } = await seedAgent();
    probe.mockRejectedValueOnce(timeoutError());

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(queued!.id);

    expect(finished?.status).toBe("succeeded");
    expect(finished?.errorCode).not.toBe("setup_failed");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    const { config } = adapterExecute.mock.calls[0]![0] as unknown as { config: { env: Record<string, string> } };
    expect(config.env.PAPERCLIP_GITHUB_AUTH_MODE).toBe("host");
    expect(config.env.PAPERCLIP_GIT_METADATA_ROOTS).toBe("[]");
    expect(config.env.PAPERCLIP_GITHUB_LAUNCHER_DIR).toBeUndefined();

    const events = await probeFallbackEvents(queued!.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "lifecycle", level: "warn" });
    expect(events[0]!.payload).toMatchObject({ reason: "timeout", signal: "SIGTERM", targetKind: "local" });
    expect(events[0]!.message).not.toContain("node -e");
    expect(JSON.stringify(events[0]!.payload)).not.toContain("node -e");

    const snapshot = finished?.contextSnapshot as Record<string, unknown>;
    expect(snapshot.githubExecutionContextProbe).toMatchObject({ status: "fallback", reason: "timeout" });
    expect(snapshot.githubAuthenticationMode).toBe("host");
  });

  it("a host-mode local run whose probe spawn fails with ENOENT still dispatches the adapter", async () => {
    const { agentId } = await seedAgent();
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-probe-missing-cwd-"));
    tempRoots.push(root);
    // A real node spawn into a directory that does not exist: the actual execFile error shape.
    probe.mockImplementationOnce((input) => realProbe({ ...input, cwd: path.join(root, "gone") }));

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(queued!.id);

    expect(finished?.status).toBe("succeeded");
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    const events = await probeFallbackEvents(queued!.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ errorCode: "ENOENT", targetKind: "local" });
  });

  it("a healthy probe records no fallback telemetry and clears a stale stamp", async () => {
    const { agentId } = await seedAgent();
    const queued = await heartbeat.invoke(
      agentId,
      "on_demand",
      { githubExecutionContextProbe: { status: "fallback", reason: "timeout" } },
      "manual",
    );
    // Non-vacuity: the stale stamp is present on the queued run's snapshot.
    expect((queued?.contextSnapshot as Record<string, unknown>).githubExecutionContextProbe).toBeDefined();
    const finished = await waitForRunToFinish(queued!.id);

    expect(finished?.status).toBe("succeeded");
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    expect(await probeFallbackEvents(queued!.id)).toHaveLength(0);
    expect(finished?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("githubExecutionContextProbe");
  });

  it("a managed-mode probe failure still fails setup (upstream fatality kept)", async () => {
    vi.stubEnv("PAPERCLIP_GITHUB_MANAGED_EXECUTION", "on");
    const { agentId } = await seedAgent({ withGitHubConnection: true });
    probe.mockRejectedValueOnce(Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" }));

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(queued!.id);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]![0].hostCredentials).toBe(false);
    expect(finished?.status).toBe("failed");
    expect(finished?.errorCode).toBe("setup_failed");
    expect(adapterExecute).not.toHaveBeenCalled();
    expect(await probeFallbackEvents(queued!.id)).toHaveLength(0);
  });
});
