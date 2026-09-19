import { z } from "zod";

/**
 * SUP-16560. Request schemas for the agent GitHub installation-token broker.
 *
 * These live in their own module, not in `./agent-github-tokens.ts`, so
 * `openapi.ts` can publish the contract without importing a route handler.
 * `openapi.ts` is reached from `services/native-runtime/runner-api-catalog.ts`,
 * so importing the route from `openapi.ts` closed the
 * heartbeat.ts -> native-runtime -> openapi.ts -> route -> services cycle.
 */

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
