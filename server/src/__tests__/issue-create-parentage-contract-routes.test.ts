import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPaperclipMcpServer } from "../../../packages/mcp-server/src/index.js";
import express from "express";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueCreateIdempotencyKeys,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue create parentage route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// Regression guard for SUP-14719 (follow-up to SUP-14715):
// `POST /api/companies/:companyId/issues` must tell the truth about the parent
// field it accepts. A create that returns 2xx and discards a supplied parent is
// the one outcome the create path must never produce.
describeEmbeddedPostgres("issue create parentage contract routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let previousSchedulingSuppression: string | undefined;

  beforeAll(async () => {
    previousSchedulingSuppression = process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-create-parentage-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueCreateIdempotencyKeys);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentApiKeys);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousSchedulingSuppression === undefined) {
      delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    } else {
      process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = previousSchedulingSuppression;
    }
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedParent(companyId: string) {
    const [parent] = await db.insert(issues).values({
      companyId,
      title: "Parent issue",
      status: "todo",
      priority: "medium",
    }).returning();
    return parent;
  }

  async function seedMonitorOwner(companyId: string) {
    const agentId = randomUUID();
    const token = `monitor-test-${randomUUID()}`;
    const responsibleUserId = randomUUID();
    const now = new Date();
    await db.insert(authUsers).values({
      id: responsibleUserId,
      name: "Monitor operator",
      email: `${responsibleUserId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: responsibleUserId,
      membershipRole: "operator",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Monitor owner",
      role: "ceo",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    });
    await db.insert(agentApiKeys).values({
      agentId,
      companyId,
      name: "Monitor test key",
      responsibleUserId,
      keyHash: createHash("sha256").update(token).digest("hex"),
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId,
      contextSnapshot: {},
    });
    return { agentId, token, runId };
  }

  async function withMcpClient(
    companyId: string,
    owner: { agentId: string; token: string; runId: string },
    run: (client: Client) => Promise<void>,
  ) {
    const http = createServer(createApp());
    const listening = once(http, "listening");
    http.listen(0, "127.0.0.1");
    await listening;
    const { server } = createPaperclipMcpServer({
      apiUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}/api`,
      apiKey: owner.token,
      companyId,
      agentId: owner.agentId,
      runId: owner.runId,
    });
    const client = new Client({ name: "monitor-contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await run(client);
    } finally {
      await client.close();
      await server.close();
      await promisify(http.close.bind(http))();
    }
  }

  it("honours a supplied parentId at create and the re-GET shows that parent", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Child created with parentId" })
      .expect(201);

    // The 2xx response must name the parent that was actually stored, not silently
    // return a success with a null parent.
    expect(created.body.parentId).toBe(parent.id);

    // The re-GET the filer uses to double-check the hierarchy shows the parent.
    const reGet = await request(app).get(`/api/issues/${created.body.id}`).expect(200);
    expect(reGet.body.parentId).toBe(parent.id);

    // The DB row is the source of truth: the child really is parented, so child
    // rollup / parent close gates see a non-empty child set.
    const rows = await db.select().from(issues).where(eq(issues.parentId, parent.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(created.body.id);
  });

  it.each(["board", "agent"] as const)("persists the %s actor's monitor ownership and redacts external references on create and GET", async (actor) => {
    const companyId = await seedCompany();
    const { agentId, token } = await seedMonitorOwner(companyId);
    const monitor = {
      nextCheckAt: "2099-12-01T12:00:00.000Z",
      notes: "Check deployment health",
      scheduledBy: actor === "board" ? "assignee" : "board",
      kind: "external_service",
      serviceName: "deployment-health",
      externalRef: `fake-ref-${randomUUID()}`,
      timeoutAt: "2099-12-02T12:00:00.000Z",
      maxAttempts: 3,
      recoveryPolicy: "escalate_to_board",
    };
    const savedMonitor = {
      ...monitor,
      scheduledBy: actor === "board" ? "board" : "assignee",
      externalRef: "[redacted]",
    };
    const app = createApp();
    const create = request(app).post(`/api/companies/${companyId}/issues`);
    if (actor === "agent") create.set("Authorization", `Bearer ${token}`);
    const created = await create.send({
        title: "Monitor deployment",
        status: actor === "board" ? "in_review" : "blocked",
        assigneeAgentId: agentId,
        executionPolicy: { monitor },
      })
      .expect(201);
    const fresh = await request(app).get(`/api/issues/${created.body.id}`).expect(200);
    for (const response of [created.body, fresh.body]) {
      expect(response.monitorNextCheckAt).toBe(monitor.nextCheckAt);
      expect(response.executionPolicy.monitor).toEqual(savedMonitor);
      expect(response.executionState.monitor).toMatchObject({ ...savedMonitor, status: "scheduled" });
      expect(response.monitorScheduledBy).toBe(savedMonitor.scheduledBy);
      expect(response.monitorNotes).toBe(savedMonitor.notes);
      expect(JSON.stringify(response)).not.toContain(monitor.externalRef);
    }
    const [stored] = await db.select().from(issues).where(eq(issues.id, created.body.id));
    expect(stored.monitorNextCheckAt?.toISOString()).toBe(monitor.nextCheckAt);
    expect(stored.executionPolicy?.monitor).toEqual(savedMonitor);
    expect(stored.executionState?.monitor).toMatchObject({ ...savedMonitor, status: "scheduled" });
    expect(stored.monitorScheduledBy).toBe(savedMonitor.scheduledBy);
    expect(stored.monitorNotes).toBe(savedMonitor.notes);
    expect(JSON.stringify(stored)).not.toContain(monitor.externalRef);
    if (actor === "agent") {
      // A parentless agent create writes its audit row fire-and-forget; wait for it so the
      // redaction check below covers it and cleanup cannot race the late insert.
      await vi.waitFor(async () => {
        const audit = await db.select().from(activityLog).where(and(
          eq(activityLog.entityId, created.body.id),
          eq(activityLog.action, "issue.created_without_parent"),
        ));
        expect(audit).toHaveLength(1);
      });
    }
    for (const rows of [
      await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)),
      await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
    ]) {
      expect(JSON.stringify(rows)).not.toContain(monitor.externalRef);
    }
  });

  it.each([false, true])("refuses top-level monitor fields without a partial create (nested monitor: %s)", async (includeNestedMonitor) => {
    const companyId = await seedCompany();
    const fields = {
      monitorNextCheckAt: "2099-12-01T12:00:00.000Z",
      monitorRecoveryPolicy: "escalate_to_board",
      monitorServiceName: "deployment-health",
      monitorMaxAttempts: 3,
    };
    const response = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Unsupported top-level monitor",
        ...fields,
        ...(includeNestedMonitor
          ? { executionPolicy: { monitor: { nextCheckAt: fields.monitorNextCheckAt } } }
          : {}),
      })
      .expect(400);
    for (const field of Object.keys(fields)) {
      expect(response.body.error).toContain(field);
    }
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toEqual([]);
  });

  it("names every permitted status when refusing an unschedulable monitor", async () => {
    const companyId = await seedCompany();
    const { agentId } = await seedMonitorOwner(companyId);
    const response = await request(createApp())
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Invalid monitor status",
        status: "todo",
        assigneeAgentId: agentId,
        executionPolicy: { monitor: { nextCheckAt: "2099-12-01T12:00:00.000Z" } },
      })
      .expect(422);
    expect(response.body.error).toBe("Monitor can only be scheduled on issues assigned to an agent in in_progress, in_review, or blocked");
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toEqual([]);
  });

  it.each([
    ["create", false], ["create", true], ["update", false], ["update", true],
  ] as const)("MCP %s refuses top-level monitor fields without saving (nested monitor: %s)", async (operation, includeNestedMonitor) => {
    const companyId = await seedCompany();
    const owner = await seedMonitorOwner(companyId);
    const monitor = {
      nextCheckAt: "2099-12-01T12:00:00.000Z",
      serviceName: "deployment-health",
      maxAttempts: 3,
      recoveryPolicy: "escalate_to_board",
    };
    await withMcpClient(companyId, owner, async (client) => {
      const { tools } = await client.listTools();
      for (const name of ["paperclipCreateIssue", "paperclipUpdateIssue"]) {
        expect(tools.find((tool) => tool.name === name)?.inputSchema.additionalProperties).toBe(false);
      }
      // A valid nested create must still reach the real route and database.
      const created = await client.callTool({
        name: "paperclipCreateIssue",
        arguments: {
          title: "MCP monitor",
          status: "in_review",
          assigneeAgentId: owner.agentId,
          executionPolicy: { monitor },
        },
      });
      expect(created.isError).not.toBe(true);
      const [baseline] = await db.select().from(issues).where(eq(issues.companyId, companyId));
      expect(baseline, JSON.stringify(created.content)).toBeDefined();
      expect(baseline.executionPolicy?.monitor).toMatchObject(monitor);
      await db.update(heartbeatRuns)
        .set({ contextSnapshot: { issueId: baseline.id } })
        .where(eq(heartbeatRuns.id, owner.runId));
      const originalRows = await db.select().from(issues).where(eq(issues.companyId, companyId));
      const fields = {
        monitorNextCheckAt: monitor.nextCheckAt,
        monitorRecoveryPolicy: monitor.recoveryPolicy,
        monitorServiceName: monitor.serviceName,
        monitorMaxAttempts: monitor.maxAttempts,
        monitorNotes: "Check health",
        monitorScheduledBy: "board",
        monitorKind: "external_service",
        monitorExternalRef: "fake-ref",
        monitorTimeoutAt: "2099-12-02T12:00:00.000Z",
        nextCheckAt: monitor.nextCheckAt,
        recoveryPolicy: monitor.recoveryPolicy,
        maxAttempts: monitor.maxAttempts,
        serviceName: monitor.serviceName,
        monitorPolicy: monitor,
        ...(operation === "create" ? { monitor } : {}),
      };
      for (const [field, value] of Object.entries(fields)) {
        const result = await client.callTool({
          name: operation === "create" ? "paperclipCreateIssue" : "paperclipUpdateIssue",
          arguments: {
            ...(operation === "create"
              ? { title: `Invalid ${field}`, status: "in_progress", assigneeAgentId: owner.agentId }
              : { issueId: baseline.id, title: `Invalid ${field}` }),
            [field]: value,
            ...(includeNestedMonitor ? { executionPolicy: { monitor } } : {}),
          },
        });
        expect(result.isError, field).toBe(true);
        expect(JSON.stringify(result.content)).toContain(field);
        expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toEqual(originalRows);
      }
      // The documented update-only monitor alias remains supported.
      if (operation === "update") {
        const conflict = await client.callTool({
          name: "paperclipUpdateIssue",
          arguments: { issueId: baseline.id, monitor, executionPolicy: { monitor } },
        });
        expect(conflict.isError).toBe(true);
        expect(JSON.stringify(conflict.content)).toContain("monitor");
        expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toEqual(originalRows);
        const updated = await client.callTool({
          name: "paperclipUpdateIssue",
          arguments: { issueId: baseline.id, monitor: { ...monitor, serviceName: "updated-health" } },
        });
        expect(updated.isError).not.toBe(true);
        const [stored] = await db.select().from(issues).where(eq(issues.id, baseline.id));
        expect(stored.executionPolicy?.monitor, JSON.stringify(updated.content)).toMatchObject({ serviceName: "updated-health" });
      }
    });
  });

  it("rejects the sibling parentIssueId spelling with a 400 naming the field", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    const app = createApp();

    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentIssueId: parent.id, title: "Child with wrong parent spelling" });

    // The strict create schema turns the unknown key into a 400 that names it —
    // never a 2xx that discards it.
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Unrecognized field(s): parentIssueId");

    // No issue was created, so there is nothing to silently drop.
    const rows = await db.select().from(issues).where(eq(issues.parentId, parent.id));
    expect(rows).toHaveLength(0);
  });

  // SUP-17538: the company-scoped create door must run the same non-authoritative
  // ADR-072 close-ladder advisory as the child-create and accepted-plan doors.
  // This runs against the real store, so the shared shape helper, the durable
  // dedup marker, and the system comment are all exercised end to end.
  it("emits the ADR-072 close-ladder advisory on the parent when the create reaches two laddered children", async () => {
    const companyId = await seedCompany();
    const parent = await seedParent(companyId);
    // Two ladder-carrying open children make the parent a decomposed body; the
    // parent's executionPolicy carries none of the ratified ADR-072 rungs, so
    // its close ladder is shape-incomplete.
    await db.insert(issues).values([
      {
        companyId,
        parentId: parent.id,
        title: "Laddered child A",
        status: "todo",
        priority: "medium",
        executionPolicy: {
          stages: [
            { id: randomUUID(), type: "review", participants: [{ type: "agent", agentId: randomUUID() }] },
          ],
        },
      },
      {
        companyId,
        parentId: parent.id,
        title: "Laddered child B",
        status: "todo",
        priority: "medium",
        executionPolicy: {
          stages: [
            { id: randomUUID(), type: "review", participants: [{ type: "agent", agentId: randomUUID() }] },
          ],
        },
      },
    ]);

    const app = createApp();
    const created = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ parentId: parent.id, title: "Third child" })
      .expect(201);
    expect(created.body.parentId).toBe(parent.id);

    // The durable marker is written on the PARENT, not the new child, so the
    // advisory is discoverable from the card that owes the ladder.
    const advisoryRows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, "issue.adr072_close_ladder_incomplete"),
          eq(activityLog.entityId, parent.id),
        ),
      );
    expect(advisoryRows).toHaveLength(1);

    const comments = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, parent.id));
    const advisories = comments.filter((row) =>
      (row.body ?? "").includes("[ADR-072 close ladder incomplete]"),
    );
    expect(advisories).toHaveLength(1);
    // Ratified order, all three rungs named.
    expect(advisories[0]!.body).toContain("review:support-QAE");
    expect(advisories[0]!.body).toContain("review:coder-LE");
    expect(advisories[0]!.body).toContain("approval:exec-CTO");
  });
});
