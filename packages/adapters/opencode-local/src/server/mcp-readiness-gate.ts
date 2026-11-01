import http from "node:http";

/**
 * OpenCode V2 (2.2.4) MCP readiness gate — the deterministic signal validated by
 * the SUP-19139 readiness spike (document `readiness-signal-report`, verdict GO:
 * 5/5 gated runs carried the `paperclip_*` tools in the first main-agent
 * request, 1/1 clean hard-fail on an unreachable MCP server).
 *
 * Gate contract:
 * - Subscribe `GET /api/event` (SSE, Basic auth) first, so no `mcp.*` event is
 *   missed; the subscription is the quiescence observable.
 * - Poll `GET /api/mcp` until every expected server reports
 *   `data[server].status.status === "connected"`.
 * - Pass only after `quiescenceMs` (default 500 ms) with NO
 *   `mcp.status.changed` / `mcp.resources.changed` event. `connected` alone is
 *   NOT sufficient: the tool catalog lags the status (readiness1 counterexample).
 * - `deadlineMs` (default 10 s) → hard-fail. The caller must then NOT create a
 *   session and NOT prompt — that is the point of the gate.
 * - NEVER issue `POST /api/experimental/mcp/{name}/connect`. Each nudge tears
 *   the catalog down and re-lists it, and a session/prompt racing that churn
 *   misses the tools (1/10 hit when nudging vs 5/5 nudge-free on 2.2.4). This
 *   module only ever issues GET requests.
 */

/** Longest wait for connected+quiescent MCP servers before the hard fail. */
export const OPENCODE_MCP_READY_DEADLINE_MS = 10_000;
/** Quiet window with no `mcp.*` event that must hold before the gate passes. */
export const OPENCODE_MCP_QUIESCENCE_MS = 500;
/** `/api/mcp` poll interval while waiting for `connected`. */
const DEFAULT_POLL_MS = 100;
/** SSE event types that reset the quiescence window. */
const QUIESCENCE_EVENT_TYPES = new Set(["mcp.status.changed", "mcp.resources.changed"]);

export type OpenCodeMcpReadinessFailureReason = "deadline" | "stream" | "aborted";

/** The hard fail the caller turns into "do not create a session, do not prompt". */
export class OpenCodeMcpReadinessError extends Error {
  readonly reason: OpenCodeMcpReadinessFailureReason;
  /** Best-effort last-read `status.status` per expected server name. */
  readonly statuses: ReadonlyMap<string, string>;

  constructor(
    reason: OpenCodeMcpReadinessFailureReason,
    message: string,
    statuses: ReadonlyMap<string, string>,
  ) {
    super(message);
    this.name = "OpenCodeMcpReadinessError";
    this.reason = reason;
    this.statuses = statuses;
  }
}

export interface OpenCodeMcpReadyInput {
  /** Serve base URL, e.g. `http://127.0.0.1:41234`. */
  baseUrl: string;
  /** Authorization header for the serve API (Basic `opencode:<password>`). */
  authorization: string;
  /** Expected MCP server names; every one must report `connected`. */
  servers: string[];
  /** Test seams; production uses the defaults. */
  deadlineMs?: number;
  quiescenceMs?: number;
  pollMs?: number;
  fetcher?: typeof globalThis.fetch;
  signal?: AbortSignal;
  onDiagnostic?: (message: string) => void;
}

export interface OpenCodeMcpReadyResult {
  /** Gate duration in ms, from SSE subscription to the pass. */
  elapsedMs: number;
  /** `status.status` per expected server at the pass. */
  statuses: Record<string, string>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Opens the SSE stream with `node:http`, which has no body timeout. */
function openEventStream(url: string, authorization: string, signal: AbortSignal) {
  return new Promise<{ status: number; chunks: AsyncIterable<Uint8Array> }>((resolve, reject) => {
    const request = http.get(url, { headers: { authorization } }, (response) => {
      resolve({ status: response.statusCode ?? 0, chunks: response });
    });
    request.on("error", reject);
    signal.addEventListener("abort", () => request.destroy(), { once: true });
  });
}

async function* readEventStream(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!line.startsWith("data: ")) continue;
      const parsed = safeJson(line.slice(6));
      if (parsed !== null) yield parsed;
    }
  }
}

function describeStatuses(servers: readonly string[], statuses: ReadonlyMap<string, string>): string {
  return servers.map((name) => `${name}: ${statuses.get(name) ?? "not reported"}`).join("; ");
}

/**
 * Resolves when every expected MCP server reports `connected` AND the SSE stream
 * has been quiet of `mcp.status.changed` / `mcp.resources.changed` for
 * `quiescenceMs`. Rejects with {@link OpenCodeMcpReadinessError} at the
 * deadline, on an unusable event stream, or on abort — the caller then does not
 * create a session and does not prompt. Issues GET requests only; it never
 * nudges `/api/experimental/mcp/{name}/connect`.
 */
