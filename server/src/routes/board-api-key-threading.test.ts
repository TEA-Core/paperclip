/**
 * Pins the route half of board-API-key attribution (SUP-23998).
 *
 * `activity-log-board-api-key-guard.test.ts` only proves that each service
 * `logActivity*` call carries a top-level `boardApiKeyId`. It cannot see
 * whether a ROUTE threads the authenticated key into that service parameter:
 * dropping `actorBoardApiKeyId(req)` from a route still compiled and passed, and
 * the audit row silently got a NULL key. These tests drive each threaded route
 * as a `board_key` actor and assert the key reaches the service call, and that
 * a session actor passes `null`.
 */
import express, { type Request } from "express";
import type { Db } from "@paperclipai/db";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import type { ChatChannelService } from "../services/chat-channels.js";
import { chatChannelRoutes } from "./chat-channels.js";
import { slackToolRoutes } from "./slack-tools.js";

const KEY = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const ENDPOINT = "33333333-3333-4333-8333-333333333333";
const CONNECTION = "44444444-4444-4444-8444-444444444444";

const settings = vi.hoisted(() => ({ getExperimental: vi.fn() }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => settings }));

// The route layer is under test, not the request schemas.
vi.mock("../middleware/validate.js", () => ({
  validate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const github = vi.hoisted(() => ({
  saveConfiguration: vi.fn(),
  identity: vi.fn(),
}));
vi.mock("../services/chat-github-management.js", () => ({ githubChatManagementService: () => github }));

const slackOauth = vi.hoisted(() => ({
  complete: vi.fn(),
  configure: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("../services/connectors/slack-search-oauth.js", () => ({ slackSearchOAuthService: () => slackOauth }));

const boardKeyActor: Request["actor"] = {
  type: "board",
  source: "board_key",
  userId: "board-user",
  keyId: KEY,
  isInstanceAdmin: true,
  companyIds: [COMPANY],
};
const sessionActor: Request["actor"] = {
  type: "board",
  source: "session",
  userId: "board-user",
  isInstanceAdmin: true,
  companyIds: [COMPANY],
};

function chatApp(actor: Request["actor"]) {
  const service = {
    get: vi.fn().mockResolvedValue({ id: ENDPOINT, companyId: COMPANY }),
    create: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    configure: vi.fn().mockResolvedValue({}),
    generateSetupSecret: vi.fn().mockResolvedValue({}),
    startGitHubRegistration: vi.fn().mockResolvedValue({}),
    storeGitHubApp: vi.fn().mockResolvedValue({}),
    replaceResources: vi.fn().mockResolvedValue({}),
    resolvePublication: vi.fn().mockResolvedValue(undefined),
    resolveAction: vi.fn().mockResolvedValue(undefined),
    publishBoardMessage: vi.fn().mockResolvedValue({}),
  };
  github.saveConfiguration.mockResolvedValue({});
  github.identity.mockResolvedValue({});
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(
    "/api",
    chatChannelRoutes({} as Db, {
      service: service as unknown as ChatChannelService,
      heartbeat: { wakeup: vi.fn() },
    }),
  );
  app.use(errorHandler);
  return { app, service };
}

interface ChatRoute {
  name: string;
  method: "post" | "put" | "patch";
  path: string;
  body: Record<string, unknown>;
  /** Which collaborator receives the key, and at which argument position. */
  call: (s: ReturnType<typeof chatApp>["service"]) => ReturnType<typeof vi.fn>;
  keyIndex: number;
}

const base = `/api/chat-endpoints/${ENDPOINT}`;
const CHAT_ROUTES: ChatRoute[] = [
  { name: "create endpoint", method: "post", path: `/api/companies/${COMPANY}/chat-endpoints`, body: {}, call: (s) => s.create, keyIndex: 3 },
  { name: "update endpoint", method: "patch", path: base, body: {}, call: (s) => s.update, keyIndex: 3 },
  { name: "configure endpoint", method: "post", path: `${base}/setup`, body: {}, call: (s) => s.configure, keyIndex: 3 },
  { name: "generate setup secret", method: "post", path: `${base}/setup-secret`, body: {}, call: (s) => s.generateSetupSecret, keyIndex: 2 },
  { name: "start GitHub registration", method: "post", path: `${base}/github/registration`, body: { name: "bot" }, call: (s) => s.startGitHubRegistration, keyIndex: 3 },
  { name: "store GitHub app", method: "post", path: `${base}/github/app`, body: { appId: "1" }, call: (s) => s.storeGitHubApp, keyIndex: 3 },
  { name: "replace resources", method: "put", path: `${base}/resources`, body: { resources: [] }, call: (s) => s.replaceResources, keyIndex: 3 },
  { name: "resolve publication", method: "post", path: `${base}/publications/p1/resolve`, body: { action: "approve" }, call: (s) => s.resolvePublication, keyIndex: 5 },
  { name: "resolve action", method: "post", path: `${base}/actions/a1/resolve`, body: { action: "approve" }, call: (s) => s.resolveAction, keyIndex: 4 },
  { name: "publish board message", method: "post", path: `${base}/conversations/c1/publications`, body: { body: "hi", idempotencyKey: "k", attachmentIds: [] }, call: (s) => s.publishBoardMessage, keyIndex: 6 },
  { name: "save GitHub configuration", method: "put", path: `${base}/github/configuration`, body: {}, call: () => github.saveConfiguration, keyIndex: 3 },
  { name: "confirm GitHub identity", method: "post", path: `${base}/github/identity`, body: { connectionId: CONNECTION }, call: () => github.identity, keyIndex: 4 },
];

beforeEach(() => {
  vi.clearAllMocks();
  settings.getExperimental.mockResolvedValue({ enableChatConnectors: true });
});

describe("chat-channels routes thread the authenticated board key into the service", () => {
  it.each(CHAT_ROUTES)("$name passes the board key", async (route) => {
    const { app, service } = chatApp(boardKeyActor);
    await request(app)[route.method](route.path).send(route.body).expect((res) => {
      if (res.status >= 400) throw new Error(`${route.name} answered ${res.status}: ${res.text}`);
    });
    const fn = route.call(service);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][route.keyIndex]).toBe(KEY);
  });

  it.each(CHAT_ROUTES)("$name passes null for a session actor", async (route) => {
    const { app, service } = chatApp(sessionActor);
    await request(app)[route.method](route.path).send(route.body).expect((res) => {
      if (res.status >= 400) throw new Error(`${route.name} answered ${res.status}: ${res.text}`);
    });
    const fn = route.call(service);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][route.keyIndex]).toBeNull();
  });
});

function slackApp(actor: Request["actor"]) {
  const db = {
    select: () => ({ from: () => ({ where: async () => [{ prefix: "PC" }] }) }),
  } as unknown as Db;
  slackOauth.complete.mockResolvedValue({ companyId: COMPANY, endpointId: ENDPOINT });
  slackOauth.configure.mockResolvedValue({});
  slackOauth.disconnect.mockResolvedValue({});
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", slackToolRoutes(db));
  app.use(errorHandler);
  return app;
}

describe("slack-tools routes thread the authenticated board key into the OAuth service", () => {
  it.each([
    ["callback", "get", "/api/slack/search/callback?state=s&code=c", () => slackOauth.complete, 3],
    ["configure", "put", `/api/companies/${COMPANY}/slack/endpoints/${ENDPOINT}/search`, () => slackOauth.configure, 4],
    ["disconnect", "delete", `/api/companies/${COMPANY}/slack/endpoints/${ENDPOINT}/search`, () => slackOauth.disconnect, 3],
  ] as const)("%s passes the board key, and null for a session actor", async (_name, method, path, call, keyIndex) => {
    await request(slackApp(boardKeyActor))[method](path).send({}).expect((res) => {
      if (res.status >= 400) throw new Error(`${path} answered ${res.status}: ${res.text}`);
    });
    expect(call()).toHaveBeenCalledTimes(1);
    expect(call().mock.calls[0][keyIndex]).toBe(KEY);

    vi.clearAllMocks();
    settings.getExperimental.mockResolvedValue({ enableChatConnectors: true });
    await request(slackApp(sessionActor))[method](path).send({}).expect((res) => {
      if (res.status >= 400) throw new Error(`${path} answered ${res.status}: ${res.text}`);
    });
    expect(call().mock.calls[0][keyIndex]).toBeNull();
  });
});
