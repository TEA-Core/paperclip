/**
 * SUP-9857. Deploys need to stop the control plane from starting *new* agent
 * work while in-flight runs finish on their own, so the container can be
 * swapped without destroying 20-90 minutes of work per run.
 *
 * The only lever that existed for that was `POST /agents/:id/pause`, and pause
 * calls `cancelActiveForAgent`, which cancels every queued/running run and
 * SIGTERMs its process group. `deploy-image.sh` paused every agent and then
 * waited for the drain to reach zero -- but the pause loop had already emptied
 * it, so the drain reported success after 0s and the runs were gone.
 *
 * The scheduler already has a suppression concept (`PAPERCLIP_IN_WORKTREE`,
 * `PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS`) with exactly the right semantics:
 * it gates dispatch and never cancels anything. It was only readable from the
 * environment, which is fixed at process start and therefore useless to a
 * deploy script talking to an already-running server. This module makes the
 * same suppression togglable at runtime.
 *
 * State is deliberately in-memory, not persisted:
 *  - the whole point is to survive only until the container is replaced, and a
 *    replaced container must come up dispatching;
 *  - `heartbeatService(db)` is constructed 15 times across routes and services,
 *    so the flag is a module singleton rather than per-service closure state.
 *
 * Every engagement carries an expiry. A deploy that dies between engage and
 * release would otherwise leave the fleet quiesced with nothing anywhere saying
 * so -- a silent stall with no error to find.
 */

/** 90 minutes: longer than the longest observed agent run, shorter than a shift. */
export const DEFAULT_DISPATCH_QUIESCE_TTL_MS = 90 * 60 * 1_000;

/** Hard ceiling. No single deploy gets to park the fleet for longer than this. */
export const MAX_DISPATCH_QUIESCE_TTL_MS = 6 * 60 * 60 * 1_000;

export type DispatchQuiesceState =
  | { quiesced: false; reason: null; engagedAt: null; expiresAt: null }
  | { quiesced: true; reason: string; engagedAt: string; expiresAt: string };

const RELEASED: DispatchQuiesceState = {
  quiesced: false,
  reason: null,
  engagedAt: null,
  expiresAt: null,
};

export type DispatchQuiesceController = {
  engage: (input: { reason: string; ttlMs: number }) => DispatchQuiesceState;
  release: () => { released: boolean; previous: DispatchQuiesceState };
  current: () => DispatchQuiesceState;
  isQuiesced: () => boolean;
};

/**
 * Turn an operator-supplied ttl in seconds into a bounded millisecond budget.
 * Anything missing, non-finite or non-positive falls back to the default rather
 * than being treated as "no quiesce" or "quiesce forever".
 */
export function resolveDispatchQuiesceTtlMs(ttlSeconds: number | null | undefined): number {
  if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return DEFAULT_DISPATCH_QUIESCE_TTL_MS;
  }
  return Math.min(MAX_DISPATCH_QUIESCE_TTL_MS, Math.round(ttlSeconds * 1_000));
}

export function createDispatchQuiesceController(
  now: () => number = Date.now,
): DispatchQuiesceController {
  let engaged: { reason: string; engagedAtMs: number; expiresAtMs: number } | null = null;

  const snapshot = (): DispatchQuiesceState => {
    if (!engaged) return RELEASED;
    if (now() >= engaged.expiresAtMs) {
      engaged = null;
      return RELEASED;
    }
    return {
      quiesced: true,
      reason: engaged.reason,
      engagedAt: new Date(engaged.engagedAtMs).toISOString(),
      expiresAt: new Date(engaged.expiresAtMs).toISOString(),
    };
  };

  return {
    engage: ({ reason, ttlMs }) => {
      const at = now();
      // Re-engaging extends the window and re-labels it, but keeps the original
      // engagement time: an operator looking at a stuck quiesce needs to know
      // how long the fleet has actually been parked, not when the last keepalive
      // landed.
      const engagedAtMs = snapshot().quiesced && engaged ? engaged.engagedAtMs : at;
      engaged = { reason, engagedAtMs, expiresAtMs: at + ttlMs };
      return snapshot();
    },
    release: () => {
      const previous = snapshot();
      engaged = null;
      return { released: previous.quiesced, previous };
    },
    current: snapshot,
    isQuiesced: () => snapshot().quiesced,
  };
}

/**
 * Process-wide dispatch quiesce. Read by every `heartbeatService` instance
 * through its scheduling-suppression resolver.
 */
export const dispatchQuiesce = createDispatchQuiesceController();
