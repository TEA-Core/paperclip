import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveGitHubToken, type TokenCommandRunner } from "./paperclip-commit-metrics.js";

const ORIGINAL_ENV = { ...process.env };

function ghRunner(behavior: { stdout?: string; throws?: boolean }): TokenCommandRunner {
  return async (file, args) => {
    if (file !== "gh" || args.join(" ") !== "auth token") {
      throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
    }
    if (behavior.throws) throw new Error("gh auth token: exit status 1");
    return { stdout: behavior.stdout ?? "", stderr: "" };
  };
}

describe("resolveGitHubToken", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("prefers the gh token when gh succeeds, even when a different GH_TOKEN is set", async () => {
    process.env.GH_TOKEN = "ambient-env-token";
    await expect(resolveGitHubToken(ghRunner({ stdout: "ghs_scoped_app_token\n" }))).resolves.toBe(
      "ghs_scoped_app_token",
    );
  });

  it("falls back to the env token when gh exits non-zero", async () => {
    process.env.GH_TOKEN = "ambient-env-token";
    await expect(resolveGitHubToken(ghRunner({ throws: true }))).resolves.toBe("ambient-env-token");
  });

  it("falls back to GITHUB_TOKEN when gh yields only whitespace", async () => {
    process.env.GITHUB_TOKEN = "fallback-token";
    await expect(resolveGitHubToken(ghRunner({ stdout: "  \n" }))).resolves.toBe("fallback-token");
  });

  it("prefers gh over GITHUB_TOKEN when both are available", async () => {
    process.env.GITHUB_TOKEN = "fallback-token";
    await expect(resolveGitHubToken(ghRunner({ stdout: "ghs_scoped_app_token" }))).resolves.toBe(
      "ghs_scoped_app_token",
    );
  });

  it("throws when neither gh nor the environment yields a token", async () => {
    await expect(resolveGitHubToken(ghRunner({ throws: true }))).rejects.toThrow(
      "Unable to resolve a GitHub token",
    );
    await expect(resolveGitHubToken(ghRunner({ stdout: "" }))).rejects.toThrow(
      "Unable to resolve a GitHub token",
    );
  });
});
