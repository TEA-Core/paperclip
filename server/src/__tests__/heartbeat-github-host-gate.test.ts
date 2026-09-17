import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  environments,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
} from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  startSshEnvLabFixture,
} from "@paperclipai/adapter-utils/ssh";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateWithLockRetry } from "./helpers/truncate-with-lock-retry.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { resolveManagedGitHubIdentitySelection } from "../services/git-credentials.ts";
import { normalizeEnvironmentConfigForPersistence } from "../services/environment-config.ts";
import { secretService } from "../services/secrets.ts";

// TEA-Core fork (fold 2c, decision D1): local and SSH runs run in host GitHub mode unless
// PAPERCLIP_GITHUB_MANAGED_EXECUTION=on, even when the company has an installed, granted
// GitHub connection that upstream #13005 would otherwise switch the run to managed mode for.

const adapterExecute = vi.hoisted(() =>
  vi.fn(async (_ctx: AdapterExecutionContext) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "GitHub host gate test run.",
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

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...actual,
    prepareGitHubExecutionEnvironment: vi.fn(actual.prepareGitHubExecutionEnvironment),
    prepareGitHubOperationLaunchers: vi.fn(actual.prepareGitHubOperationLaunchers),
  };
});

const executionTarget = await import("@paperclipai/adapter-utils/execution-target");
const prepareExecutionEnvironment = vi.mocked(executionTarget.prepareGitHubExecutionEnvironment);
const prepareLaunchers = vi.mocked(executionTarget.prepareGitHubOperationLaunchers);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const sshFixtureSupport = await getSshEnvLabSupport();

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat GitHub host gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
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

