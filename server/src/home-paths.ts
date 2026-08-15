import path from "node:path";
const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;
const FRIENDLY_PATH_SEGMENT_RE = /[^a-zA-Z0-9._-]+/g;
import {
  expandHomePrefix,
  resolveDefaultBackupDir as resolveSharedDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir as resolveSharedDefaultEmbeddedPostgresDir,
  resolveDefaultLogsDir as resolveSharedDefaultLogsDir,
  resolveDefaultSecretsKeyFilePath as resolveSharedDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir as resolveSharedDefaultStorageDir,
  resolveHomeAwarePath,
  resolvePaperclipConfigPathForInstance,
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
  resolvePaperclipInstanceRoot,
} from "@paperclipai/shared/home-paths";

export {
  expandHomePrefix,
  resolveHomeAwarePath,
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
  resolvePaperclipInstanceRoot,
};

export function resolveDefaultConfigPath(): string {
  return resolvePaperclipConfigPathForInstance();
}

export function resolveDefaultEmbeddedPostgresDir(): string {
  return resolveSharedDefaultEmbeddedPostgresDir();
}

export function resolveDefaultLogsDir(): string {
  return resolveSharedDefaultLogsDir();
}

export function resolveDefaultSecretsKeyFilePath(): string {
  return resolveSharedDefaultSecretsKeyFilePath();
}

/**
 * Resolve the secrets master key file, honouring PAPERCLIP_SECRETS_MASTER_KEY_FILE.
 *
 * SUP-12234 moved the fork's default master key OUT of the Paperclip home
 * volume (to /etc/paperclip/secrets/master.key) because that volume is mounted
 * into agent execution workspaces. `resolveDefaultSecretsKeyFilePath()` is only
 * the fallback: the deployed instance overrides it, and a call site that reads
 * the default directly silently pins itself to a path the operator has moved.
 */
export function resolveSecretsMasterKeyFilePath(): string {
  const fromEnv = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
  return resolveSharedDefaultSecretsKeyFilePath();
}

/**
 * Directory holding the master key. Every other key file the server persists
 * (decision signing, and anything a future fold adds) belongs beside it: the
 * isolation SUP-12234 bought is a property of the directory, so a sibling
 * inherits it and a key written anywhere else does not.
 */
export function resolveSecretsKeyDir(): string {
  return path.dirname(resolveSecretsMasterKeyFilePath());
}

export function resolveDefaultStorageDir(): string {
  return resolveSharedDefaultStorageDir();
}

export function resolveDefaultBackupDir(): string {
  return resolveSharedDefaultBackupDir();
}

export function resolveDefaultAgentWorkspaceDir(agentId: string): string {
  const trimmed = agentId.trim();
  if (!PATH_SEGMENT_RE.test(trimmed)) {
    throw new Error(`Invalid agent id for workspace path '${agentId}'.`);
  }
  return path.resolve(resolvePaperclipInstanceRoot(), "workspaces", trimmed);
}

function sanitizeFriendlyPathSegment(value: string | null | undefined, fallback = "_default"): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return fallback;
  const sanitized = trimmed
    .replace(FRIENDLY_PATH_SEGMENT_RE, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || fallback;
}

/**
 * Resolve the managed checkout directory for one project:
 * `<instanceRoot>/projects/<companyId>/<projectId>/<repoName|_default>`.
 *
 * Per-project directory isolation invariant: the `projectId` is a distinct path segment, so two
 * different projects always resolve to sibling directories under `<companyId>/`. One project's
 * directory can never nest inside, or be a path prefix of, another project's directory. A run that
 * materializes several referenced projects can therefore place each in its own directory without
 * collision. See the "distinct, non-nested managed dirs" test in `heartbeat-project-env.test.ts`.
 */
export function resolveManagedProjectWorkspaceDir(input: {
  companyId: string;
  projectId: string;
  repoName?: string | null;
}): string {
  const companyId = input.companyId.trim();
  const projectId = input.projectId.trim();
  if (!companyId || !projectId) {
    throw new Error("Managed project workspace path requires companyId and projectId.");
  }
  return path.resolve(
    resolvePaperclipInstanceRoot(),
    "projects",
    sanitizeFriendlyPathSegment(companyId, "company"),
    sanitizeFriendlyPathSegment(projectId, "project"),
    sanitizeFriendlyPathSegment(input.repoName, "_default"),
  );
}
