import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { publishLiveEvent } from "../services/live-events.js";

const mockWakeup = vi.hoisted(() => vi.fn());
const mockHeartbeatService = vi.hoisted(() => vi.fn(() => ({ wakeup: mockWakeup })));

vi.mock("../services/heartbeat.js", () => ({
  heartbeatService: mockHeartbeatService,
}));

import { buildHostServices } from "../services/plugin-host-services.js";

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
        clear: () => {},
      };
    },
  } as any;
}

function createSessionLookupDb(session: {
  id: string;
  companyId: string;
  agentId: string;
  taskKey: string;
}) {
  const query = {
    from: () => query,
    where: () => query,
    then: (resolve: (rows: typeof session[]) => unknown) => Promise.resolve(resolve([session])),
  };
  return {
    select: () => query,
  } as never;
}

describe("plugin agent sessions", () => {
  it("delivers the message body in wake context and returns final assistant text on done", async () => {
    const companyId = "company-1";
    const agentId = "agent-1";
    const sessionId = "session-1";
    const notifyWorker = vi.fn();
    mockWakeup.mockReset();
    mockWakeup.mockResolvedValue({ id: "run-1" });

    const services = buildHostServices(
      createSessionLookupDb({
        id: sessionId,
        companyId,
        agentId,
        taskKey: "plugin:paperclip.gateway:session:session-1",
      }),
      "plugin-record-id",
      "paperclip.gateway",
      createEventBusStub(),
      notifyWorker,
    );

    await expect(
      services.agentSessions.sendMessage({
        sessionId,
        companyId,
        prompt: "hello",
        reason: "gateway_chat_message",
      }),
    ).resolves.toEqual({ runId: "run-1" });

    expect(mockWakeup).toHaveBeenCalledWith(
      agentId,
      expect.objectContaining({
        payload: { prompt: "hello" },
        contextSnapshot: {
          taskKey: "plugin:paperclip.gateway:session:session-1",
          wakeReason: "gateway_chat_message",
          wakeSource: "automation",
          wakeTriggerDetail: "system",
          paperclipAgentMessage: {
            text: "hello",
            source: "plugin_session",
            pluginKey: "paperclip.gateway",
            sessionId,
          },
        },
      }),
    );

    publishLiveEvent({
      companyId,
      type: "heartbeat.run.status",
      payload: {
        runId: "run-1",
        status: "succeeded",
        finalText: "Hello! How can I help?",
      },
    });

    // A plugin without issues.read still gets its own session's output: this
    // run names no issue.
    await vi.waitFor(() =>
      expect(notifyWorker).toHaveBeenCalledWith(
        "agents.sessions.event",
        expect.objectContaining({
          sessionId,
          runId: "run-1",
          eventType: "done",
          message: "Hello! How can I help?",
        }),
      ),
    );

    services.dispose();
  });

  async function startSession(capabilities: string[]) {
    const notifyWorker = vi.fn();
    mockWakeup.mockReset();
    mockWakeup.mockResolvedValue({ id: "run-1" });
    const services = buildHostServices(
      createSessionLookupDb({
        id: "session-1",
        companyId: "company-1",
        agentId: "agent-1",
        taskKey: "plugin:paperclip.gateway:session:session-1",
      }),
      "plugin-record-id",
      "paperclip.gateway",
      createEventBusStub(),
      notifyWorker,
      { manifest: { id: "paperclip.gateway", capabilities } as unknown as PaperclipPluginManifestV1 },
    );
    await services.agentSessions.sendMessage({ sessionId: "session-1", companyId: "company-1", prompt: "hello" });
    return { notifyWorker, services };
  }

  const log = { runId: "run-1", issueId: "issue-restricted", seq: 1, stream: "stdout", chunk: "Restricted chunk" };
  const status = { runId: "run-1", issueId: "issue-restricted", status: "succeeded", finalText: "Restricted final text" };

  it("sends a plugin without issues.read only the metadata of session output about an issue", async () => {
    const { notifyWorker, services } = await startSession(["agent.sessions.send"]);

    publishLiveEvent({ companyId: "company-1", type: "heartbeat.run.log", payload: log });
    publishLiveEvent({ companyId: "company-1", type: "heartbeat.run.status", payload: status });

    await vi.waitFor(() => expect(notifyWorker).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(notifyWorker.mock.calls)).not.toContain("Restricted");
    expect(notifyWorker.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({
        eventType: "chunk",
        message: null,
        payload: { runId: "run-1", issueId: "issue-restricted", seq: 1, stream: "stdout" },
      }),
      expect.objectContaining({
        eventType: "done",
        message: null,
        payload: { runId: "run-1", issueId: "issue-restricted", status: "succeeded" },
      }),
    ]);
    services.dispose();
  });

  it("sends a plugin with issues.read session output unchanged", async () => {
    const { notifyWorker, services } = await startSession(["agent.sessions.send", "issues.read"]);

    publishLiveEvent({ companyId: "company-1", type: "heartbeat.run.log", payload: log });
    publishLiveEvent({ companyId: "company-1", type: "heartbeat.run.status", payload: status });

    expect(notifyWorker.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ eventType: "chunk", message: "Restricted chunk", payload: log }),
      expect.objectContaining({ eventType: "done", message: "Restricted final text", payload: status }),
    ]);
    services.dispose();
  });

  const issuelessEvent = {
    runId: "run-1",
    seq: 2,
    eventType: "adapter.message",
    message: "Free-form session message",
    error: "Free-form session error",
  };

  it("withholds error and message text of session output with no issue from a plugin without issues.read", async () => {
    const { notifyWorker, services } = await startSession(["agent.sessions.send"]);

    publishLiveEvent({ companyId: "company-1", type: "heartbeat.run.event", payload: issuelessEvent });

    await vi.waitFor(() => expect(notifyWorker).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(notifyWorker.mock.calls)).not.toContain("Free-form");
    expect(notifyWorker.mock.calls[0]![1]).toMatchObject({
      eventType: "chunk",
      message: null,
      payload: { runId: "run-1", seq: 2, eventType: "adapter.message" },
    });
    services.dispose();
  });

  it("sends a plugin with issues.read the error and message text of session output with no issue", async () => {
    const { notifyWorker, services } = await startSession(["agent.sessions.send", "issues.read"]);

    publishLiveEvent({ companyId: "company-1", type: "heartbeat.run.event", payload: issuelessEvent });

    expect(notifyWorker.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ eventType: "chunk", message: "Free-form session message", payload: issuelessEvent }),
    ]);
    services.dispose();
  });
});
