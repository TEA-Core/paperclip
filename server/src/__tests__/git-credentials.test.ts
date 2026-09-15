import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import {
  DEFAULT_GITHUB_TOKEN_SECRET_NAMES,
  GIT_CREDENTIAL_TOKEN_ENV_KEY,
  buildGitAuthInvocation,
  createGitRemoteAuthProvider,
  describeGitAuthFailure,
  forkForcesHostGitHub,
  isGitHubHttpsRemoteUrl,
  scrubGitCredentialText,
} from "../services/git-credentials.ts";

// TEA-Core fork (fold 2c D1): the provider's run-identity branch imports this module lazily.
// Tests that never reach that branch (null db or no heartbeatRunId) never call it.
const { mockResolveOperationCredentials } = vi.hoisted(() => ({
  mockResolveOperationCredentials: vi.fn(),
}));
vi.mock("../services/github-operation-credentials.js", () => ({
  resolveGitHubOperationCredentials: mockResolveOperationCredentials,
}));

const { mockResolveAppInstallationToken } = vi.hoisted(() => ({
  mockResolveAppInstallationToken: vi.fn(
    async (
      _companyId: string,
      secrets: { getByName: (companyId: string, name: string) => Promise<{ id: string } | null> },
    ) => {
      const secret = await secrets.getByName(_companyId, "GITHUB_APP_PRIVATE_KEY");
      if (!secret) return null;
      return {
        token: "app-installation-token",
        scope: "app_installation",
        secretName: "GITHUB_APP_PRIVATE_KEY",
        installationId: "153736520",
      };
    },
  ),
}));

vi.mock("../services/github-credential.js", () => ({
  resolveAppInstallationToken: mockResolveAppInstallationToken,
  GITHUB_APP_PRIVATE_KEY_SECRET_NAME: "GITHUB_APP_PRIVATE_KEY",
}));

const fakeDb = null as unknown as Db;

function buildSecretsFake(byName: Record<string, string | Error>) {
  const getByName = vi.fn(async (_companyId: string, name: string) => {
    if (!(name in byName)) return null;
    return { id: `secret-${name}` };
  });
  const resolveSecretValue = vi.fn(async (_companyId: string, secretId: string) => {
    const name = secretId.replace(/^secret-/, "");
    const value = byName[name];
    if (value instanceof Error) throw value;
    return value ?? "";
  });
  return { getByName, resolveSecretValue };
}

describe("isGitHubHttpsRemoteUrl", () => {
  it("accepts https github.com and www.github.com URLs", () => {
    expect(isGitHubHttpsRemoteUrl("https://github.com/example/repo.git")).toBe(true);
    expect(isGitHubHttpsRemoteUrl("https://www.github.com/example/repo.git")).toBe(true);
  });

  it("rejects ssh, http, enterprise hosts, other providers, userinfo URLs, and non-URLs", () => {
    expect(isGitHubHttpsRemoteUrl("git@github.com:example/repo.git")).toBe(false);
    expect(isGitHubHttpsRemoteUrl("ssh://git@github.com/example/repo.git")).toBe(false);
    expect(isGitHubHttpsRemoteUrl("http://github.com/example/repo.git")).toBe(false);
    expect(isGitHubHttpsRemoteUrl("https://github.enterprise.example/org/repo.git")).toBe(false);
    expect(isGitHubHttpsRemoteUrl("https://gitlab.com/example/repo.git")).toBe(false);
    expect(isGitHubHttpsRemoteUrl("https://alice:token@github.com/example/repo.git")).toBe(false);
    expect(isGitHubHttpsRemoteUrl("/local/path/repo.git")).toBe(false);
  });
});

