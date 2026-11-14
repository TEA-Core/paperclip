import { projectService } from "../services/projects.js";
import { callProjectTool } from "../services/project-tools.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, issues, heartbeatRuns, projects, companyMemberships, executionWorkspaces } from "@paperclipai/db";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";
import { issueService } from "../services/issues.js";
import { documentService } from "../services/documents.js";
import { activityService } from "../services/activity.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("chat project tool handoff", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  beforeAll(async () => { process.env.PAPERCLIP_AGENT_JWT_SECRET = randomUUID(); server = await startRunnerApiTestServer(); }, 60_000);
  afterAll(async () => { await server?.close(); if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET; else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret; });
  const call = (fixture: Awaited<ReturnType<typeof server.fixture>>, tool: string, args: Record<string, unknown>) => fixture.authority.execute({ tool, arguments: args, callId: randomUUID() });
  // Fork-only (fold-s3b, captain ruling): upstream #14870 scoped low-trust task creation is not
  // taken on the HTTP creation endpoints. Both keep the base blanket refusal for low-trust agents,
  // and the MCP create_task tool calls them, so those creates are refused before any boundary,
  // scope or assignee check and nothing is written. The native create_task tool does not use
  // these routes; before #14870 it had no create authorization at all, so it keeps upstream's
  // new tasks:assign and containment checks (stricter than the base) unchanged.
  const LOW_TRUST_CREATE_REFUSAL = "Low-trust actors cannot use this control-plane surface";

  it("pages only visible projects and prefilters low-trust agent and run scopes", async () => {
    const f = await server.fixture({ disableWakeOnDemand: true });
    const ids = Array.from({ length: 53 }, (_, i) => `abcdefab-0000-4000-8000-${String(i).padStart(12, "0")}`);
    await server.db.insert(projects).values(ids.map((id, i) => ({
      id, companyId: f.companyId, name: `Project ${i}`, status: "in_progress",
      description: "日本語🦀".repeat(5_000), executionWorkspacePolicy: { oversized: "x".repeat(20_000) },
    })));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const toolInput = { name: "list_projects", apiUrl: server.apiUrl, token, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, conversation: false };
    const first = await callProjectTool({ ...toolInput, arguments: {} });
    expect(first.projects).toHaveLength(50);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(256 * 1024);
    expect(first.projects.find((p: { id: string }) => p.id === ids[0])).toMatchObject({ descriptionTruncated: true });
    expect(first.projects.every((p: object) => !Object.hasOwn(p, "executionWorkspacePolicy") && !Object.hasOwn(p, "workspaces"))).toBe(true);
    const last = await callProjectTool({ ...toolInput, arguments: { cursor: first.nextCursor } });
    expect([...first.projects, ...last.projects].map((p: { id: string }) => p.id).sort()).toEqual([...ids, f.projectId].sort());
    expect(last.nextCursor).toBeNull();
    // A permitted project beyond the first database batch must remain discoverable.
    const policy = { trustPreset: "low_trust_review", authorizationPolicy: { trustBoundary: { mode: "low_trust_review", companyId: f.companyId, projectIds: ids.slice(-2) } } };
    await server.db.update(agents).set({ permissions: policy }).where(eq(agents.id, f.agentId));
    expect((await projectService(server.db).listSummaries(f.companyId, {
      limit: 51, includeArchived: false, candidateIds: ids.slice(-2),
    })).map(p => p.id)).toEqual(ids.slice(-2));
    const restricted = await callProjectTool({ ...toolInput, arguments: { limit: 1 } });
    expect(restricted.projects.map((p: { id: string }) => p.id)).toEqual([ids[51]]);
    expect(restricted.nextCursor).toBe(ids[51]);
    const restrictedLast = await callProjectTool({ ...toolInput, arguments: { limit: 1, cursor: restricted.nextCursor } });
    expect(restrictedLast.projects.map((p: { id: string }) => p.id)).toEqual([ids[52]]);
    expect(restrictedLast.nextCursor).toBeNull();
    // A run-only boundary also restricts the database candidates.
    await server.db.update(agents).set({ permissions: {} }).where(eq(agents.id, f.agentId));
    const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await server.db.update(heartbeatRuns).set({ contextSnapshot: { ...run.contextSnapshot, executionPolicy: policy } }).where(eq(heartbeatRuns.id, f.runId));
    const runRestricted = await callProjectTool({ ...toolInput, arguments: {} });
    expect(runRestricted.projects.map((p: { id: string }) => p.id)).toEqual(ids.slice(-2));
    expect(runRestricted.nextCursor).toBeNull();
    // Adding denied projects must not change either the visible page or cursor.
    await server.db.insert(projects).values({ companyId: f.companyId, name: "Hidden" });
    expect(await callProjectTool({ ...toolInput, arguments: {} })).toEqual(runRestricted);
    // Project policy may contribute a root scope, so candidate narrowing must
    // not suppress a project that the full authorization decision permits.
    await server.db.update(projects).set({ executionWorkspacePolicy: {
      authorizationPolicy: { trustBoundary: { mode: "low_trust_review", companyId: f.companyId, rootIssueId: f.issueId } },
    } }).where(eq(projects.id, f.projectId));
    const withProjectScope = await callProjectTool({ ...toolInput, arguments: {} });
    expect(withProjectScope.projects.map((p: { id: string }) => p.id).sort()).toEqual([...ids.slice(-2), f.projectId].sort());
    expect(withProjectScope.nextCursor).toBeNull();
  });

  it("allows a conversation reply to enter review without manufacturing a review interaction", async () => {
    const f = await server.fixture({ conversation: true });
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const response = await fetch(`${server.apiUrl}/api/issues/${f.issueId}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_review", comment: "The plan is ready for our next discussion." }),
    });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result.status).toBe("in_review");
  });

  it("creates an ordinary project task and its plan atomically, retaining the conversation plan", async () => {
    const f = await server.fixture({ conversation: true });
    await documentService(server.db).upsertIssueDocument({ issueId: f.issueId, key: "plan", format: "markdown", body: "Full discussion plan" });
    const input = { title: "Implement the clarified outcome", projectId: f.projectId, initialPlan: "# Execution plan\n\nBuild and verify the outcome.", idempotencyKey: "handoff" };
    const first = await call(f, "create_task", input) as any;
    const again = await call(f, "create_task", input) as any;
    expect(again.task.id).toBe(first.task.id);
    expect(first.task.parentId).toBeNull();
    const [task] = await server.db.select().from(issues).where(eq(issues.id, first.task.id));
    expect(task).toMatchObject({ projectId: f.projectId, assigneeAgentId: f.agentId, status: "todo" });
    expect((await documentService(server.db).getIssueDocumentByKey(task.id, "plan"))?.body).toBe(input.initialPlan);
    expect((await documentService(server.db).getIssueDocumentByKey(f.issueId, "plan"))?.body).toBe("Full discussion plan");
    await expect(call(f, "create_task", { ...input, title: "Different" })).rejects.toThrow(/idempotency/);
  });

  it("rejects creation, child helpers, and reparenting under a chat, while retaining legacy children", async () => {
    const f = await server.fixture({ conversation: true });
    const svc = issueService(server.db);
    await expect(svc.create(f.companyId, { title: "Invalid", parentId: f.issueId })).rejects.toThrow(/cannot have new subtasks/);
    await expect(svc.createChild(f.issueId, { title: "Invalid" })).rejects.toThrow(/cannot have new subtasks/);
    await expect(svc.importIssues(f.companyId, [{
      id: randomUUID(), ref: "imported", title: "Imported child", parentId: f.issueId,
      projectId: null, projectWorkspaceId: null, description: null, assigneeAgentId: null,
      status: "backlog", priority: "medium", billingCode: null, assigneeAdapterOverrides: null,
      executionWorkspaceSettings: null, labelIds: [], monitorNotes: null, monitorScheduledBy: null,
    }])).rejects.toThrow(/cannot have new subtasks/);
    const ordinary = await svc.create(f.companyId, { title: "Ordinary" });
    await expect(svc.update(ordinary.id, { parentId: f.issueId })).rejects.toThrow(/cannot have new subtasks/);
    await server.db.update(issues).set({ parentId: f.issueId }).where(eq(issues.id, ordinary.id));
    expect(await svc.update(ordinary.id, { title: "Legacy edited", parentId: f.issueId })).toMatchObject({ title: "Legacy edited" });
    expect(await svc.update(ordinary.id, { parentId: null })).toMatchObject({ parentId: null });
  });

  it("hands off through the same API used by Claude/Codex MCP with the plan present on return", async () => {
    const f = await server.fixture({ conversation: true });
    const result = await callProjectTool({ name: "create_task", arguments: { title: "MCP handoff", projectId: f.projectId, initialPlan: "# Plan\nImplement in the execution task.", idempotencyKey: "mcp" },
      apiUrl: server.apiUrl, token: createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!,
      companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, conversation: true });
    expect(result).toMatchObject({ parentId: null, projectId: f.projectId, assigneeAgentId: f.agentId });
    expect((await documentService(server.db).getIssueDocumentByKey(result.id, "plan"))?.body).toContain("Implement in the execution task");
  });

  it("rejects unsupported execution policies instead of dropping them", async () => {
    const f = await server.fixture({ conversation: true });
    await expect(callProjectTool({ name: "create_task", arguments: {
      title: "Reject silent monitor loss", projectId: f.projectId, idempotencyKey: "reject-monitor-policy",
      executionPolicy: { monitor: { kind: "external_service", serviceName: "weekly-report-composition", nextCheckAt: "2026-10-22T00:05:00Z", recoveryPolicy: "wake_owner", scheduledBy: "assignee" } },
    }, apiUrl: server.apiUrl, token: createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!,
    companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, conversation: true })).rejects.toThrow("paperclip_runner_tool_arguments_invalid");
  });

  it("refuses low-trust chat handoffs and subtasks on both creation endpoints; the native tool keeps upstream containment", async () => {
    const f = await server.fixture({ conversation: true, disableWakeOnDemand: true });
    const policy = { trustPreset: "low_trust_review", authorizationPolicy: { trustBoundary: { mode: "low_trust_review", companyId: f.companyId, projectIds: [f.projectId] } } };
    await server.db.update(agents).set({ permissions: policy }).where(eq(agents.id, f.agentId));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const before = await server.db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, f.companyId));
    await expect(callProjectTool({ name: "create_task", arguments: { title: "Contained MCP handoff", projectId: f.projectId, initialPlan: "Do the requested work", idempotencyKey: "contained-mcp" },
      apiUrl: server.apiUrl, token, companyId: f.companyId, issueId: f.issueId, agentId: f.agentId, conversation: true })).rejects.toThrow(LOW_TRUST_CREATE_REFUSAL);

    for (const path of [`/api/issues/${f.issueId}/children`, `/api/companies/${f.companyId}/issues`]) {
      const response = await fetch(`${server.apiUrl}${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        // Fork create contract: the schemas are strict (the /children route takes no parentId)
        // and an assigned parented backlog child must say parkDeliberately (backlog-blocking guard).
        body: JSON.stringify({ title: `Self decomposition ${path}`, ...(path.endsWith("/children") ? {} : { parentId: f.issueId }),
          assigneeAgentId: f.agentId, status: "backlog", parkDeliberately: true }),
      });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(403);
      expect(body.error).toBe(LOW_TRUST_CREATE_REFUSAL);
    }
    expect(await server.db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, f.companyId))).toEqual(before);

    const native = await call(f, "create_task", { title: "Contained native handoff", projectId: f.projectId, idempotencyKey: "contained-native" }) as any;
    expect(native.task).toMatchObject({ parentId: null, projectId: f.projectId, assigneeActorId: f.agentId });
    const [nativeTask] = await server.db.select().from(issues).where(eq(issues.id, native.task.id));
    expect(nativeTask.executionPolicy).toMatchObject({ authorizationPolicy: { trustPreset: "low_trust_review", ...policy.authorizationPolicy } });
    expect(nativeTask.sourceTrust).toMatchObject({ disposition: "quarantined" });
  });

  it("refuses a create from a run-only low-trust boundary even when standard policy is requested", async () => {
    const f = await server.fixture({ conversation: true, disableWakeOnDemand: true });
    const executionPolicy = { authorizationPolicy: { trustPreset: "low_trust_review", trustBoundary: { mode: "low_trust_review", companyId: f.companyId, projectIds: [f.projectId] } } };
    const [run] = await server.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await server.db.update(heartbeatRuns).set({ contextSnapshot: { ...run.contextSnapshot, executionPolicy } }).where(eq(heartbeatRuns.id, f.runId));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const response = await fetch(`${server.apiUrl}/api/companies/${f.companyId}/issues`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Retain containment", projectId: f.projectId, assigneeAgentId: f.agentId, executionPolicy: { authorizationPolicy: { trustPreset: "standard" } }, status: "backlog" }),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(403);
    expect(body.error).toBe(LOW_TRUST_CREATE_REFUSAL);
  });

  it("refuses low-trust creates on both creation endpoints and keeps native scope and assignee checks", async () => {
    const f = await server.fixture({ disableWakeOnDemand: true });
    const policy = { trustPreset: "low_trust_review", authorizationPolicy: { trustBoundary: { mode: "low_trust_review", companyId: f.companyId, projectIds: [f.projectId] } } };
    await server.db.update(agents).set({ permissions: policy }).where(eq(agents.id, f.agentId));
    const [outside] = await server.db.insert(projects).values({ companyId: f.companyId, name: "Outside boundary" }).returning();
    const [otherAgent] = await server.db.insert(agents).values({ companyId: f.companyId, name: "Unauthorized assignee", status: "active" }).returning();
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const create = async (path: string, fields: Record<string, unknown>) => {
      const response = await fetch(`${server.apiUrl}${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: `Boundary test ${randomUUID()}`, status: "backlog", parkDeliberately: true, assigneeAgentId: f.agentId, ...fields }),
      });
      return { status: response.status, body: await response.json() };
    };
    const before = await server.db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, f.companyId));
    for (const path of [`/api/companies/${f.companyId}/issues`, `/api/issues/${f.issueId}/children`]) {
      for (const fields of [
        { projectId: outside.id },
        { projectId: outside.id, assigneeAgentId: null },
        { projectId: f.foreignProjectId },
        { projectId: f.projectId, assigneeAgentId: otherAgent.id },
        { projectId: f.projectId, assigneeAgentId: null, assigneeUserId: "board-user" },
      ]) {
        const result = await create(path, fields);
        expect(result.status, JSON.stringify(result.body)).toBe(403);
        expect(result.body.error).toBe(LOW_TRUST_CREATE_REFUSAL);
      }
    }
    const after = await server.db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, f.companyId));
    expect(after).toEqual(before);
    for (const fields of [{ projectId: outside.id }, { projectId: f.projectId, assigneeActorId: otherAgent.id }]) {
      await expect(call(f, "create_task", { title: "Native scope denial", idempotencyKey: randomUUID(), ...fields })).rejects.toThrow(/outside.*boundary/);
    }

    await server.db.update(agents).set({ permissions: { ...policy, authorizationPolicy: {
      ...policy.authorizationPolicy, assignmentPolicy: { mode: "protected" }, protectedAgent: { blockAssignment: true },
    } } }).where(eq(agents.id, f.agentId));
    const protectedResult = await create(`/api/companies/${f.companyId}/issues`, { projectId: f.projectId });
    expect(protectedResult.status, JSON.stringify(protectedResult.body)).toBe(403);
    expect(protectedResult.body.error).toBe(LOW_TRUST_CREATE_REFUSAL);
  });

  it("refuses low-trust root-scoped subtasks on both creation endpoints; the native tool keeps upstream root-scope containment", async () => {
    const f = await server.fixture({ disableWakeOnDemand: true });
    const boundary = { mode: "low_trust_review", companyId: f.companyId, rootIssueId: f.issueId };
    await server.db.update(agents).set({ permissions: { trustPreset: "low_trust_review", authorizationPolicy: { trustBoundary: boundary } } }).where(eq(agents.id, f.agentId));
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    const beforeHttp = await server.db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, f.companyId));
    for (const path of [`/api/companies/${f.companyId}/issues`, `/api/issues/${f.issueId}/children`]) {
      const response = await fetch(`${server.apiUrl}${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: `Root subtask ${randomUUID()}`, ...(path.endsWith("/children") ? {} : { parentId: f.issueId }),
          assigneeAgentId: f.agentId, status: "backlog", parkDeliberately: true }),
      });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(403);
      expect(body.error).toBe(LOW_TRUST_CREATE_REFUSAL);
    }
    expect(await server.db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, f.companyId))).toEqual(beforeHttp);
    await expect(call(f, "create_task", { title: "Native root subtask", idempotencyKey: "root-child", status: "backlog" })).resolves.toMatchObject({ task: { parentId: f.issueId, assigneeActorId: f.agentId } });

    const [outside] = await server.db.insert(projects).values({ companyId: f.companyId, name: "Unrelated project" }).returning();
    const before = await server.db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, f.companyId));
    for (const path of [`/api/companies/${f.companyId}/issues`, `/api/issues/${f.issueId}/children`]) {
      const response = await fetch(`${server.apiUrl}${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Root cannot escape into another project", ...(path.endsWith("/children") ? {} : { parentId: f.issueId }),
          projectId: outside.id, assigneeAgentId: f.agentId, status: "backlog", parkDeliberately: true }),
      });
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(403);
      expect(body.error).toBe(LOW_TRUST_CREATE_REFUSAL);
    }
    await expect(call(f, "create_task", { title: "Native root cannot escape", projectId: outside.id,
      idempotencyKey: "root-outside", status: "backlog" })).rejects.toThrow(/outside.*boundary/);
    expect(await server.db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, f.companyId))).toEqual(before);

    await server.db.update(agents).set({ permissions: { trustPreset: "low_trust_review", authorizationPolicy: { trustBoundary: { mode: "low_trust_review", issueIds: [f.issueId] } } } }).where(eq(agents.id, f.agentId));
    await expect(call(f, "create_task", { title: "Exact scope is not a subtree", idempotencyKey: "exact-child" })).rejects.toThrow(/outside.*boundary/);
  });

  it("refuses low-trust children of a projectless root whatever workspace project they derive", async () => {
    const f = await server.fixture({ disableWakeOnDemand: true });
    const settings = instanceSettingsService(server.db);
    const previous = await settings.getExperimental();
    await settings.updateExperimental({ enableIsolatedWorkspaces: true });
    try {
      await server.db.update(issues).set({ projectId: null, projectWorkspaceId: null }).where(eq(issues.id, f.issueId));
      const [executionWorkspace] = await server.db.insert(executionWorkspaces).values({ companyId: f.companyId,
        projectId: f.projectId, projectWorkspaceId: f.projectWorkspaceId, mode: "shared", strategyType: "project_primary", name: "Outside root" }).returning();
      const boundary = { mode: "low_trust_review", companyId: f.companyId, rootIssueId: f.issueId };
      await server.db.update(agents).set({ permissions: { trustPreset: "low_trust_review", authorizationPolicy: { trustBoundary: boundary } } }).where(eq(agents.id, f.agentId));
      const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
      const before = await server.db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, f.companyId));
      const paths = [`/api/companies/${f.companyId}/issues`, `/api/issues/${f.issueId}/children`];
      const selections = [{ projectWorkspaceId: f.projectWorkspaceId }, { executionWorkspaceId: executionWorkspace.id },
        { inheritExecutionWorkspaceFromIssueId: f.blockerId }];
      const create = async (path: string, selection: Record<string, string>) => {
        const response = await fetch(`${server.apiUrl}${path}`, {
          method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ title: `Workspace scope ${randomUUID()}`, ...(path.endsWith("/children") ? {} : { parentId: f.issueId }),
            assigneeAgentId: f.agentId, status: "backlog", parkDeliberately: true, ...selection }),
        });
        return { status: response.status, body: await response.json() };
      };
      for (const path of paths) {
        for (const selection of selections) {
          if (path.endsWith("/children") && selection.inheritExecutionWorkspaceFromIssueId) continue;
          const response = await create(path, selection);
          expect(response.status, JSON.stringify(response.body)).toBe(403);
          expect(response.body.error).toBe(LOW_TRUST_CREATE_REFUSAL);
        }
      }
      expect(await server.db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, f.companyId))).toEqual(before);

      await server.db.update(agents).set({ permissions: { trustPreset: "low_trust_review", authorizationPolicy: {
        trustBoundary: { ...boundary, projectIds: [f.projectId] },
      } } }).where(eq(agents.id, f.agentId));
      for (const path of paths) {
        for (const selection of selections) {
          if (path.endsWith("/children") && selection.inheritExecutionWorkspaceFromIssueId) continue;
          const response = await create(path, selection);
          expect(response.status, JSON.stringify(response.body)).toBe(403);
          expect(response.body.error).toBe(LOW_TRUST_CREATE_REFUSAL);
        }
      }
      expect(await server.db.select({ id: issues.id }).from(issues).where(eq(issues.companyId, f.companyId))).toEqual(before);
    } finally {
      await settings.updateExperimental({ enableIsolatedWorkspaces: previous.enableIsolatedWorkspaces });
    }
  });

  it("keeps the responsible user's assignment restrictions on low-trust self-assignment", async () => {
    const f = await server.fixture({ conversation: true, disableWakeOnDemand: true });
    await server.db.update(agents).set({ permissions: { trustPreset: "low_trust_review", authorizationPolicy: { trustBoundary: { mode: "low_trust_review", projectIds: [f.projectId] } } } }).where(eq(agents.id, f.agentId));
    await server.db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(companyMemberships.principalId, f.responsibleUserId!));
    await expect(call(f, "create_task", { title: "Viewer cannot assign", projectId: f.projectId, idempotencyKey: "viewer-denied" })).rejects.toThrow();
    expect(await server.db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(2);
  });

  it("refuses a low-trust title or idempotency collision without reusing or leaking the existing task", async () => {
    const f = await server.fixture({ disableWakeOnDemand: true });
    const [outside] = await server.db.insert(projects).values({ companyId: f.companyId, name: "Private project" }).returning();
    const token = createLocalAgentJwt(f.agentId, f.companyId, "paperclip_runner", f.runId, f.responsibleUserId)!;
    for (const parentId of [null, f.issueId]) {
      const key = randomUUID();
      const title = `Existing private work ${randomUUID()}`;
      const existing = await issueService(server.db).create(f.companyId, { projectId: outside.id, parentId,
        title, description: "Private contents", assigneeAgentId: f.agentId, status: "backlog", idempotencyKey: key });
      for (const allowed of [false, true]) {
        await server.db.update(agents).set({ permissions: { trustPreset: "low_trust_review", authorizationPolicy: {
          trustBoundary: { mode: "low_trust_review", projectIds: [f.projectId, ...(allowed ? [outside.id] : [])] },
        } } }).where(eq(agents.id, f.agentId));
        for (const collision of [{ idempotencyKey: key, title: "Different proposed task" }, { title }]) {
          const response = await fetch(`${server.apiUrl}/api/companies/${f.companyId}/issues`, {
            method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ projectId: f.projectId, parentId, assigneeAgentId: f.agentId, status: "backlog", parkDeliberately: true, ...collision }),
          });
          const body = await response.json();
          expect(response.status, JSON.stringify(body)).toBe(403);
          expect(body.error).toBe(LOW_TRUST_CREATE_REFUSAL);
          expect(JSON.stringify(body)).not.toContain("Private contents");
        }
      }
      expect((await issueService(server.db).getById(existing.id))?.projectId).toBe(outside.id);
    }
  });

  it("retains ordinary child delegation and projectless task creation", async () => {
    const f = await server.fixture();
    const result = await call(f, "create_task", { title: "Delegate ordinary work", idempotencyKey: "child" }) as any;
    expect(result.task.parentId).toBe(f.issueId);
    expect(await issueService(server.db).create(f.companyId, { title: "No project needed" })).toMatchObject({ projectId: null });
  });

  it("creates a project once through the production API and records it on the source feed", async () => {
    const f = await server.fixture({ conversation: true });
    const input = { name: "New non-code project", description: "A well-scoped outcome", idempotencyKey: "project" };
    const results = await Promise.all(Array.from({ length: 4 }, () => call(f, "create_project", input))) as any[];
    const project = results[0];
    expect(new Set(results.map(result => result.id)).size).toBe(1);
    expect(project.id).toBeTruthy();
    expect((await call(f, "create_project", input) as any).id).toBe(project.id);
    const feed = await activityService(server.db).forIssue(f.issueId);
    expect(feed.filter(event => event.action === "project.created")).toHaveLength(1);
    expect(feed.find(event => event.action === "project.created")).toMatchObject({ entityId: project.id, runId: f.runId, details: { sourceIssueId: f.issueId } });
    await expect(call(f, "create_project", { ...input, name: "Changed" })).rejects.toThrow(/different inputs/);
  });

  it("includes a registered repository URL in the committed project card", async () => {
    const f = await server.fixture({ conversation: true });
    const project = await call(f, "create_project", { name: "Workspace repo", repositoryUrls: ["https://github.com/example/web"], idempotencyKey: "workspace" }) as any;
    const feed = await activityService(server.db).forIssue(f.issueId);
    expect(feed.find(event => event.entityId === project.id)?.details?.repositories).toEqual([
      expect.objectContaining({ url: "https://github.com/example/web" }),
    ]);
  });

  it.each([
    ["repoUrl", { repoUrl: "https://github.com/example/web" }],
    ["repoRef", { cwd: "/tmp/paperclip-agent-workspace", repoRef: "agent-branch" }],
    ["defaultRef", { cwd: "/tmp/paperclip-agent-workspace", defaultRef: "agent-branch" }],
  ])("refuses an agent project whose workspace names a %s, persisting nothing", async (_field, workspace) => {
    const f = await server.fixture({ conversation: true });
    const name = `Agent-chosen source ${_field}`;
    await expect(call(f, "create_project", { name, workspace, idempotencyKey: `source-${_field}` }))
      .rejects.toThrow(/Agent keys cannot set the repository or branch/);
    const rows = await server.db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, f.companyId), eq(projects.name, name)));
    expect(rows).toHaveLength(0);
  });

  it("registers multiple previously unknown GitHub URLs and deduplicates equivalent URLs", async () => {
    const f = await server.fixture({ conversation: true });
    const project = await call(f, "create_project", { name: "Across repos", repositoryUrls: ["https://github.com/example/web.git", "https://github.com/example/api", "https://github.com/example/web/"], idempotencyKey: "urls" }) as any;
    expect(project.workspaces.map((w: any) => w.repoUrl).sort()).toEqual(["https://github.com/example/api", "https://github.com/example/web"]);
    expect(project.workspaces.filter((w: any) => w.isPrimary)).toHaveLength(1);
    await expect(call(f, "create_project", { name: "Invalid", repositoryUrls: ["https://github.com/example/api"], workspace: { cwd: "/tmp/paperclip-conflict" }, idempotencyKey: "conflict" })).rejects.toThrow(/either workspace/);
    await expect(call(f, "create_project", { name: "Invalid", repositoryUrls: ["https://user:password@github.com/example/api"], idempotencyKey: "credentials" })).rejects.toThrow(/without credentials/);
  });

  it("allows planning documents while denying project/task creation in Plan and Ask mode", async () => {
    for (const mode of ["planning", "ask"] as const) {
      const f = await server.fixture({ conversation: true, mode });
      await expect(call(f, "create_project", { name: "No", idempotencyKey: "no" })).rejects.toThrow(/mode_denied/);
      await expect(call(f, "create_task", { title: "No", idempotencyKey: "no" })).rejects.toThrow(/mode_denied/);
      if (mode === "planning") await call(f, "write_document", { key: "plan", title: "Plan", body: "Clarify and plan here", idempotencyKey: "plan" });
    }
  });

  it("rejects invented repository IDs and cancelled runs without creating a project", async () => {
    const f = await server.fixture({ conversation: true });
    await expect(call(f, "create_project", { name: "Missing repo", repositoryIds: ["999999"], idempotencyKey: "missing" })).rejects.toThrow(/repository.*available/);
    await server.db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.runId));
    await expect(call(f, "create_project", { name: "Cancelled", idempotencyKey: "cancelled" })).rejects.toThrow();
  });
});
