import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { selfDeclaredRunService } from "../services/self-declared-run.js";

export function workSessionRoutes(db: Db) {
  const router = Router();
  const svc = selfDeclaredRunService(db);

  router.post("/issues/:issueId/work-session", async (req, res) => {
    const issueId = req.params.issueId as string;
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      res.status(403).json({ error: "agent authentication required" });
      return;
    }

    const result = await svc.openSelfDeclaredRun(issueId, req.actor.agentId);
    res.status(201).json(result);
  });

  router.post("/issues/:issueId/work-session/heartbeat", async (req, res) => {
    const issueId = req.params.issueId as string;
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      res.status(403).json({ error: "agent authentication required" });
      return;
    }

    const runId = req.body?.runId as string | undefined;
    if (!runId) {
      res.status(400).json({ error: "runId is required" });
      return;
    }

    const result = await svc.keepalive(runId, req.actor.agentId);
    res.status(200).json(result);
  });

  router.post("/issues/:issueId/work-session/close", async (req, res) => {
    const issueId = req.params.issueId as string;
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      res.status(403).json({ error: "agent authentication required" });
      return;
    }

    const runId = req.body?.runId as string | undefined;
    if (!runId) {
      res.status(400).json({ error: "runId is required" });
      return;
    }

    const outcome = req.body?.outcome as
      "succeeded" | "failed" | "cancelled" | undefined;
    if (!outcome || !["succeeded", "failed", "cancelled"].includes(outcome)) {
      res
        .status(400)
        .json({ error: "outcome must be succeeded, failed, or cancelled" });
      return;
    }

    const summary = req.body?.summary as string | undefined;
    const result = await svc.closeSelfDeclaredRun(
      runId,
      req.actor.agentId,
      outcome,
      summary,
    );
    res.status(200).json(result);
  });

  return router;
}
