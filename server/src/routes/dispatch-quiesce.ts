import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { heartbeatService, instanceSettingsService, logActivity } from "../services/index.js";
import {
  dispatchQuiesce,
  resolveDispatchQuiesceTtlMs,
} from "../services/dispatch-quiesce.js";

/**
 * SUP-9857. Deploy-time dispatch quiesce.
 *
 * `deploy-image.sh` used to quiesce by pausing every agent, but pause calls
 * `cancelActiveForAgent`, which cancels every queued/running run and signals its
 * process group. The drain that followed therefore always measured zero. These
 * routes give a deploy the thing it actually needed: stop starting new work,
 * leave running work alone, and report how much of it there is.
 */

function assertCanManageDispatchQuiesce(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

function assertCanReadDispatchQuiesce(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
}

export const dispatchQuiesceRequestSchema = z.object({
  /** Free-text label for who engaged the quiesce, surfaced in `GET` and the audit log. */
  reason: z.string().trim().min(1).max(200).optional(),
  /** Bounded by {@link resolveDispatchQuiesceTtlMs}; see that function for the clamp. */
  ttlSeconds: z.number().int().positive().optional(),
});

export function dispatchQuiesceRoutes(db: Db) {
  const router = Router();
  const heartbeat = heartbeatService(db);
  const instanceSettings = instanceSettingsService(db);

  // `activity_log.company_id` is required, and this lever has no company of its
  // own. Instance-level actions are audited by fanning out to every company,
  // the same way `PATCH /instance/settings` does.
  const auditInstanceAction = async (
    req: Request,
    action: string,
    details: Record<string, unknown>,
  ) => {
    const companyIds = await instanceSettings.listCompanyIds();
    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "board",
          action,
          entityType: "instance_dispatch_quiesce",
          entityId: "dispatch_quiesce",
          details,
        }),
      ),
    );
  };

  const withInFlight = async (state: ReturnType<typeof dispatchQuiesce.current>) => {
    const inFlight = await heartbeat.summarizeInFlightRuns();
    return {
      ...state,
      inFlightRuns: inFlight.running,
      queuedRuns: inFlight.queued,
      runIds: inFlight.runIds,
    };
  };

  router.get("/instance/dispatch-quiesce", async (req, res) => {
    assertCanReadDispatchQuiesce(req);
    res.json(await withInFlight(dispatchQuiesce.current()));
  });

  router.post("/instance/dispatch-quiesce", validate(dispatchQuiesceRequestSchema), async (req, res) => {
    assertCanManageDispatchQuiesce(req);
    const body = req.body as z.infer<typeof dispatchQuiesceRequestSchema>;
    const reason = body.reason ?? "unspecified";
    const state = dispatchQuiesce.engage({
      reason,
      ttlMs: resolveDispatchQuiesceTtlMs(body.ttlSeconds ?? null),
    });
    const payload = await withInFlight(state);
    await auditInstanceAction(req, "instance.dispatch_quiesce.engaged", {
      reason,
      expiresAt: state.expiresAt,
      inFlightRuns: payload.inFlightRuns,
      queuedRuns: payload.queuedRuns,
    });
    res.json(payload);
  });

  router.delete("/instance/dispatch-quiesce", async (req, res) => {
    assertCanManageDispatchQuiesce(req);
    const { released, previous } = dispatchQuiesce.release();
    const payload = await withInFlight(dispatchQuiesce.current());
    await auditInstanceAction(req, "instance.dispatch_quiesce.released", {
      released,
      previousReason: previous.reason,
      engagedAt: previous.engagedAt,
    });
    res.json({ ...payload, released });
  });

  return router;
}
