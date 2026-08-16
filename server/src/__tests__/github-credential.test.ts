import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGitHubToken, resolveGitHubTokenForRepo, isGitHubTokenResolution } from "../services/github-credential.js";
import type { Server } from "node:http";

const FIXTURE_TOKEN = "ghp_test_token_value_for_unit_tests_only";

const mockDb = {
  select: vi.fn(),
} as unknown as Parameters<typeof resolveGitHubTokenForRepo>[0];

const mockSecretService = {
  getByName: vi.fn(),
  resolveSecretValue: vi.fn(),
};

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

const mockGhFetch = vi.hoisted(() => ({
  ghFetch: vi.fn(),
}));

vi.mock("../services/github-fetch.js", () => ({
  ghFetch: mockGhFetch.ghFetch,
  gitHubApiBase: (hostname: string) =>
    hostname === "github.com" || hostname === "www.github.com"
      ? "https://api.github.com"
      : `https://${hostname}/api/v3`,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
}));

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const { createServer } = await import("node:http");
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected HTTP server to listen on a TCP port");
  }
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

async function httpRequest(url: string, path: string): Promise<{ status: number; body: any }> {
  const { get } = await import("node:http");
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = get(`${url}${path}`, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        let body: any = {};
        try {
          body = data ? JSON.parse(data) : {};
        } catch {
          body = {};
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
  });
}

describe("resolveGitHubToken", () => {
  beforeEach(() => {
    mockSecretService.getByName.mockReset();
    mockSecretService.resolveSecretValue.mockReset();
    mockDb.select.mockReset();
  });

  it("resolves at company scope when GITHUB_TOKEN exists", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === "GITHUB_TOKEN") return { id: "secret-1", name: "GITHUB_TOKEN" };
      return null;
    });
    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_TOKEN);

    const result = await resolveGitHubToken(mockDb, "company-1");
    expect(isGitHubTokenResolution(result)).toBe(true);
    if (isGitHubTokenResolution(result)) {
      expect(result.token).toBe(FIXTURE_TOKEN);
      expect(result.scope).toBe("company");
      expect(result.secretName).toBe("GITHUB_TOKEN");
    }
  });

  it("falls through to GH_TOKEN when GITHUB_TOKEN is absent", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === "GH_TOKEN") return { id: "secret-2", name: "GH_TOKEN" };
      return null;
    });
    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_TOKEN);

    const result = await resolveGitHubToken(mockDb, "company-1");
    expect(isGitHubTokenResolution(result)).toBe(true);
    if (isGitHubTokenResolution(result)) {
      expect(result.secretName).toBe("GH_TOKEN");
      expect(result.scope).toBe("company");
    }
  });

  it("falls through to PAPERCLIP_GITHUB_TOKEN when first two are absent", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === "PAPERCLIP_GITHUB_TOKEN") return { id: "secret-3", name: "PAPERCLIP_GITHUB_TOKEN" };
      return null;
    });
    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_TOKEN);

    const result = await resolveGitHubToken(mockDb, "company-1");
    expect(isGitHubTokenResolution(result)).toBe(true);
    if (isGitHubTokenResolution(result)) {
      expect(result.secretName).toBe("PAPERCLIP_GITHUB_TOKEN");
    }
  });

  it("returns unresolved when no company-scope secret exists", async () => {
    mockSecretService.getByName.mockResolvedValue(null);

    const result = await resolveGitHubToken(mockDb, "company-1");
    expect(result.token).toBeNull();
    expect(result.reason).toContain("No GitHub token resolvable");
  });

  it("skips empty/whitespace-only secret values and continues", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === "GITHUB_TOKEN") return { id: "secret-1", name: "GITHUB_TOKEN" };
      if (name === "GH_TOKEN") return { id: "secret-2", name: "GH_TOKEN" };
      return null;
    });
    mockSecretService.resolveSecretValue
      .mockResolvedValueOnce("   ")
      .mockResolvedValueOnce(FIXTURE_TOKEN);

    const result = await resolveGitHubToken(mockDb, "company-1");
    expect(isGitHubTokenResolution(result)).toBe(true);
    if (isGitHubTokenResolution(result)) {
      expect(result.secretName).toBe("GH_TOKEN");
    }
  });
});

