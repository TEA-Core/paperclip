// Minimal stand-in for `opencode serve` (2.2.4 API subset) used by serve-transport.test.ts.
// Records every request to FAKE_LOG so tests can assert order and timing.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const log = (entry) => appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
const mcpName = process.env.FAKE_MCP_NAME ?? "";
// Lets a test plant secrets the server could leak: the per-run password, the
// Authorization header it receives, and this token.
const leakToken = process.env.FAKE_SECRET ?? "";
const clients = new Set();
let mcpStarted = false;
const push = (type, data) => {
  for (const res of clients) res.write(`data: ${JSON.stringify({ id: `evt_${Math.random()}`, type, data })}\n\n`);
};

// FAKE_SHARED_SESSION_DIR: several fake servers (one per overlapping run)
// share `ses_known`, as two runs that resume one OpenCode session do. Every
// finished turn is appended to a shared log there, so each server's view of
// the session's cumulative usage includes the other servers' finished turns.
// A turn starts only once FAKE_SHARED_SESSION_RUNS servers were prompted, so
// every run reads its pre-run baseline before any shared turn spends tokens.
const sharedDir = process.env.FAKE_SHARED_SESSION_DIR ?? "";
const sharedLines = (name) => {
  try {
    return readFileSync(path.join(sharedDir, name), "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};
let ownSharedTurns = 0;
const otherSharedTurns = () => (sharedDir ? sharedLines("turns") - ownSharedTurns : 0);
const recordSharedTurn = () => {
  if (!sharedDir) return;
  appendFileSync(path.join(sharedDir, "turns"), `${process.pid}\n`);
  ownSharedTurns += 1;
};
const sharedBarrier = async () => {
  if (!sharedDir) return;
  appendFileSync(path.join(sharedDir, "prompted"), `${process.pid}\n`);
  const runs = Number(process.env.FAKE_SHARED_SESSION_RUNS ?? "1");
  while (sharedLines("prompted") < runs) await new Promise((resolve) => setTimeout(resolve, 20));
};

// Session usage: `ses_known` pretends to be a resumed session that already
// spent 500/60/40 tokens and $0.05; a fresh `ses_fake` starts at zero. Each
// prompt turn then adds 5/2/1 tokens, so a reconciled run result must report
// 5/2/1 on both paths. FAKE_USAGE_COST prices the turn (default 0 = unpriced).
const turnTokens = { input: 5, output: 2, reasoning: 0, cache: { read: 1, write: 0 } };
const addTokens = (a, b) => ({
  input: a.input + b.input,
  output: a.output + b.output,
  reasoning: a.reasoning + b.reasoning,
  cache: { read: a.cache.read + b.cache.read, write: a.cache.write + b.cache.write },
});
const turnCost = () => Number(process.env.FAKE_USAGE_COST ?? "0");
const priorUsage = (id) => {
  if (id !== "ses_known") return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  let usage = { input: 500, output: 60, reasoning: 0, cache: { read: 40, write: 0 } };
  for (let turn = otherSharedTurns(); turn > 0; turn -= 1) usage = addTokens(usage, turnTokens);
  return usage;
};
const priorCost = (id) => (id === "ses_known" ? 0.05 + otherSharedTurns() * turnCost() : 0);
// The session's live cumulative usage, so GET /api/session/{id} after a turn
// returns the final record the way a real server does.
const liveUsage = new Map();
const currentUsage = (id) => liveUsage.get(id) ?? { tokens: priorUsage(id), cost: priorCost(id) };
const prompted = new Set();
const usageEvent = (id, tokens, cost) => {
  const totals = { tokens: addTokens(priorUsage(id), tokens), cost };
  liveUsage.set(id, totals);
  push("session.usage.updated", { sessionID: id, cost: totals.cost, tokens: totals.tokens });
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
    if (process.env.FAKE_CLOSE_EVENT === "1") setTimeout(() => res.end(), 20);
    return;
  }
  if (req.url === "/api/mcp") {
    if (process.env.FAKE_HANG_MCP === "1") return;
    if (mcpName && !mcpStarted && process.env.FAKE_NO_MCP_EVENT !== "1") {
      mcpStarted = true;
      setTimeout(() => push("mcp.resources.changed", { server: mcpName }), 100);
    }
    const data = process.env.FAKE_MCP_STATUS
      ? JSON.parse(process.env.FAKE_MCP_STATUS)
      : mcpName && process.env.FAKE_NO_MCP_EVENT !== "1"
        ? [{ name: mcpName, status: { status: "connected" } }]
        : [];
    return json(200, { location: { directory: process.cwd() }, data });
  }
  if (req.url === "/api/session" && req.method === "POST") return json(200, { data: { id: "ses_fake" } });
  const sessionMatch = /^\/api\/session\/([^/]+)(\/.*)?$/.exec(req.url);
  if (sessionMatch) {
    const [, id, rest] = sessionMatch;
    if (!rest && req.method === "GET") {
      return id === "ses_known" || id === "ses_fake"
        ? prompted.has(id) && process.env.FAKE_NO_FINAL_SESSION_USAGE === "1"
          ? json(200, { data: { id } })
          : json(200, { data: { id, ...currentUsage(id) } })
        : json(404, { _tag: "SessionNotFoundError", message: `Session not found: ${id}` });
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
        usageEvent(id, { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, priorCost(id) + turnCost());
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
        usageEvent(id, { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, priorCost(id));
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
      prompted.add(id);
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
      await sharedBarrier();
      setTimeout(() => {
        push("session.execution.started", { sessionID: id });
        push("session.step.started", base);
        push("session.text.ended", { ...base, ordinal: 0, text: `fake reply${leakToken ? ` ${password} ${leakToken}` : ""}${"x".repeat(Number(process.env.FAKE_BIG_TEXT_BYTES ?? 0))}` });
        // Partial cumulative usage mid-turn, then the full total after the
        // step: the parser must keep the last event, not sum them.
        usageEvent(id, { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, priorCost(id));
        push("session.step.ended", { ...base, finish: "stop", tokens: turnTokens, cost: 0 });
        recordSharedTurn();
        usageEvent(id, turnTokens, priorCost(id) + turnCost());
        if (process.env.FAKE_USAGE_PARTIAL_LAST === "1") {
          // More model work after the full total, reported by a partial
          // cumulative update that carries only the output counter (7, up
          // from 2). The session's real cumulative input grew too (9 from 5).
          const full = { input: 9, output: 7, reasoning: 0, cache: { read: 1, write: 0 } };
          liveUsage.set(id, { tokens: addTokens(priorUsage(id), full), cost: priorCost(id) + turnCost() });
          push("session.usage.updated", { sessionID: id, tokens: { output: priorUsage(id).output + full.output } });
        }
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