describeEmbeddedPostgres("heartbeat GitHub host gate (D1)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "heartbeat-github-host-gate-secret");
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-github-host-gate-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    await truncateWithLockRetry(db, TRUNCATE_SQL);
    adapterExecute.mockClear();
    prepareExecutionEnvironment.mockClear();
    prepareLaunchers.mockClear();
    vi.unstubAllEnvs();
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "heartbeat-github-host-gate-secret");
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

  async function seedCompanyWithGitHubConnection(opts: { environment?: { driver: string; config: Record<string, unknown> } } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "GitHub host gate",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "responsible-user",
      status: "active",
      membershipRole: "member",
    });
    let environmentId: string | null = null;
    if (opts.environment) {
      environmentId = randomUUID();
      const name = `Fixture ${opts.environment.driver}`;
      // Persist the way the environments route does: the SSH private key becomes a company
      // secret ref, which the run-lease path resolves at runtime.
      const config = await normalizeEnvironmentConfigForPersistence({
        db,
        companyId,
        environmentName: name,
        driver: opts.environment.driver as "ssh",
        secretProvider: "local_encrypted",
        config: opts.environment.config,
      });
      await db.insert(environments).values({
        id: environmentId,
        name,
        driver: opts.environment.driver,
        status: "active",
        config,
      });
      const privateKeySecretId = (config.privateKeySecretRef as { secretId?: string } | null)?.secretId;
      if (privateKeySecretId) {
        await secretService(db).createBinding({
          companyId,
          secretId: privateKeySecretId,
          targetType: "environment",
          targetId: environmentId,
          configPath: "privateKeySecretRef",
        });
      }
    }
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { env: { GH_TOKEN: { type: "plain", value: "agent-bound-token" } } },
      runtimeConfig: {},
      permissions: {},
      ...(environmentId ? { defaultEnvironmentId: environmentId } : {}),
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
    // A DEDICATED agent grant: `configured: true` does not depend on responsible-user resolution.
    await db.insert(connectionGrants).values({
      companyId,
      connectionId: connection!.id,
      kind: "agent",
      subjectAgentId: agentId,
      status: "active",
      isDefault: false,
    });
    // Non-vacuity: upstream's selection sees a configured managed identity for this agent.
    const selection = await resolveManagedGitHubIdentitySelection(db, companyId, {
      agentId,
      responsibleUserId: "responsible-user",
      allowStandingDelegation: false,
    });
    expect(selection.configured).toBe(true);
    return { companyId, agentId };
  }

  function adapterCall() {
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    return adapterExecute.mock.calls[0]![0] as unknown as {
      config: { env: Record<string, string> };
      context: Record<string, unknown>;
    };
  }

  it("a local run in a company with an installed, granted GitHub connection runs in host mode with bindings intact", async () => {
    const { agentId } = await seedCompanyWithGitHubConnection();

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(queued!.id);
    expect(finished?.status).toBe("succeeded");

    expect(prepareExecutionEnvironment).toHaveBeenCalledTimes(1);
    expect(prepareExecutionEnvironment.mock.calls[0]![0].hostCredentials).toBe(true);
    expect(prepareLaunchers).not.toHaveBeenCalled();
    const { config, context } = adapterCall();
    expect(config.env.PAPERCLIP_GITHUB_AUTH_MODE).toBe("host");
    expect(config.env.PAPERCLIP_GITHUB_LAUNCHER_DIR).toBeUndefined();
    expect(config.env.PAPERCLIP_GITHUB_BROKER_TOKEN).toBeUndefined();
    expect(config.env.GH_TOKEN).toBe("agent-bound-token");
    expect(context.githubAuthenticationMode).toBe("host");
  });

  it("the same fixture goes managed only with PAPERCLIP_GITHUB_MANAGED_EXECUTION=on", async () => {
    vi.stubEnv("PAPERCLIP_GITHUB_MANAGED_EXECUTION", "on");
    const { agentId } = await seedCompanyWithGitHubConnection();

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(queued!.id);
    expect(finished?.status).toBe("succeeded");

    expect(prepareExecutionEnvironment).toHaveBeenCalledTimes(1);
    expect(prepareExecutionEnvironment.mock.calls[0]![0].hostCredentials).toBe(false);
    expect(prepareLaunchers).toHaveBeenCalledTimes(1);
    const { config, context } = adapterCall();
    expect(config.env.PAPERCLIP_GITHUB_AUTH_MODE).toBe("managed");
    expect(config.env.GH_TOKEN).not.toBe("agent-bound-token");
    expect(context.githubAuthenticationMode).toBe("managed");
  });

  it("an SSH run in a company with an installed GitHub connection runs in host mode", async () => {
    if (!sshFixtureSupport.supported) {
      console.warn(`Skipping SSH GitHub host gate test: ${sshFixtureSupport.reason ?? "unsupported environment"}`);
      return;
    }
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-host-gate-ssh-"));
    tempRoots.push(fixtureRoot);
    const fixture = await startSshEnvLabFixture({ statePath: path.join(fixtureRoot, "state.json") });
    const sshConfig = await buildSshEnvLabFixtureConfig(fixture);
    const { agentId } = await seedCompanyWithGitHubConnection({
      environment: { driver: "ssh", config: sshConfig as unknown as Record<string, unknown> },
    });

    const queued = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    const finished = await waitForRunToFinish(queued!.id, 60_000);
    expect(finished?.status, JSON.stringify({ error: finished?.error, errorCode: finished?.errorCode })).toBe("succeeded");

    expect(prepareExecutionEnvironment).toHaveBeenCalledTimes(1);
    const probeInput = prepareExecutionEnvironment.mock.calls[0]![0];
    expect(probeInput.hostCredentials).toBe(true);
    expect(probeInput.target?.kind).toBe("remote");
    expect(prepareLaunchers).not.toHaveBeenCalled();
    const { config, context } = adapterCall();
    expect(config.env.PAPERCLIP_GITHUB_AUTH_MODE).toBe("host");
    expect(config.env.PAPERCLIP_GITHUB_LAUNCHER_DIR).toBeUndefined();
    expect(config.env.GH_TOKEN).toBe("agent-bound-token");
    expect(context.githubAuthenticationMode).toBe("host");
  }, 90_000);
});
