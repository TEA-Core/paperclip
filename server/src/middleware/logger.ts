import pino from "pino";
import { pinoHttp } from "pino-http";
import { HTTP_LOG_REDACT_PATHS } from "./http-log-redaction.js";
import { shouldSilenceHttpSuccessLog } from "./http-log-policy.js";
import { redactSensitive } from "./redact-sensitive.js";
import { redactWorkspaceHandoffTicket } from "../auth/workspace-login-handoff.js";

const sharedOpts = {
  translateTime: "SYS:HH:MM:ss",
  ignore: "pid,hostname",
  singleLine: true,
};

const isProduction = process.env.NODE_ENV === "production";

// One pretty-print transport per process, even when this module is evaluated
// more than once.
//
// `pino.transport` spawns a worker thread (thread-stream) and hands back no
// handle this module could close, so every extra evaluation leaks one worker
// thread, one MessagePort and that worker's whole V8 isolate for the life of
// the process. A server process evaluates this module once, so the cache is
// inert in production. The route and authz suites do not: they call
// `vi.resetModules()` in `beforeEach` and re-import the middleware barrel per
// test, so a 50-test suite would otherwise end holding 50 live worker threads.
// Measured cost of the leak: ~400 transports in one process reach 407 threads
// and 1.68 GB RSS, so a 50-test route suite carries roughly 280 MB of dead
// workers — on the serialized shard, where files run one at a time under
// `maxWorkers=1` and a single runner carries every suite in turn.
//
// The cache lives on `globalThis` on purpose: a module-scoped variable is
// discarded by the very module-registry reset this guards against.
const PRETTY_TRANSPORT_KEY = "__paperclipPinoPrettyTransport";
type PrettyTransportCache = { [PRETTY_TRANSPORT_KEY]?: ReturnType<typeof pino.transport> };

function prettyTransport() {
  const cache = globalThis as typeof globalThis & PrettyTransportCache;
  cache[PRETTY_TRANSPORT_KEY] ??= pino.transport({
    target: "pino-pretty",
    options: { ...sharedOpts, ignore: "pid,hostname,req,res,responseTime", colorize: true, destination: 1 },
  });
  return cache[PRETTY_TRANSPORT_KEY];
}

export const logger = isProduction
  ? pino({ level: process.env.PAPERCLIP_LOG_LEVEL?.trim() || "info", redact: [...HTTP_LOG_REDACT_PATHS] })
  : pino({ level: process.env.PAPERCLIP_LOG_LEVEL?.trim() || "debug", redact: [...HTTP_LOG_REDACT_PATHS] }, prettyTransport());

export const httpLogger = pinoHttp({
  logger,
  customLogLevel(_req, res, err) {
    if (shouldSilenceHttpSuccessLog(_req.method, _req.url, res.statusCode)) {
      return "silent";
    }
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage(req, res) {
    // A workspace login handoff ticket is a bearer credential that rides in the
    // query string, so the request line has to be redacted before it is logged.
    return `${req.method} ${redactWorkspaceHandoffTicket(req.url ?? "")} ${res.statusCode}`;
  },
  customErrorMessage(req, res, err) {
    const ctx = (res as any).__errorContext;
    const errMsg = ctx?.error?.message || err?.message || (res as any).err?.message || "unknown error";
    return `${req.method} ${redactWorkspaceHandoffTicket(req.url ?? "")} ${res.statusCode} — ${errMsg}`;
  },
  customProps(req, res) {
    if (res.statusCode >= 400) {
      const ctx = (res as any).__errorContext;
      if (ctx) {
        return {
          errorContext: ctx.error,
          reqBody: redactSensitive(ctx.reqBody),
          reqParams: redactSensitive(ctx.reqParams),
          reqQuery: redactSensitive(ctx.reqQuery),
        };
      }
      const props: Record<string, unknown> = {};
      const { body, params, query } = req as any;
      if (body && typeof body === "object" && Object.keys(body).length > 0) {
        props.reqBody = redactSensitive(body);
      }
      if (params && typeof params === "object" && Object.keys(params).length > 0) {
        props.reqParams = redactSensitive(params);
      }
      if (query && typeof query === "object" && Object.keys(query).length > 0) {
        props.reqQuery = redactSensitive(query);
      }
      if ((req as any).route?.path) {
        props.routePath = (req as any).route.path;
      }
      return props;
    }
    return {};
  },
});
