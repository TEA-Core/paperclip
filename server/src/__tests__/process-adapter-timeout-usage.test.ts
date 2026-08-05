import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "../adapters/process/execute.js";

describe("process adapter timeout usage persistence", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function writeTimeoutUsageCommand(commandPath: string): Promise<void> {
    const script = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "result", usage: { input_tokens: 150, output_tokens: 4500, cached_input_tokens: 900 } }) + "\\n");
// Sleep long enough to guarantee a timeout with timeoutSec=1
const end = Date.now() + 5000;
while (Date.now() < end) {
  // busy-wait
}
process.exit(0);
`;
    await fs.writeFile(commandPath, script, "utf8");
    await fs.chmod(commandPath, 0o755);
  }

  it("returns partial usage on timedOut path when stdout contains usage JSON", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-timeout-usage-"));
    cleanupDirs.push(tmpDir);
    const commandPath = path.join(tmpDir, "fake-timeout-usage");
    await writeTimeoutUsageCommand(commandPath);

    const result = await execute({
      runId: "test-run-timeout-usage",
      agent: { id: "agent-1", companyId: "company-1", name: "test-agent", adapterType: "process", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath,
        timeoutSec: 1,
        graceSec: 1,
      },
      context: {},
      authToken: null,
      onLog: async () => {},
    });

    expect(result.timedOut).toBe(true);
    expect(result.usage).toEqual({
      inputTokens: 150,
      outputTokens: 4500,
      cachedInputTokens: 900,
    });
    expect(result.usageBasis).toBe("per_run");
    expect(result.resultJson).toEqual({
      stdout: expect.any(String),
      stderr: expect.any(String),
    });
  });

  it("returns no usage on timedOut path when stdout has no usage JSON", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-timeout-nousage-"));
    cleanupDirs.push(tmpDir);
    const commandPath = path.join(tmpDir, "fake-timeout-nousage");
    const script = `#!/usr/bin/env node
process.stdout.write("just some output\\n");
const end = Date.now() + 5000;
while (Date.now() < end) {
  // busy-wait
}
process.exit(0);
`;
    await fs.writeFile(commandPath, script, "utf8");
    await fs.chmod(commandPath, 0o755);

    const result = await execute({
      runId: "test-run-timeout-nousage",
      agent: { id: "agent-1", companyId: "company-1", name: "test-agent", adapterType: "process", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath,
        timeoutSec: 1,
        graceSec: 1,
      },
      context: {},
      authToken: null,
      onLog: async () => {},
    });

    expect(result.timedOut).toBe(true);
    expect(result.usage).toBeUndefined();
    expect(result.resultJson).toEqual({
      stdout: expect.any(String),
      stderr: expect.any(String),
    });
  });
});