/**
 * Route-level company scoping for the Slack connection routes (SUP-23998, mutant
 * C-m1: dropping `assertCompanyAccess` from the PUT configure route survived
 * every committed suite, because the two Slack suites are service-level).
 */
import express, { type Request } from "express";
import type { Db } from "@paperclipai/db";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { slackToolRoutes } from "./slack-tools.js";

const COMPANY = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY = "55555555-5555-4555-8555-555555555555";
const ENDPOINT = "33333333-3333-4333-8333-333333333333";

const settings = vi.hoisted(() => ({ getExperimental: vi.fn() }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => settings }));

const oauth = vi.hoisted(() => ({
  complete: vi.fn(),
  configure: vi.fn(),
  connect: vi.fn(),
  start: vi.fn(),
  status: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("../services/connectors/slack-search-oauth.js", () => ({ slackSearchOAuthService: () => oauth }));

const capabilities = vi.hoisted(() => vi.fn());
vi.mock("../services/connectors/slack-capabilities.js", () => ({ slackCapabilities: capabilities }));

const access = vi.hoisted(() => ({ hasPermission: vi.fn() }));
vi.mock("../services/access.js", () => ({ accessService: () => access }));

const foreignMember: Request["actor"] = {
  type: "board",
  source: "session",
  userId: "member-of-another-company",
  isInstanceAdmin: false,
  companyIds: [OTHER_COMPANY],
};

function app(actor: Request["actor"]) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  server.use("/api", slackToolRoutes({} as Db));
  server.use(errorHandler);
  return server;
}

const base = `/api/companies/${COMPANY}/slack/endpoints/${ENDPOINT}`;

beforeEach(() => {
  vi.clearAllMocks();
  settings.getExperimental.mockResolvedValue({ enableChatConnectors: true });
  access.hasPermission.mockResolvedValue(true);
  for (const fn of Object.values(oauth)) fn.mockResolvedValue({});
  capabilities.mockResolvedValue({});
});

describe("slack-tools routes enforce company scoping before touching the service", () => {
  it.each([
    ["capabilities", "get", `${base}/capabilities`],
    ["status", "get", `${base}/search`],
    ["configure", "put", `${base}/search`],
    ["connect", "post", `${base}/search/connect`],
    ["disconnect", "delete", `${base}/search`],
  ] as const)("refuses %s for a member of another company", async (_name, method, path) => {
    const res = await request(app(foreignMember))[method](path).send({});
    expect(res.status).toBe(403);
    expect(access.hasPermission).not.toHaveBeenCalled();
    for (const fn of Object.values(oauth)) expect(fn).not.toHaveBeenCalled();
    expect(capabilities).not.toHaveBeenCalled();
  });

  it("requires the connection-management permission to configure, even inside the company", async () => {
    access.hasPermission.mockResolvedValue(false);
    const member: Request["actor"] = { ...foreignMember, companyIds: [COMPANY] };
    const res = await request(app(member)).put(`${base}/search`).send({});
    expect(res.status).toBe(403);
    expect(oauth.configure).not.toHaveBeenCalled();
  });

  it("answers 403 while chat connectors are disabled, before any service call", async () => {
    settings.getExperimental.mockResolvedValue({ enableChatConnectors: false });
    const member: Request["actor"] = { ...foreignMember, companyIds: [COMPANY], isInstanceAdmin: true };
    const res = await request(app(member)).put(`${base}/search`).send({});
    expect(res.status).toBe(403);
    expect(oauth.configure).not.toHaveBeenCalled();
  });
});
