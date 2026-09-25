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

function resolveMaxWorkers(): number {
  const raw = process.env.PAPERCLIP_VITEST_MAX_WORKERS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, availableParallelism());
    }
  }
  return Math.max(1, Math.min(DEFAULT_MAX_WORKERS, availableParallelism()));
}

const maxWorkers = resolveMaxWorkers();

export default defineConfig({
  test: {
    // Bound BOTH ends: `minWorkers` stops the pool scaling back up past the cap,
    // and the fork pool gets an explicit per-worker heap ceiling so a single
    // runaway suite fails on its own JS heap instead of pushing the whole cgroup
    // into the kernel OOM killer and taking its neighbours with it.
    maxWorkers,
    minWorkers: 1,
    poolOptions: {
      forks: { maxForks: maxWorkers, minForks: 1 },
      threads: { maxThreads: maxWorkers, minThreads: 1 },
    },
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
      "packages/adapters/openclaw-gateway",
      "packages/adapters/opencode-local",
      "packages/adapters/pi-local",
      "packages/plugins/sdk",
      "packages/plugins/create-paperclip-plugin",
      "server",
      "ui",
      "cli",
    ],
  },
});
