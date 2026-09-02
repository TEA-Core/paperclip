import express from "express";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeRepoUrl,
  resolveGitHubToken,
  resolveGitHubTokenForRepo,
  resolveGitHubTokenCandidatesForRepo,
  resolveAppInstallationToken,
  resolveBrokerGitHubApp,
  isGitHubTokenResolution,
  appTokenCache,
  GITHUB_APP_ID,
  GITHUB_APP_PRIVATE_KEY_SECRET_NAME,
  FLEET_GITHUB_APP_ID,
  FLEET_GITHUB_APP_PRIVATE_KEY_SECRET_NAME,
  GITHUB_APP_REGISTRY,
  GitHubAppConfigurationError,
  DEFAULT_GITHUB_APP,
} from "../services/github-credential.js";
import { GITHUB_PROBE_URL_BY_SCOPE } from "../routes/diagnostics.js";
import type { Server } from "node:http";

const FIXTURE_TOKEN = "ghp_test_token_value_for_unit_tests_only";
const FIXTURE_APP_TOKEN = "ghs_test_installation_token_for_unit_tests_only";
const FIXTURE_INSTALLATION_ID = "12345678";

const { privateKey: FIXTURE_PRIVATE_KEY_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const FIXTURE_PRIVATE_KEY = FIXTURE_PRIVATE_KEY_PEM.export({ type: "pkcs1", format: "pem" }, "utf8");

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

function mockAppFetchResponse(url: string, response: any) {
  const originalFetch = global.fetch;
  global.fetch = vi.fn((input: string | URL, _init?: RequestInit) => {
    const target = typeof input === "string" ? input : input.toString();
    if (target.includes(url)) {
      return Promise.resolve(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }) as any;
  return () => {
    global.fetch = originalFetch;
  };
}

function mockAppFetchResponses(responses: Array<{ url: string; response: any; status?: number }>) {
  const sorted = [...responses].sort((a, b) => b.url.length - a.url.length);
  const originalFetch = global.fetch;
  global.fetch = vi.fn((input: string | URL, _init?: RequestInit) => {
    const target = typeof input === "string" ? input : input.toString();
    const match = sorted.find((r) => target.includes(r.url));
    if (match) {
      return Promise.resolve(
        new Response(JSON.stringify(match.response), {
          status: match.status ?? 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }) as any;
  return () => {
    global.fetch = originalFetch;
  };
}

describe("resolveGitHubToken", () => {
  beforeEach(() => {
    mockSecretService.getByName.mockReset();
    mockSecretService.resolveSecretValue.mockReset();
    mockDb.select.mockReset();
    appTokenCache.clear();
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

describe("resolveGitHubToken — App installation token", () => {
  beforeEach(() => {
    mockSecretService.getByName.mockReset();
    mockSecretService.resolveSecretValue.mockReset();
    mockDb.select.mockReset();
    appTokenCache.clear();
  });

  it("returns app_installation scope when App private key secret is present and mintable", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME) {
        return { id: "app-key-1", name: GITHUB_APP_PRIVATE_KEY_SECRET_NAME };
      }
      return null;
    });
    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_PRIVATE_KEY);

    const restoreFetch = mockAppFetchResponses([
      {
        url: "/app/installations",
        response: [{ id: Number(FIXTURE_INSTALLATION_ID), account: { login: "tea-core" } }],
      },
      {
        url: `/app/installations/${FIXTURE_INSTALLATION_ID}/access_tokens`,
        response: {
          token: FIXTURE_APP_TOKEN,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      },
    ]);

    try {
      const result = await resolveGitHubToken(mockDb, "company-1");
      expect(isGitHubTokenResolution(result)).toBe(true);
      if (isGitHubTokenResolution(result)) {
        expect(result.token).toBe(FIXTURE_APP_TOKEN);
        expect(result.scope).toBe("app_installation");
        expect(result.secretName).toBe(GITHUB_APP_PRIVATE_KEY_SECRET_NAME);
        expect(result.installationId).toBe(FIXTURE_INSTALLATION_ID);
      }
    } finally {
      restoreFetch();
    }
  });

  it("falls back to PAT when App private key secret is absent (byte-for-byte PAT behaviour)", async () => {
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
      expect(result.installationId).toBeUndefined();
    }
  });

  it("falls back to PAT when App private key secret resolves to empty value", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME) {
        return { id: "app-key-1", name: GITHUB_APP_PRIVATE_KEY_SECRET_NAME };
      }
      if (name === "GITHUB_TOKEN") return { id: "secret-1", name: "GITHUB_TOKEN" };
      return null;
    });
    mockSecretService.resolveSecretValue.mockImplementation((_companyId, secretId) => {
      if (secretId === "app-key-1") return Promise.resolve("   ");
      return Promise.resolve(FIXTURE_TOKEN);
    });

    const result = await resolveGitHubToken(mockDb, "company-1");
    expect(isGitHubTokenResolution(result)).toBe(true);
    if (isGitHubTokenResolution(result)) {
      expect(result.scope).toBe("company");
      expect(result.secretName).toBe("GITHUB_TOKEN");
    }
  });

  it("falls back to PAT when JWT generation fails (malformed PEM)", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME) {
        return { id: "app-key-1", name: GITHUB_APP_PRIVATE_KEY_SECRET_NAME };
      }
      if (name === "GITHUB_TOKEN") return { id: "secret-1", name: "GITHUB_TOKEN" };
      return null;
    });
    mockSecretService.resolveSecretValue.mockImplementation((_companyId, secretId) => {
      if (secretId === "app-key-1") return Promise.resolve("not-a-valid-pem-key");
      return Promise.resolve(FIXTURE_TOKEN);
    });

    const result = await resolveGitHubToken(mockDb, "company-1");
    expect(isGitHubTokenResolution(result)).toBe(true);
    if (isGitHubTokenResolution(result)) {
      expect(result.scope).toBe("company");
      expect(result.secretName).toBe("GITHUB_TOKEN");
    }
  });

  it("falls back to PAT when GitHub returns non-2xx on installation token mint", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME) {
        return { id: "app-key-1", name: GITHUB_APP_PRIVATE_KEY_SECRET_NAME };
      }
      if (name === "GITHUB_TOKEN") return { id: "secret-1", name: "GITHUB_TOKEN" };
      return null;
    });
    mockSecretService.resolveSecretValue.mockImplementation((_companyId, secretId) => {
      if (secretId === "app-key-1") return Promise.resolve(FIXTURE_PRIVATE_KEY);
      return Promise.resolve(FIXTURE_TOKEN);
    });

    const originalFetch = global.fetch;
    global.fetch = vi.fn((input: string | URL) => {
      const target = typeof input === "string" ? input : input.toString();
      if (target.includes("/app/installations")) {
        return Promise.resolve(
          new Response(JSON.stringify([{ id: Number(FIXTURE_INSTALLATION_ID) }]), { status: 200 }),
        );
      }
      if (target.includes("/access_tokens")) {
        return Promise.resolve(
          new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as any;

    try {
      const result = await resolveGitHubToken(mockDb, "company-1");
      expect(isGitHubTokenResolution(result)).toBe(true);
      if (isGitHubTokenResolution(result)) {
        expect(result.scope).toBe("company");
        expect(result.secretName).toBe("GITHUB_TOKEN");
      }
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("falls back to PAT when GitHub returns non-2xx on installation resolution", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME) {
        return { id: "app-key-1", name: GITHUB_APP_PRIVATE_KEY_SECRET_NAME };
      }
      if (name === "GITHUB_TOKEN") return { id: "secret-1", name: "GITHUB_TOKEN" };
      return null;
    });
    mockSecretService.resolveSecretValue.mockImplementation((_companyId, secretId) => {
      if (secretId === "app-key-1") return Promise.resolve(FIXTURE_PRIVATE_KEY);
      return Promise.resolve(FIXTURE_TOKEN);
    });

    const originalFetch = global.fetch;
    global.fetch = vi.fn((input: string | URL) => {
      const target = typeof input === "string" ? input : input.toString();
      if (target.includes("/app/installations")) {
        return Promise.resolve(
          new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as any;

    try {
      const result = await resolveGitHubToken(mockDb, "company-1");
      expect(isGitHubTokenResolution(result)).toBe(true);
      if (isGitHubTokenResolution(result)) {
        expect(result.scope).toBe("company");
        expect(result.secretName).toBe("GITHUB_TOKEN");
      }
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("never throws on minting failure — falls through to PAT", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME) {
        return { id: "app-key-1", name: GITHUB_APP_PRIVATE_KEY_SECRET_NAME };
      }
      if (name === "GITHUB_TOKEN") return { id: "secret-1", name: "GITHUB_TOKEN" };
      return null;
    });
    mockSecretService.resolveSecretValue.mockImplementation((_companyId, secretId) => {
      if (secretId === "app-key-1") return Promise.resolve(FIXTURE_PRIVATE_KEY);
      return Promise.resolve(FIXTURE_TOKEN);
    });

    const originalFetch = global.fetch;
    global.fetch = vi.fn(() => Promise.reject(new Error("network failure"))) as any;

    try {
      const result = await resolveGitHubToken(mockDb, "company-1");
      expect(isGitHubTokenResolution(result)).toBe(true);
      if (isGitHubTokenResolution(result)) {
        expect(result.scope).toBe("company");
      }
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("does not include private key or token in error/log messages on failure", async () => {
    const loggerModule = await import("../middleware/logger.js");
    const loggerWarn = vi.mocked(loggerModule.logger.warn);

    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME) {
        return { id: "app-key-1", name: GITHUB_APP_PRIVATE_KEY_SECRET_NAME };
      }
      if (name === "GITHUB_TOKEN") return { id: "secret-1", name: "GITHUB_TOKEN" };
      return null;
    });
    mockSecretService.resolveSecretValue.mockImplementation((_companyId, secretId) => {
      if (secretId === "app-key-1") return Promise.resolve(FIXTURE_PRIVATE_KEY);
      return Promise.resolve(FIXTURE_TOKEN);
    });

    const originalFetch = global.fetch;
    global.fetch = vi.fn(() => Promise.reject(new Error("network failure"))) as any;

    try {
      await resolveGitHubToken(mockDb, "company-1");
      const allCalls = loggerWarn.mock.calls;
      expect(allCalls.length).toBeGreaterThan(0);
      for (const call of allCalls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain(FIXTURE_PRIVATE_KEY);
        expect(serialized).not.toContain(FIXTURE_APP_TOKEN);
        expect(serialized).not.toContain(FIXTURE_TOKEN);
      }
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("caches the minted token and reuses it within its lifetime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T12:00:00Z"));

    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME) {
        return { id: "app-key-1", name: GITHUB_APP_PRIVATE_KEY_SECRET_NAME };
      }
      return null;
    });
    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_PRIVATE_KEY);

    const fetchCallCount = { count: 0 };
    const originalFetch = global.fetch;
    global.fetch = vi.fn((input: string | URL) => {
      const target = typeof input === "string" ? input : input.toString();
      fetchCallCount.count++;
      if (target.includes("/app/installations") && !target.includes("access_tokens")) {
        return Promise.resolve(
          new Response(JSON.stringify([{ id: Number(FIXTURE_INSTALLATION_ID) }]), { status: 200 }),
        );
      }
      if (target.includes("/access_tokens")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: FIXTURE_APP_TOKEN,
              expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as any;

    try {
      const result1 = await resolveGitHubToken(mockDb, "company-1");
      expect(isGitHubTokenResolution(result1)).toBe(true);
      if (isGitHubTokenResolution(result1)) {
        expect(result1.token).toBe(FIXTURE_APP_TOKEN);
        expect(result1.scope).toBe("app_installation");
      }

      const firstFetchCount = fetchCallCount.count;

      const result2 = await resolveGitHubToken(mockDb, "company-1");
      expect(isGitHubTokenResolution(result2)).toBe(true);
      if (isGitHubTokenResolution(result2)) {
        expect(result2.token).toBe(FIXTURE_APP_TOKEN);
      }

      expect(fetchCallCount.count).toBe(firstFetchCount);
    } finally {
      global.fetch = originalFetch;
      vi.useRealTimers();
    }
  });

  it("re-mints after expiry (safety margin) — proven by injected clock, not sleep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T12:00:00Z"));

    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME) {
        return { id: "app-key-1", name: GITHUB_APP_PRIVATE_KEY_SECRET_NAME };
      }
      return null;
    });
    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_PRIVATE_KEY);

    let mintCount = 0;
    const originalFetch = global.fetch;
    global.fetch = vi.fn((input: string | URL) => {
      const target = typeof input === "string" ? input : input.toString();
      if (target.includes("/app/installations") && !target.includes("access_tokens")) {
        return Promise.resolve(
          new Response(JSON.stringify([{ id: Number(FIXTURE_INSTALLATION_ID) }]), { status: 200 }),
        );
      }
      if (target.includes("/access_tokens")) {
        mintCount++;
        const token = `ghs_token_mint_${mintCount}`;
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        return Promise.resolve(
          new Response(JSON.stringify({ token, expires_at: expiresAt }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as any;

    try {
      const result1 = await resolveGitHubToken(mockDb, "company-1");
      expect(isGitHubTokenResolution(result1)).toBe(true);
      if (isGitHubTokenResolution(result1)) {
        expect(result1.token).toBe("ghs_token_mint_1");
      }
      expect(mintCount).toBe(1);

      const result2 = await resolveGitHubToken(mockDb, "company-1");
      expect(isGitHubTokenResolution(result2)).toBe(true);
      if (isGitHubTokenResolution(result2)) {
        expect(result2.token).toBe("ghs_token_mint_1");
      }
      expect(mintCount).toBe(1);

      vi.setSystemTime(new Date("2026-08-17T12:55:00Z"));

      const result3 = await resolveGitHubToken(mockDb, "company-1");
      expect(isGitHubTokenResolution(result3)).toBe(true);
      if (isGitHubTokenResolution(result3)) {
        expect(result3.token).toBe("ghs_token_mint_2");
      }
      expect(mintCount).toBe(2);
    } finally {
      global.fetch = originalFetch;
      vi.useRealTimers();
    }
  });
});

describe("resolveAppInstallationToken — App identity selection", () => {
  const company = "company-1";
  const owner = "owner";
  const repo = "repo";

  beforeEach(() => {
    mockSecretService.getByName.mockReset();
    mockSecretService.resolveSecretValue.mockReset();
    mockDb.select.mockReset();
    appTokenCache.clear();
  });

  it("does not serve one App's cached token to a caller selecting a different App", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === "FLEET_APP_KEY") return { id: "fleet-key" };
      if (name === "SECOND_APP_KEY") return { id: "second-key" };
      return null;
    });
    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_PRIVATE_KEY);

    let mintCount = 0;
    const originalFetch = global.fetch;
    global.fetch = vi.fn((input: string | URL) => {
      const target = typeof input === "string" ? input : input.toString();
      if (target.includes("/repos/owner/repo/installation")) {
        return Promise.resolve(
          new Response(JSON.stringify({ id: Number(FIXTURE_INSTALLATION_ID) }), { status: 200 }),
        );
      }
      if (target.includes("/access_tokens")) {
        mintCount += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: `ghs_app_token_mint_${mintCount}`,
              expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as any;

    try {
      const fleetApp = await resolveAppInstallationToken(
        company,
        mockSecretService,
        owner,
        repo,
        undefined,
        { appId: GITHUB_APP_ID, privateKeySecretName: "FLEET_APP_KEY" },
      );
      const secondApp = await resolveAppInstallationToken(
        company,
        mockSecretService,
        owner,
        repo,
        undefined,
        { appId: "9999001", privateKeySecretName: "SECOND_APP_KEY" },
      );

      expect(isGitHubTokenResolution(fleetApp)).toBe(true);
      expect(isGitHubTokenResolution(secondApp)).toBe(true);
      if (isGitHubTokenResolution(fleetApp) && isGitHubTokenResolution(secondApp)) {
        // Two Apps on the same company/owner/repo each mint their own token —
        // the second App did not reuse the first App's cache entry.
        expect(fleetApp.token).toBe("ghs_app_token_mint_1");
        expect(secondApp.token).toBe("ghs_app_token_mint_2");
        expect(fleetApp.token).not.toBe(secondApp.token);
        expect(secondApp.secretName).toBe("SECOND_APP_KEY");
      }
      expect(mintCount).toBe(2);

      // Selecting the fleet App again is a cache hit — no additional mint.
      const fleetAppAgain = await resolveAppInstallationToken(
        company,
        mockSecretService,
        owner,
        repo,
        undefined,
        { appId: GITHUB_APP_ID, privateKeySecretName: "FLEET_APP_KEY" },
      );
      if (isGitHubTokenResolution(fleetApp) && isGitHubTokenResolution(fleetAppAgain)) {
        expect(fleetAppAgain.token).toBe(fleetApp.token);
      }
      expect(mintCount).toBe(2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("does not serve a broad cached token to a caller requesting a narrowed permission set", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME) {
        return { id: "app-key-1", name: GITHUB_APP_PRIVATE_KEY_SECRET_NAME };
      }
      return null;
    });
    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_PRIVATE_KEY);

    let mintCount = 0;
    const originalFetch = global.fetch;
    global.fetch = vi.fn((input: string | URL) => {
      const target = typeof input === "string" ? input : input.toString();
      if (target.includes("/repos/owner/repo/installation")) {
        return Promise.resolve(
          new Response(JSON.stringify({ id: Number(FIXTURE_INSTALLATION_ID) }), { status: 200 }),
        );
      }
      if (target.includes("/access_tokens")) {
        mintCount += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: `ghs_perm_token_mint_${mintCount}`,
              expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as any;

    try {
      // Broad: a permission-less caller mints and caches the broad token.
      const broad = await resolveAppInstallationToken(
        company,
        mockSecretService,
        owner,
        repo,
        undefined,
        DEFAULT_GITHUB_APP,
      );
      expect(isGitHubTokenResolution(broad)).toBe(true);
      expect(mintCount).toBe(1);

      // Narrow: a narrowed permission set must mint its OWN token — it must NOT
      // be served the broad token the permission-less caller cached for the same
      // owner/repo. This is the regression the permissions-fingerprint key fixes.
      const narrow = await resolveAppInstallationToken(
        company,
        mockSecretService,
        owner,
        repo,
        undefined,
        DEFAULT_GITHUB_APP,
        { contents: "read" },
      );
      expect(isGitHubTokenResolution(narrow)).toBe(true);
      if (isGitHubTokenResolution(broad) && isGitHubTokenResolution(narrow)) {
        expect(broad.token).toBe("ghs_perm_token_mint_1");
        expect(narrow.token).toBe("ghs_perm_token_mint_2");
        expect(narrow.token).not.toBe(broad.token);
      }
      expect(mintCount).toBe(2);

      // A repeat narrow request (same permission set) is a cache hit — no second narrow mint.
      const narrowAgain = await resolveAppInstallationToken(
        company,
        mockSecretService,
        owner,
        repo,
        undefined,
        DEFAULT_GITHUB_APP,
        { contents: "read" },
      );
      if (isGitHubTokenResolution(narrow) && isGitHubTokenResolution(narrowAgain)) {
        expect(narrowAgain.token).toBe(narrow.token);
      }
      expect(mintCount).toBe(2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("keys the token cache by the selected App id, including the default 4595159", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME) {
        return { id: "app-key-1", name: GITHUB_APP_PRIVATE_KEY_SECRET_NAME };
      }
      return null;
    });
    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_PRIVATE_KEY);

    const restoreFetch = mockAppFetchResponses([
      {
        url: "/app/installations",
        response: [{ id: Number(FIXTURE_INSTALLATION_ID), account: { login: "tea-core" } }],
      },
      {
        url: `/app/installations/${FIXTURE_INSTALLATION_ID}/access_tokens`,
        response: {
          token: FIXTURE_APP_TOKEN,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      },
    ]);

    try {
      await resolveGitHubToken(mockDb, company);
      const keys = [...appTokenCache.keys()];
      expect(keys).toHaveLength(1);
      expect(keys[0]).toContain(`${company}:${GITHUB_APP_ID}`);
      expect(keys[0]).toContain(company);
    } finally {
      restoreFetch();
    }
  });

  it("never includes the private key or a minted token in log payloads for a non-default App", async () => {
    const loggerModule = await import("../middleware/logger.js");
    const loggerWarn = vi.mocked(loggerModule.logger.warn);
    loggerWarn.mockClear();

    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === "FLEET_APP_KEY") return { id: "fleet-key" };
      if (name === "GITHUB_TOKEN") return { id: "secret-1", name: "GITHUB_TOKEN" };
      return null;
    });
    mockSecretService.resolveSecretValue.mockImplementation((_companyId, secretId) => {
      if (secretId === "fleet-key") return Promise.resolve(FIXTURE_PRIVATE_KEY);
      return Promise.resolve(FIXTURE_TOKEN);
    });

    const originalFetch = global.fetch;
    global.fetch = vi.fn(() => Promise.reject(new Error("network failure"))) as any;

    try {
      const result = await resolveAppInstallationToken(
        company,
        mockSecretService,
        owner,
        repo,
        undefined,
        { appId: "9999001", privateKeySecretName: "FLEET_APP_KEY" },
      );
      expect(result).toBeNull();
      const allCalls = loggerWarn.mock.calls;
      expect(allCalls.length).toBeGreaterThan(0);
      for (const call of allCalls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain(FIXTURE_PRIVATE_KEY);
        expect(serialized).not.toContain(FIXTURE_APP_TOKEN);
        expect(serialized).not.toContain(FIXTURE_TOKEN);
      }
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("resolveBrokerGitHubApp — configurable broker App descriptor", () => {
  it("selects the default App when no name is given (absent, empty, or whitespace)", () => {
    expect(resolveBrokerGitHubApp()).toBe(DEFAULT_GITHUB_APP);
    expect(resolveBrokerGitHubApp("")).toBe(DEFAULT_GITHUB_APP);
    expect(resolveBrokerGitHubApp("   ")).toBe(DEFAULT_GITHUB_APP);
    expect(DEFAULT_GITHUB_APP).toEqual({
      appId: GITHUB_APP_ID,
      privateKeySecretName: GITHUB_APP_PRIVATE_KEY_SECRET_NAME,
    });
  });

  it("selects the fleet App as a coherent pair — its id is always bound to its own secret", () => {
    const fleet = resolveBrokerGitHubApp("fleet");
    expect(fleet).toEqual({
      appId: FLEET_GITHUB_APP_ID,
      privateKeySecretName: FLEET_GITHUB_APP_PRIVATE_KEY_SECRET_NAME,
    });
    // The 401 from the issue is a fleet id signed with the default App's key; the fleet
    // descriptor must never pair 4809618 with the default secret.
    expect(fleet.privateKeySecretName).not.toBe(GITHUB_APP_PRIVATE_KEY_SECRET_NAME);
  });

  it("makes a mismatched appId/secret pairing impossible to express from any registry name", () => {
    // Every registry entry keeps an App's id bound to that App's own key; no entry pairs
    // 4595159 with the fleet key nor 4809618 with the default key.
    for (const descriptor of Object.values(GITHUB_APP_REGISTRY)) {
      if (descriptor.appId === FLEET_GITHUB_APP_ID) {
        expect(descriptor.privateKeySecretName).toBe(FLEET_GITHUB_APP_PRIVATE_KEY_SECRET_NAME);
        expect(descriptor.privateKeySecretName).not.toBe(GITHUB_APP_PRIVATE_KEY_SECRET_NAME);
      }
      if (descriptor.appId === GITHUB_APP_ID) {
        expect(descriptor.privateKeySecretName).toBe(GITHUB_APP_PRIVATE_KEY_SECRET_NAME);
        expect(descriptor.privateKeySecretName).not.toBe(FLEET_GITHUB_APP_PRIVATE_KEY_SECRET_NAME);
      }
    }
  });

  it("throws a named error for an unknown App name instead of silently falling back to the default", () => {
    expect(() => resolveBrokerGitHubApp("bogus")).toThrow(GitHubAppConfigurationError);
    expect(() => resolveBrokerGitHubApp("bogus")).toThrow(
      /Unknown GitHub App descriptor "bogus"; valid names: default, fleet/,
    );
    // A typo'd name must not resolve to the default App (which would mint under the wrong issuer).
    // Names are matched case-sensitively, so "Default" is unknown.
    expect(() => resolveBrokerGitHubApp("Default")).toThrow(GitHubAppConfigurationError);
  });

  it("rejects Object.prototype names instead of returning an inherited truthy property", () => {
    // Indexing a plain-object registry by a user-supplied name would otherwise return
    // Object.prototype members (toString, constructor, __proto__, ...) as a truthy
    // non-descriptor, silently yielding undefined appId/privateKeySecretName. Each such
    // name must fail fast with the same named error as any other unknown name.
    for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(() => resolveBrokerGitHubApp(name)).toThrow(GitHubAppConfigurationError);
      expect(() => resolveBrokerGitHubApp(name)).toThrow(
        /Unknown GitHub App descriptor ".*"; valid names: default, fleet/,
      );
    }
  });
});

describe("resolveGitHubTokenForRepo", () => {
  beforeEach(() => {
    mockSecretService.getByName.mockReset();
    mockSecretService.resolveSecretValue.mockReset();
    mockDb.select.mockReset();
    appTokenCache.clear();
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

  it("reports 'repo not found' (not a project-bound-token message) when only a substring-containing workspace matches", async () => {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        { repoUrl: "https://github.com/TEA-Core/paperclip-smart-router" },
      ]),
    };
    mockDb.select.mockReturnValue(selectChain);

    mockSecretService.getByName.mockResolvedValue(null);

    const result = await resolveGitHubTokenForRepo(mockDb, "company-1", "TEA-Core", "paperclip");
    expect(result.token).toBeNull();
    expect(result.reason).toContain("repo not found");
    expect(result.reason).not.toContain("No GitHub token bound to project");
  });

  it("resolves app_installation token with repo context for resolveGitHubTokenForRepo", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME) {
        return { id: "app-key-1", name: GITHUB_APP_PRIVATE_KEY_SECRET_NAME };
      }
      return null;
    });
    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_PRIVATE_KEY);

    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDb.select.mockReturnValue(selectChain);

    const restoreFetch = mockAppFetchResponses([
      {
        url: `/repos/owner/repo/installation`,
        response: { id: Number(FIXTURE_INSTALLATION_ID), account: { login: "owner" } },
      },
      {
        url: `/app/installations/${FIXTURE_INSTALLATION_ID}/access_tokens`,
        response: {
          token: FIXTURE_APP_TOKEN,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      },
    ]);

    try {
      const result = await resolveGitHubTokenForRepo(mockDb, "company-1", "owner", "repo");
      expect(isGitHubTokenResolution(result)).toBe(true);
      if (isGitHubTokenResolution(result)) {
        expect(result.token).toBe(FIXTURE_APP_TOKEN);
        expect(result.scope).toBe("app_installation");
        expect(result.installationId).toBe(FIXTURE_INSTALLATION_ID);
      }
    } finally {
      restoreFetch();
    }
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
    appTokenCache.clear();
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
      expect(mockGhFetch.ghFetch).toHaveBeenCalledWith(
        "https://api.github.com/user",
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: `Bearer ${FIXTURE_TOKEN}` }),
        }),
      );
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

      // The token length must also not leak as a value anywhere in the body.
      const leafValues: unknown[] = [];
      const collectLeafValues = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const item of value) collectLeafValues(item);
          return;
        }
        if (value !== null && typeof value === "object") {
          for (const item of Object.values(value)) collectLeafValues(item);
          return;
        }
        leafValues.push(value);
      };
      collectLeafValues(res.body);
      expect(leafValues).not.toContain(FIXTURE_TOKEN.length);
      expect(leafValues).not.toContain(FIXTURE_TOKEN.length.toString());
    } finally {
      await server.close();
    }
  });

  it("reports app_installation scope in diagnostics when App token is used", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME) {
        return { id: "app-key-1", name: GITHUB_APP_PRIVATE_KEY_SECRET_NAME };
      }
      return null;
    });
    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_PRIVATE_KEY);

    const restoreFetch = mockAppFetchResponses([
      {
        url: "/app/installations",
        response: [{ id: Number(FIXTURE_INSTALLATION_ID), account: { login: "tea-core" } }],
      },
      {
        url: `/app/installations/${FIXTURE_INSTALLATION_ID}/access_tokens`,
        response: {
          token: FIXTURE_APP_TOKEN,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      },
    ]);

    mockGhFetch.ghFetch.mockResolvedValue(
      new Response(JSON.stringify({ total_count: 1, repositories: [] }), {
        status: 200,
        headers: { "x-ratelimit-limit": "15000" },
      }),
    );

    try {
      const app = await createApp();
      const server = await startServer(app);
      try {
        const res = await httpRequest(server.url, "/api/companies/company-1/diagnostics/github-credential");

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          resolved: true,
          scope: "app_installation",
          secretName: GITHUB_APP_PRIVATE_KEY_SECRET_NAME,
          installationId: FIXTURE_INSTALLATION_ID,
          probe: {
            attempted: true,
            status: 200,
            ok: true,
            rateLimitLimit: 15000,
          },
        });
        expect(res.body.token).toBeUndefined();
        expect(mockGhFetch.ghFetch).toHaveBeenCalledWith(
          "https://api.github.com/installation/repositories?per_page=1",
          expect.objectContaining({
            headers: expect.objectContaining({ authorization: `Bearer ${FIXTURE_APP_TOKEN}` }),
          }),
        );
      } finally {
        await server.close();
      }
    } finally {
      restoreFetch();
    }
  });

  it("reports probe ok=false for a rejected app_installation token (403)", async () => {
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME) {
        return { id: "app-key-1", name: GITHUB_APP_PRIVATE_KEY_SECRET_NAME };
      }
      return null;
    });
    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_PRIVATE_KEY);

    const restoreFetch = mockAppFetchResponses([
      {
        url: "/app/installations",
        response: [{ id: Number(FIXTURE_INSTALLATION_ID), account: { login: "tea-core" } }],
      },
      {
        url: `/app/installations/${FIXTURE_INSTALLATION_ID}/access_tokens`,
        response: {
          token: FIXTURE_APP_TOKEN,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      },
    ]);

    mockGhFetch.ghFetch.mockResolvedValue(
      new Response(JSON.stringify({ message: "Resource not accessible by integration" }), {
        status: 403,
        headers: { "x-ratelimit-limit": "15000" },
      }),
    );

    try {
      const app = await createApp();
      const server = await startServer(app);
      try {
        const res = await httpRequest(server.url, "/api/companies/company-1/diagnostics/github-credential");

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          resolved: true,
          scope: "app_installation",
          secretName: GITHUB_APP_PRIVATE_KEY_SECRET_NAME,
          installationId: FIXTURE_INSTALLATION_ID,
          probe: {
            attempted: true,
            status: 403,
            ok: false,
            rateLimitLimit: 15000,
          },
        });
        expect(mockGhFetch.ghFetch).toHaveBeenCalledWith(
          "https://api.github.com/installation/repositories?per_page=1",
          expect.anything(),
        );
      } finally {
        await server.close();
      }
    } finally {
      restoreFetch();
    }
  });

  it("probes /user for project_env scope", async () => {
    const ghCredential = await import("../services/github-credential.js");
    const resolveSpy = vi
      .spyOn(ghCredential, "resolveGitHubToken")
      .mockResolvedValue({ token: FIXTURE_TOKEN, scope: "project_env", secretName: "GITHUB_TOKEN" });

    mockGhFetch.ghFetch.mockResolvedValue(
      new Response(JSON.stringify({ login: "test" }), {
        status: 200,
        headers: { "x-ratelimit-limit": "5000" },
      }),
    );

    try {
      const app = await createApp();
      const server = await startServer(app);
      try {
        const res = await httpRequest(server.url, "/api/companies/company-1/diagnostics/github-credential");

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          resolved: true,
          scope: "project_env",
          secretName: "GITHUB_TOKEN",
          probe: {
            attempted: true,
            status: 200,
            ok: true,
            rateLimitLimit: 5000,
          },
        });
        expect(mockGhFetch.ghFetch).toHaveBeenCalledWith(
          "https://api.github.com/user",
          expect.objectContaining({
            headers: expect.objectContaining({ authorization: `Bearer ${FIXTURE_TOKEN}` }),
          }),
        );
      } finally {
        await server.close();
      }
    } finally {
      resolveSpy.mockRestore();
    }
  });

  it("selects the probe URL by scope", () => {
    expect(GITHUB_PROBE_URL_BY_SCOPE.app_installation).toBe("https://api.github.com/installation/repositories?per_page=1");
    expect(GITHUB_PROBE_URL_BY_SCOPE.project_env).toBe("https://api.github.com/user");
    expect(GITHUB_PROBE_URL_BY_SCOPE.company).toBe("https://api.github.com/user");
  });
});

