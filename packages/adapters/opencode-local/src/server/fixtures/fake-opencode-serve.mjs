// Minimal stand-in for `opencode serve` (2.2.4 API subset) used by serve-transport.test.ts.
// Records every request to FAKE_LOG so tests can assert order and timing.
import { appendFileSync } from "node:fs";
import http from "node:http";

const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const log = (entry) => appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
const mcpName = process.env.FAKE_MCP_NAME ?? "";
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
      json(200, { data: { id: "msg_1" } });
      const base = { sessionID: id, assistantMessageID: "msg_a" };
      setTimeout(() => {
        push("session.execution.started", { sessionID: id });
        push("session.step.started", base);
        push("session.text.ended", { ...base, ordinal: 0, text: "fake reply" });
        push("session.step.ended", { ...base, finish: "stop", tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 1, write: 0 } }, cost: 0 });
        if (process.env.FAKE_FAIL === "1") push("session.execution.failed", { sessionID: id, error: { type: "output-limit", message: "capped" } });
        else push("session.execution.succeeded", { sessionID: id });
      }, 50);
      return;
    }
  }
  json(404, { _tag: "NotFound" });
});

server.listen(0, "127.0.0.1", () => {
  console.log(`server listening on http://127.0.0.1:${server.address().port}`);
});
process.on("SIGTERM", () => process.exit(0));
