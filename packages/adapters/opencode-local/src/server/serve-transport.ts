import { randomBytes } from "node:crypto";
import {
  appendWithCap,
  asString,
  parseObject,
  runChildProcess,
  runningProcesses,
  signalRunningProcess,
  type RunProcessResult,
} from "@paperclipai/adapter-utils/server-utils";
import {
  createOpenCodeServeEventState,
  mapOpenCodeServeEvent,
  parseOpenCodeJsonl,
  type OpenCodeServeTurnOutcome,
} from "./parse.js";

/**
 * OpenCode V2 server transport.
 *
 * A one-shot `opencode run` builds its first model request before a remote MCP
 * server's tools have been listed, so a `codemode:false` Paperclip tool is
 * missing from it (upstream issue https://github.com/anomalyco/opencode/issues/60893).
 * `opencode serve` lets the adapter start the server, wait for the MCP servers
 * it injected, and only then create the session and send the prompt.
 *
 * The readiness gate is TIMER-BASED BY NECESSITY: OpenCode 2.2.4 exposes no
 * endpoint or event that says a new session will see an MCP server's tools.
 * `mcp.resources.changed` precedes tool availability by a short unmarked
 * interval (prompting immediately carried the tools in 0 of 5 lab runs;
 * +100, +250 and +500 ms after the event carried them in 5 of 5 each). The gate
 * waits for that event from every injected server, settles, and fails the run
 * closed when the event never arrives. On a loaded host the settle can be too
 * short, which starts a run WITHOUT its Paperclip tools.
 */

/** Longest wait for `mcp.resources.changed` from every injected MCP server. */
export const OPENCODE_SERVE_MCP_READY_TIMEOUT_MS = 15_000;
/** Settle after the event; 0 ms failed 5/5 in the lab, 100+ ms passed 5/5. */
export const OPENCODE_SERVE_MCP_SETTLE_MS = 1_000;
const SERVE_START_TIMEOUT_MS = 30_000;
const SERVER_USERNAME = "opencode";
// The text `opencode run` gives the model when it auto-rejects a permission request.
const PERMISSION_REJECT_MESSAGE =
  "This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action.";

export interface OpenCodeServeMcpServer {
  name: string;
  token: string;
}

export interface OpenCodeServeInput {
  runId: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  prompt: string;
  /** `provider/model`, as configured. */
  model: string;
  variant: string;
  resumeSessionId: string | null;
  /** MCP servers the adapter injected; the gate waits for each of them. */
  mcpServers: OpenCodeServeMcpServer[];
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  /** Test seams; production uses the defaults. */
  mcpReadyTimeoutMs?: number;
  mcpSettleMs?: number;
}

export function buildOpenCodeServeArgs(): string[] {
  // Port 0 lets the kernel pick a free loopback port; the server prints the one
  // it bound, so there is no probe-then-bind race.
  return ["serve", "--hostname", "127.0.0.1", "--port", "0"];
}

export function parseOpenCodeServeModel(model: string, variant: string) {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return null;
  return {
    providerID: model.slice(0, slash),
    id: model.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
}

export function redactOpenCodeServeSecrets(text: string, secrets: string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 4) result = result.split(secret).join("[redacted]");
  }
  return result;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A timeout that can be cancelled, so a finished race leaves no live timer. */
function timeout(ms: number) {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    handle = setTimeout(() => resolve("timeout"), ms);
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A failure the transport reports to the run log; the run then exits 1. */
class ServeTransportError extends Error {}

async function* readEventStream(response: Response, signal: AbortSignal): AsyncGenerator<unknown> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (!line.startsWith("data: ")) continue;
        const parsed = safeJson(line.slice(6));
        if (parsed) yield parsed;
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  }
}

