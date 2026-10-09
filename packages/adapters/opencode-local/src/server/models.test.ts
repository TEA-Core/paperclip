import { afterEach, describe, expect, it, vi } from "vitest";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";
import {
  discoverOpenCodeModels,
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  requireOpenCodeModelId,
  resetOpenCodeModelsCacheForTests,
  verifyOpenCodeCliVersion,
} from "./models.js";

describe("openCode models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    delete process.env.PAPERCLIP_OPENCODE_MODEL_VALIDATION_RETRIES;
    resetOpenCodeModelsCacheForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND =
      "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("accepts a provider/model id without running discovery", () => {
    expect(requireOpenCodeModelId("openai/gpt-5.2-codex")).toBe(
      "openai/gpt-5.2-codex",
    );
  });

  it("rejects malformed provider/model ids before discovery", () => {
    expect(() => requireOpenCodeModelId("gpt-5.2-codex")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
    expect(() => requireOpenCodeModelId("openai/")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
  });

  it("proceeds with the configured model when discovery cannot run (probe is best-effort, never fatal)", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND =
      "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).resolves.toEqual([{ id: "openai/gpt-5", label: "openai/gpt-5" }]);
  });

  it("skips the availability check when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND =
      "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).resolves.toEqual([
      {
        id: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        label: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
      },
    ]);
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND =
      "__paperclip_missing_opencode_command__";
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "anthropic/gateway/some-model",
      }),
    ).resolves.toEqual([
      {
        id: "anthropic/gateway/some-model",
        label: "anthropic/gateway/some-model",
      },
    ]);
  });

  it("still enforces provider/model format when OPENCODE_ALLOW_ALL_MODELS is set", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "not-a-valid-id",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("verifies the exact V2 CLI version before using the binary", async () => {
    const spy = vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "opencode 2.0.26\n",
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    });

    await expect(verifyOpenCodeCliVersion({ cliVersion: "2.0.26" })).resolves.toBeUndefined();
    expect(spy.mock.calls[0]?.[2]).toEqual(["--version"]);
  });

  it("rejects a V2 binary whose reported version does not match", async () => {
    vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "opencode 1.18.33\n",
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    });

    await expect(verifyOpenCodeCliVersion({ cliVersion: "2.0.26" })).rejects.toThrow(
      "OpenCode CLI version mismatch",
    );
  });

  it("accepts a version probe with a leading v", async () => {
    vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "v2.0.26\n",
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    });

    await expect(verifyOpenCodeCliVersion({ cliVersion: "2.0.26" })).resolves.toBeUndefined();
  });

  it("rejects a failed V2 version probe", async () => {
    vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "permission denied",
      pid: 1,
      startedAt: new Date().toISOString(),
    });

    await expect(verifyOpenCodeCliVersion({ cliVersion: "2.0.26" })).rejects.toThrow(
      "OpenCode CLI version probe failed",
    );
  });

  it("uses standalone discovery for V2 without changing V1 discovery", async () => {
    const spy = vi.spyOn(serverUtils, "runChildProcess").mockImplementation(async (_runId, _command, args) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: args[0] === "--version" ? "opencode 2.0.26\n" : "openai/gpt-5\n",
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    }));

    await expect(discoverOpenCodeModels({ cliVersion: "2.0.26" })).resolves.toEqual([
      { id: "openai/gpt-5", label: "openai/gpt-5" },
    ]);
    expect(spy.mock.calls[0]?.[2]).toEqual(["--version"]);
    expect(spy.mock.calls[1]?.[2]).toEqual(["models", "--standalone"]);

    resetOpenCodeModelsCacheForTests();
    await expect(discoverOpenCodeModels()).resolves.toEqual([
      { id: "openai/gpt-5", label: "openai/gpt-5" },
    ]);
    expect(spy.mock.calls[2]?.[2]).toEqual(["models"]);
  });

  it("fails loudly for an empty V2 catalog", async () => {
    vi.spyOn(serverUtils, "runChildProcess").mockImplementation(async (_runId, _command, args) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: args[0] === "--version" ? "opencode 2.0.26\n" : "",
      stderr: "",
      pid: 1,
      startedAt: new Date().toISOString(),
    }));

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        cliVersion: "2.0.26",
        model: "openai/gpt-5",
      }),
    ).rejects.toThrow("OpenCode V2 model discovery returned no models");
  });

  it("fails loudly when V2 catalog discovery fails", async () => {
    vi.useFakeTimers();
    vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "provider auth failed",
      pid: 1,
      startedAt: new Date().toISOString(),
    });

    const promise = ensureOpenCodeModelConfiguredAndAvailable({
      cliVersion: "2.0.26",
      model: "openai/gpt-5",
    });
    const assertion = expect(promise).rejects.toThrow("OpenCode V2 model discovery failed");
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("retries a transient `opencode models` failure with backoff before succeeding", async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(serverUtils, "runChildProcess")
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "queued behind another opencode run",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: null,
        signal: null,
        timedOut: true,
        stdout: "",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ollama/qwen2.5-coder:7b\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      });

    const promise = discoverOpenCodeModels();
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual([
      { id: "ollama/qwen2.5-coder:7b", label: "ollama/qwen2.5-coder:7b" },
    ]);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("refreshes a stale non-empty catalog before rejecting the configured model", async () => {
    // TEA-Core fork: disable the fork's uncached re-enumeration retries (a0535ed8c) so this
    // upstream test exercises the `models --refresh` path in isolation; production runs
    // the retries first, then this refresh.
    process.env.PAPERCLIP_OPENCODE_MODEL_VALIDATION_RETRIES = "0";
    const spy = vi
      .spyOn(serverUtils, "runChildProcess")
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/stale-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Models cache refreshed\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout:
          "openrouter/example/current-model\nopenrouter/deepseek/deepseek-v4-flash-0731\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      });

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
      }),
    ).resolves.toContainEqual({
      id: "openrouter/deepseek/deepseek-v4-flash-0731",
      label: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[0]?.[2]).toEqual(["models"]);
    expect(spy.mock.calls[1]?.[2]).toEqual(["models", "--refresh"]);
    expect(spy.mock.calls[2]?.[2]).toEqual(["models"]);
  });

  it("re-enumerates uncached before refreshing the cache when the configured model is missing (fork transient-blip retry)", async () => {
    // TEA-Core fork (a0535ed8c): an enumeration blip can omit a registry/auth-backed provider
    // while `opencode models` still exits 0. The fork re-enumerates first; upstream's
    // `models --refresh` runs only if the model is still missing afterwards.
    process.env.PAPERCLIP_OPENCODE_MODEL_VALIDATION_RETRIES = "1";
    const spy = vi
      .spyOn(serverUtils, "runChildProcess")
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/stale-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/stale-model\nopenrouter/deepseek/deepseek-v4-flash-0731\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      });

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
      }),
    ).resolves.toContainEqual({
      id: "openrouter/deepseek/deepseek-v4-flash-0731",
      label: "openrouter/deepseek/deepseek-v4-flash-0731",
    });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map((call) => call[2])).toEqual([["models"], ["models"]]);
  });

  it("still rejects when a refreshed non-empty catalog omits the configured model", async () => {
    process.env.PAPERCLIP_OPENCODE_MODEL_VALIDATION_RETRIES = "0";
    const spy = vi
      .spyOn(serverUtils, "runChildProcess")
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/stale-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Models cache refreshed\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/current-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      });

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
      }),
    ).rejects.toThrow(
      "Configured OpenCode model is unavailable: openrouter/deepseek/deepseek-v4-flash-0731",
    );
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[1]?.[2]).toEqual(["models", "--refresh"]);
    expect(spy.mock.calls[2]?.[2]).toEqual(["models"]);
  });

  it("still rejects from the original catalog when post-refresh enumeration returns no models", async () => {
    process.env.PAPERCLIP_OPENCODE_MODEL_VALIDATION_RETRIES = "0";
    const spy = vi
      .spyOn(serverUtils, "runChildProcess")
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/stale-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Models cache refreshed\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      });

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
      }),
    ).rejects.toThrow("Available models: openrouter/example/stale-model");
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[1]?.[2]).toEqual(["models", "--refresh"]);
    expect(spy.mock.calls[2]?.[2]).toEqual(["models"]);
  });

  it("still rejects from the original catalog when refresh fails", async () => {
    process.env.PAPERCLIP_OPENCODE_MODEL_VALIDATION_RETRIES = "0";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spy = vi
      .spyOn(serverUtils, "runChildProcess")
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openrouter/example/stale-model\n",
        stderr: "",
        pid: 1,
        startedAt: new Date().toISOString(),
      })
      .mockRejectedValueOnce(new Error("refresh unavailable"));

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openrouter/deepseek/deepseek-v4-flash-0731",
      }),
    ).rejects.toThrow("Available models: openrouter/example/stale-model");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[2]).toEqual(["models", "--refresh"]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'refresh failed for "openrouter/deepseek/deepseek-v4-flash-0731"',
      ),
    );
  });

  it("surfaces the last error once retries are exhausted", async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(serverUtils, "runChildProcess").mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "queued behind another opencode run",
      pid: 1,
      startedAt: new Date().toISOString(),
    });

    const promise = discoverOpenCodeModels();
    const assertion = expect(promise).rejects.toThrow(
      "`opencode models` failed: queued behind another opencode run",
    );
    await vi.runAllTimersAsync();
    await assertion;
    expect(spy).toHaveBeenCalledTimes(3);
  });
});
