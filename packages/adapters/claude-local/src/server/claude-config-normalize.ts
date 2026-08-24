import { pathToFileURL } from "node:url";
import {
  isAgentSideClaudeConfigPath,
  normalizeClaudeConfigDirTree,
} from "./claude-config.js";

/**
 * Standalone agent-uid pass of the agent-side Claude config home re-normalize
 * (SUP-13872). Exec'd through the setuid spawn shim as
 * `shim <node> <this file> <configDir>` so the walk runs as the agent uid
 * (1001) and can chmod/chgrp the SDK dirs the claude CLI created during the
 * run — dirs the server uid (1000) cannot hand over (chown across uids needs
 * CAP_CHOWN).
 *
 * The target is path-constrained to
 * `<instanceRoot>/companies/<companyId>/agents/<agentId>/claude-config`;
 * anything else is refused before the walk touches the filesystem. The walk
 * itself is the shared `normalizeClaudeConfigDirTree`, so this pass keeps
 * byte-identical semantics with the in-process pass (dirent-type-only
 * recursion, per-dir best-effort, stat-and-skip of dirs the running uid does
 * not own, files untouched).
 *
 * The caller (the managed-home teardown in `acp.ts`) scrubs the control-plane
 * secrets out of the child env before exec'ing: this process runs as the
 * agent uid, and handing it the server's `PAPERCLIP_SECRETS_*` env would
 * reopen the exact exposure the uid split exists to close.
 */
export async function runClaudeConfigNormalizerCli(input: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  const env = input.env ?? process.env;
  const target = (input.argv[2] ?? "").trim();
  if (!isAgentSideClaudeConfigPath(target, env)) {
    process.stderr.write(
      `claude-config-normalize: refusing target ${JSON.stringify(target)}; ` +
        "expected <instanceRoot>/companies/<companyId>/agents/<agentId>/claude-config\n",
    );
    return 2;
  }
  await normalizeClaudeConfigDirTree(target, async (_stream, message) => {
    process.stderr.write(message);
  });
  return 0;
}

// Entry-point guard: run the CLI only when this module is the spawned script
// (`node .../claude-config-normalize.js <target>`), never when it is imported
// (the in-process pass and the tests import the shared walk directly).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runClaudeConfigNormalizerCli({ argv: process.argv }).then((exitCode) => {
    if (exitCode !== 0) process.exit(exitCode);
  });
}
