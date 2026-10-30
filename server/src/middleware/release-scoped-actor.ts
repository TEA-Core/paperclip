import type { RequestHandler } from "express";
import { createRequestScopedDb, type Db } from "@paperclipai/db";
import { actorMiddleware, type ActorMiddlewareOptions } from "./auth.js";
import type { ReleaseRequestClock } from "./release-request-clock.js";

/** Most dedicated authentication connections open at once; a request over it is refused (503), fail closed. */
export const RELEASE_AUTH_SCOPE_LIMIT = 4;

/**
 * The actor middleware, except that a release request (one the release clock is watching) authenticates on a
 * dedicated connection of its own. When the clock runs out that connection is cancelled, so the board-key
 * lookup does not stay active on the shared pool after the answer. The browser-session path
 * (`resolveSession`) runs on the session library's own pool and is abandoned, not cancelled. A client that
 * cannot make a dedicated connection falls back to the shared actor middleware.
 *
 * A request that was already answered (the clock ran out while its body was still arriving, or the caller
 * left) authenticates nothing when it reaches this middleware, and at most `limit` dedicated connections
 * are open at once: a request over that is refused instead of opening another.
 */
export function releaseScopedActor(db: Db, opts: ActorMiddlewareOptions, totalMs: number, limit = RELEASE_AUTH_SCOPE_LIMIT): RequestHandler {
  const shared = actorMiddleware(db, opts);
  let open = 0;
  return (req, res, next) => {
    const clock = res.locals.releaseClock as ReleaseRequestClock | undefined;
    if (!clock) {
      void shared(req, res, next);
      return;
    }
    // Answered before this point: no lookup, no connection, nothing handed on.
    if (clock.expired || res.headersSent || res.writableEnded || res.destroyed) return;
    if (open >= limit) {
      res.status(503).set("Retry-After", "5").json({
        outcome: "failed",
        auditRecorded: false,
        message: "status:failed:busy: too many release requests are being authenticated; nothing was published, try again shortly",
      });
      return;
    }
    const scope = createRequestScopedDb(db, { statementTimeoutMs: totalMs, lockTimeoutMs: totalMs, idleInTransactionMs: totalMs, connectTimeoutMs: Math.min(totalMs, 10_000) });
    if (!scope) {
      void shared(req, res, next);
      return;
    }
    open += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      open -= 1;
      void scope.close();
    };
    clock.cancelAuth = () => scope.cancel();
    res.once("close", release);
    const finished = (error?: unknown) => {
      clock.cancelAuth = undefined;
      release();
      (next as (e?: unknown) => void)(error);
    };
    // A lookup the clock cancelled rejects; the request was already answered, so that is not an error to report.
    Promise.resolve(actorMiddleware(scope.db, opts)(req, res, finished)).catch((error) => {
      if (!clock.expired) finished(error);
    });
  };
}