describe("createGitRemoteAuthProvider", () => {
  const githubUrl = "https://github.com/example/repo.git";

  beforeEach(() => {
    mockResolveAppInstallationToken.mockClear();
  });

  it("prefers company secrets in declared order", async () => {
    const secrets = buildSecretsFake({ GH_TOKEN: "gh-token", PAPERCLIP_GITHUB_TOKEN: "pc-token" });
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets,
      env: { GITHUB_TOKEN: "env-token" },
      probeToken: async () => true,
    });
    const invocation = await provider(githubUrl);
    expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("gh-token");
    expect(invocation?.source).toBe("company_secret");
    expect(invocation?.secretName).toBe("GH_TOKEN");
    // The App private key is probed first even though it does not exist, then the names.
    expect(secrets.getByName.mock.calls.map((call) => call[1])).toEqual([
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_TOKEN",
      "GH_TOKEN",
    ]);
  });

  it("authenticates an App-covered remote with the installation token, not a company PAT", async () => {
    const secrets = buildSecretsFake({ GITHUB_APP_PRIVATE_KEY: "stub-private-key", GITHUB_TOKEN: "company-pat" });
    const probeToken = vi.fn(async () => true);
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets,
      env: {},
      probeToken,
    });
    const invocation = await provider("https://github.com/TEA-Core/paperclip.git");
    expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("app-installation-token");
    expect(invocation?.source).toBe("app_installation");
    expect(invocation?.secretName).toBe("GITHUB_APP_PRIVATE_KEY");
    // The company secrets are never probed once the App token is accepted.
    expect(probeToken).toHaveBeenCalledTimes(1);
    expect(probeToken).toHaveBeenCalledWith("app-installation-token", "TEA-Core", "paperclip");
  });

  it("falls through to the next candidate when GitHub rejects the first", async () => {
    const secrets = buildSecretsFake({ GITHUB_TOKEN: "dead-token", GH_TOKEN: "live-token" });
    const probeToken = vi.fn(async (token: string) => token !== "dead-token");
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets,
      env: {},
      probeToken,
    });
    const invocation = await provider(githubUrl);
    expect(invocation?.secretName).toBe("GH_TOKEN");
    expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("live-token");
    expect(probeToken).toHaveBeenCalledTimes(2);
  });

  it("falls back to the server env, GITHUB_TOKEN before GH_TOKEN", async () => {
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets: buildSecretsFake({}),
      env: { GITHUB_TOKEN: "env-github", GH_TOKEN: "env-gh" },
    });
    const invocation = await provider(githubUrl);
    expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("env-github");
    expect(invocation?.source).toBe("server_env");
    expect(invocation?.secretName).toBeNull();
  });

  it("returns null when no token is available anywhere", async () => {
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets: buildSecretsFake({}),
      env: {},
    });
    await expect(provider(githubUrl)).resolves.toBeNull();
  });

  it("accepts GitHub SSH remotes for process-scoped HTTPS rewriting", async () => {
    const secrets = buildSecretsFake({ GITHUB_TOKEN: "token" });
    const probeToken = vi.fn(async () => true);
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets,
      env: {},
      probeToken,
    });
    const invocation = await provider("git@github.com:example/repo.git");
    // TEA-Core fork: an scp-style remote is scoped to its owner/repo, so the SUP-13224 probe
    // (and its fall-through to the next candidate) applies to it like an HTTPS remote.
    expect(probeToken).toHaveBeenCalledWith("token", "example", "repo");
    expect(invocation?.env.GIT_CONFIG_VALUE_3).toBe("git@github.com:");
    expect(invocation?.env.GIT_CONFIG_KEY_3).toBe("url.https://github.com/.insteadOf");
  });

  it("returns null for non-GitHub URLs without touching the secret store", async () => {
    const secrets = buildSecretsFake({ GITHUB_TOKEN: "token" });
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets,
      env: {},
    });
    await expect(provider("https://gitlab.com/example/repo.git")).resolves.toBeNull();
    expect(secrets.getByName).not.toHaveBeenCalled();
    expect(mockResolveAppInstallationToken).not.toHaveBeenCalled();
  });

  it("memoizes the credential lookup per owner/repo across calls", async () => {
    const secrets = buildSecretsFake({ GITHUB_TOKEN: "token" });
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets,
      env: {},
      probeToken: async () => true,
    });
    await provider(githubUrl);
    await provider(githubUrl);
    // One resolution for the same owner/repo: the App private-key lookup plus the names, once.
    expect(secrets.getByName).toHaveBeenCalledTimes(2);
    expect(secrets.resolveSecretValue).toHaveBeenCalledTimes(1);
    expect(mockResolveAppInstallationToken).toHaveBeenCalledTimes(1);
    // A different owner/repo URL resolves separately.
    await provider("https://github.com/example/another.git");
    expect(secrets.getByName).toHaveBeenCalledTimes(4);
    expect(mockResolveAppInstallationToken).toHaveBeenCalledTimes(2);
  });

  it("passes a system access context so resolution is audited", async () => {
    const secrets = buildSecretsFake({ GITHUB_TOKEN: "token" });
    const provider = createGitRemoteAuthProvider(
      fakeDb,
      "company-1",
      { issueId: "issue-1", heartbeatRunId: "run-1" },
      { secrets, env: {}, probeToken: async () => true },
    );
    await provider(githubUrl);
    expect(secrets.resolveSecretValue).toHaveBeenCalledWith("company-1", "secret-GITHUB_TOKEN", "latest", {
      accessContext: expect.objectContaining({
        consumerType: "system",
        consumerId: "workspace-git-credential",
        actorType: "system",
        issueId: "issue-1",
        heartbeatRunId: "run-1",
      }),
    });
  });

  it("continues down the chain when one secret fails to resolve", async () => {
    const secrets = buildSecretsFake({
      GITHUB_TOKEN: new Error("provider outage"),
      GH_TOKEN: "gh-token",
    });
    const provider = createGitRemoteAuthProvider(fakeDb, "company-1", undefined, {
      secrets,
      env: {},
      probeToken: async () => true,
    });
    const invocation = await provider(githubUrl);
    expect(invocation?.secretName).toBe("GH_TOKEN");
  });

  it("ignores a managed connection installed only for another agent", async () => {
    const query = (rows: unknown[]) => ({
      from: () => ({ where: async () => rows }),
    });
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(query([{
          id: "github-connection",
          companyId: "company-1",
          enabled: true,
          status: "active",
          config: { sourceTemplateKey: "github" },
        }]))
        .mockReturnValueOnce(query([{
          connectionId: "github-connection",
          companyId: "company-1",
          targetType: "agent",
          targetId: "agent-a",
        }])),
    } as unknown as Db;
    const secrets = buildSecretsFake({ GH_TOKEN: "agent-b-legacy-token" });
    const provider = createGitRemoteAuthProvider(db, "company-1", { agentId: "agent-b" }, {
      secrets,
      env: {},
      // TEA-Core fork: without an injected probe the SUP-13224 probe calls api.github.com with
      // this fake token, gets a 401 when online, and falls through to no credential.
      probeToken: async () => true,
    });

    const invocation = await provider(githubUrl);

    expect(invocation?.source).toBe("company_secret");
    expect(invocation?.secretName).toBe("GH_TOKEN");
    expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("agent-b-legacy-token");
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});

