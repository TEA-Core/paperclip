import express from "express";
import { generateKeyPairSync } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issues, projectWorkspaces } from "@paperclipai/db";
import { agentGitHubTokenRoutes } from "../routes/agent-github-tokens.js";
import { errorHandler } from "../middleware/error-handler.js";
import {
  DEFAULT_GITHUB_APP,
  FLEET_GITHUB_APP,
  FLEET_GITHUB_APP_ID,
  FLEET_GITHUB_APP_PRIVATE_KEY_SECRET_NAME,
  GITHUB_APP_ID,
  GITHUB_APP_PRIVATE_KEY_SECRET_NAME,
  GitHubAppConfigurationError,
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

const { privateKey: FIXTURE_PRIVATE_KEY_PEM } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const FIXTURE_PRIVATE_KEY = FIXTURE_PRIVATE_KEY_PEM.export({ type: "pkcs1", format: "pem" }) as string;
const FIXTURE_TOKEN = "ghs_test_installation_token_for_agent_route_tests_only";
const FIXTURE_INSTALLATION_ID = "12345678";
const WRITER_AUDITOR_AGENT_ID = "d051c75c-b20f-4efb-87cf-76f73e349a29";

type IssueRow = { projectId: string | null };
type WorkspaceRow = { projectId: string; repoUrl: string | null };
type FakeRows = { issues?: IssueRow[]; workspaces?: WorkspaceRow[] };

// Defaults make the fixture agent reachable for owner/repo via project-x, so the
// pre-existing happy-path tests (which don't exercise project scoping) keep
// passing with no explicit rows.
const DEFAULT_ISSUE_ROWS: IssueRow[] = [{ projectId: "project-x" }];
const DEFAULT_WORKSPACE_ROWS: WorkspaceRow[] = [
  { projectId: "project-x", repoUrl: "https://github.com/owner/repo" },
];

type RouteDeps = NonNullable<Parameters<typeof agentGitHubTokenRoutes>[1]>;

function fakeDb(rows: FakeRows = {}) {
  const issueRows = rows.issues ?? DEFAULT_ISSUE_ROWS;
  const workspaceRows = rows.workspaces ?? DEFAULT_WORKSPACE_ROWS;
  return {
    select: () => ({
      from: (table: unknown) => ({
        // The route dispatches on the same singleton table objects it imports,
        // so identity comparison selects the right fixture rows.
        where: () => Promise.resolve(table === issues ? issueRows : workspaceRows),
      }),
    }),
  } as any;
}

function createApp(actor: Record<string, unknown>, deps: RouteDeps = {}, rows: FakeRows = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentGitHubTokenRoutes(fakeDb(rows), deps));
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

function fakeDeps(
  opts: {
    secret?: { id: string } | null;
    fleetSecret?: { id: string } | null;
    tokenResult?: GitHubTokenResolution | null;
  } = {},
) {
  const secrets: AppInstallationTokenSecrets = {
    getByName: vi.fn(async (_companyId, name) => {
      if (name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME) {
        return opts.secret !== undefined ? opts.secret : { id: "app-key-1" };
      }
      if (name === FLEET_GITHUB_APP_PRIVATE_KEY_SECRET_NAME) {
        return opts.fleetSecret !== undefined ? opts.fleetSecret : { id: "fleet-key-1" };
      }
      return null;
    }),
    resolveSecretValue: vi.fn(async () => FIXTURE_PRIVATE_KEY),
  };
  const resolveToken = vi.fn<NonNullable<RouteDeps["resolveToken"]>>(async () =>
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
  const log = vi.fn<NonNullable<RouteDeps["log"]>>();
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
    const app = createApp(agentActor(), deps, { workspaces: [] });
    const res = await request(app).post("/api/agents/me/github/installation-tokens").send({ owner: "owner", repo: "repo" });
    expect(res.status).toBe(404);
    // Genuinely unregistered: no company workspace row maps to this repo. The message
    // must name that, not claim a workspace merely "is not for" the agent.
    expect(res.body.error).toBe("No project workspace is registered for owner/repo in this company");
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it("denies an agent with no assigned projects (404), even for a reachable company workspace, without minting", async () => {
    const { deps, resolveToken } = fakeDeps();
    const app = createApp(agentActor(), deps, {
      issues: [],
      workspaces: [{ projectId: "project-y", repoUrl: "https://github.com/owner/repo" }],
    });
    const res = await request(app).post("/api/agents/me/github/installation-tokens").send({ owner: "owner", repo: "repo" });
    expect(res.status).toBe(404);
    // The gate is issue-assignment, not registration: the requested workspace IS
    // registered, but the agent holds no assigned issue anywhere, so it names the
    // assignment condition and does not claim the workspace is missing.
    expect(res.body.error).toBe(
      "Agent holds no assigned issues in this company, so it can reach no project (requested owner/repo)",
    );
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it("denies a registered repo owned by a project the agent holds no issue in (404), naming the assignment gate, without minting", async () => {
    const { deps, resolveToken } = fakeDeps();
    const app = createApp(agentActor(), deps, {
      issues: [{ projectId: "project-x" }],
      workspaces: [{ projectId: "project-y", repoUrl: "https://github.com/owner/repo" }],
    });
    const res = await request(app).post("/api/agents/me/github/installation-tokens").send({ owner: "owner", repo: "repo" });
    expect(res.status).toBe(404);
    // Registered-but-unreachable: the repo has a company workspace, but it belongs to
    // project-y, which the agent holds no issue in. Distinct from both the no-assignment
    // and the unregistered outcomes.
    expect(res.body.error).toBe(
      "Project workspace for owner/repo is registered, but belongs to a project the agent holds no assigned issue in",
    );
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it.each([
    { name: "omits permissions", body: { owner: "owner", repo: "repo" } },
    {
      name: "requests contents write",
      body: { owner: "owner", repo: "repo", permissions: { contents: "write" } },
    },
  ])("mints contents-read for writer-Auditor on a registered but unassigned repo when it $name", async ({ body }) => {
    const { deps, resolveToken } = fakeDeps();
    const app = createApp(agentActor({ agentId: WRITER_AUDITOR_AGENT_ID }), deps, {
      issues: [{ projectId: "project-x" }],
      workspaces: [{ projectId: "project-y", repoUrl: "https://github.com/owner/repo" }],
    });
    const res = await request(app).post("/api/agents/me/github/installation-tokens").send(body);
    expect(res.status).toBe(200);
    expect(resolveToken).toHaveBeenCalledWith(
      "company-1",
      expect.anything(),
      "owner",
      "repo",
      undefined,
      DEFAULT_GITHUB_APP,
      { contents: "read", metadata: "read" },
    );
  });

  it("reports an unregistered repo for writer-Auditor without minting even with no assigned issues", async () => {
    const { deps, resolveToken } = fakeDeps();
    const app = createApp(agentActor({ agentId: WRITER_AUDITOR_AGENT_ID }), deps, {
      issues: [],
      workspaces: [],
    });
    const res = await request(app)
      .post("/api/agents/me/github/installation-tokens")
      .send({ owner: "owner", repo: "repo" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("No project workspace is registered for owner/repo in this company");
    expect(resolveToken).not.toHaveBeenCalled();
  });

  // SUP-23880: the writer-Auditor assurance exception authorizes exactly one
  // company-registered GitHub repository against its CANONICAL owner/repo
  // strings, host-aware. An alias spelling that merely normalizes to the
  // registered repo must refuse; a same-named non-GitHub registration must not
  // authorize a GitHub mint.
  describe("writer-Auditor assurance mint — canonical repo identity and GitHub host (SUP-23880)", () => {
    const assuranceRows: FakeRows = {
      issues: [{ projectId: "project-x" }],
      workspaces: [{ projectId: "project-y", repoUrl: "https://github.com/TEA-Core/paperclip" }],
    };

    it.each([
      { name: "different-case owner", body: { owner: "tea-core", repo: "paperclip" } },
      { name: "different-case repo", body: { owner: "TEA-Core", repo: "Paperclip" } },
      { name: "repo with trailing .git", body: { owner: "TEA-Core", repo: "paperclip.git" } },
      { name: "URL-form owner", body: { owner: "https://github.com/TEA-Core", repo: "paperclip" } },
      { name: "owner with trailing whitespace", body: { owner: "TEA-Core ", repo: "paperclip" } },
      { name: "repo with trailing whitespace", body: { owner: "TEA-Core", repo: "paperclip " } },
    ])("refuses the $name alias of a registered repo without minting", async ({ body }) => {
      const { deps, resolveToken } = fakeDeps();
      const app = createApp(agentActor({ agentId: WRITER_AUDITOR_AGENT_ID }), deps, assuranceRows);
      const res = await request(app).post("/api/agents/me/github/installation-tokens").send(body);
      expect(res.status).toBe(404);
      // The refusal names the canonical registration, so the caller can retry exactly.
      expect(res.body.error).toBe(
        "Assurance GitHub mint requires the registered canonical repository exactly (requested " +
          `${body.owner}/${body.repo}, registered TEA-Core/paperclip)`,
      );
      expect(resolveToken).not.toHaveBeenCalled();
    });

    it("refuses a non-GitHub workspace URL with the same owner/repo without minting", async () => {
      const { deps, resolveToken } = fakeDeps();
      const app = createApp(agentActor({ agentId: WRITER_AUDITOR_AGENT_ID }), deps, {
        issues: [{ projectId: "project-x" }],
        workspaces: [{ projectId: "project-y", repoUrl: "https://gitlab.example.com/TEA-Core/paperclip" }],
      });
      const res = await request(app)
        .post("/api/agents/me/github/installation-tokens")
        .send({ owner: "TEA-Core", repo: "paperclip" });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe(
        "Assurance GitHub mint requires a workspace registered on github.com " +
          "(requested TEA-Core/paperclip matches only a non-GitHub registration)",
      );
      expect(resolveToken).not.toHaveBeenCalled();
    });

    it("refuses a file:// registration impersonating github.com with 404 and without minting (SUP-23892)", async () => {
      const { deps, resolveToken } = fakeDeps();
      const app = createApp(agentActor({ agentId: WRITER_AUDITOR_AGENT_ID }), deps, {
        issues: [{ projectId: "project-x" }],
        workspaces: [{ projectId: "project-y", repoUrl: "file://github.com/TEA-Core/paperclip" }],
      });
      const res = await request(app)
        .post("/api/agents/me/github/installation-tokens")
        .send({ owner: "TEA-Core", repo: "paperclip" });
      expect(res.status).toBe(404);
      // normalizeRepoUrl still matches the repo name (it erases the transport and
      // host), so the refusal is the non-GitHub-registration gate: file:// is not
      // a GitHub transport and must fail closed before resolveToken.
      expect(res.body.error).toBe(
        "Assurance GitHub mint requires a workspace registered on github.com " +
          "(requested TEA-Core/paperclip matches only a non-GitHub registration)",
      );
      expect(resolveToken).not.toHaveBeenCalled();
    });

    it("mints with the canonical registered owner/repo and exactly contents+metadata read on an exact match", async () => {
      const { deps, resolveToken } = fakeDeps();
      const app = createApp(agentActor({ agentId: WRITER_AUDITOR_AGENT_ID }), deps, assuranceRows);
      // Requested permissions are ignored on the assurance path: the mint is
      // pinned to contents-read + metadata-read regardless.
      const res = await request(app)
        .post("/api/agents/me/github/installation-tokens")
        .send({ owner: "TEA-Core", repo: "paperclip", permissions: { contents: "write" } });
      expect(res.status).toBe(200);
      expect(resolveToken).toHaveBeenCalledTimes(1);
      expect(resolveToken).toHaveBeenCalledWith(
        "company-1",
        expect.anything(),
        "TEA-Core",
        "paperclip",
        undefined,
        DEFAULT_GITHUB_APP,
        { contents: "read", metadata: "read" },
      );
    });

    it("canonicalizes a .git-suffixed GitHub registration to the stripped registered values", async () => {
      const { deps, resolveToken } = fakeDeps();
      const app = createApp(agentActor({ agentId: WRITER_AUDITOR_AGENT_ID }), deps, {
        issues: [{ projectId: "project-x" }],
        workspaces: [{ projectId: "project-y", repoUrl: "https://github.com/TEA-Core/paperclip.git" }],
      });
      const res = await request(app)
        .post("/api/agents/me/github/installation-tokens")
        .send({ owner: "TEA-Core", repo: "paperclip" });
      expect(res.status).toBe(200);
      // The mint uses the registration's canonical (`.git`-stripped) strings,
      // not the raw clone-URL spelling.
      expect(resolveToken).toHaveBeenCalledWith(
        "company-1",
        expect.anything(),
        "TEA-Core",
        "paperclip",
        undefined,
        DEFAULT_GITHUB_APP,
        { contents: "read", metadata: "read" },
      );
    });

    it("keeps the case-insensitive normalized mint for every other agent (assignment gate preserved)", async () => {
      const { deps, resolveToken } = fakeDeps();
      const app = createApp(agentActor(), deps, {
        issues: [{ projectId: "project-x" }],
        workspaces: [{ projectId: "project-x", repoUrl: "https://github.com/TEA-Core/paperclip" }],
      });
      const res = await request(app)
        .post("/api/agents/me/github/installation-tokens")
        .send({ owner: "tea-core", repo: "paperclip" });
      expect(res.status).toBe(200);
      // The non-assurance path is unchanged: normalized comparison still matches
      // casing differences, and the mint uses the caller's own owner/repo.
      expect(resolveToken).toHaveBeenCalledWith(
        "company-1",
        expect.anything(),
        "tea-core",
        "paperclip",
        undefined,
        DEFAULT_GITHUB_APP,
        undefined,
      );
    });

    // Release-assurance NO-GO at bf2a23ac: the registration's host and owner/repo must
    // read the same to the check as to every real URL client and to the GitHub wire.
    // Each row is a registration whose literal owner/repo the request repeats exactly,
    // so only the registration-side gate stands between it and a mint.
    const LONG_OWNER = "o".repeat(40);
    const LONG_REPO = "r".repeat(101);
    it.each([
      {
        name: "the review thread's backslash userinfo (WHATWG host attacker.example)",
        repoUrl: "https://attacker.example\\@github.com/TEA-Core/paperclip",
        body: { owner: "TEA-Core", repo: "paperclip" },
      },
      {
        name: "a `#` in userinfo (WHATWG host evil.example)",
        repoUrl: "https://evil.example#@github.com/TEA-Core/paperclip",
        body: { owner: "TEA-Core", repo: "paperclip" },
      },
      {
        name: "a `?` in userinfo (WHATWG host evil.example)",
        repoUrl: "https://evil.example?@github.com/TEA-Core/paperclip",
        body: { owner: "TEA-Core", repo: "paperclip" },
      },
      {
        name: "github.com as userinfo of another host",
        repoUrl: "https://github.com@evil.example/TEA-Core/paperclip",
        body: { owner: "TEA-Core", repo: "paperclip" },
      },
      {
        name: "a lookalike host",
        repoUrl: "https://github.com.evil.example/TEA-Core/paperclip",
        body: { owner: "TEA-Core", repo: "paperclip" },
      },
      {
        name: "a tab inside the repo",
        repoUrl: "https://github.com/TEA-Core/pape\trclip",
        body: { owner: "TEA-Core", repo: "pape\trclip" },
      },
      {
        name: "a percent-encoded owner",
        repoUrl: "https://github.com/TEA%2DCore/paperclip",
        body: { owner: "TEA%2DCore", repo: "paperclip" },
      },
      {
        name: "a percent-encoded repo",
        repoUrl: "https://github.com/TEA-Core/pap%65rclip",
        body: { owner: "TEA-Core", repo: "pap%65rclip" },
      },
      {
        name: "an owner over GitHub's 39-character limit",
        repoUrl: `https://github.com/${LONG_OWNER}/paperclip`,
        body: { owner: LONG_OWNER, repo: "paperclip" },
      },
      {
        name: "a repo over GitHub's 100-character limit",
        repoUrl: `https://github.com/TEA-Core/${LONG_REPO}`,
        body: { owner: "TEA-Core", repo: LONG_REPO },
      },
    ])("refuses a registration with $name without minting", async ({ repoUrl, body }) => {
      const { deps, resolveToken } = fakeDeps();
      const app = createApp(agentActor({ agentId: WRITER_AUDITOR_AGENT_ID }), deps, {
        issues: [{ projectId: "project-x" }],
        workspaces: [{ projectId: "project-y", repoUrl }],
      });
      const res = await request(app).post("/api/agents/me/github/installation-tokens").send(body);
      expect(res.status).toBe(404);
      expect(resolveToken).not.toHaveBeenCalled();
    });

    it.each([
      { name: "userinfo with a password", repoUrl: "https://user:pass@github.com/TEA-Core/paperclip" },
      { name: "an uppercase host and .git/ suffix", repoUrl: "https://GitHub.com/TEA-Core/paperclip.git/" },
      { name: "the scp-like form", repoUrl: "git@github.com:TEA-Core/paperclip.git" },
    ])("still mints for a canonical registration written with $name", async ({ repoUrl }) => {
      const { deps, resolveToken } = fakeDeps();
      const app = createApp(agentActor({ agentId: WRITER_AUDITOR_AGENT_ID }), deps, {
        issues: [{ projectId: "project-x" }],
        workspaces: [{ projectId: "project-y", repoUrl }],
      });
      const res = await request(app)
        .post("/api/agents/me/github/installation-tokens")
        .send({ owner: "TEA-Core", repo: "paperclip" });
      expect(res.status).toBe(200);
      expect(resolveToken).toHaveBeenCalledWith(
        "company-1",
        expect.anything(),
        "TEA-Core",
        "paperclip",
        undefined,
        DEFAULT_GITHUB_APP,
        { contents: "read", metadata: "read" },
      );
    });

    it("still mints at exactly GitHub's owner (39) and repo (100) length limits", async () => {
      const owner = "o".repeat(39);
      const repo = "r".repeat(100);
      const { deps, resolveToken } = fakeDeps();
      const app = createApp(agentActor({ agentId: WRITER_AUDITOR_AGENT_ID }), deps, {
        issues: [{ projectId: "project-x" }],
        workspaces: [{ projectId: "project-y", repoUrl: `https://github.com/${owner}/${repo}` }],
      });
      const res = await request(app).post("/api/agents/me/github/installation-tokens").send({ owner, repo });
      expect(res.status).toBe(200);
      expect(resolveToken).toHaveBeenCalledTimes(1);
    });
  });

  it("allows an agent to mint for a project it is assigned to", async () => {
    const { deps, resolveToken } = fakeDeps();
    const app = createApp(agentActor(), deps, {
      issues: [{ projectId: "project-x" }],
      workspaces: [{ projectId: "project-x", repoUrl: "https://github.com/owner/repo" }],
    });
    const res = await request(app).post("/api/agents/me/github/installation-tokens").send({ owner: "owner", repo: "repo" });
    expect(res.status).toBe(200);
    expect(resolveToken).toHaveBeenCalledTimes(1);
  });

  it("denies an agent minting for an unrelated company project it is not assigned to, while allowing its own", async () => {
    const { deps, resolveToken } = fakeDeps();
    const rows: FakeRows = {
      issues: [{ projectId: "project-x" }],
      workspaces: [
        { projectId: "project-x", repoUrl: "https://github.com/owner/allowed" },
        { projectId: "project-y", repoUrl: "https://github.com/owner/other" },
      ],
    };
    const app = createApp(agentActor(), deps, rows);

    // Unrelated project-y repo -> denied, no mint.
    const denied = await request(app)
      .post("/api/agents/me/github/installation-tokens")
      .send({ owner: "owner", repo: "other" });
    expect(denied.status).toBe(404);

    // Own project-x repo -> allowed, single mint.
    const allowed = await request(app)
      .post("/api/agents/me/github/installation-tokens")
      .send({ owner: "owner", repo: "allowed" });
    expect(allowed.status).toBe(200);

    expect(resolveToken).toHaveBeenCalledTimes(1);
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

  it("rejects an unknown permission key with a typed 400 that names the key, without minting", async () => {
    const { deps, resolveToken } = fakeDeps({ tokenResult: null });
    const app = createApp(agentActor(), deps);
    const res = await request(app)
      .post("/api/agents/me/github/installation-tokens")
      .send({ owner: "owner", repo: "repo", permissions: { contnets: "read" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Unrecognized field(s): permissions.contnets");
    expect(Array.isArray(res.body.details)).toBe(true);
    const issue = (res.body.details as Array<{ code?: string; keys?: unknown[]; path?: Array<string | number> }>).find(
      (entry) => entry.code === "unrecognized_keys",
    );
    expect(issue?.path?.includes("permissions")).toBe(true);
    expect(issue?.keys).toContain("contnets");
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
      appId: GITHUB_APP_ID,
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
    const audit = log.mock.calls[0]![1] as unknown as Record<string, unknown>;
    expect(audit.action).toBe("github_installation_token_minted");
    expect(audit.actorType).toBe("agent");
    expect(audit.entityType).toBe("github_installation");
    const details = audit.details as Record<string, unknown>;
    expect(details.token).toBe("<redacted>");
    expect(JSON.stringify(audit)).not.toContain(FIXTURE_TOKEN);
    expect(JSON.stringify(audit)).not.toContain(FIXTURE_PRIVATE_KEY);
  });
});

describe("broker App selection (configurable descriptor)", () => {
  beforeEach(() => {
    appTokenCache.clear();
    delete process.env.PAPERCLIP_GITHUB_BROKER_APP;
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_GITHUB_BROKER_APP;
  });

  it("mints from the fleet App and reports its appId when the broker selects fleet", async () => {
    const { deps, resolveToken, secrets } = fakeDeps();
    const app = createApp(agentActor(), { ...deps, appName: "fleet" });
    const res = await request(app).post("/api/agents/me/github/installation-tokens").send({ owner: "owner", repo: "repo" });

    expect(res.status).toBe(200);
    expect(res.body.appId).toBe(FLEET_GITHUB_APP_ID);
    // The mint was keyed to the fleet App's own secret, not the default App's.
    expect(secrets.getByName).toHaveBeenCalledWith("company-1", FLEET_GITHUB_APP_PRIVATE_KEY_SECRET_NAME);
    expect(resolveToken).toHaveBeenCalledWith(
      "company-1",
      expect.anything(),
      "owner",
      "repo",
      undefined,
      FLEET_GITHUB_APP,
      undefined,
    );
  });

  it("reports the default App's appId when no App is selected", async () => {
    const { deps } = fakeDeps();
    const app = createApp(agentActor(), deps);
    const res = await request(app).post("/api/agents/me/github/installation-tokens").send({ owner: "owner", repo: "repo" });
    expect(res.status).toBe(200);
    expect(res.body.appId).toBe(DEFAULT_GITHUB_APP.appId);
  });

  it("selects the fleet App from the PAPERCLIP_GITHUB_BROKER_APP env var", async () => {
    process.env.PAPERCLIP_GITHUB_BROKER_APP = "fleet";
    const { deps, resolveToken } = fakeDeps();
    const app = createApp(agentActor(), deps);
    const res = await request(app).post("/api/agents/me/github/installation-tokens").send({ owner: "owner", repo: "repo" });
    expect(res.status).toBe(200);
    expect(res.body.appId).toBe(FLEET_GITHUB_APP_ID);
    expect(resolveToken).toHaveBeenCalledWith(
      "company-1",
      expect.anything(),
      "owner",
      "repo",
      undefined,
      FLEET_GITHUB_APP,
      undefined,
    );
  });

  it("returns 404 app_not_configured when the selected fleet App's key is not stored, without minting", async () => {
    const { deps, resolveToken } = fakeDeps({ fleetSecret: null });
    const app = createApp(agentActor(), { ...deps, appName: "fleet" });
    const res = await request(app).post("/api/agents/me/github/installation-tokens").send({ owner: "owner", repo: "repo" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("app_not_configured");
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it("rejects an unknown App name at route construction with a named error, before any mint", async () => {
    const { deps, resolveToken } = fakeDeps();
    expect(() => agentGitHubTokenRoutes(fakeDb(), { ...deps, appName: "bogus" })).toThrow(GitHubAppConfigurationError);
    expect(() => agentGitHubTokenRoutes(fakeDb(), { ...deps, appName: "bogus" })).toThrow(
      /Unknown GitHub App descriptor "bogus"/,
    );
    expect(resolveToken).not.toHaveBeenCalled();
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
      expect(isGitHubTokenResolution(result!)).toBe(true);
      expect(mintBody).toBe(
        JSON.stringify({
          permissions: { contents: "read", pull_requests: "write" },
          repositories: [repo],
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("narrows the minted token to the requested repo by sending repositories in the mint POST body", async () => {
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
      // No permissions requested — the body is ONLY the narrowing. This is the
      // bug this test pins: the mint must carry the repo so the credential cannot
      // reach any other repo in the installation, even though the request layer
      // already authorized exactly this one.
      const result = await resolveAppInstallationToken(company, fakeSecrets, owner, repo, undefined, DEFAULT_GITHUB_APP);
      expect(isGitHubTokenResolution(result!)).toBe(true);
      expect(mintBody).toBe(JSON.stringify({ repositories: [repo] }));
      expect(JSON.stringify(mintBody)).not.toContain("permissions");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("does not narrow a mint with no repo context (company-wide scope stays broad)", async () => {
    let mintBody: unknown;
    const originalFetch = global.fetch;
    global.fetch = vi.fn((input: string | URL, init?: RequestInit) => {
      const target = typeof input === "string" ? input : input.toString();
      // /access_tokens is a substring of the install-mint URL, so it must be
      // checked before the /app/installations list match.
      if (target.includes("/access_tokens")) {
        mintBody = init?.body;
        return Promise.resolve(
          new Response(JSON.stringify({ token: FIXTURE_TOKEN, expires_at: "2026-08-17T13:00:00.000Z" }), { status: 200 }),
        );
      }
      if (target.includes("/app/installations")) {
        return Promise.resolve(new Response(JSON.stringify([{ id: Number(FIXTURE_INSTALLATION_ID) }]), { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as any;

    try {
      const result = await resolveAppInstallationToken(company, fakeSecrets, undefined, undefined, undefined, DEFAULT_GITHUB_APP);
      expect(isGitHubTokenResolution(result!)).toBe(true);
      // No owner/repo → no narrowing: the body is omitted entirely (undefined),
      // so the company-wide diagnostics probe still sees the whole installation.
      expect(mintBody).toBeUndefined();
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
      expect(isGitHubTokenResolution(result!)).toBe(true);
      if (isGitHubTokenResolution(result!)) {
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
      expect(isGitHubTokenResolution(first!)).toBe(true);
      expect(isGitHubTokenResolution(second!)).toBe(true);
      if (isGitHubTokenResolution(first!) && isGitHubTokenResolution(second!)) {
        expect(second.token).toBe(first.token);
        expect(second.expiresAt).toBe(first.expiresAt);
      }
      expect(mintCount).toBe(1);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// Release-assurance NO-GO at bf2a23ac: the installation lookup and the mint must send GitHub
// exactly the owner/repo the check authorized, and a read-only single-repo mint must come back
// exactly that narrow. The stub below is the only "network": it answers by path, records every
// request, and — like real fetch under `redirect: "error"` — never follows a 3xx; a request that
// would follow one is recorded as a second call so the test can see it.
describe("resolveAppInstallationToken — wire encoding, name limits, response scope, redirects", () => {
  const company = "company-1";
  const fakeSecrets: AppInstallationTokenSecrets = {
    getByName: async (_companyId, name) =>
      name === GITHUB_APP_PRIVATE_KEY_SECRET_NAME ? { id: "app-key-1" } : null,
    resolveSecretValue: async () => FIXTURE_PRIVATE_KEY,
  };
  const READ_ONLY = { contents: "read", metadata: "read" };
  const exactMint = (owner: string, repo: string) => ({
    token: FIXTURE_TOKEN,
    expires_at: "2026-08-17T13:00:00.000Z",
    permissions: { contents: "read", metadata: "read" },
    repository_selection: "selected",
    repositories: [{ id: 1, name: repo, full_name: `${owner}/${repo}` }],
  });

  let originalFetch: typeof fetch;
  let calls: Array<{ url: string; redirect: RequestInit["redirect"] }>;

  function stubGitHubApi(opts: {
    installationId?: unknown;
    mintResponse?: Record<string, unknown>;
    lookupRedirectsTo?: string;
  }) {
    global.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, redirect: init?.redirect });
      if (url.endsWith("/access_tokens")) {
        return new Response(JSON.stringify(opts.mintResponse ?? {}), { status: 200 });
      }
      if (url.endsWith("/installation")) {
        if (opts.lookupRedirectsTo) {
          if (init?.redirect === "error") throw new TypeError("fetch failed: redirect refused");
          calls.push({ url: opts.lookupRedirectsTo, redirect: init?.redirect });
        }
        return new Response(JSON.stringify({ id: opts.installationId ?? Number(FIXTURE_INSTALLATION_ID) }), {
          status: 200,
        });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    appTokenCache.clear();
    calls = [];
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("percent-encodes owner and repo in the installation lookup path", async () => {
    stubGitHubApi({ mintResponse: { token: FIXTURE_TOKEN, expires_at: "2026-08-17T13:00:00.000Z" } });
    await resolveAppInstallationToken(company, fakeSecrets, "own#er", "re?po/x", undefined, DEFAULT_GITHUB_APP);
    expect(calls[0]!.url).toBe("https://api.github.com/repos/own%23er/re%3Fpo%2Fx/installation");
  });

  it("percent-encodes the installation id in the mint path", async () => {
    stubGitHubApi({
      installationId: "1/../../app/installations/9",
      mintResponse: { token: FIXTURE_TOKEN, expires_at: "2026-08-17T13:00:00.000Z" },
    });
    await resolveAppInstallationToken(company, fakeSecrets, "owner", "repo", undefined, DEFAULT_GITHUB_APP);
    expect(calls[1]!.url).toBe(
      "https://api.github.com/app/installations/1%2F..%2F..%2Fapp%2Finstallations%2F9/access_tokens",
    );
  });

  it.each([
    { name: "a tab in the owner", owner: "TEA-Core\t", repo: "paperclip" },
    { name: "a tab in the repo", owner: "TEA-Core", repo: "pape\trclip" },
    { name: "a percent-encoding in the owner", owner: "TEA%2DCore", repo: "paperclip" },
    { name: "a percent-encoding in the repo", owner: "TEA-Core", repo: "pap%65rclip" },
    { name: "a backslash in the repo", owner: "TEA-Core", repo: "x\\paperclip" },
    { name: "a trailing space in the owner", owner: "TEA-Core ", repo: "paperclip" },
    { name: "a newline in the repo", owner: "TEA-Core", repo: "paperclip\n" },
    { name: "a dot-dot repo segment", owner: "TEA-Core", repo: ".." },
    { name: "an owner over 39 characters", owner: "o".repeat(40), repo: "paperclip" },
    { name: "a repo over 100 characters", owner: "TEA-Core", repo: "r".repeat(101) },
    { name: "a 300-character owner", owner: "o".repeat(300), repo: "paperclip" },
  ])("refuses $name before reading the key or touching the wire", async ({ owner, repo }) => {
    stubGitHubApi({ mintResponse: exactMint(owner, repo) });
    const getByName = vi.fn(fakeSecrets.getByName);
    const result = await resolveAppInstallationToken(
      company,
      { ...fakeSecrets, getByName },
      owner,
      repo,
      undefined,
      DEFAULT_GITHUB_APP,
      READ_ONLY,
    );
    expect(result).toBeNull();
    expect(getByName).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("returns and caches a read-only mint whose response is exactly the one requested repo and permissions", async () => {
    // GitHub reports the repository's own casing; names are case-insensitive, so this still matches.
    stubGitHubApi({ mintResponse: exactMint("tea-core", "Paperclip") });
    const result = await resolveAppInstallationToken(
      company,
      fakeSecrets,
      "TEA-Core",
      "paperclip",
      undefined,
      DEFAULT_GITHUB_APP,
      READ_ONLY,
    );
    expect(result && isGitHubTokenResolution(result) ? result.token : null).toBe(FIXTURE_TOKEN);
    expect(appTokenCache.size).toBe(1);
  });

  it.each([
    {
      name: "names a different repository",
      mint: { ...exactMint("TEA-Core", "paperclip"), repositories: [{ id: 2, name: "other", full_name: "TEA-Core/other" }] },
    },
    {
      name: "names the same repo name under a different owner",
      mint: { ...exactMint("TEA-Core", "paperclip"), repositories: [{ id: 3, name: "paperclip", full_name: "evil/paperclip" }] },
    },
    {
      name: "names a second repository",
      mint: {
        ...exactMint("TEA-Core", "paperclip"),
        repositories: [
          { id: 1, name: "paperclip", full_name: "TEA-Core/paperclip" },
          { id: 2, name: "other", full_name: "TEA-Core/other" },
        ],
      },
    },
    {
      name: "omits the repositories (installation-wide)",
      mint: { ...exactMint("TEA-Core", "paperclip"), repositories: undefined, repository_selection: "all" },
    },
    {
      name: "grants contents write",
      mint: { ...exactMint("TEA-Core", "paperclip"), permissions: { contents: "write", metadata: "read" } },
    },
    {
      name: "grants an extra permission",
      mint: { ...exactMint("TEA-Core", "paperclip"), permissions: { contents: "read", metadata: "read", issues: "read" } },
    },
    {
      name: "omits the permissions",
      mint: { ...exactMint("TEA-Core", "paperclip"), permissions: undefined },
    },
  ])("refuses, without returning or caching it, a read-only mint whose response $name", async ({ mint }) => {
    stubGitHubApi({ mintResponse: mint });
    const result = await resolveAppInstallationToken(
      company,
      fakeSecrets,
      "TEA-Core",
      "paperclip",
      undefined,
      DEFAULT_GITHUB_APP,
      READ_ONLY,
    );
    expect(result).toBeNull();
    expect(appTokenCache.size).toBe(0);
  });

  it("does not follow a redirect from the installation lookup (the request carries redirect: error)", async () => {
    stubGitHubApi({
      lookupRedirectsTo: "https://elsewhere.example/repositories/1/installation",
      mintResponse: exactMint("TEA-Core", "paperclip"),
    });
    const result = await resolveAppInstallationToken(
      company,
      fakeSecrets,
      "TEA-Core",
      "paperclip",
      undefined,
      DEFAULT_GITHUB_APP,
      READ_ONLY,
    );
    expect(result).toBeNull();
    expect(calls.map((call) => call.url)).toEqual(["https://api.github.com/repos/TEA-Core/paperclip/installation"]);
  });

  it("route: the writer-Auditor gets 502 and no token when GitHub's mint is wider than read-only on one repo", async () => {
    stubGitHubApi({
      mintResponse: { ...exactMint("TEA-Core", "paperclip"), permissions: { contents: "write", metadata: "read" } },
    });
    const { secrets, log } = fakeDeps();
    const app = createApp(agentActor({ agentId: WRITER_AUDITOR_AGENT_ID }), { secrets, log }, {
      issues: [{ projectId: "project-x" }],
      workspaces: [{ projectId: "project-y", repoUrl: "https://github.com/TEA-Core/paperclip" }],
    });
    const res = await request(app)
      .post("/api/agents/me/github/installation-tokens")
      .send({ owner: "TEA-Core", repo: "paperclip" });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("mint_failed");
    expect(JSON.stringify(res.body)).not.toContain(FIXTURE_TOKEN);
    expect(log).not.toHaveBeenCalled();
  });

  it("route: the writer-Auditor gets the token when GitHub's mint is exactly read-only on the registered repo", async () => {
    stubGitHubApi({ mintResponse: exactMint("TEA-Core", "paperclip") });
    const { secrets, log } = fakeDeps();
    const app = createApp(agentActor({ agentId: WRITER_AUDITOR_AGENT_ID }), { secrets, log }, {
      issues: [{ projectId: "project-x" }],
      workspaces: [{ projectId: "project-y", repoUrl: "https://github.com/TEA-Core/paperclip" }],
    });
    const res = await request(app)
      .post("/api/agents/me/github/installation-tokens")
      .send({ owner: "TEA-Core", repo: "paperclip" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBe(FIXTURE_TOKEN);
    expect(calls.map((call) => call.redirect)).toEqual(["error", "error"]);
  });
});
