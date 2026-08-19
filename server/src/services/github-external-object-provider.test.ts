import type { Db } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import { createGitHubExternalObjectProvider } from "./github-external-object-provider.js";
import type { GitHubTokenResult } from "./github-credential.js";
import type { ExternalObjectResolveResult } from "./external-objects.js";

type CapturedRequest = { url: string; init?: RequestInit };

function makeFetchMock(body: Record<string, unknown> = { id: 42, state: "open", title: "test" }): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  return {
    calls,
    fetch: (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { etag: "etag-1" },
        }),
      );
    },
  };
}

function makeObject(externalId: string) {
  return {
    externalId,
    sanitizedCanonicalUrl: `https://github.com/${externalId.split("#")[0].replace("/", "/")}`,
  } as any;
}

function getAuthHeader(init?: RequestInit): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get("authorization") ?? undefined;
  return (headers as Record<string, string>)["authorization"];
}

describe("github-external-object-provider", () => {
  describe("token resolution", () => {
    it("puts an App-installation token on the authorization header when resolveGitHubTokenForRepo returns a resolution", async () => {
      const appToken = "ghs_app_installation_token_123";
      const resolution: GitHubTokenResult = {
        token: appToken,
        scope: "app_installation",
        secretName: "GITHUB_APP_PRIVATE_KEY",
        installationId: "153736520",
      };
      const tokenProvider = vi.fn().mockResolvedValue(resolution);
      const mockFetch = makeFetchMock();

      const { resolvers } = createGitHubExternalObjectProvider({} as Db, {
        fetch: mockFetch.fetch,
        tokenProvider,
      });

      const pullRequestResolver = resolvers.find((r) => r.objectType === "pull_request")!;
      const result = await pullRequestResolver.resolve({
        companyId: "test-company",
        object: makeObject("owner/repo#pull/1"),
      });

      expect(result.ok).toBe(true);
      expect(tokenProvider).toHaveBeenCalledWith("test-company", "owner", "repo");
      expect(getAuthHeader(mockFetch.calls[0]?.init)).toBe(`Bearer ${appToken}`);
    });

    it("sends no authorization header when token resolution fails (isGitHubTokenResolution false)", async () => {
      const failure: GitHubTokenResult = {
        token: null,
        reason: "No GitHub token resolvable for owner/repo",
      };
      const tokenProvider = vi.fn().mockResolvedValue(failure);
      const mockFetch = makeFetchMock();

      const { resolvers } = createGitHubExternalObjectProvider({} as Db, {
        fetch: mockFetch.fetch,
        tokenProvider,
      });

      const pullRequestResolver = resolvers.find((r) => r.objectType === "pull_request")!;
      const result = await pullRequestResolver.resolve({
        companyId: "test-company",
        object: makeObject("owner/repo#pull/1"),
      });

      expect(result.ok).toBe(true);
      expect(getAuthHeader(mockFetch.calls[0]?.init)).toBeUndefined();
    });

    it("sends no authorization header when tokenProvider returns null", async () => {
      const tokenProvider = vi.fn().mockResolvedValue(null);
      const mockFetch = makeFetchMock();

      const { resolvers } = createGitHubExternalObjectProvider({} as Db, {
        fetch: mockFetch.fetch,
        tokenProvider,
      });

      const pullRequestResolver = resolvers.find((r) => r.objectType === "pull_request")!;
      const result = await pullRequestResolver.resolve({
        companyId: "test-company",
        object: makeObject("owner/repo#pull/1"),
      });

      expect(result.ok).toBe(true);
      expect(getAuthHeader(mockFetch.calls[0]?.init)).toBeUndefined();
    });

    it("sends the authorization header when tokenProvider returns a plain string token", async () => {
      const tokenProvider = vi.fn().mockResolvedValue("plain_pat_token");
      const mockFetch = makeFetchMock();

      const { resolvers } = createGitHubExternalObjectProvider({} as Db, {
        fetch: mockFetch.fetch,
        tokenProvider,
      });

      const pullRequestResolver = resolvers.find((r) => r.objectType === "pull_request")!;
      const result = await pullRequestResolver.resolve({
        companyId: "test-company",
        object: makeObject("owner/repo#pull/1"),
      });

      expect(result.ok).toBe(true);
      expect(getAuthHeader(mockFetch.calls[0]?.init)).toBe("Bearer plain_pat_token");
    });

    it("returns auth_required when tokenProvider throws", async () => {
      const tokenProvider = vi.fn().mockRejectedValue(new Error("secret provider down"));
      const mockFetch = makeFetchMock();

      const { resolvers } = createGitHubExternalObjectProvider({} as Db, {
        fetch: mockFetch.fetch,
        tokenProvider,
      });

      const pullRequestResolver = resolvers.find((r) => r.objectType === "pull_request")!;
      const result = await pullRequestResolver.resolve({
        companyId: "test-company",
        object: makeObject("owner/repo#pull/1"),
      });

      expect(result.ok).toBe(false);
      const failure = result as Extract<ExternalObjectResolveResult, { ok: false }>;
      expect(failure.errorCode).toBe("github_token_unavailable");
      expect(mockFetch.calls).toHaveLength(0);
    });
  });

  describe("issue resolver", () => {
    it("passes owner and repo to tokenProvider for issue objects", async () => {
      const resolution: GitHubTokenResult = {
        token: "ghs_token",
        scope: "app_installation",
        secretName: "GITHUB_APP_PRIVATE_KEY",
        installationId: "153736520",
      };
      const tokenProvider = vi.fn().mockResolvedValue(resolution);
      const mockFetch = makeFetchMock();

      const { resolvers } = createGitHubExternalObjectProvider({} as Db, {
        fetch: mockFetch.fetch,
        tokenProvider,
      });

      const issueResolver = resolvers.find((r) => r.objectType === "issue")!;
      await issueResolver.resolve({
        companyId: "test-company",
        object: makeObject("owner/repo#issues/2"),
      });

      expect(tokenProvider).toHaveBeenCalledWith("test-company", "owner", "repo");
    });
  });

  describe("pull_request resolver", () => {
    it("carries merged_at on the snapshot data when the GitHub PR body has it", async () => {
      const tokenProvider = vi.fn().mockResolvedValue(null);
      const mockFetch = makeFetchMock({
        id: 3158,
        state: "closed",
        merged: true,
        merged_at: "2026-08-18T20:34:57Z",
        closed_at: null,
        title: "test",
      });

      const { resolvers } = createGitHubExternalObjectProvider({} as Db, {
        fetch: mockFetch.fetch,
        tokenProvider,
      });

      const pullRequestResolver = resolvers.find((r) => r.objectType === "pull_request")!;
      const result = await pullRequestResolver.resolve({
        companyId: "test-company",
        object: makeObject("owner/repo#pull/3158"),
      });

      expect(result.ok).toBe(true);
      const snapshot = (result as Extract<ExternalObjectResolveResult, { ok: true }>).snapshot;
      expect(snapshot.data?.merged_at).toBe("2026-08-18T20:34:57Z");
      expect(snapshot.data?.closed_at).toBeUndefined();
    });

    it("carries closed_at on the snapshot data when the GitHub PR body has it", async () => {
      const tokenProvider = vi.fn().mockResolvedValue(null);
      const mockFetch = makeFetchMock({
        id: 3158,
        state: "closed",
        merged: false,
        merged_at: null,
        closed_at: "2026-08-18T20:34:57Z",
        title: "test",
      });

      const { resolvers } = createGitHubExternalObjectProvider({} as Db, {
        fetch: mockFetch.fetch,
        tokenProvider,
      });

      const pullRequestResolver = resolvers.find((r) => r.objectType === "pull_request")!;
      const result = await pullRequestResolver.resolve({
        companyId: "test-company",
        object: makeObject("owner/repo#pull/3158"),
      });

      expect(result.ok).toBe(true);
      const snapshot = (result as Extract<ExternalObjectResolveResult, { ok: true }>).snapshot;
      expect(snapshot.data?.closed_at).toBe("2026-08-18T20:34:57Z");
      expect(snapshot.data?.merged_at).toBeUndefined();
    });
  });
});
