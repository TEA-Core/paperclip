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
    return json(200, { location: { directory: process.cwd() }, data: JSON.parse(process.env.FAKE_MCP_STATUS ?? "[]") });
  }
  if (req.url === "/api/session" && req.method === "POST") return json(200, { data: { id: "ses_fake" } });
  const sessionMatch = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(req.url);
  if (sessionMatch) {
    const [, id, rest] = sessionMatch;
    if (!rest && req.method === "GET") {
      return id === "ses_known" || id === "ses_fake" ? json(200, { data: { id } }) : json(404, { _tag: "SessionNotFoundError", message: `Session not found: ${id}` });
    }
    const permissionReply = /^\/permission\/([^/]+)\/reply$/.exec(rest ?? "");
    if (permissionReply && req.method === "POST") {
      if (process.env.FAKE_PERMISSION_REPLY_STATUS) return json(Number(process.env.FAKE_PERMISSION_REPLY_STATUS), { _tag: "ReplyFailed" });
      res.writeHead(204);
      res.end();
      const base = { sessionID: id, assistantMessageID: "msg_a" };
      setTimeout(() => {
        push("permission.replied", { sessionID: id, requestID: permissionReply[1], reply: "reject" });
        if (id !== "ses_fake") return;
        push("session.tool.failed", { ...base, id: "call_1", error: { type: "permission.rejected", message: JSON.parse(body).message } });
        push("session.step.ended", { ...base, finish: "stop", tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 });
        push("session.execution.succeeded", { sessionID: id });
      }, 10);
      return;
    }
    const formDelete = /^\/form\/([^/]+)$/.exec(rest ?? "");
    if (formDelete && req.method === "DELETE") {
      if (process.env.FAKE_FORM_DELETE_STATUS) return json(Number(process.env.FAKE_FORM_DELETE_STATUS), { _tag: "DeleteFailed" });
      res.writeHead(204);
      res.end();
      const base = { sessionID: id, assistantMessageID: "msg_a" };
      setTimeout(() => {
        push("form.cancelled", { sessionID: id, formID: formDelete[1] });
        if (id !== "ses_fake") return;
        push("session.tool.failed", { ...base, id: "call_q", error: { type: "aborted", message: "The user dismissed this question" } });
        push("session.step.failed", { ...base, error: { message: "Step interrupted" } });
        push("session.execution.interrupted", { sessionID: id });
      }, 10);
      return;
    }
    if (rest === "/model") {
      res.writeHead(204);
      return res.end();
    }
    if (rest === "/prompt") {
      if (process.env.FAKE_PROMPT_STATUS) return json(Number(process.env.FAKE_PROMPT_STATUS), { _tag: "PromptRejected" });
      json(200, { data: { id: "msg_1" } });
      const base = { sessionID: id, assistantMessageID: "msg_a" };
      if (process.env.FAKE_QUESTION === "1") {
        const form = (formId, sessionID, kind) => ({
          id: formId,
          sessionID,
          title: "Questions",
          metadata: { kind, tool: { messageID: "msg_a", id: "call_q" } },
          fields: [{ key: "q1", title: "Pick one", description: "Which option?", type: "select", options: [{ label: "A" }], custom: false }],
        });
        setTimeout(() => {
          push("session.execution.started", { sessionID: id });
          push("session.step.started", base);
          push("session.tool.input.started", { ...base, id: "call_q", name: "question" });
          push("session.tool.called", { ...base, id: "call_q", input: { questions: [] }, executed: false });
          push("form.created", { form: form("frm_1", id, "question") });
          push("form.created", { form: form("frm_other", "ses_other", "question") });
          push("form.created", { form: form("frm_text", id, "text") });
        }, 50);
        return;
      }
      if (process.env.FAKE_PERMISSION === "1") {
        setTimeout(() => {
          push("session.execution.started", { sessionID: id });
          push("session.step.started", base);
          push("session.tool.input.started", { ...base, id: "call_1", name: "shell" });
          push("session.tool.called", { ...base, id: "call_1", input: { command: "echo hi" }, executed: false });
          push("permission.asked", { id: "per_1", sessionID: id, action: "shell", resources: ["echo hi"], save: ["echo *"], source: { type: "tool", messageID: "msg_a", id: "call_1" } });
          push("permission.asked", { id: "per_other", sessionID: "ses_other", action: "shell", resources: ["rm -rf /"], save: [], source: { type: "tool", messageID: "msg_x", id: "call_x" } });
        }, 50);
        return;
      }
      setTimeout(() => {
        push("session.execution.started", { sessionID: id });
        push("session.step.started", base);
        push("session.text.ended", { ...base, ordinal: 0, text: `fake reply${leakToken ? ` ${password} ${leakToken}` : ""}${"x".repeat(Number(process.env.FAKE_BIG_TEXT_BYTES ?? 0))}` });
        push("session.step.ended", { ...base, finish: "stop", tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 1, write: 0 } }, cost: 0 });
        if (process.env.FAKE_HANG_TURN === "1") return;
        if (process.env.FAKE_ENDS_MID_TURN === "close-stream") {
          for (const res of clients) res.end();
          return;
        }
        if (process.env.FAKE_ENDS_MID_TURN === "exit") process.exit(0);
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
