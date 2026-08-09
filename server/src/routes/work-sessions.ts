import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { selfDeclaredRunService } from "../services/self-declared-run.js";

const heartbeatBodySchema = z.object({
  runId: z.string().uuid(),
}).strict();

const closeBodySchema = z.object({
  runId: z.string().uuid(),
  outcome: z.enum(["succeeded", "failed", "cancelled"]),
  summary: z.string().optional(),
}).strict();

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

    const parsed = heartbeatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "runId is required and must be a valid UUID" });
      return;
    }

    const result = await svc.keepalive(parsed.data.runId, req.actor.agentId, issueId);
    res.status(200).json(result);
  });

  router.post("/issues/:issueId/work-session/close", async (req, res) => {
    const issueId = req.params.issueId as string;
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      res.status(403).json({ error: "agent authentication required" });
      return;
    }

    const parsed = closeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "runId (UUID), outcome, and optional summary are required" });
      return;
    }

    const result = await svc.closeSelfDeclaredRun(
      parsed.data.runId,
      req.actor.agentId,
      issueId,
      parsed.data.outcome,
      parsed.data.summary,
    );
    res.status(200).json(result);
  });

  return router;
}
