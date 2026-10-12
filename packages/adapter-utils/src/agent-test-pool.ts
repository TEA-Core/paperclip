import { fileURLToPath } from "node:url";

export const PAPERCLIP_AGENT_TEST_POOL_MAX_WORKERS = 4;
export const PAPERCLIP_AGENT_TEST_POOL_PRELOAD_PATH = fileURLToPath(
  new URL("./vitest-worker-bound-preload.cjs", import.meta.url),
);

export function applyPaperclipAgentTestPoolBound(
  env: Record<string, string | undefined>,
  enabled = true,
): Record<string, string | undefined> {
  if (!enabled) return env;
  const preloadOption = `--require=${PAPERCLIP_AGENT_TEST_POOL_PRELOAD_PATH}`;
  const nodeOptions = env.NODE_OPTIONS?.trim();
  if (nodeOptions?.split(/\s+/u).includes(preloadOption)) return env;
  return {
    ...env,
    NODE_OPTIONS: nodeOptions ? `${nodeOptions} ${preloadOption}` : preloadOption,
  };
}
