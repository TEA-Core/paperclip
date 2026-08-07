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
const THROWING_ADAPTER = "error_reason_classifying_detail_adapter";
// The adapter throws with an ANSI-decorated message so this test also proves the
// classifying prefix survives `truncateAgentErrorReason`'s escape stripping.
const ADAPTER_FAILURE_MESSAGE = "Error: Unexpected error";

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat errorReason classifying-detail tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat agent errorReason carries classifying errorCode", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-error-classifying-detail-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: THROWING_ADAPTER,
      execute: async () => {
        throw new Error(`\x1b[31m${ADAPTER_FAILURE_MESSAGE}\x1b[0m`);
      },
      testEnvironment: async () => ({
        adapterType: THROWING_ADAPTER,
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
    await db.delete(companies);
  });

  afterAll(async () => {
    unregisterServerAdapter(THROWING_ADAPTER);
    await tempDb?.cleanup();
  });

  it("persists errorReason with the classifying errorCode prefix, not a bare adapter message", async () => {
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
      adapterType: THROWING_ADAPTER,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const readAgent = () =>
      db
        .select({ status: agents.status, errorReason: agents.errorReason })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0] ?? null);

    // Acceptance bullet 3 (SUP-10903): the classifying detail available at the
    // failure site must be persisted, not flattened to the bare adapter message.
    // The ANSI decoration the adapter emitted must not survive either.
    await expect.poll(readAgent, { timeout: 10_000, interval: 50 }).toEqual({
      status: "error",
      errorReason: `[adapter_failed] ${ADAPTER_FAILURE_MESSAGE}`,
    });

    const agentRow = await readAgent();
    expect(agentRow?.errorReason).not.toBe(ADAPTER_FAILURE_MESSAGE);
    expect(agentRow?.errorReason).not.toContain("\x1b");
  }, 30_000);
});
