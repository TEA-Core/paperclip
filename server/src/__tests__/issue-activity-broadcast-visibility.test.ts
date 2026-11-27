import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  instanceUserRoles,
  issues,
} from "@paperclipai/db";
import type { LiveEvent, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { logActivity, setPluginEventBus } from "../services/activity-log.js";
import { publishLiveEvent } from "../services/live-events.js";
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
const RESTRICTED_DOCUMENT_TITLE = "Restricted document title";

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
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(instanceUserRoles);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function startLiveEventsServer(
    options: { resolveSessionFromHeaders?: () => Promise<BetterAuthSessionResult | null> } = {},
  ) {
    const httpServer = createServer();
    setupLiveEventsWebSocketServer(httpServer, db, { deploymentMode: "authenticated", ...options });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    server = httpServer;
    return (httpServer.address() as AddressInfo).port;
  }

  /** Connects with an agent key, or with the stubbed board session when `token` is null. */
  async function connect(port: number, companyId: string, token: string | null) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/companies/${companyId}/events/ws`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
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

  const isActivityFor = (issueId: string) => (event: LiveEvent) =>
    event.type === "activity.logged" && event.payload.entityId === issueId;

  async function seedScopedAndReaderKeys(companyId: string, userId: string, ownIssueId: string) {
    const scopedAgent = await seedAgent(db, companyId);
    const readerAgent = await seedAgent(db, companyId);
    // A skill-test key may read only its own harness issue, so GET on any
    // other issue answers 403 for it.
    const nonReaderToken = await seedAgentKey(db, {
      companyId,
      agentId: scopedAgent.id,
      responsibleUserId: userId,
      scopeConfig: { kind: "skill_test", issueId: ownIssueId },
    });
    const readerToken = await seedAgentKey(db, {
      companyId,
      agentId: readerAgent.id,
      responsibleUserId: userId,
      scopeConfig: null,
    });
    return { scopedAgent, nonReaderToken, readerToken };
  }

  it("withholds a restricted issue's content from a live-events subscriber that cannot read it", async () => {
    const { company, userId } = await seedCompany(db);
    const restrictedIssue = await seedIssue(db, company.id, {
      title: RESTRICTED_TITLE,
      description: RESTRICTED_DESCRIPTION,
    });
    const ownIssue = await seedIssue(db, company.id, {
      title: "Skill-test harness issue",
      description: "Visible to the scoped key",
    });
    const { nonReaderToken, readerToken } = await seedScopedAndReaderKeys(company.id, userId, ownIssue.id);

    const port = await startLiveEventsServer();
    const nonReaderEvents = await connect(port, company.id, nonReaderToken);
    const readerEvents = await connect(port, company.id, readerToken);

    await logIssueCreated(db, company.id, restrictedIssue);
    // A later event the scoped key can read proves the earlier one was
    // processed for that socket rather than still in flight.
    await logIssueCreated(db, company.id, ownIssue);

    await waitFor(() => nonReaderEvents.some(isActivityFor(ownIssue.id)));
    await waitFor(() => readerEvents.some(isActivityFor(ownIssue.id)));

    expect(JSON.stringify(nonReaderEvents)).not.toContain(RESTRICTED_DESCRIPTION);
    // Only the content is withheld: the entry keeps its identifiers and metadata.
    const nonReaderRestricted = nonReaderEvents.find(isActivityFor(restrictedIssue.id));
    expect(nonReaderRestricted?.payload).toMatchObject({
      action: "issue.created",
      entityType: "issue",
      entityId: restrictedIssue.id,
      details: { title: RESTRICTED_TITLE, identifier: restrictedIssue.identifier },
    });
    expect(nonReaderRestricted?.payload.details).not.toHaveProperty("description");

    // A subscriber that can read the issue still receives the full payload.
    const readerRestricted = readerEvents.find(isActivityFor(restrictedIssue.id));
    expect(readerRestricted?.payload.details).toMatchObject({
      title: RESTRICTED_TITLE,
      description: RESTRICTED_DESCRIPTION,
    });
  });

  it("strips the titles of unreadable referenced issues from activity the subscriber can read", async () => {
    const { company, userId } = await seedCompany(db);
    const restrictedIssue = await seedIssue(db, company.id, {
      title: RESTRICTED_TITLE,
      description: RESTRICTED_DESCRIPTION,
    });
    const ownIssue = await seedIssue(db, company.id, {
      title: "Skill-test harness issue",
      description: "Visible to the scoped key",
    });
    const { nonReaderToken, readerToken } = await seedScopedAndReaderKeys(company.id, userId, ownIssue.id);

    const port = await startLiveEventsServer();
    const nonReaderEvents = await connect(port, company.id, nonReaderToken);
    const readerEvents = await connect(port, company.id, readerToken);

    const restrictedSummary = { id: restrictedIssue.id, identifier: restrictedIssue.identifier, title: RESTRICTED_TITLE };
    const ownSummary = { id: ownIssue.id, identifier: ownIssue.identifier, title: ownIssue.title };
    const details = {
      key: "plan",
      addedReferencedIssues: [restrictedSummary, ownSummary],
      currentReferencedIssues: [restrictedSummary, ownSummary],
      blockedByIssues: [restrictedSummary],
    };
    await logActivity(db, {
      companyId: company.id,
      actorType: "system",
      actorId: "system",
      action: "issue.document_updated",
      entityType: "issue",
      entityId: ownIssue.id,
      details,
    });

    await waitFor(() => nonReaderEvents.some(isActivityFor(ownIssue.id)));
    await waitFor(() => readerEvents.some(isActivityFor(ownIssue.id)));

    expect(JSON.stringify(nonReaderEvents)).not.toContain(RESTRICTED_TITLE);
    const strippedSummary = { id: restrictedIssue.id, identifier: restrictedIssue.identifier };
    expect(nonReaderEvents.find(isActivityFor(ownIssue.id))?.payload.details).toEqual({
      key: "plan",
      addedReferencedIssues: [strippedSummary, ownSummary],
      currentReferencedIssues: [strippedSummary, ownSummary],
      blockedByIssues: [strippedSummary],
    });
    expect(readerEvents.find(isActivityFor(ownIssue.id))?.payload.details).toEqual(details);
  });

  it("withholds a restricted issue's document quote from a subscriber that cannot read it and keeps the document title", async () => {
    const { company, userId } = await seedCompany(db);
    const restrictedIssue = await seedIssue(db, company.id, {
      title: RESTRICTED_TITLE,
      description: RESTRICTED_DESCRIPTION,
    });
    const ownIssue = await seedIssue(db, company.id, {
      title: "Skill-test harness issue",
      description: "Visible to the scoped key",
    });
    const { nonReaderToken, readerToken } = await seedScopedAndReaderKeys(company.id, userId, ownIssue.id);

    const port = await startLiveEventsServer();
    const nonReaderEvents = await connect(port, company.id, nonReaderToken);
    const readerEvents = await connect(port, company.id, readerToken);

    const quoteDetails = { key: "plan", documentKey: "plan", threadId: "thread-1", quote: RESTRICTED_DESCRIPTION };
    const documentDetails = { key: "plan", documentId: "doc-1", title: RESTRICTED_DOCUMENT_TITLE, revisionNumber: 2 };
    for (const [action, details] of [
      ["issue.document_annotation_thread_created", quoteDetails],
      ["issue.document_updated", documentDetails],
    ] as const) {
      await logActivity(db, {
        companyId: company.id,
        actorType: "system",
        actorId: "system",
        action,
        entityType: "issue",
        entityId: restrictedIssue.id,
        details,
      });
    }
    await logIssueCreated(db, company.id, ownIssue);

    await waitFor(() => nonReaderEvents.some(isActivityFor(ownIssue.id)));
    await waitFor(() => readerEvents.some(isActivityFor(ownIssue.id)));

    const restrictedDetails = (events: LiveEvent[]) =>
      events.filter(isActivityFor(restrictedIssue.id)).map((event) => event.payload.details);
    expect(JSON.stringify(nonReaderEvents)).not.toContain(RESTRICTED_DESCRIPTION);
    // Titles are metadata: the document title stays, like the issue's own title.
    expect(restrictedDetails(nonReaderEvents)).toEqual([
      { key: "plan", documentKey: "plan", threadId: "thread-1" },
      documentDetails,
    ]);
    expect(restrictedDetails(readerEvents)).toEqual([quoteDetails, documentDetails]);
    expect(nonReaderEvents.find(isActivityFor(ownIssue.id))?.payload.details).toMatchObject({ title: ownIssue.title });
  });

  it("sends a non-reader only the metadata of nested issue-update details", async () => {
    const { company, userId } = await seedCompany(db);
    const restrictedIssue = await seedIssue(db, company.id, {
      title: RESTRICTED_TITLE,
      description: RESTRICTED_DESCRIPTION,
    });
    const ownIssue = await seedIssue(db, company.id, {
      title: "Skill-test harness issue",
      description: "Visible to the scoped key",
    });
    const { nonReaderToken, readerToken } = await seedScopedAndReaderKeys(company.id, userId, ownIssue.id);

    const port = await startLiveEventsServer();
    const nonReaderEvents = await connect(port, company.id, nonReaderToken);
    const readerEvents = await connect(port, company.id, readerToken);

    const details = {
      identifier: restrictedIssue.identifier,
      title: RESTRICTED_TITLE,
      status: "in_progress",
      description: RESTRICTED_DESCRIPTION,
      labelIds: ["label-1"],
      changes: {
        status: { from: "todo", to: "in_progress" },
        description: { from: "Restricted previous description", to: RESTRICTED_DESCRIPTION },
      },
      _previous: { status: "todo", description: "Restricted previous description" },
    };
    await logActivity(db, {
      companyId: company.id,
      actorType: "system",
      actorId: "system",
      action: "issue.updated",
      entityType: "issue",
      entityId: restrictedIssue.id,
      details,
    });
    await logIssueCreated(db, company.id, ownIssue);

    await waitFor(() => nonReaderEvents.some(isActivityFor(ownIssue.id)));
    await waitFor(() => readerEvents.some(isActivityFor(ownIssue.id)));

    expect(JSON.stringify(nonReaderEvents)).not.toContain("Restricted previous description");
    expect(JSON.stringify(nonReaderEvents)).not.toContain(RESTRICTED_DESCRIPTION);
    expect(nonReaderEvents.find(isActivityFor(restrictedIssue.id))?.payload.details).toEqual({
      identifier: restrictedIssue.identifier,
      title: RESTRICTED_TITLE,
      status: "in_progress",
      labelIds: ["label-1"],
      changes: { status: { from: "todo", to: "in_progress" } },
      _previous: { status: "todo" },
    });
    expect(readerEvents.find(isActivityFor(restrictedIssue.id))?.payload.details).toEqual(details);
  });

  it("sends activity about a non-issue entity unchanged to a subscriber without company-wide read", async () => {
    const { company, userId } = await seedCompany(db);
    const ownIssue = await seedIssue(db, company.id, {
      title: "Skill-test harness issue",
      description: "Visible to the scoped key",
    });
    const { scopedAgent, nonReaderToken } = await seedScopedAndReaderKeys(company.id, userId, ownIssue.id);

    const port = await startLiveEventsServer();
    const scopedEvents = await connect(port, company.id, nonReaderToken);

    const details = {
      name: "Renamed agent",
      changes: { name: { from: "Old agent", to: "Renamed agent" } },
      reason: "Free-text reason for the rename",
    };
    await logActivity(db, {
      companyId: company.id,
      actorType: "system",
      actorId: "system",
      action: "agent.updated",
      entityType: "agent",
      entityId: scopedAgent.id,
      details,
    });

    const isAgentActivity = (event: LiveEvent) => event.payload.entityType === "agent";
    await waitFor(() => scopedEvents.some(isAgentActivity));

    expect(scopedEvents.find(isAgentActivity)?.payload.details).toEqual(details);
  });

  it("sends run output that names no issue only as metadata to a subscriber without company-wide read", async () => {
    const { company, userId } = await seedCompany(db);
    const ownIssue = await seedIssue(db, company.id, {
      title: "Skill-test harness issue",
      description: "Visible to the scoped key",
    });
    const { scopedAgent, nonReaderToken, readerToken } = await seedScopedAndReaderKeys(company.id, userId, ownIssue.id);
    // The run's context names no issue, so no issue read decides its output.
    const run = await db
      .insert(heartbeatRuns)
      .values({ companyId: company.id, agentId: scopedAgent.id, status: "running", contextSnapshot: {} })
      .returning()
      .then((rows) => rows[0]!);

    const port = await startLiveEventsServer();
    const scopedEvents = await connect(port, company.id, nonReaderToken);
    const readerEvents = await connect(port, company.id, readerToken);

    const progress = {
      runId: run.id,
      agentId: scopedAgent.id,
      issueId: null,
      phase: "working",
      message: RESTRICTED_DESCRIPTION,
      lastAssistantSnippet: RESTRICTED_DESCRIPTION,
    };
    publishLiveEvent({ companyId: company.id, type: "heartbeat.run.progress", payload: progress });
    publishLiveEvent({ companyId: company.id, type: "agent.status", payload: { agentId: scopedAgent.id, status: "idle" } });

    const isAgentStatus = (event: LiveEvent) => event.type === "agent.status";
    await waitFor(() => scopedEvents.some(isAgentStatus));
    await waitFor(() => readerEvents.some(isAgentStatus));

    expect(JSON.stringify(scopedEvents)).not.toContain(RESTRICTED_DESCRIPTION);
    expect(scopedEvents[0]!.payload).toEqual({ runId: run.id, agentId: scopedAgent.id, issueId: null, phase: "working" });
    // A subscriber with company-wide read still receives the full event.
    expect(readerEvents[0]!.payload).toEqual(progress);
  });

  it("sends run and goal events about an unreadable issue without their issue content", async () => {
    const { company, userId } = await seedCompany(db);
    const restrictedIssue = await seedIssue(db, company.id, {
      title: RESTRICTED_TITLE,
      description: RESTRICTED_DESCRIPTION,
    });
    const ownIssue = await seedIssue(db, company.id, {
      title: "Skill-test harness issue",
      description: "Visible to the scoped key",
    });
    const { scopedAgent, nonReaderToken, readerToken } = await seedScopedAndReaderKeys(company.id, userId, ownIssue.id);
    const run = await db
      .insert(heartbeatRuns)
      .values({ companyId: company.id, agentId: scopedAgent.id, status: "running", contextSnapshot: { issueId: restrictedIssue.id } })
      .returning()
      .then((rows) => rows[0]!);

    const port = await startLiveEventsServer();
    const nonReaderEvents = await connect(port, company.id, nonReaderToken);
    const readerEvents = await connect(port, company.id, readerToken);

    const progress = {
      runId: run.id,
      agentId: scopedAgent.id,
      issueId: restrictedIssue.id,
      phase: "working",
      message: RESTRICTED_DESCRIPTION,
      currentToolName: "Bash",
      lastAssistantSnippet: RESTRICTED_DESCRIPTION,
    };
    // A run event that does not name its issue still concerns the run's issue.
    const status = {
      runId: run.id,
      agentId: scopedAgent.id,
      issueId: null,
      status: "failed",
      errorCode: "adapter_failed",
      error: RESTRICTED_DESCRIPTION,
      finalText: RESTRICTED_DESCRIPTION,
    };
    const runEvent = {
      runId: run.id,
      agentId: scopedAgent.id,
      issueId: restrictedIssue.id,
      seq: 1,
      eventType: "assistant",
      message: RESTRICTED_DESCRIPTION,
      error: null,
      lastAssistantSnippet: null,
      payload: { text: RESTRICTED_DESCRIPTION },
    };
    const log = { runId: run.id, agentId: scopedAgent.id, issueId: restrictedIssue.id, seq: 1, stream: "stdout", chunk: RESTRICTED_DESCRIPTION };
    const goal = {
      issueId: restrictedIssue.id,
      agentId: scopedAgent.id,
      revision: 3,
      goal: { objective: RESTRICTED_DESCRIPTION, lastReason: RESTRICTED_DESCRIPTION, status: "active", iterations: 2 },
    };
    publishLiveEvent({ companyId: company.id, type: "heartbeat.run.progress", payload: progress });
    publishLiveEvent({ companyId: company.id, type: "heartbeat.run.status", payload: status });
    publishLiveEvent({ companyId: company.id, type: "heartbeat.run.event", payload: runEvent });
    publishLiveEvent({ companyId: company.id, type: "heartbeat.run.log", payload: log });
    publishLiveEvent({ companyId: company.id, type: "agent.session.goal.changed", payload: goal });
    // An event without issue content reaches every subscriber and marks the end of the batch.
    publishLiveEvent({
      companyId: company.id,
      type: "agent.status",
      payload: { agentId: scopedAgent.id, status: "idle" },
    });

    const isAgentStatus = (event: LiveEvent) => event.type === "agent.status";
    await waitFor(() => nonReaderEvents.some(isAgentStatus));
    await waitFor(() => readerEvents.some(isAgentStatus));

    expect(JSON.stringify(nonReaderEvents)).not.toContain(RESTRICTED_DESCRIPTION);
    // Only metadata passes: identifiers, states, enums, counters and timestamps.
    expect(nonReaderEvents.map((event) => event.payload)).toEqual([
      { runId: run.id, agentId: scopedAgent.id, issueId: restrictedIssue.id, phase: "working", currentToolName: "Bash" },
      { runId: run.id, agentId: scopedAgent.id, issueId: null, status: "failed", errorCode: "adapter_failed" },
      { runId: run.id, agentId: scopedAgent.id, issueId: restrictedIssue.id, seq: 1, eventType: "assistant" },
      { runId: run.id, agentId: scopedAgent.id, issueId: restrictedIssue.id, seq: 1, stream: "stdout" },
      { issueId: restrictedIssue.id, agentId: scopedAgent.id, revision: 3, goal: { status: "active" } },
      { agentId: scopedAgent.id, status: "idle" },
    ]);
    // A subscriber that can read the issue still receives every event in full.
    expect(readerEvents.map((event) => event.payload)).toEqual([
      progress,
      status,
      runEvent,
      log,
      goal,
      { agentId: scopedAgent.id, status: "idle" },
    ]);
  });

  it("stops sending issue content to a session once its instance-admin role is removed", async () => {
    const { company } = await seedCompany(db);
    const firstIssue = await seedIssue(db, company.id, {
      title: RESTRICTED_TITLE,
      description: RESTRICTED_DESCRIPTION,
    });
    const secondIssue = await seedIssue(db, company.id, {
      title: "Second restricted title",
      description: RESTRICTED_DESCRIPTION,
    });
    // An instance admin with no company membership reads issues only through the role.
    const adminUserId = `admin-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: adminUserId,
      name: "Instance admin",
      email: `${adminUserId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(instanceUserRoles).values({ userId: adminUserId, role: "instance_admin" });

    const port = await startLiveEventsServer({
      resolveSessionFromHeaders: async () => ({
        session: { id: `session-${randomUUID()}`, userId: adminUserId },
        user: { id: adminUserId },
      }),
    });
    const events = await connect(port, company.id, null);

    await logIssueCreated(db, company.id, firstIssue);
    await waitFor(() => events.some(isActivityFor(firstIssue.id)));
    expect(events.find(isActivityFor(firstIssue.id))?.payload.details).toMatchObject({
      description: RESTRICTED_DESCRIPTION,
    });

    await db.delete(instanceUserRoles).where(eq(instanceUserRoles.userId, adminUserId));
    await logIssueCreated(db, company.id, secondIssue);
    await waitFor(() => events.some(isActivityFor(secondIssue.id)));

    const afterRemoval = events.find(isActivityFor(secondIssue.id));
    expect(afterRemoval?.payload.details).toMatchObject({ title: "Second restricted title" });
    expect(afterRemoval?.payload.details).not.toHaveProperty("description");
  });

  it("withholds issue content from a key without a responsible user and strips details of a missing issue", async () => {
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
    expect(orphanEvents.find((event) => event.payload.entityId === issue.id)?.payload.details)
      .toMatchObject({ title: RESTRICTED_TITLE });

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
