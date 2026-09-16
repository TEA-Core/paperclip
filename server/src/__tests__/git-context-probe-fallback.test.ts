import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareGitHubExecutionEnvironment } from "@paperclipai/adapter-utils/execution-target";
import { applyPaperclipGitHubCredentialHelperEnv } from "@paperclipai/adapter-utils/server-utils";
import {
  buildHostModeGitContextFallbackEnv,
  prepareGitExecutionEnvironmentWithHostFallback,
} from "../services/git-context-probe-fallback.ts";

// TEA-Core fork (fold 2c, decision D3): host-mode Git-context probe failures fall back to the
// runtime env instead of failing the run; managed-mode failures stay fatal.

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-git-probe-fallback-"));
  roots.push(root);
  return root;
}

function timeoutError() {
  return Object.assign(new Error("Command failed: node -e const fs = require('node:fs') ..."), {
    killed: true,
    signal: "SIGTERM",
    code: null,
  });
}

describe("Git-context probe host-mode fallback (D3)", () => {
  it("host mode: a missing workspace cwd falls back to the runtime env with PAPERCLIP_GITHUB_AUTH_MODE=host", async () => {
    const root = await tempRoot();
    const result = await prepareGitExecutionEnvironmentWithHostFallback(
      {
        target: null,
        cwd: path.join(root, "missing", "workspace"),
        env: { FOO: "bar" },
        hostCredentials: true,
        networkAccess: true,
      },
      { prepare: prepareGitHubExecutionEnvironment },
    );

    expect(result.env.FOO).toBe("bar");
    expect(result.env.PAPERCLIP_GITHUB_AUTH_MODE).toBe("host");
    expect(result.env.PAPERCLIP_GIT_METADATA_ROOTS).toBe("[]");
    expect(result.env.PAPERCLIP_RUNNER_NETWORK_ROOTS).toBe("[]");
    expect(result.env.PAPERCLIP_RUNNER_NETWORK_ACCESS).toBe("enabled");
    expect(result.env.PAPERCLIP_GITHUB_HOST_HOME).toBeUndefined();
    expect(result.env.PAPERCLIP_GITHUB_LAUNCHER_DIR).toBeUndefined();
    expect(result.fallback).toMatchObject({ reason: "cwd_missing", errorCode: "ENOENT", targetKind: "local" });
  });

  it("host mode: a probe timeout falls back instead of failing", async () => {
    const prepare = vi.fn().mockRejectedValue(timeoutError());
    const now = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(16_000);
    const root = await tempRoot();

    const result = await prepareGitExecutionEnvironmentWithHostFallback(
      { target: null, cwd: root, env: {}, hostCredentials: true, networkAccess: true },
      { prepare, now },
    );

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(result.fallback).toMatchObject({ reason: "timeout", signal: "SIGTERM", errorCode: null, elapsedMs: 15_000 });
    expect(result.env.PAPERCLIP_GITHUB_AUTH_MODE).toBe("host");
  });

  it.each([
    { label: "spawn ENOENT with an existing cwd", error: { code: "ENOENT", syscall: "spawn /nonexistent/node" }, reason: "spawn_failed", errorCode: "ENOENT" },
    { label: "spawn EACCES", error: { code: "EACCES" }, reason: "spawn_failed", errorCode: "EACCES" },
    { label: "output overflow", error: { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, reason: "output_overflow", errorCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" },
    { label: "non-zero probe exit", error: Object.assign(new Error("x"), { code: 3 }), reason: "probe_exit_nonzero", errorCode: "3" },
  ])("host mode: $label classifies as $reason", async ({ error, reason, errorCode }) => {
    const root = await tempRoot();
    const result = await prepareGitExecutionEnvironmentWithHostFallback(
      { target: null, cwd: root, env: {}, hostCredentials: true, networkAccess: true },
      { prepare: vi.fn().mockRejectedValue(error) },
    );
    expect(result.fallback).toMatchObject({ reason, errorCode });
    expect(result.env.PAPERCLIP_GITHUB_AUTH_MODE).toBe("host");
  });

  it("host mode: unreadable local probe output and a failing remote probe both fall back", async () => {
    const root = await tempRoot();
    const unreadable = await prepareGitExecutionEnvironmentWithHostFallback(
      { target: null, cwd: root, env: {}, hostCredentials: true, networkAccess: true },
      { prepare: vi.fn().mockRejectedValue(new Error("Could not read execution-target Git context")) },
    );
    expect(unreadable.fallback?.reason).toBe("unreadable_output");

    const remoteTarget = (execute: (...args: unknown[]) => Promise<unknown>) => ({
      kind: "remote" as const,
      transport: "sandbox" as const,
      providerKey: "fixture",
      remoteCwd: root,
      runner: { execute: vi.fn(execute) },
    }) as unknown as Parameters<typeof prepareGitHubExecutionEnvironment>[0]["target"];

    const timedOut = await prepareGitExecutionEnvironmentWithHostFallback(
      {
        target: remoteTarget(async () => ({
          exitCode: 1, signal: null, timedOut: true, stdout: "", stderr: "", pid: null, startedAt: new Date().toISOString(),
        })),
        cwd: root, env: {}, hostCredentials: true, networkAccess: true,
      },
      { prepare: prepareGitHubExecutionEnvironment },
    );
    expect(timedOut.fallback).toMatchObject({ reason: "remote_probe_failed", targetKind: "remote" });
    expect(timedOut.env.PAPERCLIP_GITHUB_AUTH_MODE).toBe("host");

    const unreachable = await prepareGitExecutionEnvironmentWithHostFallback(
      {
        target: remoteTarget(async () => {
          throw new Error("ssh connect ECONNREFUSED");
        }),
        cwd: root, env: {}, hostCredentials: true, networkAccess: true,
      },
      { prepare: prepareGitHubExecutionEnvironment },
    );
    expect(unreachable.fallback?.reason).toBe("remote_probe_failed");
  });

  it("managed mode: a probe failure still rejects with the original error", async () => {
    const root = await tempRoot();
    await expect(prepareGitExecutionEnvironmentWithHostFallback(
      { target: null, cwd: path.join(root, "missing"), env: {}, hostCredentials: false, networkAccess: true },
      { prepare: prepareGitHubExecutionEnvironment },
    )).rejects.toMatchObject({ code: "ENOENT" });

    const error = timeoutError();
    await expect(prepareGitExecutionEnvironmentWithHostFallback(
      { target: null, cwd: root, env: {}, hostCredentials: false, networkAccess: true },
      { prepare: vi.fn().mockRejectedValue(error) },
    )).rejects.toBe(error);
  });

  it("fallback forces controller-owned keys over forged runtime bindings", async () => {
    const root = await tempRoot();
    const result = await prepareGitExecutionEnvironmentWithHostFallback(
      {
        target: null,
        cwd: root,
        env: {
          PAPERCLIP_GIT_METADATA_ROOTS: '["/injected"]',
          PAPERCLIP_RUNNER_NETWORK_ROOTS: '["/injected"]',
          PAPERCLIP_GITHUB_HOST_HOME: "/injected",
          PAPERCLIP_GITHUB_AUTH_MODE: "managed",
          PAPERCLIP_RUNNER_NETWORK_ACCESS: "enabled",
        },
        hostCredentials: true,
        networkAccess: false,
      },
      { prepare: vi.fn().mockRejectedValue(timeoutError()) },
    );
    expect(result.env.PAPERCLIP_GIT_METADATA_ROOTS).toBe("[]");
    expect(result.env.PAPERCLIP_RUNNER_NETWORK_ROOTS).toBe("[]");
    expect(result.env.PAPERCLIP_GITHUB_HOST_HOME).toBeUndefined();
    expect(result.env.PAPERCLIP_GITHUB_AUTH_MODE).toBe("host");
    expect(result.env.PAPERCLIP_RUNNER_NETWORK_ACCESS).toBe("disabled");
  });

  it("success path returns exactly the upstream probe env", async () => {
    const root = await tempRoot();
    const repo = path.join(root, "repo");
    await exec("git", ["init", repo]);
    const input = { target: null, cwd: repo, env: { FOO: "bar" }, hostCredentials: true, networkAccess: true };

    const wrapped = await prepareGitExecutionEnvironmentWithHostFallback(input, { prepare: prepareGitHubExecutionEnvironment });
    const raw = await prepareGitHubExecutionEnvironment(input);

    expect(wrapped.fallback).toBeNull();
    expect(wrapped.env).toEqual(raw);
  });

  it("fork credential helper wiring applies on top of a fallback env (I4)", () => {
    const empty = buildHostModeGitContextFallbackEnv({ env: {}, networkAccess: true });
    applyPaperclipGitHubCredentialHelperEnv(empty, "/opt/helper.sh");
    expect(empty).toMatchObject({
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      GIT_CONFIG_KEY_2: "credential.https://www.github.com.helper",
      GIT_CONFIG_COUNT: "3",
      GIT_TERMINAL_PROMPT: "0",
      PAPERCLIP_GITHUB_AUTH_MODE: "host",
    });

    const withSafeDirectory = buildHostModeGitContextFallbackEnv({
      env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "/paperclip/vaults/tsp" },
      networkAccess: true,
    });
    applyPaperclipGitHubCredentialHelperEnv(withSafeDirectory, "/opt/helper.sh");
    expect(withSafeDirectory).toMatchObject({
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "/paperclip/vaults/tsp",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_COUNT: "4",
    });
  });
});

describe("Git-context probe call-site guard (D3)", () => {
  it("the Git-context probe is reached only through the host-mode fallback wrapper", async () => {
    const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "node_modules") await walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          files.push(full);
        }
      }
    };
    await walk(serverSrc);
    expect(files.length).toBeGreaterThan(100);

    const directCalls: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (/prepareGitHubExecutionEnvironment\s*\(/.test(source)) directCalls.push(path.relative(serverSrc, file));
    }
    expect(directCalls, "call the probe through prepareGitExecutionEnvironmentWithHostFallback (fold decision D3)").toEqual([]);

    const heartbeat = await readFile(path.join(serverSrc, "services/heartbeat.ts"), "utf8");
    expect(heartbeat.split("await prepareGitExecutionEnvironmentWithHostFallback(").length - 1).toBe(1);
  });
});
