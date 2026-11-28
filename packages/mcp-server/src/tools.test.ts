import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPaperclipMcpServer } from "./index.js";
import { PaperclipApiClient } from "./client.js";
import { createToolDefinitions } from "./tools.js";

function makeClient() {
  return new PaperclipApiClient({
    apiUrl: "http://localhost:3100/api",
    apiKey: "token-123",
    companyId: "11111111-1111-1111-1111-111111111111",
    agentId: "22222222-2222-2222-2222-222222222222",
    runId: "33333333-3333-3333-3333-333333333333",
  });
}

function getTool(name: string) {
  const tool = createToolDefinitions(makeClient()).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function mockJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("paperclip MCP tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("adds auth headers and run id to mutating requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipUpdateIssue");
    await tool.execute({
      issueId: "PAP-1135",
      status: "done",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135");
    expect(init.method).toBe("PATCH");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer token-123");
    expect((init.headers as Record<string, string>)["X-Paperclip-Run-Id"]).toBe(
      "33333333-3333-3333-3333-333333333333",
    );
  });

  it("preserves returnAssigneeAgentId through create and update tool requests", async () => {
    const returnAssigneeAgentId = "38ca3dab-cdb5-4d90-84dd-c5f2eb15da5e";
    const reviewerAgentId = "d1982606-4c66-475f-af56-63c4b9d92f24";
    const executionPolicy = {
      mode: "normal",
      commentRequired: true,
      returnAssigneeAgentId,
      stages: [
        {
          type: "review",
          approvalsNeeded: 1,
          participants: [{ type: "agent", agentId: reviewerAgentId }],
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "PAP-1135", status: "backlog", executionPolicy }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const createTool = getTool("paperclipCreateIssue");
    await createTool.execute({
      title: "Exercise return assignee",
      executionPolicy,
    });

    const [createUrl, createInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(createUrl)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/issues",
    );
    expect(createInit.method).toBe("POST");
    expect(JSON.parse(String(createInit.body)).executionPolicy.returnAssigneeAgentId).toBe(
      returnAssigneeAgentId,
    );

    const updateTool = getTool("paperclipUpdateIssue");
    await updateTool.execute({
      issueId: "PAP-1135",
      executionPolicy: { returnAssigneeAgentId },
    });

    const [updateUrl, updateInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(updateUrl)).toBe("http://localhost:3100/api/issues/PAP-1135");
    expect(updateInit.method).toBe("PATCH");
    expect(JSON.parse(String(updateInit.body)).executionPolicy.returnAssigneeAgentId).toBe(
      returnAssigneeAgentId,
    );
  });

  it("forwards a top-level monitor alias as the PATCH alias (SUP-21447)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "PAP-1135", status: "in_progress" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipUpdateIssue");
    const response = await tool.execute({
      issueId: "PAP-1135",
      monitor: { nextCheckAt: "2026-12-01T12:00:00.000Z" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135");
    expect(init.method).toBe("PATCH");
    const body = JSON.parse(String(init.body));
    expect(body.monitor).toMatchObject({ nextCheckAt: "2026-12-01T12:00:00.000Z" });
    expect(body).not.toHaveProperty("executionPolicy");
    expect(response.content[0]?.text).toContain("PAP-1135");
  });

  it("rejects monitor combined with executionPolicy before any request (SUP-21447)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipUpdateIssue");
    const response = await tool.execute({
      issueId: "PAP-1135",
      monitor: { nextCheckAt: "2026-12-01T12:00:00.000Z" },
      executionPolicy: { monitor: { nextCheckAt: "2027-01-01T00:00:00.000Z" } },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.content[0]?.text).toContain(
      "monitor cannot be combined with executionPolicy",
    );
  });

  it("returns issue activity with the future-check cancellation record intact", async () => {
    const activity = {
      id: "activity-1", companyId: "company-1", actorType: "agent", actorId: "agent-1",
      agentId: "agent-1", runId: "run-1", action: "issue.monitor_cleared",
      entityType: "issue", entityId: "issue-1", createdAt: "2026-11-25T20:38:28.132Z",
      details: {
        identifier: "PAP-1135", previousNextCheckAt: "2026-11-26T19:00:00.000Z",
        recoveryPolicy: "wake_owner", reason: "cleared_by_close_future_check", notes: "Verify deployment tomorrow",
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse([activity]));
    vi.stubGlobal("fetch", fetchMock);
    const { server } = createPaperclipMcpServer({
      apiUrl: "http://localhost:3100/api", apiKey: "test-token", companyId: null, agentId: null, runId: null,
    });
    const client = new Client({ name: "activity-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      const advertised = tools.find((tool) => tool.name === "paperclipListIssueActivity");
      expect(advertised?.outputSchema).toMatchObject({
        properties: { items: { items: { anyOf: [
          { properties: { details: { properties: { reason: { const: "cleared_by_close_future_check" } } } } },
          expect.anything(),
        ] } } },
      });
      const response = await client.callTool({ name: "paperclipListIssueActivity", arguments: { issueId: "PAP-1135" } });
      expect(String(fetchMock.mock.calls[0]![0])).toBe("http://localhost:3100/api/issues/PAP-1135/activity");
      expect(response.structuredContent).toEqual({ items: [activity] });
      const textResponse = z.object({
        content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
      }).parse(response);
      expect(JSON.parse(textResponse.content[0]!.text)).toEqual(response.structuredContent);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns an MCP error instead of activity data after an activity read denial", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockJsonResponse({ error: "Forbidden" }, 403)));
    const response = await getTool("paperclipListIssueActivity").execute({ issueId: "PAP-1135" });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
    expect(JSON.parse(response.content[0]!.text)).toMatchObject({ status: 403, body: { error: "Forbidden" } });
  });

  it("lists the company skill library with the default company id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse([{ key: "paperclipai/bundled/product/wireframe", name: "wireframe" }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipListSkills");
    const response = await tool.execute({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/skills",
    );
    expect(response.content[0]?.text).toContain("wireframe");
  });

  it("uses default company id for company-scoped list tools", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse([{ id: "issue-1" }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipListIssues");
    const response = await tool.execute({});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/issues",
    );
    expect(response.content[0]?.text).toContain("issue-1");
  });

  it("uses default agent id for checkout requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "PAP-1135", status: "in_progress" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipCheckoutIssue");
    await tool.execute({
      issueId: "PAP-1135",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      agentId: "22222222-2222-2222-2222-222222222222",
      expectedStatuses: ["todo", "backlog", "blocked"],
    });
  });

  it("opens a work session and surfaces the workspace cwd", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({
        runId: "run-1",
        issueId: "PAP-1135",
        status: "running",
        workspace: {
          strategy: "git_worktree",
          cwd: "/path/to/worktree",
          branchName: "SUP-1135",
          worktreePath: "/path/to/worktree",
          executionWorkspaceId: "44444444-4444-4444-8444-444444444444",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipOpenWorkSession");
    const response = await tool.execute({ issueId: "PAP-1135" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135/work-session");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({});
    expect(response.content[0]?.text).toContain("/path/to/worktree");
  });

  it("heartbeats a work session with runId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ runId: "run-1", expiresAt: "2026-08-09T14:00:00Z" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipHeartbeatWorkSession");
    const response = await tool.execute({ issueId: "PAP-1135", runId: "f47ac10b-58cc-4372-a567-0e02b2c3d479" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135/work-session/heartbeat");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ runId: "f47ac10b-58cc-4372-a567-0e02b2c3d479" });
    expect(response.content[0]?.text).toContain("2026-08-09T14:00:00Z");
  });

  it("closes a work session with runId, outcome and optional summary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ runId: "run-1", status: "succeeded" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipCloseWorkSession");
    await tool.execute({
      issueId: "PAP-1135",
      runId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      outcome: "succeeded",
      summary: "All done",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135/work-session/close");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      runId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      outcome: "succeeded",
      summary: "All done",
    });
  });

  it("rejects invalid work session close outcomes", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const tool = getTool("paperclipCloseWorkSession");
    const response = await tool.execute({
      issueId: "PAP-1135",
      outcome: "bogus" as unknown as "succeeded",
    });

    // zod 4.x renders enum rejections as "Invalid option: expected one of ..."
    // (zod 3 used "Invalid enum value").
    expect(response.content[0]?.text).toContain("Invalid option");
  });

  it("allows create issue requests to omit status so the API applies assignee defaults", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "issue-1", status: "todo" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipCreateIssue");
    await tool.execute({
      title: "Assigned follow-up",
      assigneeAgentId: "22222222-2222-2222-2222-222222222222",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/issues",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      title: "Assigned follow-up",
      workMode: "standard",
      priority: "medium",
      assigneeAgentId: "22222222-2222-2222-2222-222222222222",
      parkDeliberately: false,
      requestDepth: 0,
      allowDuplicate: false,
    });
  });

  it("defaults issue document format to markdown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ key: "plan", latestRevisionNumber: 2 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipUpsertIssueDocument");
    await tool.execute({
      issueId: "PAP-1135",
      key: "plan",
      body: "# Updated",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      format: "markdown",
      body: "# Updated",
    });
  });

  it("forwards issue document list and get reads to the issue document routes", async () => {
    const ledger = {
      id: "66666666-6666-4666-8666-666666666666",
      issueId: "77777777-7777-4777-8777-777777777777",
      key: "census-chain-ledger",
      latestRevisionId: "88888888-8888-4888-8888-888888888888",
      latestRevisionNumber: 3,
      body: "last-census-serial: 80",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse([ledger]))
      .mockResolvedValueOnce(mockJsonResponse(ledger));
    vi.stubGlobal("fetch", fetchMock);

    const listed = await getTool("paperclipListDocuments").execute({ issueId: "PAP-1135" });
    const fetched = await getTool("paperclipGetDocument").execute({
      issueId: "PAP-1135",
      key: "census-chain-ledger",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [listUrl, listInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(listUrl)).toBe("http://localhost:3100/api/issues/PAP-1135/documents");
    expect(listInit.method).toBe("GET");
    const [getUrl, getInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(String(getUrl)).toBe("http://localhost:3100/api/issues/PAP-1135/documents/census-chain-ledger");
    expect(getInit.method).toBe("GET");
    expect(listed.isError).toBeUndefined();
    expect(JSON.parse(listed.content[0]!.text)).toEqual([ledger]);
    expect(JSON.parse(fetched.content[0]!.text)).toEqual(ledger);
  });

  it("preserves status, path, body and the API target on an issue document 404", async () => {
    const notFoundBody = {
      error: "Document not found",
      issueId: "a6fb3c84-28eb-4bbd-8509-665f41a558b1",
      issueIdentifier: "PAP-1136",
      key: "census-chain-ledger",
    };
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(notFoundBody, 404));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getTool("paperclipGetDocument").execute({
      issueId: "a6fb3c84-28eb-4bbd-8509-665f41a558b1",
      key: "census-chain-ledger",
    });

    const path = "/issues/a6fb3c84-28eb-4bbd-8509-665f41a558b1/documents/census-chain-ledger";
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      error: `GET ${path} failed with 404: Document not found`,
      status: 404,
      method: "GET",
      path,
      url: `http://localhost:3100/api${path}`,
      body: notFoundBody,
    });
  });

  it("controls issue workspace services through the current execution workspace", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({
        currentExecutionWorkspace: {
          id: "44444444-4444-4444-8444-444444444444",
          runtimeServices: [],
        },
      }))
      .mockResolvedValueOnce(mockJsonResponse({
        operation: { id: "operation-1" },
        workspace: {
          id: "44444444-4444-4444-8444-444444444444",
          runtimeServices: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              serviceName: "web",
              status: "running",
              url: "http://127.0.0.1:5173",
            },
          ],
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipControlIssueWorkspaceServices");
    await tool.execute({
      issueId: "PAP-1135",
      action: "restart",
      workspaceCommandId: "web",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [lookupUrl, lookupInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(lookupUrl)).toBe("http://localhost:3100/api/issues/PAP-1135/heartbeat-context");
    expect(lookupInit.method).toBe("GET");

    const [controlUrl, controlInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(String(controlUrl)).toBe(
      "http://localhost:3100/api/execution-workspaces/44444444-4444-4444-8444-444444444444/runtime-services/restart",
    );
    expect(controlInit.method).toBe("POST");
    expect(JSON.parse(String(controlInit.body))).toEqual({
      workspaceCommandId: "web",
    });
  });

  it("waits for an issue workspace runtime service URL", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockJsonResponse({
        currentExecutionWorkspace: {
          id: "44444444-4444-4444-8444-444444444444",
          runtimeServices: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              serviceName: "web",
              status: "running",
              healthStatus: "healthy",
              url: "http://127.0.0.1:5173",
            },
          ],
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipWaitForIssueWorkspaceService");
    const response = await tool.execute({
      issueId: "PAP-1135",
      serviceName: "web",
      timeoutSeconds: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.content[0]?.text).toContain("http://127.0.0.1:5173");
  });

  it("creates suggest_tasks interactions with the expected issue-scoped payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "interaction-1", kind: "suggest_tasks" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipSuggestTasks");
    await tool.execute({
      issueId: "PAP-1135",
      idempotencyKey: "run-1:suggest",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135/interactions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "suggest_tasks",
      continuationPolicy: "wake_assignee",
      idempotencyKey: "run-1:suggest",
      payload: {
        version: 1,
        tasks: [{ clientKey: "task-1", title: "One" }],
      },
    });
  });

  it("creates request_confirmation interactions with plan target payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "interaction-1", kind: "request_confirmation" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipRequestConfirmation");
    await tool.execute({
      issueId: "PAP-1135",
      idempotencyKey: "confirmation:PAP-1135:plan:33333333-3333-4333-8333-333333333333",
      title: "Plan approval",
      payload: {
        version: 1,
        prompt: "Accept this plan?",
        acceptLabel: "Accept plan",
        allowDeclineReason: true,
        rejectLabel: "Request changes",
        rejectRequiresReason: true,
        supersedeOnUserComment: true,
        target: {
          type: "issue_document",
          key: "plan",
          revisionId: "33333333-3333-4333-8333-333333333333",
          revisionNumber: 3,
        },
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135/interactions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "request_confirmation",
      continuationPolicy: "none",
      idempotencyKey: "confirmation:PAP-1135:plan:33333333-3333-4333-8333-333333333333",
      title: "Plan approval",
      payload: {
        version: 1,
        prompt: "Accept this plan?",
        acceptLabel: "Accept plan",
        allowDeclineReason: true,
        rejectLabel: "Request changes",
        rejectRequiresReason: true,
        supersedeOnUserComment: true,
        target: {
          type: "issue_document",
          key: "plan",
          revisionId: "33333333-3333-4333-8333-333333333333",
          revisionNumber: 3,
        },
      },
    });
  });

  it("creates request_checkbox_confirmation interactions with checkbox payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "interaction-1", kind: "request_checkbox_confirmation" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipRequestCheckboxConfirmation");
    await tool.execute({
      issueId: "PAP-1135",
      idempotencyKey: "confirmation:PAP-1135:files",
      title: "Choose files",
      payload: {
        version: 1,
        prompt: "Which files should be included?",
        detailsMarkdown: "Pick the files to attach.",
        options: [
          { id: "file-a", label: "File A", description: "Primary draft" },
          { id: "file-b", label: "File B" },
        ],
        defaultSelectedOptionIds: ["file-a"],
        minSelected: 1,
        maxSelected: 2,
        acceptLabel: "Use selected files",
        rejectLabel: "Do not attach files",
        rejectRequiresReason: true,
        allowDeclineReason: false,
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe("http://localhost:3100/api/issues/PAP-1135/interactions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      kind: "request_checkbox_confirmation",
      continuationPolicy: "wake_assignee",
      idempotencyKey: "confirmation:PAP-1135:files",
      title: "Choose files",
      payload: {
        version: 1,
        prompt: "Which files should be included?",
        detailsMarkdown: "Pick the files to attach.",
        options: [
          { id: "file-a", label: "File A", description: "Primary draft" },
          { id: "file-b", label: "File B" },
        ],
        defaultSelectedOptionIds: ["file-a"],
        minSelected: 1,
        maxSelected: 2,
        acceptLabel: "Use selected files",
        rejectLabel: "Do not attach files",
        rejectRequiresReason: true,
        allowDeclineReason: false,
      },
    });
  });

  it("creates approvals with the expected company-scoped payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockJsonResponse({ id: "approval-1" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipCreateApproval");
    await tool.execute({
      type: "hire_agent",
      payload: { branch: "pap-1167" },
      issueIds: ["44444444-4444-4444-4444-444444444444"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe(
      "http://localhost:3100/api/companies/11111111-1111-1111-1111-111111111111/approvals",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      type: "hire_agent",
      payload: { branch: "pap-1167" },
      issueIds: ["44444444-4444-4444-4444-444444444444"],
    });
  });

  it("exposes structured done-tier declarations on update and comment tools", () => {
    const tier2 = {
      tier: "tier2" as const,
      probeEvidence: "Health check returned 200",
    };
    const tier1 = {
      tier: "tier1" as const,
      reason: "Merged change is ready",
      landing: {
        mode: "landedAtTip" as const,
        mergeCommit: "abcdef1234567",
      },
    };
    const delegated = {
      tier: "tier1" as const,
      reason: "Landing delegated",
      landing: {
        mode: "landingDelegated" as const,
        prNumber: 123,
        carrier: "done-close-landing-backstop" as const,
      },
    };
    const updateTool = getTool("paperclipUpdateIssue");
    const commentTool = getTool("paperclipAddComment");

    expect(updateTool.schema.shape.doneTier.parse(tier2)).toEqual(tier2);
    expect(commentTool.schema.shape.doneTier.parse(tier1)).toEqual(tier1);
    expect(commentTool.schema.shape.doneTier.parse(delegated)).toEqual(delegated);
    expect(updateTool.schema.shape.doneTier.safeParse({ tier: "tier2", probeEvidence: "" }).success).toBe(false);
    expect(commentTool.schema.shape.doneTier.safeParse({
      tier: "tier1",
      reason: "line 1\nline 2",
      landing: delegated.landing,
    }).success).toBe(false);
  });

  it.each(["paperclipUpdateIssue", "paperclipAddComment"])(
    "%s advertises the full structured doneTier declaration to tool clients",
    (toolName) => {
      const advertised = z.toJSONSchema(getTool(toolName).schema.shape.doneTier, { io: "input" }) as {
        oneOf?: Array<{ properties?: Record<string, { const?: string; oneOf?: Array<{ properties?: { mode?: { const?: string } } }> }> }>;
      };

      const tiers = advertised.oneOf?.map((branch) => branch.properties?.tier?.const).sort();
      expect(tiers).toEqual(["tier1", "tier2"]);
      const tier1 = advertised.oneOf?.find((branch) => branch.properties?.tier?.const === "tier1");
      expect(tier1?.properties?.landing?.oneOf?.map((landing) => landing.properties?.mode?.const).sort()).toEqual([
        "landedAtTip",
        "landingDelegated",
        "noRepositoryLanding",
      ]);
    },
  );

  it("exposes paperclipCreateApproval as a mergeable object schema", () => {
    const tool = getTool("paperclipCreateApproval");

    expect(tool.schema).toBeInstanceOf(z.ZodObject);
    expect(Object.keys(tool.schema.shape).sort()).toEqual([
      "companyId",
      "issueIds",
      "payload",
      "requestedByAgentId",
      "type",
    ]);
  });

  it("leaves issue-gating issueIds enforcement to the server on create approval", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: "approval-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipCreateApproval");
    await tool.execute({
      type: "request_board_approval",
      payload: { title: "Approve" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      type: "request_board_approval",
      payload: { title: "Approve" },
    });
  });

  it("rejects invalid generic request paths", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const tool = getTool("paperclipApiRequest");
    const response = await tool.execute({
      method: "GET",
      path: "issues",
    });

    expect(response.content[0]?.text).toContain("path must start with /");
  });

  it("rejects generic request paths that escape /api", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const tool = getTool("paperclipApiRequest");
    const response = await tool.execute({
      method: "GET",
      path: "/../../secret",
    });

    expect(response.content[0]?.text).toContain("must not contain '..'");
  });

  it("resolves absolute /api-prefixed paths without double-prefixing the base", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipApiRequest");
    await tool.execute({
      method: "GET",
      path: "/api/health",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(String(url)).toBe("http://localhost:3100/api/health");
  });

  it("resolves relative and /api-prefixed paths to the same URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const tool = getTool("paperclipApiRequest");
    await tool.execute({ method: "GET", path: "/health" });
    await tool.execute({ method: "GET", path: "/api/health" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [relativeUrl] = fetchMock.mock.calls[0] as [string];
    const [prefixedUrl] = fetchMock.mock.calls[1] as [string];
    expect(String(relativeUrl)).toBe("http://localhost:3100/api/health");
    expect(String(prefixedUrl)).toBe("http://localhost:3100/api/health");
  });
});
