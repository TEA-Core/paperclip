import { Router, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { issues, projectWorkspaces } from "@paperclipai/db";
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

/**
 * Access levels a GitHub installation-token `permissions` entry accepts
 * (REST: POST /app/installations/{installation_id}/access_tokens). The value
 * set is deliberately a superset (read/write/admin/none) so the broker accepts
 * every level GitHub will honor for the default App.
 */
export const GITHUB_INSTALLATION_PERMISSION_LEVELS = ["read", "write", "admin", "none"] as const;

/**
 * The GitHub installation-permission name set accepted in an installation-token
 * `permissions` body. The broker threads these straight into the mint, so a
 * typo'd *name* is a caller input error (typed 400) rather than a 502 mint
 * failure.
 */
export const GITHUB_INSTALLATION_PERMISSION_NAMES = [
  "actions",
  "administration",
  "artifact_metadata",
  "attestations",
  "checks",
  "code_quality",
  "codespaces",
  "contents",
  "dependabot_secrets",
  "deployments",
  "discussions",
  "environments",
  "issues",
  "merge_queues",
  "metadata",
  "packages",
  "pages",
  "pull_requests",
  "repository_custom_properties",
  "repository_hooks",
  "repository_projects",
  "secret_scanning_alerts",
  "secrets",
  "security_events",
  "single_file",
  "statuses",
  "vulnerability_alerts",
  "workflows",
  "custom_properties_for_organizations",
  "members",
  "organization_administration",
  "organization_custom_roles",
  "organization_custom_org_roles",
  "organization_custom_properties",
  "organization_copilot_seat_management",
  "organization_copilot_agent_settings",
  "organization_announcement_banners",
  "organization_events",
  "organization_hooks",
  "organization_personal_access_tokens",
  "organization_personal_access_token_requests",
  "organization_plan",
  "organization_projects",
  "organization_packages",
  "organization_secrets",
  "organization_self_hosted_runners",
  "organization_user_blocking",
  "email_addresses",
  "followers",
  "git_ssh_keys",
  "gpg_keys",
  "interaction_limits",
  "profile",
  "starring",
  "enterprise_custom_properties_for_organizations",
] as const;

const permissionLevel = z.enum(GITHUB_INSTALLATION_PERMISSION_LEVELS);

// A token may request a subset of the App's permission names, each at one level.
// `.strict()` rejects any name outside the set so a typo'd key is a typed 400
// that names the offending key, instead of flowing through to the mint as a 502.
export const agentInstallationTokenPermissionsSchema = z.object(
  Object.fromEntries(
    GITHUB_INSTALLATION_PERMISSION_NAMES.map((name) => [name, permissionLevel.optional()]),
  ),
).strict();

// Shared by the OpenAPI registration (openapi.ts) so the published contract and
// the runtime schema cannot drift.
export const agentInstallationTokenRequestSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  permissions: agentInstallationTokenPermissionsSchema.optional(),
});

type InstallationTokenBody = z.infer<typeof agentInstallationTokenRequestSchema>;

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

  // The repo must map to a project workspace of a project the calling agent is
  // actually assigned to (issues assigned to it in this company), not just any
  // company project workspace — so an agent cannot mint a token for a project it
  // has no business touching.
  async function assertRepoReachable(companyId: string, agentId: string, owner: string, repo: string) {
    const normalizedRepo = normalizeRepoUrl(`${owner}/${repo}`);

    const assignedIssueRows = await db
      .select({ projectId: issues.projectId })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.assigneeAgentId, agentId)));
    const assignedProjectIds = new Set(
      assignedIssueRows.map((row) => row.projectId).filter((id): id is string => typeof id === "string"),
    );
    if (assignedProjectIds.size === 0) {
      throw notFound(`No project workspace for ${owner}/${repo}`);
    }

    const workspaceRows = await db
      .select({ projectId: projectWorkspaces.projectId, repoUrl: projectWorkspaces.repoUrl })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.companyId, companyId));
    const reachable = workspaceRows.some(
      (row) =>
        typeof row.projectId === "string" &&
        typeof row.repoUrl === "string" &&
        assignedProjectIds.has(row.projectId) &&
        normalizeRepoUrl(row.repoUrl) === normalizedRepo,
    );
    if (!reachable) {
      throw notFound(`No project workspace for ${owner}/${repo}`);
    }
  }

  router.post(
    "/agents/me/github/installation-tokens",
    validate(agentInstallationTokenRequestSchema),
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
      await assertRepoReachable(companyId, req.actor.agentId, owner, repo);

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
