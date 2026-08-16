import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NO_REASON_ADAPTER = "wv_failure_no_reason_adapter";
const WITH_REASON_ADAPTER = "wv_failure_with_reason_adapter";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat workspace-validation-failure-classification tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat workspace_validation_failed classification requires reason", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wv-failure-class-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);

    registerServerAdapter({
      type: NO_REASON_ADAPTER,
      execute: async () => {
        const err: Record<string, unknown> = new Error("adapter_failed");
        err.code = "workspace_validation_failed";
        err.resultJson = { stopReason: "adapter_failed", timeoutFired: false };
        throw err;
      },
      testEnvironment: async () => ({
        adapterType: NO_REASON_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });

    registerServerAdapter({
      type: WITH_REASON_ADAPTER,
      execute: async () => {
        const err: Record<string, unknown> = new Error("adapter_failed");
        err.code = "workspace_validation_failed";
        err.resultJson = {
          stopReason: "adapter_failed",
          timeoutFired: false,
          workspaceValidation: { reason: "git_worktree_base_agent_home" },
        };
        throw err;
      },
      testEnvironment: async () => ({
        adapterType: WITH_REASON_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  async function cleanupHeartbeatRunDependents() {
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
  }

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await cleanupHeartbeatRunDependents();
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    unregisterServerAdapter(NO_REASON_ADAPTER);
    unregisterServerAdapter(WITH_REASON_ADAPTER);
    await tempDb?.cleanup();
  });

  async function setupAgent(adapterType: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "FailingAgent",
      role: "engineer",
      status: "idle",
      errorReason: null,
      adapterType,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    return { companyId, agentId };
  }

  function readAgentErrorReason(agentId: string) {
    return () =>
      db
        .select({ status: agents.status, errorReason: agents.errorReason })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);
  }

  it("classifies a workspace_validation_failed error without a reason as adapter_failed", async () => {
    const { agentId } = await setupAgent(NO_REASON_ADAPTER);

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const readAgent = readAgentErrorReason(agentId);
    let agentRow: { status: string | null; errorReason: string | null } | null = null;
    await expect.poll(() => {
      return readAgent().then((row) => {
        agentRow = row;
        return row?.status;
      });
    }, { timeout: 10_000, interval: 50 }).toBe("error");

    expect(agentRow?.errorReason).toMatch(/^\[adapter_failed\]/);
    expect(agentRow?.errorReason).not.toMatch(/^\[workspace_validation_failed\]/);
  }, 30_000);

  it("classifies a workspace_validation_failed error with a reason as workspace_validation_failed", async () => {
    const { agentId } = await setupAgent(WITH_REASON_ADAPTER);

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const readRunErrorCode = () =>
      db
        .select({ errorCode: heartbeatRuns.errorCode, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run!.id))
        .then((rows) => rows[0] ?? null);

    let runRow: { status: string | null; errorCode: string | null } | null = null;
    await expect.poll(() => {
      return readRunErrorCode().then((row) => {
        runRow = row;
        return row?.errorCode;
      });
    }, { timeout: 10_000, interval: 50 }).toBe("workspace_validation_failed");

    expect(runRow?.errorCode).toBe("workspace_validation_failed");
    expect(runRow?.status).toBe("failed");

    const readAgent = readAgentErrorReason(agentId);
    let agentRow: { status: string | null; errorReason: string | null } | null = null;
    await expect.poll(() => {
      return readAgent().then((row) => {
        agentRow = row;
        return row?.status;
      });
    }, { timeout: 10_000, interval: 50 }).toBe("idle");

    expect(agentRow?.status).toBe("idle");
    expect(agentRow?.errorReason).toBeNull();
  }, 30_000);
});