describe("resolveGitHubTokenCandidatesForRepo", () => {
  beforeEach(() => {
    mockSecretService.getByName.mockReset();
    mockSecretService.resolveSecretValue.mockReset();
    mockDb.select.mockReset();
  });

  it("returns project_env candidate first, then company candidate", async () => {
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

    mockSecretService.resolveSecretValue.mockImplementation((_companyId, secretId) => {
      if (secretId === "secret-1") return "company-token-value";
      return FIXTURE_TOKEN;
    });
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === "GITHUB_TOKEN") return { id: "secret-1", name: "GITHUB_TOKEN" };
      return null;
    });

    const result = await resolveGitHubTokenCandidatesForRepo(mockDb, "company-1", "owner", "repo");
    expect(result).toHaveLength(2);
    expect(result[0]!.scope).toBe("project_env");
    expect(result[0]!.secretName).toBe("GITHUB_TOKEN");
    expect(result[0]!.token).toBe(FIXTURE_TOKEN);
    expect(result[1]!.scope).toBe("company");
    expect(result[1]!.secretName).toBe("GITHUB_TOKEN");
    expect(result[1]!.token).toBe("company-token-value");
  });

  it("skips empty/whitespace-only secret values and dedupes identical token values", async () => {
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

    mockSecretService.resolveSecretValue
      .mockResolvedValueOnce("   ")
      .mockResolvedValueOnce(FIXTURE_TOKEN);
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === "GITHUB_TOKEN") return { id: "secret-1", name: "GITHUB_TOKEN" };
      return null;
    });

    const result = await resolveGitHubTokenCandidatesForRepo(mockDb, "company-1", "owner", "repo");
    expect(result).toHaveLength(1);
    expect(result[0]!.scope).toBe("company");
    expect(result[0]!.secretName).toBe("GITHUB_TOKEN");
  });

  it("dedupes identical token values across project_env and company scopes", async () => {
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
    mockSecretService.getByName.mockImplementation((_companyId, name) => {
      if (name === "GITHUB_TOKEN") return { id: "secret-1", name: "GITHUB_TOKEN" };
      return null;
    });

    const result = await resolveGitHubTokenCandidatesForRepo(mockDb, "company-1", "owner", "repo");
    expect(result).toHaveLength(1);
    expect(result[0]!.scope).toBe("project_env");
    expect(result[0]!.secretName).toBe("GITHUB_TOKEN");
  });

  it("returns empty array when no token is resolvable at any scope", async () => {
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

    const result = await resolveGitHubTokenCandidatesForRepo(mockDb, "company-1", "owner", "repo");
    expect(result).toHaveLength(0);
  });

  it("returns empty array when repo is not found at company or project scope", async () => {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    mockDb.select.mockReturnValue(selectChain);

    mockSecretService.getByName.mockResolvedValue(null);

    const result = await resolveGitHubTokenCandidatesForRepo(mockDb, "company-1", "owner", "repo");
    expect(result).toHaveLength(0);
  });

  it("excludes substring-containing workspaces (SUP-13220 cross-project credential bleed)", async () => {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: "pw-smart-router",
          projectId: "proj-smart-router",
          repoUrl: "https://github.com/TEA-Core/paperclip-smart-router",
          projectEnv: {
            GITHUB_TOKEN: { type: "secret_ref", secretId: "sr-secret", version: "latest" },
          },
        },
        {
          id: "pw-paperclip",
          projectId: "proj-paperclip",
          repoUrl: "https://github.com/TEA-Core/paperclip",
          projectEnv: {
            GITHUB_TOKEN: { type: "secret_ref", secretId: "pc-secret", version: "latest" },
          },
        },
      ]),
    };
    mockDb.select.mockReturnValue(selectChain);

    mockSecretService.resolveSecretValue.mockImplementation((_companyId, secretId) => {
      if (secretId === "sr-secret") return "smart-router-token-should-never-appear";
      return "paperclip-project-token";
    });
    mockSecretService.getByName.mockResolvedValue(null);

    const result = await resolveGitHubTokenCandidatesForRepo(mockDb, "company-1", "TEA-Core", "paperclip");
    expect(result).toHaveLength(1);
    expect(result[0]!.scope).toBe("project_env");
    expect(result[0]!.secretName).toBe("GITHUB_TOKEN");
    expect(result[0]!.token).toBe("paperclip-project-token");
    for (const candidate of result) {
      expect(candidate.token).not.toContain("smart-router");
    }
  });

  it("contributes a project_env candidate for an https-form workspace repoUrl", async () => {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: "pw-1",
          projectId: "proj-1",
          repoUrl: "https://github.com/TEA-Core/paperclip",
          projectEnv: {
            GITHUB_TOKEN: { type: "secret_ref", secretId: "ref-secret-1", version: "latest" },
          },
        },
      ]),
    };
    mockDb.select.mockReturnValue(selectChain);

    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_TOKEN);
    mockSecretService.getByName.mockResolvedValue(null);

    const result = await resolveGitHubTokenCandidatesForRepo(mockDb, "company-1", "TEA-Core", "paperclip");
    expect(result).toHaveLength(1);
    expect(result[0]!.scope).toBe("project_env");
    expect(result[0]!.token).toBe(FIXTURE_TOKEN);
  });

  it("contributes a project_env candidate for a .git-suffixed workspace repoUrl", async () => {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: "pw-1",
          projectId: "proj-1",
          repoUrl: "https://github.com/TEA-Core/paperclip.git",
          projectEnv: {
            GITHUB_TOKEN: { type: "secret_ref", secretId: "ref-secret-1", version: "latest" },
          },
        },
      ]),
    };
    mockDb.select.mockReturnValue(selectChain);

    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_TOKEN);
    mockSecretService.getByName.mockResolvedValue(null);

    const result = await resolveGitHubTokenCandidatesForRepo(mockDb, "company-1", "TEA-Core", "paperclip");
    expect(result).toHaveLength(1);
    expect(result[0]!.scope).toBe("project_env");
    expect(result[0]!.token).toBe(FIXTURE_TOKEN);
  });

  it("contributes a project_env candidate when owner/repo case differs from the workspace repoUrl", async () => {
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        {
          id: "pw-1",
          projectId: "proj-1",
          repoUrl: "https://github.com/tea-core/paperclip",
          projectEnv: {
            GITHUB_TOKEN: { type: "secret_ref", secretId: "ref-secret-1", version: "latest" },
          },
        },
      ]),
    };
    mockDb.select.mockReturnValue(selectChain);

    mockSecretService.resolveSecretValue.mockResolvedValue(FIXTURE_TOKEN);
    mockSecretService.getByName.mockResolvedValue(null);

    const result = await resolveGitHubTokenCandidatesForRepo(mockDb, "company-1", "TEA-Core", "Paperclip");
    expect(result).toHaveLength(1);
    expect(result[0]!.scope).toBe("project_env");
    expect(result[0]!.token).toBe(FIXTURE_TOKEN);
  });
});

