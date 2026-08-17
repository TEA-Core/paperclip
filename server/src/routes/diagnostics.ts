import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertAuthenticated, assertCompanyAccess } from "./authz.js";
import { accessService } from "../services/index.js";
import { resolveGitHubToken } from "../services/github-credential.js";
import { ghFetch } from "../services/github-fetch.js";
import { logger } from "../middleware/logger.js";

export interface GitHubCredentialProbe {
  attempted: boolean;
  status?: number;
  ok?: boolean;
  rateLimitLimit?: number;
}

export interface GitHubCredentialDiagnostics {
  resolved: boolean;
  scope: "app_installation" | "project_env" | "company" | null;
  secretName: string | null;
  installationId?: string | null;
  probe: GitHubCredentialProbe;
  checkedAt: string;
  reason?: string;
}

export function diagnosticsRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);

  router.get("/companies/:companyId/diagnostics/github-credential", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertAuthenticated(req);
    assertCompanyAccess(req, companyId);

    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      res.status(403).json({ error: "Activity is outside this actor's authorization boundary" });
      return;
    }

    const checkedAt = new Date().toISOString();

    let tokenResult;
    try {
      tokenResult = await resolveGitHubToken(db, companyId);
    } catch (err) {
      logger.warn({ err, companyId }, "GitHub credential resolution failed in diagnostics");
      res.json({
        resolved: false,
        scope: null,
        secretName: null,
        reason: `resolution_error: ${err instanceof Error ? err.message : "unknown"}`,
        probe: { attempted: false },
        checkedAt,
      });
      return;
    }

    if (tokenResult.token === null) {
      res.json({
        resolved: false,
        scope: null,
        secretName: null,
        reason: tokenResult.reason,
        probe: { attempted: false },
        checkedAt,
      });
      return;
    }

    const probe: GitHubCredentialProbe = { attempted: true };
    try {
      const response = await ghFetch("https://api.github.com/user", {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "paperclip-diagnostics",
          "x-github-api-version": "2022-11-28",
          authorization: `Bearer ${tokenResult.token}`,
        },
      });
      probe.status = response.status;
      probe.ok = response.ok;
      const rateLimitLimit = response.headers.get("x-ratelimit-limit");
      if (rateLimitLimit !== null) {
        probe.rateLimitLimit = Number(rateLimitLimit);
      }
    } catch (err) {
      logger.warn({ err, companyId }, "GitHub credential probe failed");
      probe.status = 0;
      probe.ok = false;
    }

    res.json({
      resolved: true,
      scope: tokenResult.scope,
      secretName: tokenResult.secretName,
      installationId: tokenResult.installationId ?? null,
      probe,
      checkedAt,
    });
  });

  return router;
}