export async function waitForOpenCodeMcpReady(input: OpenCodeMcpReadyInput): Promise<OpenCodeMcpReadyResult> {
  const servers = [...input.servers];
  if (servers.length === 0) throw new Error("waitForOpenCodeMcpReady needs at least one expected MCP server");
  const deadlineMs = input.deadlineMs ?? OPENCODE_MCP_READY_DEADLINE_MS;
  const quiescenceMs = input.quiescenceMs ?? OPENCODE_MCP_QUIESCENCE_MS;
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  const fetcher = input.fetcher ?? globalThis.fetch;
  const startedAt = Date.now();
  const deadline = startedAt + deadlineMs;
  const abort = new AbortController();
  const onExternalAbort = () => abort.abort();
  input.signal?.addEventListener("abort", onExternalAbort, { once: true });
  let lastMcpEventAt = startedAt;
  const lastStatuses = new Map<string, string>();
  let lastReadProblem: string | null = null;

  const fail = (reason: OpenCodeMcpReadinessFailureReason, message: string) =>
    new OpenCodeMcpReadinessError(reason, message, lastStatuses);

  let stream: Awaited<ReturnType<typeof openEventStream>>;
  try {
    // Subscribe before polling: every `mcp.*` event from here on resets the
    // quiescence window, so catalog churn can never masquerade as quiet.
    stream = await openEventStream(`${input.baseUrl}/api/event`, input.authorization, abort.signal);
  } catch (error) {
    input.signal?.removeEventListener("abort", onExternalAbort);
    throw fail(
      "stream",
      `OpenCode event stream could not be opened: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (stream.status < 200 || stream.status >= 300) {
    abort.abort();
    input.signal?.removeEventListener("abort", onExternalAbort);
    throw fail("stream", `OpenCode event stream unavailable: HTTP ${stream.status}`);
  }

  // The pump only maintains `lastMcpEventAt`; polls stay authoritative, so a
  // dying pump never turns into a silent pass — the window just stops growing.
  const pump = (async () => {
    try {
      for await (const envelope of readEventStream(stream.chunks)) {
        if (abort.signal.aborted) return;
        const type = asRecord(envelope).type;
        if (typeof type === "string" && QUIESCENCE_EVENT_TYPES.has(type)) {
          lastMcpEventAt = Date.now();
          input.onDiagnostic?.(`mcp event: ${type}`);
        }
      }
    } catch {
      // The poll loop owns the verdict; a closed stream surfaces there.
    }
  })();

  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw fail(
          "deadline",
          `OpenCode MCP server(s) did not reach connected and quiet within ${deadlineMs / 1000}s ` +
            `(last status: ${describeStatuses(servers, lastStatuses)}${lastReadProblem ? `; last read failed: ${lastReadProblem}` : ""}); ` +
            `do not create a session — it would begin without its Paperclip tools`,
        );
      }
      if (input.signal?.aborted) throw fail("aborted", "OpenCode MCP readiness wait was aborted");

      let statuses: Map<string, string> | null = null;
      try {
        // The only side effect this module can trigger: on 2.2.4 the first
        // `GET /api/mcp` is what starts the MCP servers. It stays a GET.
        const response = await fetcher(`${input.baseUrl}/api/mcp`, {
          headers: { authorization: input.authorization },
          signal: abort.signal,
        });
        if (response.ok) {
          const entries = asRecord(safeJson(await response.text())).data;
          const read = new Map<string, string>();
          if (Array.isArray(entries)) {
            for (const entry of entries) {
              const record = asRecord(entry);
              if (typeof record.name !== "string") continue;
              const status = asRecord(record.status).status;
              read.set(record.name, typeof status === "string" ? status : "unknown");
            }
          }
          statuses = read;
          lastStatuses.clear();
          for (const [name, status] of read) lastStatuses.set(name, status);
          lastReadProblem = null;
        } else {
          lastReadProblem = `HTTP ${response.status}`;
        }
      } catch (error) {
        if (abort.signal.aborted) throw fail("aborted", "OpenCode MCP readiness wait was aborted");
        lastReadProblem = error instanceof Error ? error.message : String(error);
      }

      const quietFor = Date.now() - lastMcpEventAt;
      if (statuses !== null && servers.every((name) => statuses.get(name) === "connected")) {
        if (quietFor >= quiescenceMs) {
          return {
            elapsedMs: Date.now() - startedAt,
            statuses: Object.fromEntries(servers.map((name) => [name, statuses.get(name) ?? "unknown"])),
          };
        }
        input.onDiagnostic?.(`connected but not quiet (${quietFor}ms < ${quiescenceMs}ms); waiting`);
      }

      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  } finally {
    abort.abort();
    input.signal?.removeEventListener("abort", onExternalAbort);
    await pump;
  }
}
