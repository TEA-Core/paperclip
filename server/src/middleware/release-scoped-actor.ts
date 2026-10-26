import type { RequestHandler } from "express";
import { createRequestScopedDb, type Db } from "@paperclipai/db";
import { actorMiddleware, type ActorMiddlewareOptions } from "./auth.js";
import type { ReleaseRequestClock } from "./release-request-clock.js";

/**
 * The actor middleware, except that a release request (one the release clock is watching) authenticates on a
 * dedicated connection of its own. When the clock runs out that connection is cancelled, so the board-key
 * lookup does not stay active on the shared pool after the answer. The browser-session path
 * (`resolveSession`) runs on the session library's own pool and is abandoned, not cancelled. A client that
 * cannot make a dedicated connection falls back to the shared actor middleware.
 */
export function releaseScopedActor(db: Db, opts: ActorMiddlewareOptions, totalMs: number): RequestHandler {
  const shared = actorMiddleware(db, opts);
  return (req, res, next) => {
    const clock = res.locals.releaseClock as ReleaseRequestClock | undefined;
    const scope = clock
      ? createRequestScopedDb(db, { statementTimeoutMs: totalMs, lockTimeoutMs: totalMs, idleInTransactionMs: totalMs, connectTimeoutMs: Math.min(totalMs, 10_000) })
      : null;
    if (!clock || !scope) {
      void shared(req, res, next);
      return;
    }
    clock.cancelAuth = () => scope.cancel();
    res.once("close", () => { void scope.close(); });
    const finished = (error?: unknown) => {
      clock.cancelAuth = undefined;
      void scope.close();
      (next as (e?: unknown) => void)(error);
    };
    // A lookup the clock cancelled rejects; the request was already answered, so that is not an error to report.
    Promise.resolve(actorMiddleware(scope.db, opts)(req, res, finished)).catch((error) => {
      if (!clock.expired) finished(error);
    });
  };
}
