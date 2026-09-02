import express from "express";
import { generateKeyPairSync } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentGitHubTokenRoutes } from "../routes/agent-github-tokens.js";
import { errorHandler } from "../middleware/error-handler.js";
import {
  DEFAULT_GITHUB_APP,
  GITHUB_APP_PRIVATE_KEY_SECRET_NAME,
  appTokenCache,
  isGitHubTokenResolution,
  resolveAppInstallationToken,
} from "../services/github-credential.js";
import type { AppInstallationTokenSecrets, GitHubTokenResolution } from "../services/github-credential.js";

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({ getByName: vi.fn(), resolveSecretValue: vi.fn() }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../services/index.js", () => ({
  secretService: () => ({ getByName: vi.fn(), resolveSecretValue: vi.fn() }),
  logActivity: vi.fn(),
}));

const { privateKey: FIXTURE_PRIVATE_KEY_PEM } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const FIXTURE_PRIVATE_KEY = FIXTURE_PRIVATE_KEY_PEM.export({ type: "pkcs1", format: "pem" }, "utf8");
const FIXTURE_TOKEN = "ghs_test_installation_token_for_agent_route_tests_only";
const FIXTURE_INSTALLATION_ID = "12345678";
const REACHABLE_REPO = [{ repoUrl: "https://github.com/owner/repo" }];

type RouteDeps = Parameters<typeof agentGitHubTokenRoutes>[1];

function fakeDb(repoRows: Array<{ repoUrl: string | null }> = REACHABLE_REPO) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(repoRows),
      }),
    }),
  } as any;
}

function createApp(actor: Record<string, unknown>, deps: RouteDeps = {}, repoRows = REACHABLE_REPO) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentGitHubTokenRoutes(fakeDb(repoRows), deps));
  app.use(errorHandler);
  return app;
}

function agentActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "agent",
    agentId: "33333333-3333-4333-8333-333333333333",
    companyId: "company-1",
    runId: "55555555-5555-4555-8555-555555555555",
    source: "agent_jwt",
    ...overrides,
  };
}

function fakeDeps(opts: { secret?: { id: string } | null; tokenResult?: GitHubTokenResolution | null } = {}) {
  const secrets: AppInstallationTokenSecrets = {
    getByName: vi.fn(async (_companyId, name) =>
      name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME
        ? (opts.secret !== undefined ? opts.secret : { id: "app-key-1" })
        : null,
    ),
    resolveSecretValue: vi.fn(async () => FIXTURE_PRIVATE_KEY),
  };
  const resolveToken = vi.fn(async () =>
    opts.tokenResult !== undefined
      ? opts.tokenResult
      : {
          token: FIXTURE_TOKEN,
          scope: "app_installation",
          secretName: GITHUB_APP_PRIVATE_KEY_SECRET_NAME,
          installationId: FIXTURE_INSTALLATION_ID,
          expiresAt: 1_900_000_000_000,
        },
  );
  const log = vi.fn(async () => undefined);
  return { deps: { secrets, resolveToken, log }, secrets, resolveToken, log };
}

