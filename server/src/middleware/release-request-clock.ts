import type { RequestHandler } from "express";

/** The release routes (any letter case: Express routes case-insensitively): a board owner/admin releasing one PR head (SUP-20772). */
const RELEASE_ROUTE = /^\/api\/issues\/[^/]+\/merge-arming\/release(?:-override)?\/?$/i;

/** What the route handler reads from `res.locals.releaseClock`. */
export interface ReleaseRequestClock {
  /** When the request reached the server, before authentication. */
  startedAt: number;
  /** The clock ran out before the handler started: the answer is already sent, and the handler must do nothing. */
  expired: boolean;
  /** Set by the handler once it runs; from then on the handler owns the deadline and the answer. */
  handlerStarted: boolean;
  /** Ends the request's authentication work on its dedicated connection (see releaseScopedActor), if it has one. */
  cancelAuth?: () => Promise<void> | void;
}

/**
 * One request clock for the release routes that starts BEFORE authentication (and before the body is read). The actor middleware
 * resolves the board actor on the shared connection pool, a wait nothing in the handler can cancel; if
 * it is stuck, the request is still answered when the clock runs out (409, nothing published) and the
 * handler, when it finally gets to run, does nothing: no read, no write, no audit row. The stuck
 * authentication query itself is abandoned, not cancelled. Once the handler has started it owns the
 * deadline (it is given the time that is left) and this timer is inert.
 */
export function releaseRequestClock(opts: { totalMs: number }): RequestHandler {
  return (req, res, next) => {
    if (req.method !== "POST" || !RELEASE_ROUTE.test(req.path)) {
      next();
      return;
    }
    const clock: ReleaseRequestClock = { startedAt: Date.now(), expired: false, handlerStarted: false };
    res.locals.releaseClock = clock;
    const timer = setTimeout(() => {
      if (clock.handlerStarted || res.headersSent) return;
      clock.expired = true;
      // The authentication query that is still running is cancelled first (briefly awaited), so it is not
      // alive when the caller reads the answer.
      const cancelled = (async () => { await clock.cancelAuth?.(); })().catch(() => undefined);
      let cap: ReturnType<typeof setTimeout> | undefined;
      void Promise.race([cancelled, new Promise<void>((resolve) => { cap = setTimeout(resolve, 3000); })]).then(() => {
        clearTimeout(cap);
        if (res.headersSent) return;
        res.status(409).json({
          outcome: "failed",
          auditRecorded: false,
          message: "status:failed:deadline: the release request did not finish within its deadline while waiting to be authenticated; nothing was published",
        });
      });
    }, opts.totalMs);
    timer.unref?.();
    res.once("close", () => clearTimeout(timer));
    next();
  };
}