describe("resolveGitHubTokenForRepo", () => {
  beforeEach(() => {
    mockSecretService.getByName.mockReset();
    mockSecretService.resolveSecretValue.mockReset();
    mockDb.select.mockReset();
  });

  it("resolves via projects.env secret_ref at project_env scope", async () => {
    const secretRef = { type: "secret_ref", secretId: "ref-secret-1", version: "latest" };
    const projectEnv = { GITHUB_TOKEN: secretRef };

    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        { id: "pw-1", projectId: "proj-1", repoUrl: "https://github.com/owner/repo", projectEnv },
      ]),
    };
    mockDb.select.mockReturnValue(selectChain);

    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_TOKEN);

    const result = await resolveGitHubTokenForRepo(mockDb, "company-1", "owner", "repo");
    expect(isGitHubTokenResolution(result)).toBe(true);
    if (isGitHubTokenResolution(result)) {
      expect(result.token).toBe(FIXTURE_TOKEN);
      expect(result.scope).toBe("project_env");
      expect(result.secretName).toBe("GITHUB_TOKEN");
    }
  });

  it("falls back to company scope when no project_env binding resolves", async () => {
    const projectEnv = { GITHUB_TOKEN: { type: "secret_ref", secretId: "ref-secret-1", version: "latest" } };

    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        { id: "pw-1", projectId: "proj-1", repoUrl: "https://github.com/owner/repo", projectEnv },
      ]),
    };
    mockDb.select.mockReturnValue(selectChain);

    mockSecretService.resolveSecretValue
      .mockResolvedValueOnce("   ")
      .mockResolvedValueOnce(FIXTURE_TOKEN);
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === "GITHUB_TOKEN") return { id: "secret-1", name: "GITHUB_TOKEN" };
      return null;
    });

    const result = await resolveGitHubTokenForRepo(mockDb, "company-1", "owner", "repo");
    expect(isGitHubTokenResolution(result)).toBe(true);
    if (isGitHubTokenResolution(result)) {
      expect(result.scope).toBe("company");
      expect(result.secretName).toBe("GITHUB_TOKEN");
    }
  });

  it("returns unresolved when no token is resolvable at any scope", async () => {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        { id: "pw-1", projectId: "proj-1", repoUrl: "https://github.com/owner/repo", projectEnv: { GITHUB_TOKEN: { type: "secret_ref", secretId: "ref-1", version: "latest" } } },
      ]),
    };
    mockDb.select.mockReturnValue(selectChain);

    mockSecretService.resolveSecretValue.mockResolvedValue("   ");
    mockSecretService.getByName.mockResolvedValue(null);

    const result = await resolveGitHubTokenForRepo(mockDb, "company-1", "owner", "repo");
    expect(result.token).toBeNull();
    expect(result.reason).toContain("No GitHub token bound to project");
  });

  it("returns unresolved when repo is not found at company or project scope", async () => {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDb.select.mockReturnValue(selectChain);

    mockSecretService.getByName.mockResolvedValue(null);

    const result = await resolveGitHubTokenForRepo(mockDb, "company-1", "owner", "repo");
    expect(result.token).toBeNull();
    expect(result.reason).toContain("repo not found");
  });
});

