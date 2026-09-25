import { availableParallelism } from "node:os";

import { defineConfig } from "vitest/config";

/**
 * Bound on the GLOBAL worker pool this root config drives.
 *
 * Vitest allocates ONE pool for a `projects` run; a per-project `maxWorkers`
 * (server/vitest.config.ts pins it to 1) does NOT bound that pool. So a bare
 * `vitest` / `pnpm test:watch` at the repo root runs the server suites
 * `availableParallelism()`-ways concurrently, and every concurrent server suite
 * boots its OWN embedded Postgres in beforeAll. That is both a correctness
 * hazard (the per-project pin exists to serialize those suites) and a resource
 * one.
 *
 * Production incident, 2026-09-25: an agent run executing the suite inside
 * the `paperclip-server-1` container spawned 16 forks on a 16-core host. Worker
 * RSS climbed to 8.5 GiB each, the container's 40 GiB cgroup limit was hit, and
 * the kernel OOM-killed 13 workers across three minutes (33 kills in kern.log
 * overall) while host load peaked at 24.4. The Paperclip server shares that
 * cgroup, so the same OOM sweep can take the control plane down while the
 * container still reports `Up` — tini stays PID 1 — leaving the edge proxy with
 * nothing to reach.
 *
 * Capping the pool bounds the blast radius. The supported full-suite path
 * remains `pnpm test` (scripts/run-vitest-stable.mjs), which shards deliberately
 * and keeps the server lane serial; this cap only governs ad-hoc root runs.
 * Override with PAPERCLIP_VITEST_MAX_WORKERS when a run genuinely owns the box.
 */
const DEFAULT_MAX_WORKERS = 4;

/**
 * NOTE on what this cap does and does not do.
 *
 * It bounds how MANY workers run, not how large each one grows. A per-worker JS
 * heap ceiling would be the complementary guard, but `execArgv` does not survive
 * a `projects` run: the pool SIZE is global and honoured here, while worker spawn
 * arguments are resolved per project, so a value set in this root config never
 * reaches the workers. Verified by sampling every 0.3s across a full run — zero
 * workers carried the flag, while `maxWorkers` was obeyed exactly. Applying a heap
 * ceiling would mean editing all 20 project configs, which is out of scope here.
 *
 * So the memory budget rests on the worker count: 4 workers against the observed
 * 8.5 GiB runaway is ~34 GiB, under the container's 40 GiB cgroup but not
 * comfortably. That is deliberate — this cap makes the OOM far less likely, and
 * the agent subprocess OOM priority (packages/adapter-utils/src/oom-priority.ts)
 * separately ensures the control plane is not the victim when it does happen.
 * Neither guard is sufficient alone.
 */

/**
 * Parses a whole-number environment override.
 *
 * The string must be ALL digits. `Number.parseInt` stops at the first
 * non-numeric character, so it would silently read "16GB" as 16 and "0.5" as 0 —
 * turning an operator's typo into a quietly wrong limit rather than a fallback
 * to the documented default.
 */
function envInteger(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) return fallback;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < min) return fallback;
  return parsed;
}

function resolveMaxWorkers(): number {
  const configured = envInteger("PAPERCLIP_VITEST_MAX_WORKERS", DEFAULT_MAX_WORKERS, 1);
  return Math.max(1, Math.min(configured, availableParallelism()));
}

const maxWorkers = resolveMaxWorkers();

export default defineConfig({
  test: {
    // `minWorkers` stops the pool scaling back up past the cap.
    //
    // These are TOP-LEVEL options. Vitest 4 removed `test.poolOptions`, and a
    // config still using it gets a deprecation warning and no effect — the
    // per-pool `maxForks`/`maxThreads` keys silently do nothing. Keep them here.
    maxWorkers,
    minWorkers: 1,
    projects: [
      "packages/shared",
      "packages/skills-catalog",
      "packages/db",
      "packages/adapter-utils",
      "packages/adapters/claude-local",
      "packages/adapters/codex-local",
      "packages/adapters/cursor-cloud",
      "packages/adapters/cursor-local",
      "packages/adapters/gemini-local",
      "packages/adapters/grok-local",
      "packages/adapters/kimi-local",
      "packages/adapters/openclaw-gateway",
      "packages/adapters/opencode-local",
      "packages/adapters/pi-local",
      "packages/plugins/sdk",
      "packages/plugins/create-paperclip-plugin",
      "packages/plugins/sandbox-providers/daytona",
      "server",
      "ui",
      "cli",
      "scripts",
    ],
  },
});
