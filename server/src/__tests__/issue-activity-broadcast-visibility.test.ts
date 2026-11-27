import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issues,
} from "@paperclipai/db";
import type { LiveEvent, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { logActivity, setPluginEventBus } from "../services/activity-log.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue activity broadcast visibility tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const RESTRICTED_TITLE = "Restricted issue title";
const RESTRICTED_DESCRIPTION = "Restricted issue description body";

type Db = ReturnType<typeof createDb>;

async function waitFor(condition: () => boolean, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function seedCompany(db: Db) {
  const company = await db
    .insert(companies)
    .values({
      name: `Broadcast visibility ${randomUUID()}`,
      issuePrefix: `BV${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
  const userId = `user-${randomUUID()}`;
  const now = new Date();
  await db.insert(authUsers).values({
    id: userId,
    name: "Responsible user",
    email: `${userId}@example.test`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(companyMemberships).values({
    companyId: company.id,
    principalType: "user",
    principalId: userId,
    status: "active",
    membershipRole: "owner",
  });
  return { company, userId };
}

async function seedAgent(db: Db, companyId: string) {
  return db
    .insert(agents)
    .values({
      companyId,
      name: `Agent ${randomUUID()}`,
      role: "engineer",
      permissions: {},
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedIssue(db: Db, companyId: string, input: { title: string; description: string }) {
  return db
    .insert(issues)
    .values({
      companyId,
      title: input.title,
      description: input.description,
      status: "todo",
      priority: "medium",
    })
    .returning()
    .then((rows) => rows[0]!);
}

async function seedAgentKey(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    responsibleUserId: string;
    scopeConfig: Record<string, unknown> | null;
  },
) {
  const token = `pcp_test_${randomUUID()}`;
  await db.insert(agentApiKeys).values({
    agentId: input.agentId,
    companyId: input.companyId,
    name: "broadcast-visibility",
    keyHash: hashToken(token),
    responsibleUserId: input.responsibleUserId,
    scopeConfig: input.scopeConfig as never,
  });
  return token;
}

function logIssueCreated(db: Db, companyId: string, issue: { id: string; title: string; identifier: string | null; description: string | null }) {
  return logActivity(db, {
    companyId,
    actorType: "system",
    actorId: "system",
    action: "issue.created",
    entityType: "issue",
    entityId: issue.id,
    details: {
      title: issue.title,
      identifier: issue.identifier,
      description: issue.description,
    },
  });
}

function pluginManifest(id: string, capabilities: string[]): PaperclipPluginManifestV1 {
  return {
    id,
    apiVersion: 1,
    version: "0.0.1",
    displayName: id,
    description: "Broadcast visibility test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities,
    entrypoints: { worker: "./dist/worker.js" },
  } as unknown as PaperclipPluginManifestV1;
}

describeEmbeddedPostgres("issue activity broadcast visibility", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let server: Server | null = null;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-activity-broadcast-visibility-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    if (server) {
      const closing = server;
      server = null;
      await new Promise<void>((resolve) => closing.close(() => resolve()));
    }
    await db.delete(activityLog);
    await db.delete(agentApiKeys);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function startLiveEventsServer() {
    const httpServer = createServer();
    setupLiveEventsWebSocketServer(httpServer, db, { deploymentMode: "authenticated" });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    server = httpServer;
    return (httpServer.address() as AddressInfo).port;
  }

  async function connect(port: number, companyId: string, token: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/companies/${companyId}/events/ws`, {
      headers: { authorization: `Bearer ${token}` },
    });
    sockets.push(socket);
    const received: LiveEvent[] = [];
    socket.on("message", (data) => {
      received.push(JSON.parse(data.toString()) as LiveEvent);
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
      socket.once("unexpected-response", (_req, res) => reject(new Error(`upgrade rejected: ${res.statusCode}`)));
    });
    return received;
  }

  it("withholds a restricted issue's created activity from a live-events subscriber that cannot read it", async () => {
    const { company, userId } = await seedCompany(db);
    const restrictedIssue = await seedIssue(db, company.id, {
      title: RESTRICTED_TITLE,
      description: RESTRICTED_DESCRIPTION,
    });
    const ownIssue = await seedIssue(db, company.id, {
      title: "Skill-test harness issue",
      description: "Visible to the scoped key",
    });
    const scopedAgent = await seedAgent(db, company.id);
    const readerAgent = await seedAgent(db, company.id);
    // A skill-test key may read only its own harness issue, so GET on the
    // restricted issue answers 403 for it.
    const nonReaderToken = await seedAgentKey(db, {
      companyId: company.id,
      agentId: scopedAgent.id,
      responsibleUserId: userId,
      scopeConfig: { kind: "skill_test", issueId: ownIssue.id },
    });
    const readerToken = await seedAgentKey(db, {
      companyId: company.id,
      agentId: readerAgent.id,
      responsibleUserId: userId,
      scopeConfig: null,
    });

    const port = await startLiveEventsServer();
    const nonReaderEvents = await connect(port, company.id, nonReaderToken);
    const readerEvents = await connect(port, company.id, readerToken);

    await logIssueCreated(db, company.id, restrictedIssue);
    // A later event the scoped key can read proves the earlier one was
    // processed for that socket rather than still in flight.
    await logIssueCreated(db, company.id, ownIssue);

    const isActivityFor = (issueId: string) => (event: LiveEvent) =>
      event.type === "activity.logged" && event.payload.entityId === issueId;
    await waitFor(() => nonReaderEvents.some(isActivityFor(ownIssue.id)));
    await waitFor(() => readerEvents.some(isActivityFor(ownIssue.id)));

    const nonReaderWire = JSON.stringify(nonReaderEvents);
    expect(nonReaderWire).not.toContain(RESTRICTED_DESCRIPTION);
    expect(nonReaderWire).not.toContain(RESTRICTED_TITLE);
    expect(nonReaderEvents.some(isActivityFor(restrictedIssue.id))).toBe(false);

    // A subscriber that can read the issue still receives the full payload.
    const readerRestricted = readerEvents.find(isActivityFor(restrictedIssue.id));
    expect(readerRestricted?.payload.details).toMatchObject({
      title: RESTRICTED_TITLE,
      description: RESTRICTED_DESCRIPTION,
    });
  });

  it("withholds issue activity from a key without a responsible user and strips details of a missing issue", async () => {
    const { company, userId } = await seedCompany(db);
    const issue = await seedIssue(db, company.id, {
      title: RESTRICTED_TITLE,
      description: RESTRICTED_DESCRIPTION,
    });
    const agent = await seedAgent(db, company.id);
    // The HTTP API refuses every request from a key that names no responsible user.
    const orphanToken = `pcp_test_${randomUUID()}`;
    await db.insert(agentApiKeys).values({
      agentId: agent.id,
      companyId: company.id,
      name: "no-responsible-user",
      keyHash: hashToken(orphanToken),
      responsibleUserId: null,
    });
    const readerToken = await seedAgentKey(db, {
      companyId: company.id,
      agentId: agent.id,
      responsibleUserId: userId,
      scopeConfig: null,
    });

    const port = await startLiveEventsServer();
    const orphanEvents = await connect(port, company.id, orphanToken);
    const readerEvents = await connect(port, company.id, readerToken);

    const missingIssueId = randomUUID();
    await logIssueCreated(db, company.id, issue);
    await logActivity(db, {
      companyId: company.id,
      actorType: "system",
      actorId: "system",
      action: "issue.deleted",
      entityType: "issue",
      entityId: missingIssueId,
      details: { title: RESTRICTED_TITLE },
    });
    await logActivity(db, {
      companyId: company.id,
      actorType: "system",
      actorId: "system",
      action: "agent.updated",
      entityType: "agent",
      entityId: agent.id,
      details: {},
    });

    const isAgentActivity = (event: LiveEvent) => event.payload.entityType === "agent";
    await waitFor(() => orphanEvents.some(isAgentActivity));
    await waitFor(() => readerEvents.some(isAgentActivity));

    expect(JSON.stringify(orphanEvents)).not.toContain(RESTRICTED_DESCRIPTION);
    expect(orphanEvents.some((event) => event.payload.entityType === "issue")).toBe(false);

    const missing = readerEvents.find((event) => event.payload.entityId === missingIssueId);
    expect(missing?.payload).toMatchObject({ action: "issue.deleted", details: null });
    expect(readerEvents.find((event) => event.payload.entityId === issue.id)?.payload.details)
      .toMatchObject({ description: RESTRICTED_DESCRIPTION });
  });

  it("withholds the issue description from a plugin that cannot read the issue", async () => {
    const { company } = await seedCompany(db);
    const restrictedIssue = await seedIssue(db, company.id, {
      title: RESTRICTED_TITLE,
      description: RESTRICTED_DESCRIPTION,
    });
    const bus = createPluginEventBus();
    setPluginEventBus(bus);

    const deliveries = new Map<string, PluginEvent[]>();
    async function subscribePlugin(pluginKey: string, capabilities: string[]) {
      const received: PluginEvent[] = [];
      deliveries.set(pluginKey, received);
      const services = buildHostServices(
        db,
        randomUUID(),
        pluginKey,
        bus,
        (method, params) => {
          if (method === "onEvent") received.push((params as { event: PluginEvent }).event);
        },
        { manifest: pluginManifest(pluginKey, capabilities) },
      );
      await services.events.subscribe({ eventPattern: "issue.created" });
      return { received, services };
    }

    const nonReader = await subscribePlugin("paperclip.broadcast-non-reader", ["events.subscribe"]);
    const reader = await subscribePlugin("paperclip.broadcast-reader", ["events.subscribe", "issues.read"]);

    try {
      await logIssueCreated(db, company.id, restrictedIssue);
      await waitFor(() => nonReader.received.length > 0 && reader.received.length > 0);

      const nonReaderEvent = nonReader.received[0]!;
      expect(nonReaderEvent.entityId).toBe(restrictedIssue.id);
      expect(JSON.stringify(nonReader.received)).not.toContain(RESTRICTED_DESCRIPTION);
      expect(nonReaderEvent.payload).toMatchObject({ title: RESTRICTED_TITLE });

      // A plugin granted issues.read still receives the full payload.
      expect(reader.received[0]!.payload).toMatchObject({
        title: RESTRICTED_TITLE,
        description: RESTRICTED_DESCRIPTION,
      });
    } finally {
      nonReader.services.dispose();
      reader.services.dispose();
    }
  });
});
