import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OPENCODE_MCP_READY_DEADLINE_MS,
  OPENCODE_MCP_QUIESCENCE_MS,
  OpenCodeMcpReadinessError,
  waitForOpenCodeMcpReady,
} from "./mcp-readiness-gate.js";

// The gate is tested against a real local HTTP fake of the OpenCode 2.2.4 serve
// API: `/api/event` speaks SSE, `/api/mcp` reports a mutable per-server status.
// Every request is recorded so the tests can prove the no-nudge invariant —
// the gate must only ever issue GETs and must never touch
// `/api/experimental/mcp/{name}/connect` (each nudge tears down and re-lists
// the catalog; 1/10 hit when nudging vs 5/5 nudge-free in the readiness spike).
interface RecordedRequest {
  method: string;
  url: string;
  authorization?: string;
}

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe("waitForOpenCodeMcpReady", () => {
  let server: Server;
  let baseUrl: string;
  let requests: RecordedRequest[];
  let sseClients: Set<{ write: (chunk: string) => void }>;
  let mcpEntries: Array<{ name: string; status: { status: string; error?: string } }>;
  let eventStreamStatus: number;

  const emit = (type: string, data: Record<string, unknown> = {}) => {
    for (const client of sseClients) client.write(sseFrame({ type, data }));
  };

  const noNudgeWasIssued = () => {
    expect(
      requests.every((request) => request.method === "GET"),
      `gate requests must all be GETs: ${JSON.stringify(requests)}`,
    ).toBe(true);
    expect(
      requests.every((request) => !request.url.includes("/connect")),
      `gate must never touch the connect endpoint: ${JSON.stringify(requests)}`,
    ).toBe(true);
  };

  beforeAll(async () => {
    requests = [];
    sseClients = new Set();
    mcpEntries = [];
    eventStreamStatus = 200;
    server = createServer((req, res) => {
      const recorded: RecordedRequest = { method: req.method ?? "", url: req.url ?? "" };
      requests.push(recorded);
      if (req.headers.authorization) recorded.authorization = String(req.headers.authorization);
      if (req.url === "/api/event" && req.method === "GET") {
        res.writeHead(eventStreamStatus, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        if (eventStreamStatus === 200) {
          sseClients.add(res);
          res.write(sseFrame({ type: "server.connected" }));
        } else {
          res.end();
        }
        return;
      }
      if (req.url === "/api/mcp" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: mcpEntries }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("passes once every server is connected and the event stream has been quiet", async () => {
    mcpEntries = [{ name: "paperclip", status: { status: "connecting" } }];
    let lastEventAt = 0;
    const flipConnected = setTimeout(() => {
      // The real 2.2.4 sequence: the pair of events around the transition,
      // then silence while the catalog settles.
      mcpEntries = [{ name: "paperclip", status: { status: "connected" } }];
      emit("mcp.status.changed", { server: "paperclip", status: "connected" });
      emit("mcp.resources.changed", { server: "paperclip" });
      lastEventAt = Date.now();
    }, 120);

    const diagnostics: string[] = [];
    const result = await waitForOpenCodeMcpReady({
      baseUrl,
      authorization: "Basic b3BlbmNvZGU6cHc=",
      servers: ["paperclip"],
      deadlineMs: 3_000,
      quiescenceMs: 150,
      pollMs: 20,
      onDiagnostic: (message) => diagnostics.push(message),
    });
    clearTimeout(flipConnected);

    expect(result.statuses).toEqual({ paperclip: "connected" });
    // The pass must respect the quiescence window measured from the last event.
    expect(Date.now() - lastEventAt).toBeGreaterThanOrEqual(150 - 30);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(120 + 150 - 40);
    expect(requests.some((request) => request.url === "/api/event" && request.authorization === "Basic b3BlbmNvZGU6cHc=")).toBe(true);
    expect(requests.filter((request) => request.url === "/api/mcp").length).toBeGreaterThan(1);
    expect(diagnostics).toContain("mcp event: mcp.status.changed");
    noNudgeWasIssued();
  });

  it("hard-fails at the deadline when the MCP server never connects (readiness4 neg1)", async () => {
    mcpEntries = [
      { name: "other", status: { status: "connected" } },
      { name: "paperclip", status: { status: "error", error: "connect ECONNREFUSED 127.0.0.1:9" } },
    ];
    const startedAt = Date.now();
    const error = await waitForOpenCodeMcpReady({
      baseUrl,
      authorization: "Basic b3BlbmNvZGU6cHc=",
      servers: ["paperclip"],
      deadlineMs: 400,
      quiescenceMs: 100,
      pollMs: 25,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    const waitedMs = Date.now() - startedAt;

    expect(error).toBeInstanceOf(OpenCodeMcpReadinessError);
    const failure = error as OpenCodeMcpReadinessError;
    expect(failure.reason).toBe("deadline");
    expect(failure.statuses.get("paperclip")).toBe("error");
    expect(failure.message).toContain("paperclip: error");
    expect(failure.message).toContain("do not create a session");
    // It fails at the deadline, not early and never past it by much.
    expect(waitedMs).toBeGreaterThanOrEqual(400 - 30);
    expect(waitedMs).toBeLessThan(2_000);
    noNudgeWasIssued();
  });

  it("holds the pass while mcp events keep churning even though status says connected", async () => {
    // readiness1's counterexample made structural: `connected` alone is not a
    // pass. The fake reports connected immediately, then churns the catalog.
    mcpEntries = [{ name: "paperclip", status: { status: "connected" } }];
    const churnMs = 420;
    const churn = setInterval(() => emit("mcp.status.changed", { server: "paperclip" }), 60);
    const churnEndsAt = Date.now() + churnMs;
    // The churn must stop on its own, or the gate could never observe quiet.
    const churnStop = setTimeout(() => clearInterval(churn), churnMs);

    const result = await waitForOpenCodeMcpReady({
      baseUrl,
      authorization: "Basic b3BlbmNvZGU6cHc=",
      servers: ["paperclip"],
      deadlineMs: 3_000,
      quiescenceMs: 150,
      pollMs: 20,
    });
    clearInterval(churn);
    clearTimeout(churnStop);

    // The pass must come only after the churn ended plus the quiet window. The
    // last churn tick lands at most one interval before the stop, so the
    // earliest legal pass is churnEndsAt - 60 + 150.
    expect(Date.now()).toBeGreaterThanOrEqual(churnEndsAt + 90 - 25);
    expect(result.statuses).toEqual({ paperclip: "connected" });
    noNudgeWasIssued();
  }, 5_000);

  it("hard-fails immediately when the event stream is unusable", async () => {
    eventStreamStatus = 404;
    try {
      const error = await waitForOpenCodeMcpReady({
        baseUrl,
        authorization: "Basic b3BlbmNvZGU6cHc=",
        servers: ["paperclip"],
        deadlineMs: 1_000,
        quiescenceMs: 50,
        pollMs: 20,
      }).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(OpenCodeMcpReadinessError);
      expect((error as OpenCodeMcpReadinessError).reason).toBe("stream");
      noNudgeWasIssued();
    } finally {
      eventStreamStatus = 200;
    }
  });

  it("ships the validated defaults", () => {
    expect(OPENCODE_MCP_READY_DEADLINE_MS).toBe(10_000);
    expect(OPENCODE_MCP_QUIESCENCE_MS).toBe(500);
  });
});
