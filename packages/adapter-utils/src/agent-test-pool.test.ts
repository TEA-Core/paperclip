import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  applyPaperclipAgentTestPoolBound,
  PAPERCLIP_AGENT_TEST_POOL_MAX_WORKERS,
  PAPERCLIP_AGENT_TEST_POOL_PRELOAD_PATH,
} from "./agent-test-pool.js";

describe("applyPaperclipAgentTestPoolBound", () => {
  it("adds the trusted preload to the agent environment", () => {
    const env = applyPaperclipAgentTestPoolBound({ PATH: "/usr/bin" });

    expect(env).toEqual({
      PATH: "/usr/bin",
      NODE_OPTIONS: `--require=${PAPERCLIP_AGENT_TEST_POOL_PRELOAD_PATH}`,
    });
  });

  it("preserves existing Node options without duplicating the preload", () => {
    const existing = "--trace-warnings";
    const env = applyPaperclipAgentTestPoolBound({ NODE_OPTIONS: existing });
    const repeated = applyPaperclipAgentTestPoolBound(env);

    expect(env.NODE_OPTIONS).toBe(
      `${existing} --require=${PAPERCLIP_AGENT_TEST_POOL_PRELOAD_PATH}`,
    );
    expect(repeated).toBe(env);
  });

  it("does not mutate disabled environments", () => {
    const env = { NODE_OPTIONS: "--trace-warnings" };

    expect(applyPaperclipAgentTestPoolBound(env, false)).toBe(env);
  });

});

describe("vitest-worker-bound-preload", () => {
  it("limits vitest's maxWorkers flag in a child process", () => {
    const result = spawnSync(process.execPath, [
      "--require",
      PAPERCLIP_AGENT_TEST_POOL_PRELOAD_PATH,
      "--eval",
      "process.stdout.write(JSON.stringify(process.argv))",
      "/tmp/vitest",
      "--maxWorkers=12",
    ], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toContain(
      `--maxWorkers=${PAPERCLIP_AGENT_TEST_POOL_MAX_WORKERS}`,
    );
    expect(JSON.parse(result.stdout)).not.toContain("--maxWorkers=12");
  });
});
