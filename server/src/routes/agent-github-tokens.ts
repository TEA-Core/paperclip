import { Router, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { projectWorkspaces } from "@paperclipai/db";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";
import { HttpError, forbidden, notFound } from "../errors.js";
import { logActivity, secretService } from "../services/index.js";
import {
  DEFAULT_GITHUB_APP,
  normalizeRepoUrl,
  resolveAppInstallationToken,
  type AppInstallationTokenSecrets,
  type GitHubTokenResolution,
} from "../services/github-credential.js";

const agentInstallationTokenBodySchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  permissions: z.record(z.string(), z.enum(["read", "write", "admin", "none"])).optional(),
});

type InstallationTokenBody = z.infer<typeof agentInstallationTokenBodySchema>;

type AgentGitHubTokenRoutesDeps = {
  secrets?: AppInstallationTokenSecrets;
  resolveToken?: (
    companyId: string,
    secrets: AppInstallationTokenSecrets,
    owner?: string,
    repo?: string,
    accessContext?: Record<string, unknown>,
    app?: typeof DEFAULT_GITHUB_APP,
    permissions?: Record<string, unknown>,
  ) => Promise<GitHubTokenResolution | null>;
  log?: typeof logActivity;
};

/**
 * Agent-authenticated broker for GitHub App installation tokens.
 *
 * An agent run asks for a short-lived installation token scoped to a repo it can
 * already reach through a company project workspace. The route is agent-only,
 * verifies company + repo access, and mints a fresh App installation token (or
 * returns a cached one) via the shared `resolveAppInstallationToken` service.
 */
export function agentGitHubTokenRoutes(db: Db, deps: AgentGitHubTokenRoutesDeps = {}) {
  const router = Router();
  const secrets = deps.secrets ?? secretService(db);
  const resolveToken = deps.resolveToken ?? resolveAppInstallationToken;
  const log = deps.log ?? logActivity;

  // The repo must map to a company project workspace so an agent cannot mint a
  // token for an arbitrary owner/repo it has no business touching.
  async function assertRepoReachable(companyId: string, owner: string, repo: string) {
    const normalizedRepo = normalizeRepoUrl(`${owner}/${repo}`);
    const rows = await db
      .select({ repoUrl: projectWorkspaces.repoUrl })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.companyId, companyId));
    const reachable = rows.some(
      (row) => typeof row.repoUrl === "string" && normalizeRepoUrl(row.repoUrl) === normalizedRepo,
    );
    if (!reachable) {
      throw notFound(`No project workspace for ${owner}/${repo}`);
    }
  }

  router.post(
    "/agents/me/github/installation-tokens",
    validate(agentInstallationTokenBodySchema),
    async (req, res: Response) => {
      if (
        req.actor.type !== "agent" ||
        !req.actor.agentId ||
        !req.actor.companyId ||
        !req.actor.runId
      ) {
        throw forbidden("Run-bound agent authentication required");
      }
      const companyId = req.actor.companyId;
      assertCompanyAccess(req, companyId);

      const { owner, repo, permissions } = req.body as InstallationTokenBody;
      await assertRepoReachable(companyId, owner, repo);

      const app = DEFAULT_GITHUB_APP;

      // Distinguish "App not configured" (404) from "configured but mint failed" (502).
      const secret = await secrets.getByName(companyId, app.privateKeySecretName);
      if (!secret) {
        throw new HttpError(404, "GitHub App is not configured for this company", {
          code: "app_not_configured",
        });
      }

      const result = await resolveToken(companyId, secrets, owner, repo, undefined, app, permissions);

      if (!result) {
        throw new HttpError(502, "Failed to mint GitHub installation token", {
          code: "mint_failed",
        });
      }

      await log(db, {
        companyId,
        actorType: "agent",
        actorId: req.actor.agentId,
        action: "github_installation_token_minted",
        entityType: "github_installation",
        entityId: result.installationId ?? "unknown",
        agentId: req.actor.agentId,
        runId: req.actor.runId,
        details: {
          owner,
          repo,
          appId: app.appId,
          installationId: result.installationId ?? null,
          token: "<redacted>",
        },
      });

      res.status(200).json({
        token: result.token,
        expiresAt: result.expiresAt,
        installationId: result.installationId,
      });
    },
  );

  return router;
}
