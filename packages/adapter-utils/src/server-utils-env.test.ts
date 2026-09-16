import { describe, expect, it } from "vitest";
import { LOCAL_HOST_DISCOVERY_EXCLUDED_ENV_KEYS } from "./execution-target.js";
import { MANAGED_GITHUB_TOKEN_KEYS, sanitizeInheritedPaperclipEnv } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });
});

describe("sanitizeInheritedPaperclipEnv — managed GitHub credential isolation (SUP-16539)", () => {
  it("strips all five managed GitHub token keys plus GH_CONFIG_DIR from the inherited env", () => {
    const env = sanitizeInheritedPaperclipEnv({
      HOME: "/home/user",
      PATH: "/usr/bin",
      GH_TOKEN: "server-token",
      GITHUB_TOKEN: "server-token",
      GH_ENTERPRISE_TOKEN: "server-token",
      GITHUB_ENTERPRISE_TOKEN: "server-token",
      PAPERCLIP_GIT_TOKEN: "server-token",
      GH_CONFIG_DIR: "/server/gh",
    });
    for (const key of MANAGED_GITHUB_TOKEN_KEYS) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.GH_CONFIG_DIR).toBeUndefined();
  });

  it("keeps unrelated keys and the PAPERCLIP_ runtime allowlist", () => {
    const env = sanitizeInheritedPaperclipEnv({
      HOME: "/home/user",
      PATH: "/usr/bin",
      GIT_CONFIG_COUNT: "1",
      GH_TOKEN: "server-token",
      PAPERCLIP_RUNTIME_API_URL: "http://runtime",
      PAPERCLIP_LISTEN_HOST: "0.0.0.0",
      PAPERCLIP_LISTEN_PORT: "3100",
    });
    expect(env.HOME).toBe("/home/user");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.PAPERCLIP_RUNTIME_API_URL).toBe("http://runtime");
    expect(env.PAPERCLIP_LISTEN_HOST).toBe("0.0.0.0");
    expect(env.PAPERCLIP_LISTEN_PORT).toBe("3100");
    expect(env.GH_TOKEN).toBeUndefined();
  });

  it("strips PAPERCLIP_GIT_TOKEN explicitly even though the PAPERCLIP_ prefix guard covers it", () => {
    // Pinned against the shared set so a future prefix-rule change cannot
    // silently drop the key from the managed-GitHub alignment.
    expect([...MANAGED_GITHUB_TOKEN_KEYS]).toEqual([
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
      "PAPERCLIP_GIT_TOKEN",
    ]);
  });

  it("lets an adapterConfig-bound GH_TOKEN reach the child when applied after sanitizing", () => {
    // runChildProcess lanes build their spawn env as
    // { ...sanitizeInheritedPaperclipEnv(process.env), ...env } with the
    // adapter-bound env last, so a bound token overrides the stripped
    // inherited one.
    const sanitized = sanitizeInheritedPaperclipEnv({ GH_TOKEN: "server-token", GH_CONFIG_DIR: "/server/gh" });
    const spawnEnv = { ...sanitized, ...{ GH_TOKEN: "bound-token", GH_CONFIG_DIR: "/bound/gh" } };
    expect(spawnEnv.GH_TOKEN).toBe("bound-token");
    expect(spawnEnv.GH_CONFIG_DIR).toBe("/bound/gh");
  });

  it("keeps the local host discovery exclusion list aligned with the shared token set", () => {
    // The probe (prepareGitHubExecutionEnvironment) runs on the sanitized
    // server env and deletes these keys from its discovery result. GH_CONFIG_DIR
    // is reported by the probe script but never read by git, and its value is
    // deleted from the result either way, so the widening of the sanitizer
    // changes no probe output.
    expect([...LOCAL_HOST_DISCOVERY_EXCLUDED_ENV_KEYS]).toEqual([...MANAGED_GITHUB_TOKEN_KEYS, "GH_CONFIG_DIR"]);
  });
});
