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
  const readArgv = (...arguments_: string[]) => {
    const result = spawnSync(process.execPath, [
      "--require",
      PAPERCLIP_AGENT_TEST_POOL_PRELOAD_PATH,
      "--eval",
      "process.stdout.write(JSON.stringify(process.argv))",
      "/tmp/vitest",
      ...arguments_,
    ], { encoding: "utf8" });

    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as string[];
  };

  it.each([
    ["numeric equals", ["--maxWorkers=12"]],
    ["percentage equals", ["--maxWorkers=50%"]],
    ["numeric split", ["--maxWorkers", "12"]],
    ["percentage split", ["--maxWorkers", "50%"]],
  ])("normalizes %s", (_label, arguments_) => {
    const argv = readArgv(...arguments_);

    expect(argv).toContain(
      `--maxWorkers=${PAPERCLIP_AGENT_TEST_POOL_MAX_WORKERS}`,
    );
    expect(argv).not.toContain("--maxWorkers=12");
    expect(argv).not.toContain("--maxWorkers=50%");
    expect(argv).not.toContain("12");
    expect(argv).not.toContain("50%");
  });
});