describe("POST /api/agents/me/github/installation-tokens", () => {
  beforeEach(() => {
    appTokenCache.clear();
  });

  it("rejects a board actor with 403 (agent-only route)", async () => {
    const { deps } = fakeDeps();
    const app = createApp({ type: "board", userId: "user-1", source: "session", companyIds: ["company-1"] }, deps);
    const res = await request(app).post("/api/agents/me/github/installation-tokens").send({ owner: "owner", repo: "repo" });
    expect(res.status).toBe(403);
  });

  it("rejects an agent without a bound run with 403", async () => {
    const { deps, resolveToken } = fakeDeps();
    const app = createApp(agentActor({ runId: undefined }), deps);
    const res = await request(app).post("/api/agents/me/github/installation-tokens").send({ owner: "owner", repo: "repo" });
    expect(res.status).toBe(403);
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it("rejects with 404 when the repo is not a company project workspace", async () => {
    const { deps, resolveToken } = fakeDeps();
    const app = createApp(agentActor(), deps, []);
    const res = await request(app).post("/api/agents/me/github/installation-tokens").send({ owner: "owner", repo: "repo" });
    expect(res.status).toBe(404);
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it("returns 404 app_not_configured when the App private key is not set, without minting", async () => {
    const { deps, resolveToken } = fakeDeps({ secret: null });
    const app = createApp(agentActor(), deps);
    const res = await request(app).post("/api/agents/me/github/installation-tokens").send({ owner: "owner", repo: "repo" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("app_not_configured");
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it("returns 502 mint_failed when the App is configured but the token cannot be minted", async () => {
    const { deps, resolveToken } = fakeDeps({ tokenResult: null });
    const app = createApp(agentActor(), deps);
    const res = await request(app).post("/api/agents/me/github/installation-tokens").send({ owner: "owner", repo: "repo" });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("mint_failed");
    expect(resolveToken).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed body with 400", async () => {
    const { deps } = fakeDeps();
    const app = createApp(agentActor(), deps);
    const res = await request(app).post("/api/agents/me/github/installation-tokens").send({ owner: "owner" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid permissions value with 400 instead of surfacing a 502 mint_failed", async () => {
    const { deps, resolveToken } = fakeDeps({ tokenResult: null });
    const app = createApp(agentActor(), deps);
    const res = await request(app)
      .post("/api/agents/me/github/installation-tokens")
      .send({ owner: "owner", repo: "repo", permissions: { contents: "bogus" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(Array.isArray(res.body.details)).toBe(true);
    const issue = (res.body.details as Array<{ code?: string; path?: Array<string | number> }>).find(
      (entry) => entry.path?.includes("contents"),
    );
    expect(issue?.code).toBe("invalid_value");
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it("returns the minted token, expiry, and installation id on the happy path", async () => {
    const { deps, resolveToken } = fakeDeps();
    const app = createApp(agentActor(), deps);
    const res = await request(app)
      .post("/api/agents/me/github/installation-tokens")
      .send({ owner: "owner", repo: "repo" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      token: FIXTURE_TOKEN,
      expiresAt: 1_900_000_000_000,
      installationId: FIXTURE_INSTALLATION_ID,
    });
    expect(resolveToken).toHaveBeenCalledWith(
      "company-1",
      expect.anything(),
      "owner",
      "repo",
      undefined,
      DEFAULT_GITHUB_APP,
      undefined,
    );
  });

  it("threads the requested permissions to the resolver", async () => {
    const permissions = { contents: "read", pull_requests: "write" };
    const { deps, resolveToken } = fakeDeps();
    const app = createApp(agentActor(), deps);
    const res = await request(app)
      .post("/api/agents/me/github/installation-tokens")
      .send({ owner: "owner", repo: "repo", permissions });
    expect(res.status).toBe(200);
    expect(resolveToken).toHaveBeenCalledWith(
      "company-1",
      expect.anything(),
      "owner",
      "repo",
      undefined,
      DEFAULT_GITHUB_APP,
      permissions,
    );
  });

  it("writes an audit entry with a redacted token and no secret value", async () => {
    const { deps, log } = fakeDeps();
    const app = createApp(agentActor(), deps);
    const res = await request(app)
      .post("/api/agents/me/github/installation-tokens")
      .send({ owner: "owner", repo: "repo" });
    expect(res.status).toBe(200);
    expect(log).toHaveBeenCalledTimes(1);
    const audit = log.mock.calls[0]![1] as Record<string, unknown>;
    expect(audit.action).toBe("github_installation_token_minted");
    expect(audit.actorType).toBe("agent");
    expect(audit.entityType).toBe("github_installation");
    const details = audit.details as Record<string, unknown>;
    expect(details.token).toBe("<redacted>");
    expect(JSON.stringify(audit)).not.toContain(FIXTURE_TOKEN);
    expect(JSON.stringify(audit)).not.toContain(FIXTURE_PRIVATE_KEY);
  });
});

describe("resolveAppInstallationToken — permissions, expiry, cache (route contract)", () => {
  const company = "company-1";
  const owner = "owner";
  const repo = "repo";
  const fakeSecrets: AppInstallationTokenSecrets = {
    getByName: async (_companyId, name) =>
      name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME ? { id: "app-key-1" } : null,
    resolveSecretValue: async () => FIXTURE_PRIVATE_KEY,
  };

  beforeEach(() => {
    appTokenCache.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("threads the requested permissions into the GitHub mint POST body", async () => {
    const expiresAt = "2026-08-17T13:00:00.000Z";
    let mintBody: unknown;
    const originalFetch = global.fetch;
    global.fetch = vi.fn((input: string | URL, init?: RequestInit) => {
      const target = typeof input === "string" ? input : input.toString();
      if (target.includes(`/repos/${owner}/${repo}/installation`)) {
        return Promise.resolve(new Response(JSON.stringify({ id: Number(FIXTURE_INSTALLATION_ID) }), { status: 200 }));
      }
      if (target.includes("/access_tokens")) {
        mintBody = init?.body;
        return Promise.resolve(
          new Response(JSON.stringify({ token: FIXTURE_TOKEN, expires_at: expiresAt }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as any;

    try {
      const result = await resolveAppInstallationToken(
        company,
        fakeSecrets,
        owner,
        repo,
        undefined,
        DEFAULT_GITHUB_APP,
        { contents: "read", pull_requests: "write" },
      );
      expect(isGitHubTokenResolution(result)).toBe(true);
      expect(mintBody).toBe(JSON.stringify({ permissions: { contents: "read", pull_requests: "write" } }));
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("surfaces the token expiry in the resolution", async () => {
    const expiresAt = "2026-08-17T13:00:00.000Z";
    const originalFetch = global.fetch;
    global.fetch = vi.fn((input: string | URL) => {
      const target = typeof input === "string" ? input : input.toString();
      if (target.includes(`/repos/${owner}/${repo}/installation`)) {
        return Promise.resolve(new Response(JSON.stringify({ id: Number(FIXTURE_INSTALLATION_ID) }), { status: 200 }));
      }
      if (target.includes("/access_tokens")) {
        return Promise.resolve(new Response(JSON.stringify({ token: FIXTURE_TOKEN, expires_at: expiresAt }), { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as any;

    try {
      const result = await resolveAppInstallationToken(company, fakeSecrets, owner, repo, undefined, DEFAULT_GITHUB_APP);
      expect(isGitHubTokenResolution(result)).toBe(true);
      if (isGitHubTokenResolution(result)) {
        expect(result.expiresAt).toBe(new Date(expiresAt).getTime());
      }
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("reuses the shared cache across repeat requests (no second mint)", async () => {
    let mintCount = 0;
    const originalFetch = global.fetch;
    global.fetch = vi.fn((input: string | URL) => {
      const target = typeof input === "string" ? input : input.toString();
      if (target.includes(`/repos/${owner}/${repo}/installation`)) {
        return Promise.resolve(new Response(JSON.stringify({ id: Number(FIXTURE_INSTALLATION_ID) }), { status: 200 }));
      }
      if (target.includes("/access_tokens")) {
        mintCount += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: `ghs_mint_${mintCount}`,
              expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as any;

    try {
      const first = await resolveAppInstallationToken(company, fakeSecrets, owner, repo, undefined, DEFAULT_GITHUB_APP);
      const second = await resolveAppInstallationToken(company, fakeSecrets, owner, repo, undefined, DEFAULT_GITHUB_APP);
      expect(isGitHubTokenResolution(first)).toBe(true);
      expect(isGitHubTokenResolution(second)).toBe(true);
      if (isGitHubTokenResolution(first) && isGitHubTokenResolution(second)) {
        expect(second.token).toBe(first.token);
        expect(second.expiresAt).toBe(first.expiresAt);
      }
      expect(mintCount).toBe(1);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