describe("normalizeRepoUrl", () => {
  it("strips URL scheme + host, .git suffix, trailing slash, and lowercases", () => {
    expect(normalizeRepoUrl("https://github.com/TEA-Core/paperclip")).toBe("tea-core/paperclip");
    expect(normalizeRepoUrl("https://github.com/TEA-Core/paperclip.git")).toBe("tea-core/paperclip");
    expect(normalizeRepoUrl("https://github.com/TEA-Core/paperclip/")).toBe("tea-core/paperclip");
    expect(normalizeRepoUrl("https://github.com/TEA-Core/paperclip.git/")).toBe("tea-core/paperclip");
    expect(normalizeRepoUrl("http://github.com/TEA-Core/paperclip")).toBe("tea-core/paperclip");
    expect(normalizeRepoUrl("git@github.com:TEA-Core/paperclip.git")).toBe("tea-core/paperclip");
    expect(normalizeRepoUrl("TEA-Core/paperclip")).toBe("tea-core/paperclip");
  });

  it("is case-insensitive", () => {
    expect(normalizeRepoUrl("tea-core/Paperclip")).toBe("tea-core/paperclip");
    expect(normalizeRepoUrl("TeA-cOrE/pApErClIp")).toBe("tea-core/paperclip");
  });

  it("does not conflate distinct repos that share a prefix", () => {
    expect(normalizeRepoUrl("https://github.com/TEA-Core/paperclip-smart-router")).toBe(
      "tea-core/paperclip-smart-router",
    );
    expect(normalizeRepoUrl("https://github.com/TEA-Core/paperclip-smart-router")).not.toBe(
      normalizeRepoUrl("https://github.com/TEA-Core/paperclip"),
    );
  });
});