describe("forkForcesHostGitHub", () => {
  it("forces host for local, ssh and an absent driver unless PAPERCLIP_GITHUB_MANAGED_EXECUTION=on", () => {
    for (const driver of ["local", "ssh", null, undefined]) {
      expect(forkForcesHostGitHub(driver, {})).toBe(true);
      expect(forkForcesHostGitHub(driver, { PAPERCLIP_GITHUB_MANAGED_EXECUTION: "on" })).toBe(false);
      expect(forkForcesHostGitHub(driver, { PAPERCLIP_GITHUB_MANAGED_EXECUTION: " ON " })).toBe(false);
      for (const value of ["off", "1", "true", ""]) {
        expect(forkForcesHostGitHub(driver, { PAPERCLIP_GITHUB_MANAGED_EXECUTION: value })).toBe(true);
      }
    }
    for (const driver of ["sandbox", "plugin", "kubernetes"]) {
      expect(forkForcesHostGitHub(driver, {})).toBe(false);
      expect(forkForcesHostGitHub(driver, { PAPERCLIP_GITHUB_MANAGED_EXECUTION: "on" })).toBe(false);
    }
  });
});

describe("fork host-mode gate (D1)", () => {
  const githubUrl = "https://github.com/example/repo.git";

  // A fake db that answers by table: the run row carries an identity context, every other
  // table (the managed-identity arm's tool connections) is empty.
  function tableDb() {
    const tables: unknown[] = [];
    const db = {
      select: vi.fn(() => ({
        from: (table: unknown) => {
          tables.push(table);
          return { where: async () => (table === heartbeatRuns ? [{ contextId: "ctx-1" }] : []) };
        },
      })),
    } as unknown as Db;
    return { db, tables };
  }

  beforeEach(() => {
    mockResolveOperationCredentials.mockReset();
  });

  it.each(["local", "ssh", null])(
    "a %s run with an identity context never reaches the run-identity projection",
    async (environmentDriver) => {
      const { db, tables } = tableDb();
      const provider = createGitRemoteAuthProvider(
        db,
        "company-1",
        { heartbeatRunId: "run-1", agentId: "agent-1", environmentDriver },
        { secrets: buildSecretsFake({ GITHUB_TOKEN: "host-token" }), env: {}, probeToken: async () => true },
      );

      const invocation = await provider(githubUrl);

      expect(mockResolveOperationCredentials).not.toHaveBeenCalled();
      expect(tables).not.toContain(heartbeatRuns);
      expect(invocation?.source).toBe("company_secret");
      expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("host-token");
      // Server-side workspace git for a local run never gets upstream's anonymous projection.
      expect(invocation?.env.GIT_CONFIG_GLOBAL).toBeUndefined();
      expect(invocation?.env.GIT_CONFIG_SYSTEM).toBeUndefined();
    },
  );

  it("absent arm: with the opt-in on, an absent run identity falls back to the owner/repo-scoped chain and memoizes per repo", async () => {
    const { db } = tableDb();
    mockResolveOperationCredentials.mockResolvedValue({ status: "absent", env: {} });
    const secrets = buildSecretsFake({ GITHUB_TOKEN: "t-a", GH_TOKEN: "t-b" });
    const probeToken = vi.fn(async (token: string, owner: string, repo: string) =>
      !(token === "t-a" && owner === "example" && repo === "other"));
    const provider = createGitRemoteAuthProvider(
      db,
      "company-1",
      { heartbeatRunId: "run-1", agentId: "agent-1", environmentDriver: "local" },
      { secrets, env: { PAPERCLIP_GITHUB_MANAGED_EXECUTION: "on" }, probeToken },
    );

    const first = await provider(githubUrl);
    const second = await provider("git@github.com:example/other.git");
    const getByNameCalls = secrets.getByName.mock.calls.length;
    const third = await provider(githubUrl);

    expect(mockResolveOperationCredentials).toHaveBeenCalledTimes(3);
    for (const call of mockResolveOperationCredentials.mock.calls) {
      expect(call[1]).toEqual({ companyId: "company-1", runId: "run-1", agentId: "agent-1" });
    }
    expect(first?.secretName).toBe("GITHUB_TOKEN");
    expect(second?.secretName).toBe("GH_TOKEN");
    expect(probeToken.mock.calls).toContainEqual(["t-a", "example", "other"]);
    expect(probeToken.mock.calls).toContainEqual(["t-b", "example", "other"]);
    expect(third?.secretName).toBe("GITHUB_TOKEN");
    expect(secrets.getByName.mock.calls.length).toBe(getByNameCalls);
    for (const invocation of [first, second, third]) {
      expect(invocation?.env.GIT_CONFIG_GLOBAL).toBeUndefined();
    }
  });

  it.each([
    { label: "opt-in on, local driver", env: { PAPERCLIP_GITHUB_MANAGED_EXECUTION: "on" }, environmentDriver: "local" },
    { label: "sandbox driver, no opt-in", env: {}, environmentDriver: "sandbox" },
  ])("$label keeps upstream's fail-closed anonymous invocation for a configured-but-unusable identity", async ({ env, environmentDriver }) => {
    const { db } = tableDb();
    mockResolveOperationCredentials.mockResolvedValue({ status: "unavailable", env: { GH_TOKEN: "" } });
    const secrets = buildSecretsFake({ GITHUB_TOKEN: "host-token" });
    const provider = createGitRemoteAuthProvider(
      db,
      "company-1",
      { heartbeatRunId: "run-1", agentId: "agent-1", environmentDriver },
      { secrets, env, probeToken: async () => true },
    );

    const invocation = await provider(githubUrl);

    expect(mockResolveOperationCredentials).toHaveBeenCalledTimes(1);
    expect(invocation?.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(invocation?.env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(invocation?.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("");
    expect(invocation?.env.GIT_AUTHOR_NAME).toBe("");
    expect(secrets.getByName).not.toHaveBeenCalled();
  });
});

describe("buildGitAuthInvocation", () => {
  it("keeps the token out of argv and installs the helper URL-scoped to github.com", () => {
    const invocation = buildGitAuthInvocation({
      token: "super-secret-token",
      source: "company_secret",
      secretName: "GITHUB_TOKEN",
    });
    expect(invocation.configArgs.join(" ")).not.toContain("super-secret-token");
    expect(invocation.configArgs[0]).toBe("-c");
    expect(invocation.configArgs[1]).toBe("credential.helper=");
    expect(invocation.configArgs[3]).toContain("credential.https://github.com.helper=");
    expect(invocation.configArgs[3]).toContain("x-access-token");
    expect(invocation.configArgs[5]).toContain("credential.https://www.github.com.helper=");
    expect(invocation.env[GIT_CREDENTIAL_TOKEN_ENV_KEY]).toBe("super-secret-token");
    expect(invocation.env.GH_TOKEN).toBe("super-secret-token");
    expect(invocation.env.GITHUB_TOKEN).toBe("super-secret-token");
    expect(invocation.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(invocation.env).not.toHaveProperty("HOME");
  });

  it("sets GitHub's stable noreply commit identity without exposing the token in config", () => {
    const invocation = buildGitAuthInvocation({
      token: "super-secret-token",
      source: "managed_connection",
      secretName: null,
      githubIdentity: { userId: "12345", login: "octocat" },
    });
    expect(invocation.env.GIT_CONFIG_KEY_7).toBe("user.name");
    expect(invocation.env.GIT_CONFIG_VALUE_7).toBe("octocat");
    expect(invocation.env.GIT_CONFIG_KEY_8).toBe("user.email");
    expect(invocation.env.GIT_CONFIG_VALUE_8).toBe("12345+octocat@users.noreply.github.com");
    expect(invocation.env.GIT_AUTHOR_NAME).toBe("octocat");
    expect(invocation.env.GIT_AUTHOR_EMAIL).toBe("12345+octocat@users.noreply.github.com");
    expect(invocation.env.GIT_COMMITTER_NAME).toBe("octocat");
    expect(invocation.env.GIT_COMMITTER_EMAIL).toBe("12345+octocat@users.noreply.github.com");
    expect(Object.values(invocation.env).filter((value) => value.includes("super-secret-token"))).toHaveLength(3);
  });
});

describe("credential helper execution (real git, no network)", () => {
  async function runCredentialFill(description: string) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-cred-fill-"));
    try {
      const invocation = buildGitAuthInvocation({
        token: "abc123",
        source: "company_secret",
        secretName: "GITHUB_TOKEN",
      });
      return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn("git", [...invocation.configArgs, "credential", "fill"], {
            cwd,
            env: { ...process.env, ...invocation.env },
            stdio: ["pipe", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => { stdout += String(chunk); });
          child.stderr.on("data", (chunk) => { stderr += String(chunk); });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, stdout, stderr }));
          child.stdin.write(description);
          child.stdin.end();
        },
      );
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }

  it("answers a github.com https request with the env-carried token", async () => {
    const result = await runCredentialFill("protocol=https\nhost=github.com\n\n");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("username=x-access-token");
    expect(result.stdout).toContain("password=abc123");
  });

  it("never hands the token to another host, even if git asks", async () => {
    // Simulates a request whose effective host changed after our pre-invocation URL check
    // (for example a repository-local url.<base>.insteadOf rewrite): the URL-scoped helper
    // config keeps git from consulting the helper, prompts are disabled, so the fill fails
    // and the token is never emitted.
    const result = await runCredentialFill("protocol=https\nhost=evil.example\n\n");
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("abc123");
  });

  it("never answers plain-http requests for github.com", async () => {
    const result = await runCredentialFill("protocol=http\nhost=github.com\n\n");
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("abc123");
  });
});

describe("scrubGitCredentialText", () => {
  it("masks URL userinfo", () => {
    expect(scrubGitCredentialText("https://x-access-token:ghp_secret@github.com/a/b.git")).toBe(
      "https://***@github.com/a/b.git",
    );
  });

  it("masks userinfo on non-HTTP schemes, leaving scp-style remotes alone", () => {
    expect(scrubGitCredentialText("ssh://deploy:hunter2@internal.example/repo.git")).toBe(
      "ssh://***@internal.example/repo.git",
    );
    expect(scrubGitCredentialText("git@github.com:example/repo.git")).toBe(
      "git@github.com:example/repo.git",
    );
  });

  it("masks entire URL query strings regardless of parameter names", () => {
    expect(scrubGitCredentialText("https://github.com/a/b.git?access_token=ghs_secret&ref=main")).toBe(
      "https://github.com/a/b.git?***",
    );
    expect(scrubGitCredentialText("https://host.example/r.git?obscure_cred_name=secret")).toBe(
      "https://host.example/r.git?***",
    );
  });

  it("leaves credential-free text unchanged", () => {
    expect(scrubGitCredentialText("fatal: repository not found")).toBe("fatal: repository not found");
  });
});

describe("describeGitAuthFailure", () => {
  it("names the company secret when a stored credential was used", () => {
    expect(describeGitAuthFailure({
      error: "fatal: Authentication failed",
      used: { source: "company_secret", secretName: "GH_TOKEN" },
    })).toContain("the GH_TOKEN company-secret GitHub credential");
  });

  it("names the App installation when an App installation credential was used", () => {
    expect(describeGitAuthFailure({
      error: "fatal: Authentication failed",
      used: { source: "app_installation", secretName: "GITHUB_APP_PRIVATE_KEY" },
    })).toContain("the GitHub App installation credential");
  });

  it("names the server environment when an env credential was used", () => {
    expect(describeGitAuthFailure({
      error: "fatal: Authentication failed",
      used: { source: "server_env", secretName: null },
    })).toContain("server-environment GitHub credential");
  });

  it("points at Settings → Secrets for auth-looking failures without a credential", () => {
    expect(describeGitAuthFailure({
      error: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      used: null,
    })).toContain("add a GITHUB_TOKEN or GH_TOKEN company secret");
  });

  it("stays silent for non-auth failures without a credential", () => {
    expect(describeGitAuthFailure({
      error: "fatal: unable to resolve host example.invalid",
      used: null,
    })).toBeNull();
  });

  it("stays silent for non-auth failures even when a credential was used", () => {
    // A credential present during an unrelated failure (network outage, target-path
    // collision) must not be blamed for it.
    expect(describeGitAuthFailure({
      error: "fatal: destination path '/x/y' already exists and is not an empty directory.",
      used: { source: "company_secret", secretName: "GH_TOKEN" },
    })).toBeNull();
  });
});

describe("DEFAULT_GITHUB_TOKEN_SECRET_NAMES", () => {
  it("keeps the shared name order stable", () => {
    expect([...DEFAULT_GITHUB_TOKEN_SECRET_NAMES]).toEqual([
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "PAPERCLIP_GITHUB_TOKEN",
    ]);
  });
});
