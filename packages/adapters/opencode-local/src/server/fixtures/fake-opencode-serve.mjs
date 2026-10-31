// Minimal stand-in for `opencode serve` (2.2.4 API subset) used by serve-transport.test.ts.
// Records every request to FAKE_LOG so tests can assert order and timing.
import { appendFileSync, writeFileSync } from "node:fs";
import http from "node:http";

const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const log = (entry) => appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
const mcpName = process.env.FAKE_MCP_NAME ?? "";
// Lets a test plant secrets the server could leak: the per-run password, the
// Authorization header it receives, and this token.
const leakToken = process.env.FAKE_SECRET ?? "";
const clients = new Set();
const push = (type, data) => {
  for (const res of clients) res.write(`data: ${JSON.stringify({ id: `evt_${Math.random()}`, type, data })}\n\n`);
};

const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  if (req.headers.authorization !== expected) {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ _tag: "UnauthorizedError" }));
  }
  log({ method: req.method, path: req.url, body });
  if (leakToken) console.error(`debug request ${req.url} authorization=${req.headers.authorization} password=${password} token=${leakToken}`);
  const json = (status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (req.url === "/api/event") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    clients.add(res);
    res.on("close", () => clients.delete(res));
    res.write(`data: ${JSON.stringify({ id: "evt_0", type: "server.connected", data: {} })}\n\n`);
    return;
  }
  if (req.url === "/api/mcp") {
    if (process.env.FAKE_HANG_MCP === "1") return;
    if (mcpName && process.env.FAKE_NO_MCP_EVENT !== "1") {
      setTimeout(() => push("mcp.resources.changed", { server: mcpName }), 100);
    }
    return json(200, { location: { directory: process.cwd() }, data: [] });
  }
  if (req.url === "/api/session" && req.method === "POST") return json(200, { data: { id: "ses_fake" } });
  const sessionMatch = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(req.url);
  if (sessionMatch) {
    const [, id, rest] = sessionMatch;
    if (!rest && req.method === "GET") {
      return id === "ses_known" || id === "ses_fake" ? json(200, { data: { id } }) : json(404, { _tag: "SessionNotFoundError", message: `Session not found: ${id}` });
    }
    if (rest === "/model") {
      res.writeHead(204);
      return res.end();
    }
    if (rest === "/prompt") {
      if (process.env.FAKE_PROMPT_STATUS) return json(Number(process.env.FAKE_PROMPT_STATUS), { _tag: "PromptRejected" });
      json(200, { data: { id: "msg_1" } });
      const base = { sessionID: id, assistantMessageID: "msg_a" };
      setTimeout(() => {
        push("session.execution.started", { sessionID: id });
        push("session.step.started", base);
        push("session.text.ended", { ...base, ordinal: 0, text: `fake reply${leakToken ? ` ${password} ${leakToken}` : ""}${"x".repeat(Number(process.env.FAKE_BIG_TEXT_BYTES ?? 0))}` });
        push("session.step.ended", { ...base, finish: "stop", tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 1, write: 0 } }, cost: 0 });
        if (process.env.FAKE_HANG_TURN === "1") return;
        if (process.env.FAKE_FAIL === "1") push("session.execution.failed", { sessionID: id, error: { type: "output-limit", message: process.env.FAKE_FAIL_MESSAGE ?? "capped" } });
        else push("session.execution.succeeded", { sessionID: id });
      }, 50);
      return;
    }
  }
  json(404, { _tag: "NotFound" });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  writeFileSync(`${process.env.FAKE_LOG}.port`, String(port));
  writeFileSync(`${process.env.FAKE_LOG}.password`, password);
  console.log(`server listening on http://127.0.0.1:${port}`);
  if (leakToken) console.log(`debug banner password=${password} token=${leakToken}`);
});
process.on("SIGTERM", () => {
  if (process.env.FAKE_IGNORE_SIGTERM !== "1") process.exit(0);
});