describe("diagnostics route", () => {
  async function createApp(
    actor: Record<string, unknown> = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    },
  ) {
    const [{ diagnosticsRoutes }] = await Promise.all([
      import("../routes/diagnostics.js") as Promise<typeof import("../routes/diagnostics.js")>,
    ]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        ...actor,
        companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
      };
      next();
    });
    app.use("/api", diagnosticsRoutes(mockDb));
    return app;
  }

  beforeEach(() => {
    mockAccessService.decide.mockReset();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockSecretService.getByName.mockReset();
    mockSecretService.resolveSecretValue.mockReset();
    mockDb.select.mockReset();
    mockGhFetch.ghFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns resolved=true with scope and secretName at company scope", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === "GITHUB_TOKEN") return { id: "secret-1", name: "GITHUB_TOKEN" };
      return null;
    });
    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_TOKEN);
    mockGhFetch.ghFetch.mockResolvedValue(new Response(JSON.stringify({ login: "test" }), {
      status: 200,
      headers: { "x-ratelimit-limit": "5000" },
    }));

    const app = await createApp();
    const server = await startServer(app);
    try {
      const res = await httpRequest(server.url, "/api/companies/company-1/diagnostics/github-credential");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        resolved: true,
        scope: "company",
        secretName: "GITHUB_TOKEN",
        probe: {
          attempted: true,
          status: 200,
          ok: true,
          rateLimitLimit: 5000,
        },
      });
      expect(res.body.checkedAt).toBeDefined();
    } finally {
      await server.close();
    }
  });

  it("returns 403 for a caller outside the company", async () => {
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      action: "company_scope:read",
      reason: "deny_test",
      explanation: "Denied by test mock.",
    });

    const app = await createApp();
    const server = await startServer(app);
    try {
      const res = await httpRequest(server.url, "/api/companies/company-1/diagnostics/github-credential");

      expect(res.status).toBe(403);
      expect(res.body.error).toBeDefined();
    } finally {
      await server.close();
    }
  });

  it("returns resolved=false when no token is resolvable", async () => {
    mockSecretService.getByName.mockResolvedValue(null);

    const app = await createApp();
    const server = await startServer(app);
    try {
      const res = await httpRequest(server.url, "/api/companies/company-1/diagnostics/github-credential");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        resolved: false,
        scope: null,
        secretName: null,
        probe: { attempted: false },
      });
      expect(res.body.reason).toBeDefined();
      expect(res.body.checkedAt).toBeDefined();
    } finally {
      await server.close();
    }
  });

  it("reports probe status 401 when GitHub returns 401", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === "GITHUB_TOKEN") return { id: "secret-1", name: "GITHUB_TOKEN" };
      return null;
    });
    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_TOKEN);
    mockGhFetch.ghFetch.mockResolvedValue(new Response(JSON.stringify({ message: "Bad credentials" }), {
      status: 401,
      headers: { "x-ratelimit-limit": "60" },
    }));

    const app = await createApp();
    const server = await startServer(app);
    try {
      const res = await httpRequest(server.url, "/api/companies/company-1/diagnostics/github-credential");

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        resolved: true,
        scope: "company",
        secretName: "GITHUB_TOKEN",
        probe: {
          attempted: true,
          status: 401,
          ok: false,
          rateLimitLimit: 60,
        },
      });
    } finally {
      await server.close();
    }
  });

  it("never includes the token value in the response body", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === "GITHUB_TOKEN") return { id: "secret-1", name: "GITHUB_TOKEN" };
      return null;
    });
    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_TOKEN);
    mockGhFetch.ghFetch.mockResolvedValue(new Response(JSON.stringify({ login: "test" }), {
      status: 200,
      headers: { "x-ratelimit-limit": "5000" },
    }));

    const app = await createApp();
    const server = await startServer(app);
    try {
      const res = await httpRequest(server.url, "/api/companies/company-1/diagnostics/github-credential");

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(FIXTURE_TOKEN);
      expect(serialized).not.toContain(FIXTURE_TOKEN.slice(0, 4));
      expect(serialized).not.toContain(FIXTURE_TOKEN.slice(-4));
      // `checkedAt` is a wall-clock ISO timestamp, so its digits coincidentally
      // contain the token length often enough to make a raw substring check
      // flaky. Assert the length leak against the body without that timestamp.
      const withoutCheckedAt = { ...(res.body as Record<string, unknown>) };
      delete withoutCheckedAt.checkedAt;
      expect(JSON.stringify(withoutCheckedAt)).not.toContain(FIXTURE_TOKEN.length.toString());
    } finally {
      await server.close();
    }
  });
});