export async function runOpenCodeServeProcess(input: OpenCodeServeInput): Promise<RunProcessResult> {
  const password = randomBytes(24).toString("hex");
  const credential = Buffer.from(`${SERVER_USERNAME}:${password}`).toString("base64");
  const secrets = [password, credential, ...input.mcpServers.map((server) => server.token)];
  const redact = (text: string) => redactOpenCodeServeSecrets(text, secrets);
  const authorization = `Basic ${credential}`;
  const readyTimeoutMs = input.mcpReadyTimeoutMs ?? OPENCODE_SERVE_MCP_READY_TIMEOUT_MS;

  let stdout = "";
  let stderr = "";
  const emit = async (stream: "stdout" | "stderr", text: string) => {
    if (stream === "stdout") stdout = appendWithCap(stdout, text);
    else stderr = appendWithCap(stderr, text);
    // A failing log sink must not change the run result or skip the cleanup.
    await input.onLog(stream, text).catch((err: unknown) =>
      console.warn({ err, runId: input.runId }, "failed to append OpenCode serve log chunk"),
    );
  };
  // `toResult` takes errorMessage from the parsed stdout `error` event, the same
  // place `opencode run` reports a failure, and classifies from stderr.
  const reportFailure = async (message: string) => {
    const text = redact(message);
    await emit("stdout", `${JSON.stringify({ type: "error", error: { message: text } })}\n`);
    await emit("stderr", `[paperclip] ${text}\n`);
  };

  const port = deferred<number>();
  let serverOutput = "";
  let listening = false;
  // The server's own output is diagnostics, not run result: it goes to stderr so
  // `stdout` stays the JSONL contract of `run --format json`.
  const server = runChildProcess(input.runId, input.command, buildOpenCodeServeArgs(), {
    cwd: input.cwd,
    env: { ...input.env, OPENCODE_SERVER_PASSWORD: password },
    timeoutSec: input.timeoutSec,
    graceSec: input.graceSec,
    onSpawn: input.onSpawn,
    onLog: async (_stream, chunk) => {
      if (!listening) {
        serverOutput += chunk;
        const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(serverOutput);
        if (match) {
          listening = true;
          port.resolve(Number(match[1]));
        }
      }
      // The banner would otherwise be the first stderr line, which is what
      // `toResult` quotes when a run fails without a parsed error.
      const diagnostics = chunk.replace(/^.*listening on http:\/\/127\.0\.0\.1:\d+.*(?:\r?\n|$)/m, "");
      if (diagnostics) await emit("stderr", redact(diagnostics));
    },
  });
  const serverExit = server.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const serverExited = serverExit.then(() => "server-exited" as const);

  const abort = new AbortController();
  const turnDone = deferred<OpenCodeServeTurnOutcome>();
  let outcome: OpenCodeServeTurnOutcome | null = null;
  let failure: string | null = null;
  let boundSessionId: string | null = null;
  const seenResourceServers = new Set<string>();
  const readyWaiters: Array<() => void> = [];
  const eventState = createOpenCodeServeEventState();

  let base = "";
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: authorization, "content-type": "application/json" },
      signal: abort.signal,
    });
    return { status: response.status, text: await response.text() };
  };

  // `opencode run` auto-rejects a permission request because it cannot ask
  // anyone; a server waits for a reply forever, so the transport gives the same
  // answer. Allowing is the job of the configured allow-list, never of this.
  const rejectPermission = async (data: Record<string, unknown>) => {
    const requestId = asString(data.id, "");
    const resources = Array.isArray(data.resources) ? data.resources.map((resource) => String(resource)) : [];
    await emit("stderr", redact(`! permission requested: ${asString(data.action, "")} (${resources.join(", ")}); auto-rejecting\n`));
    try {
      const reply = await request(
        `/api/session/${encodeURIComponent(asString(data.sessionID, ""))}/permission/${encodeURIComponent(requestId)}/reply`,
        { method: "POST", body: JSON.stringify({ decision: "reject", message: PERMISSION_REJECT_MESSAGE }) },
      );
      if (reply.status >= 300) throw new Error(`HTTP ${reply.status}`);
    } catch (error) {
      if (abort.signal.aborted) return;
      // An unanswered request would hold the turn open until the wall clock.
      failure = redact(`OpenCode permission request ${requestId} could not be rejected: ${error instanceof Error ? error.message : String(error)}`);
      await reportFailure(failure);
      turnDone.resolve("failed");
    }
  };

  const handleEvent = async (envelope: unknown) => {
    const event = parseObject(envelope);
    const data = parseObject(event.data);
    if (asString(event.type, "") === "mcp.resources.changed") {
      const name = asString(data.server, "");
      if (name) seenResourceServers.add(name);
      for (const wake of readyWaiters.splice(0)) wake();
      return;
    }
    if (!boundSessionId || asString(data.sessionID, "") !== boundSessionId) return;
    if (asString(event.type, "") === "permission.asked") {
      void rejectPermission(data);
      return;
    }
    const mapped = mapOpenCodeServeEvent(envelope, eventState);
    for (const line of mapped.lines) await emit("stdout", `${redact(line)}\n`);
    if (mapped.outcome === "failed") {
      const message = parseOpenCodeJsonl(mapped.lines.join("\n")).errorMessage;
      if (message) await emit("stderr", `${redact(message)}\n`);
    }
    if (mapped.outcome) {
      outcome = mapped.outcome;
      turnDone.resolve(mapped.outcome);
    }
  };

  const finish = async (exitCodeOnTurnEnd: number): Promise<RunProcessResult> => {
    abort.abort();
    const running = runningProcesses.get(input.runId);
    if (running) signalRunningProcess(running, "SIGTERM");
    // Only runChildProcess's own deadline otherwise escalates, so a server that
    // ignores SIGTERM would hold the run (and its port) until the wall clock.
    const grace = timeout(Math.max(1, input.graceSec) * 1000);
    const stopped = await Promise.race([serverExit, grace.promise]);
    grace.cancel();
    if (stopped === "timeout") {
      const lingering = runningProcesses.get(input.runId);
      if (lingering) signalRunningProcess(lingering, "SIGKILL");
    }
    const settled = await serverExit;
    if (!settled.ok) {
      await reportFailure(settled.error instanceof Error ? settled.error.message : String(settled.error));
      return { exitCode: 1, signal: null, timedOut: false, stdout, stderr, pid: null, startedAt: null };
    }
    const proc = settled.value;
    // We stop the server after the turn, so its exit status says nothing about
    // the run. A server that died on its own (timeout, cancel, crash) keeps its.
    const endedByTurn = outcome !== null || failure !== null;
    if (outcome === "interrupted" && !proc.timedOut) {
      await reportFailure("OpenCode session was interrupted before it finished");
    }
    if (!endedByTurn && !proc.timedOut) {
      await reportFailure("OpenCode ended before the turn finished (event stream closed or server exited)");
    }
    return {
      ...proc,
      exitCode: proc.timedOut ? proc.exitCode : endedByTurn ? exitCodeOnTurnEnd : proc.exitCode || 1,
      signal: endedByTurn ? null : proc.signal,
      stdout,
      stderr,
    };
  };

  let exitCodeOnTurnEnd = 1;
  try {
    const startTimer = timeout(SERVE_START_TIMEOUT_MS);
    const started = await Promise.race([port.promise, serverExited, startTimer.promise]);
    startTimer.cancel();
    if (started === "server-exited") throw new ServeTransportError("OpenCode server exited before it started listening");
    if (started === "timeout") {
      throw new ServeTransportError(`OpenCode server did not start listening within ${SERVE_START_TIMEOUT_MS / 1000}s`);
    }
    base = `http://127.0.0.1:${started}`;

    // Subscribe before anything can happen so no event is missed. The server
    // sends `server.connected` first once the subscription is live.
    const stream = await fetch(`${base}/api/event`, { headers: { Authorization: authorization }, signal: abort.signal });
    if (!stream.ok || !stream.body) throw new ServeTransportError(`OpenCode event stream unavailable: HTTP ${stream.status}`);
    const connected = deferred<void>();
    const pump = (async () => {
      for await (const envelope of readEventStream(stream, abort.signal)) {
        if (asString(parseObject(envelope).type, "") === "server.connected") connected.resolve();
        await handleEvent(envelope);
      }
    })();
    const pumpEnded = pump.then(
      () => "stream-closed" as const,
      () => "stream-closed" as const,
    );
    const connectTimer = timeout(10_000);
    const connectResult = await Promise.race([connected.promise.then(() => "connected" as const), pumpEnded, serverExited, connectTimer.promise]);
    connectTimer.cancel();
    if (connectResult !== "connected") throw new ServeTransportError(`OpenCode event stream did not connect (${connectResult})`);

    // First location-scoped request: this is what makes OpenCode start MCP.
    // The readiness deadline covers it, so a request that blocks while the MCP
    // servers come up cannot outlast the bound.
    const deadline = Date.now() + readyTimeoutMs;
    const touchTimer = timeout(readyTimeoutMs);
    const touched = await Promise.race([request("/api/mcp").then(() => "touched" as const), serverExited, touchTimer.promise]);
    touchTimer.cancel();
    if (touched === "server-exited") throw new ServeTransportError("OpenCode server stopped while starting its MCP servers");
    if (touched === "timeout") {
      throw new ServeTransportError(`OpenCode did not answer its MCP status request within ${readyTimeoutMs / 1000}s; the run was not started.`);
    }

    if (input.mcpServers.length > 0) {
      const missing = () => input.mcpServers.filter((entry) => !seenResourceServers.has(entry.name)).map((entry) => entry.name);
      while (missing().length > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new ServeTransportError(
            `OpenCode did not report mcp.resources.changed for MCP server(s) ${missing().join(", ")} within ` +
              `${readyTimeoutMs / 1000}s; the run was not started because it would have begun without its Paperclip tools.`,
          );
        }
        const wake = deferred<void>();
        readyWaiters.push(wake.resolve);
        const tick = timeout(remaining);
        const reason = await Promise.race([wake.promise.then(() => "event" as const), serverExited, pumpEnded, tick.promise]);
        tick.cancel();
        if (reason === "server-exited" || reason === "stream-closed") {
          throw new ServeTransportError("OpenCode server stopped while waiting for its MCP servers");
        }
      }
      await sleep(input.mcpSettleMs ?? OPENCODE_SERVE_MCP_SETTLE_MS);
    }

    const model = parseOpenCodeServeModel(input.model, input.variant);
    if (!model) throw new ServeTransportError(`OpenCode model must be in provider/model format: ${input.model || "(none)"}`);

    let sessionId: string;
    if (input.resumeSessionId) {
      sessionId = input.resumeSessionId;
      const existing = await request(`/api/session/${encodeURIComponent(sessionId)}`);
      if (existing.status === 404) throw new ServeTransportError(`OpenCode session ${sessionId} not found (unknown session)`);
      if (existing.status !== 200) throw new ServeTransportError(`OpenCode could not load session ${sessionId}: HTTP ${existing.status}`);
      const switched = await request(`/api/session/${encodeURIComponent(sessionId)}/model`, {
        method: "POST",
        body: JSON.stringify({ model }),
      });
      if (switched.status >= 300) {
        throw new ServeTransportError(`OpenCode could not select model ${input.model} for session ${sessionId}: HTTP ${switched.status}`);
      }
    } else {
      const created = await request("/api/session", { method: "POST", body: JSON.stringify({ title: "paperclip", model }) });
      if (created.status !== 200) {
        throw new ServeTransportError(`OpenCode could not create a session: HTTP ${created.status} ${created.text.slice(0, 300)}`);
      }
      const createdId = asString(parseObject(parseObject(safeJson(created.text)).data).id, "");
      if (!createdId) throw new ServeTransportError("OpenCode created a session without an id");
      sessionId = createdId;
    }
    boundSessionId = sessionId;

    const prompted = await request(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text: input.prompt }),
    });
    if (prompted.status !== 200) {
      throw new ServeTransportError(`OpenCode rejected the prompt: HTTP ${prompted.status} ${prompted.text.slice(0, 300)}`);
    }

    // The turn ends with `session.execution.*`, or the server dies first
    // (wall-clock timeout, external cancel, crash) and the stream closes.
    await Promise.race([turnDone.promise, serverExited, pumpEnded]);
    exitCodeOnTurnEnd = outcome === "succeeded" ? 0 : 1;
  } catch (error) {
    failure = redact(error instanceof Error ? error.message : String(error));
    await reportFailure(failure);
  }
  return await finish(exitCodeOnTurnEnd);
}
