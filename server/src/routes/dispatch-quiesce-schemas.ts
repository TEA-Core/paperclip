import { z } from "zod";

/**
 * SUP-16560. Request schema for deploy-time dispatch quiesce.
 *
 * This lives in its own module, not in `./dispatch-quiesce.ts`, so `openapi.ts`
 * can publish the contract without importing a route handler. `openapi.ts` is
 * reached from `services/native-runtime/runner-api-catalog.ts`, and the
 * dispatch-quiesce route imports `services/heartbeat.ts`, so importing the route
 * from `openapi.ts` closed the cycle `heartbeat.ts -> native-runtime ->
 * runner-api-catalog -> openapi.ts -> routes/dispatch-quiesce.ts -> heartbeat.ts`.
 */
export const dispatchQuiesceRequestSchema = z.object({
  /** Free-text label for who engaged the quiesce, surfaced in `GET` and the audit log. */
  reason: z.string().trim().min(1).max(200).optional(),
  /** Bounded by `resolveDispatchQuiesceTtlMs`; see that function for the clamp. */
  ttlSeconds: z.number().int().positive().optional(),
});
