import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { COMPANY_IMPORT_TRANSFERS_ROUTE_PATH } from "@paperclipai/shared/company-import-transfer";
import { errorHandler } from "../middleware/index.js";
import { COMPANY_IMPORT_ROUTE_PATH } from "../routes/company-import-paths.js";
import { OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH } from "../services/tool-access.js";
import { buildOpenApiSpec, openApiRoutes } from "../routes/openapi.js";
import {
  GITHUB_INSTALLATION_PERMISSION_LEVELS,
  GITHUB_INSTALLATION_PERMISSION_NAMES,
} from "../routes/agent-github-tokens-schemas.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTES_DIR = path.resolve(__dirname, "../routes");

const apiPrefixes: Record<string, string> = {
  "pipelines.ts": "/api",
  "cases.ts": "/api",
  "smoke-lab.ts": "/api",
  "access.ts": "/api",
  "activity.ts": "/api",
  "adapters.ts": "/api",
  "agent-github-tokens.ts": "/api",
  "agents.ts": "/api",
  "attention.ts": "/api",
  "approvals.ts": "/api",
  "assets.ts": "/api",
  "auth.ts": "/api/auth",
  "board-chat.ts": "/api",
  "built-in-agents.ts": "/api",
  "chat-channels.ts": "/api",
  "email.ts": "/api",
  "cloud.ts": "/api/cloud",
  "companies.ts": "/api/companies",
  "company-skills.ts": "/api",
  "company-skill-policy.ts": "/api",
  "connection-intents.ts": "/api",
  "costs.ts": "/api",
  "dashboard.ts": "/api",
  "decision-queues.ts": "/api",
  "decisions.ts": "/api",
  "decision-training.ts": "/api",
  "diagnostics.ts": "/api",
  "dispatch-quiesce.ts": "/api",
  "environments.ts": "/api",
  "execution-workspaces.ts": "/api",
  "file-resources.ts": "/api",
  "folders.ts": "/api",
  "goals.ts": "/api",
  "health.ts": "/api/health",
  "inbox-agent-policy.ts": "/api",
  "inbox-dismissals.ts": "/api",
  "instance-database-backups.ts": "/api",
  "instance-settings.ts": "/api",
  "issues.ts": "/api",
  "issue-tree-control.ts": "/api",
  "llms.ts": "/api",
  "managed-agent-profiles.ts": "/api",
  "onboarding-seed.ts": "/api",
  "openapi.ts": "/api",
  "plugin-ui-static.ts": "/api",
  "plugins.ts": "/api",
  "projects.ts": "/api",
  "resource-memberships.ts": "/api",
  "remote-agent-profiles.ts": "/api",
  "routines.ts": "/api",
  "secrets.ts": "/api",
  "sidebar-badges.ts": "/api",
  "sidebar-preferences.ts": "/api",
  "summary-slots.ts": "/api",
  "status-cards.ts": "/api",
  "teams-catalog.ts": "/api",
  "tool-access.ts": "/api",
  "tool-gateway.ts": "/api",
  "user-profiles.ts": "/api",
  "work-sessions.ts": "/api",
};

const ROUTE_LITERAL_PATTERN =
  /router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
const ROUTER_METHOD_PATTERN = /router\.(get|post|put|patch|delete)\(/;
const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);
const explicitOpenApiCoverageExclusions = new Set<string>();

const explicitOpenApiOperationCoverageExclusions = new Set([
  // This endpoint is authenticated by the provider signature rather than by a
  // Paperclip board/agent credential. It intentionally stays out of the public
  // board API document, while this exact exclusion keeps route coverage honest.
  "POST /api/chat-webhooks/agentmail/{publicId}",
  "POST /api/chat-webhooks/{publicId}/{provider}",
]);

// The set of contract-first routes whose OpenAPI document leads the mounted
// request handler. The company-and-environment Claude setup-token login routes
// now have request handlers, so the set is empty. A new contract-first route
// belongs here only until its handler lands.
const specOnlyContractFirstRoutes = new Set<string>([]);

function createApp() {
  const app = express();
  app.use("/api", openApiRoutes());
  app.use(errorHandler);
  return app;
}

// Route files may compose paths from shared path constants inside template
// literals; substitute the constants' values before normalizing.
const routePathConstantSubstitutions: Record<string, string> = {
  "${COMPANY_IMPORT_TRANSFERS_ROUTE_PATH}": COMPANY_IMPORT_TRANSFERS_ROUTE_PATH,
};

function normalizeExpressPath(routePath: string) {
  let substituted = routePath;
  for (const [placeholder, value] of Object.entries(
    routePathConstantSubstitutions,
  )) {
    substituted = substituted.split(placeholder).join(value);
  }
  return substituted
    .replace(/\*([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
    .replace(/\/+/g, "/");
}

function resolveMountedPath(file: string, prefix: string, routePath: string) {
  if (
    (file === "chat-channels.ts" || file === "email.ts") &&
    routePath.startsWith("/api/chat-webhooks/")
  ) {
    return routePath;
  }
  if (file === "tool-gateway.ts" && routePath.startsWith("/mcp/gateways/")) {
    return routePath;
  }
  if (
    file === "connection-intents.ts" &&
    (routePath.startsWith("/mcp/") || routePath.startsWith("/runtime-tools/"))
  ) {
    return routePath;
  }
  if ((file === "companies.ts" || file === "health.ts") && routePath === "/") {
    return prefix;
  }
  if (file === "companies.ts" || file === "health.ts") {
    return `${prefix}${routePath}`;
  }
  if (file === "auth.ts") {
    return `${prefix}${routePath === "/" ? "" : routePath}`;
  }
  return `${prefix}${routePath}`;
}

function loadActualRoutes() {
  const routes = new Set<string>();
  const excludedRoutes = new Set<string>();
  const unknownRouteFiles: string[] = [];

  for (const file of fs
    .readdirSync(ROUTES_DIR)
    .filter((entry) => entry.endsWith(".ts"))) {
    if (explicitOpenApiCoverageExclusions.has(file)) continue;
    const prefix = apiPrefixes[file];
    const source = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    if (!prefix) {
      if (ROUTER_METHOD_PATTERN.test(source)) {
        unknownRouteFiles.push(file);
      }
      continue;
    }

    for (const match of source.matchAll(ROUTE_LITERAL_PATTERN)) {
      const method = match[1].toUpperCase();
      const routePath = match[2];
      const operation = `${method} ${normalizeExpressPath(resolveMountedPath(file, prefix, routePath))}`;
      if (explicitOpenApiOperationCoverageExclusions.has(operation)) {
        excludedRoutes.add(operation);
      } else {
        routes.add(operation);
      }
    }

    if (
      file === "companies.ts" &&
      source.includes("router.post(COMPANY_IMPORT_ROUTE_PATH")
    ) {
      routes.add("POST /api/companies/import");
    }
    if (
      file === "companies.ts" &&
      source.includes("router.post(COMPANY_IMPORT_TRANSFERS_ROUTE_PATH")
    ) {
      routes.add(`POST /api/companies${COMPANY_IMPORT_TRANSFERS_ROUTE_PATH}`);
    }
  }

  return {
    routes,
    excludedRoutes,
    unknownRouteFiles: unknownRouteFiles.sort(),
  };
}

function loadSpecRoutes() {
  const spec = buildOpenApiSpec();
  const routes = new Set<string>();

  for (const [routePath, pathItem] of Object.entries<
    Record<string, Record<string, unknown>>
  >(spec.paths ?? {})) {
    for (const method of Object.keys(pathItem)) {
      if (HTTP_METHODS.has(method)) {
        routes.add(`${method.toUpperCase()} ${routePath}`);
      }
    }
  }

  return { spec, routes };
}

describe("openapi routes", () => {
  it("documents exact failed-run selection and durable accepted retry responses", async () => {
    const res = await request(createApp()).get("/api/openapi.json");
    const wake = res.body.paths["/api/agents/{id}/wakeup"].post;
    expect(
      wake.requestBody.content["application/json"].schema.properties
        .failedRunId,
    ).toMatchObject({ type: "string", format: "uuid" });
    expect(wake.responses["202"]).toBeDefined();
    expect(wake.responses["409"]).toBeDefined();
    expect(wake.description).toContain("durable queued/deferred receipt");
  });
  it("serves the generated OpenAPI document", async () => {
    const res = await request(createApp()).get("/api/openapi.json");

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.0.0");
    expect(res.body.info.title).toBe("Paperclip API");
    expect(res.body.paths["/api/openapi.json"].get.summary).toBe(
      "Get the generated OpenAPI document",
    );
    expect(
      res.body.paths["/api/companies/{companyId}/agents"].get.summary,
    ).toBe("List agents in a company");
    expect(res.body.paths["/api/agents/{id}/keys"].post.summary).toBe(
      "Create an agent API key",
    );
    expect(res.body.components.securitySchemes).toMatchObject({
      BoardSessionAuth: { type: "apiKey", in: "cookie" },
      BoardApiKeyAuth: { type: "http", scheme: "bearer" },
      AgentBearerAuth: { type: "http", scheme: "bearer" },
    });
    expect(res.body.paths["/api/health"].get.security).toEqual([]);
    expect(
      res.body.paths["/mcp/gateways/{gatewayPublicId}"].post.security,
    ).toEqual([]);
    expect(
      res.body.paths["/api/mcp/gateways/{gatewayPublicId}"],
    ).toBeUndefined();
    expect(res.body.paths["/api/companies"].get.parameters).toContainEqual({
      name: "scope",
      in: "query",
      required: false,
      schema: { type: "string", enum: ["accessible"] },
    });
    expect(res.body.paths["/api/companies"].get.responses["403"]).toBeDefined();
    expect(res.body.paths["/api/companies"].get.responses["400"]).toBeDefined();
    expect(
      res.body.paths["/api/companies"].post.responses["201"],
    ).toBeDefined();
    expect(
      res.body.paths["/api/companies"].post.requestBody.content[
        "application/json"
      ].schema,
    ).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
      },
      required: ["name"],
    });
    expect(
      JSON.stringify(res.body.paths["/api/companies"].post.responses),
    ).not.toContain("candidates");
    expect(
      res.body.paths["/api/companies/{companyId}/skills/scan-projects"].post
        .responses["200"].content["application/json"].schema,
    ).toMatchObject({
      type: "object",
      properties: {
        candidates: { type: "array" },
      },
      required: expect.arrayContaining(["candidates"]),
    });
    expect(
      res.body.paths["/api/agents/{id}/keys"].post.requestBody.content[
        "application/json"
      ].schema,
    ).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
      },
    });
    expect(
      res.body.paths["/api/companies/{companyId}/folders"].post.responses[
        "201"
      ],
    ).toBeDefined();
    expect(
      Object.keys(
        res.body.paths[
          "/api/issues/{id}/work-products/{workProductId}/review-document"
        ].post.responses,
      ).sort(),
    ).toEqual(["200", "201", "401", "403", "404", "409", "413", "415", "422"]);
    expect(
      res.body.paths["/api/issues/{id}/interactions/{interactionId}/withdraw"]
        .post.summary,
    ).toBe("Withdraw a pending issue thread interaction");
    const createInteraction =
      res.body.paths["/api/issues/{id}/interactions"].post;
    expect(createInteraction.description).toContain(
      "defaults to canonical `anyone`",
    );
    const createInteractionSchema = JSON.stringify(
      createInteraction.requestBody.content["application/json"].schema,
    );
    for (const resolverPolicy of [
      "anyone",
      "not_creator",
      "human_only",
      "board_or_agents",
      "board_only",
    ]) {
      expect(createInteractionSchema).toContain(`\"${resolverPolicy}\"`);
    }
    expect(
      res.body.paths["/api/companies/{companyId}/folders/items/move"].post
        .summary,
    ).toBe("Move an item into or out of a folder");
    const createQueue =
      res.body.paths["/api/companies/{companyId}/decision-queues"].post;
    expect(createQueue.security).toContainEqual({ AgentBearerAuth: [] });
    expect(createQueue.responses["200"]).toBeDefined();
    expect(createQueue.responses["201"]).toBeDefined();
    expect(
      createQueue.requestBody.content["application/json"].schema,
    ).toMatchObject({
      type: "object",
      properties: {
        key: { type: "string", minLength: 1, maxLength: 80 },
        title: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["key", "title"],
    });
    const updateTriage =
      res.body.paths[
        "/api/companies/{companyId}/decision-triage/{sourceKind}/{sourceId}"
      ].put;
    expect(updateTriage.responses["422"]).toBeDefined();
    expect(
      updateTriage.requestBody.content["application/json"].schema.properties,
    ).toMatchObject({
      decideBy: { nullable: true },
      snoozedUntil: { type: "string", format: "date-time", nullable: true },
    });
    expect(JSON.stringify(res.body.paths["/api/tool-gateway/tools"].get)).not.toContain("sessionToken");
    expect(JSON.stringify(res.body.paths["/api/tool-gateway/tools/call"].post)).not.toContain("sessionToken");
    expect(res.body.paths["/api/issues/{id}/interactions/{interactionId}/withdraw"]).toBeDefined();
    expect(res.body.paths["/api/issues/{id}/interactions/{interactionId}/withdraw"].post.summary).toBe(
      "Withdraw a pending issue thread interaction",
    );
    expect(res.body.paths["/api/issues/{id}/interactions/{interactionId}/withdraw"].post.responses["409"]).toBeDefined();
    expect(res.body.paths["/api/issues/{id}/interactions/{interactionId}/withdraw"].post.responses["403"]).toBeDefined();
  });

  it("publishes the complete board contract for chat channels", () => {
    const { spec } = loadSpecRoutes();
    const boardSecurity = [{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }];
    const operations = [
      ["get", "/api/companies/{companyId}/chat-endpoints"],
      ["post", "/api/companies/{companyId}/chat-endpoints"],
      ["get", "/api/chat-endpoints/{endpointId}"],
      ["patch", "/api/chat-endpoints/{endpointId}"],
      ["post", "/api/chat-endpoints/{endpointId}/setup"],
      ["post", "/api/chat-endpoints/{endpointId}/setup-secret"],
      ["post", "/api/chat-endpoints/{endpointId}/test"],
      ["get", "/api/chat-endpoints/{endpointId}/resources"],
      ["put", "/api/chat-endpoints/{endpointId}/resources"],
      ["get", "/api/chat-endpoints/{endpointId}/principals"],
      [
        "post",
        "/api/chat-endpoints/{endpointId}/principals/{principalId}/link-intent",
      ],
      [
        "delete",
        "/api/chat-endpoints/{endpointId}/principals/{principalId}/link",
      ],
      ["get", "/api/chat-identity-links/preview"],
      ["post", "/api/chat-identity-links/confirm"],
      ["get", "/api/chat-endpoints/{endpointId}/conversations"],
      ["get", "/api/chat-endpoints/{endpointId}/activity"],
      [
        "post",
        "/api/chat-endpoints/{endpointId}/deliveries/{deliveryId}/replay",
      ],
      [
        "post",
        "/api/chat-endpoints/{endpointId}/publications/{publicationId}/replay",
      ],
      [
        "post",
        "/api/chat-endpoints/{endpointId}/publications/{publicationId}/resolve",
      ],
      ["post", "/api/chat-endpoints/{endpointId}/actions/{actionId}/resolve"],
      [
        "post",
        "/api/chat-endpoints/{endpointId}/conversations/{conversationId}/publications",
      ],
      ["get", "/api/issues/{issueId}/chat-binding"],
      [
        "get",
        "/api/chat-endpoints/{endpointId}/conversations/{conversationId}/publications/{publicationId}/status",
      ],
    ] as const;

    for (const [method, routePath] of operations) {
      const operation = spec.paths[routePath]?.[method];
      expect(
        operation,
        `${method.toUpperCase()} ${routePath} is documented`,
      ).toBeDefined();
      expect(
        operation.security,
        `${method.toUpperCase()} ${routePath} is board-only`,
      ).toEqual(boardSecurity);
      expect(operation["x-paperclip-authorization"]).toEqual({
        actor: "board",
      });
      expect(operation.tags).toContain("chat-channels");
    }

    const create = spec.paths["/api/companies/{companyId}/chat-endpoints"].post;
    expect(create.responses["201"]).toBeDefined();
    expect(create.requestBody.content["application/json"].schema).toMatchObject(
      {
        type: "object",
        additionalProperties: false,
        properties: {
          provider: {
            type: "string",
            enum: ["slack", "github", "discord", "microsoft-teams", "telegram"],
          },
          assignedAgentId: { type: "string", format: "uuid" },
        },
        required: ["provider", "assignedAgentId"],
      },
    );

    const endpointResponse =
      spec.paths["/api/chat-endpoints/{endpointId}"].get.responses["200"]
        .content["application/json"].schema;
    expect(endpointResponse).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        assignedAgentId: { type: "string", format: "uuid" },
        status: {
          type: "string",
          enum: [
            "draft",
            "verifying",
            "active",
            "paused",
            "attention",
            "revoked",
            "archived",
          ],
        },
        capabilities: { type: "object", additionalProperties: false },
        setup: { type: "object", additionalProperties: false },
      },
    });
    expect(JSON.stringify(endpointResponse)).not.toContain("credentials");
    expect(JSON.stringify(endpointResponse)).not.toContain("privateKey");
    expect(JSON.stringify(endpointResponse)).not.toContain("signingSecret");
    expect(
      endpointResponse.properties.setup.properties.callbacksNeedUpdate,
    ).toEqual({ type: "boolean" });
    expect(
      endpointResponse.properties.setup.properties.callbackSurfaces.properties
        .events.properties.status.enum,
    ).toEqual(["current", "stale", "unverified"]);

    const setup = spec.paths["/api/chat-endpoints/{endpointId}/setup"].post;
    expect(
      setup.requestBody.content["application/json"].schema.properties.action
        .enum,
    ).toEqual([
      "configure",
      "verify",
      "pause",
      "resume",
      "reconnect",
      "remove",
    ]);
    expect(setup.description).toContain(
      "Discord: `applicationId`, `guildId`, `botToken`",
    );
    expect(setup.responses["409"]).toBeDefined();
    expect(setup.responses["422"]).toBeDefined();

    const setupSecret =
      spec.paths["/api/chat-endpoints/{endpointId}/setup-secret"].post;
    expect(
      setupSecret.responses["201"].content["application/json"].schema,
    ).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["webhookSecret"],
    });
    expect(setupSecret.responses["409"]).toBeDefined();
    expect(setupSecret.responses["422"]).toBeDefined();

    const resolveAction =
      spec.paths["/api/chat-endpoints/{endpointId}/actions/{actionId}/resolve"]
        .post;
    expect(
      resolveAction.requestBody.content["application/json"].schema.properties
        .action.enum,
    ).toEqual(["mark_delivered", "retry_anyway", "cancel"]);
    expect(resolveAction.responses["409"]).toBeDefined();
    expect(resolveAction.responses["422"]).toBeDefined();

    const activity =
      spec.paths["/api/chat-endpoints/{endpointId}/activity"].get.responses[
        "200"
      ].content["application/json"].schema.items;
    expect(activity.properties.actionType.enum).toEqual([
      "slash_task_start",
      "provider_effect",
      "github_webhook_ingress",
      "slack_session_sync",
      "slack_session_stop",
    ]);
    const fileTransfer = activity.properties.fileTransfer;
    expect(fileTransfer).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["provider", "phase", "filename", "version"],
      properties: {
        provider: { type: "string", enum: ["microsoft-teams"] },
        version: { type: "integer", minimum: 0, exclusiveMinimum: true },
      },
    });
    expect(Object.keys(fileTransfer.properties).sort()).toEqual([
      "expiresAt",
      "filename",
      "phase",
      "provider",
      "version",
    ]);
    expect(fileTransfer.properties.phase.enum).toHaveLength(15);
    const boardSend =
      spec.paths[
        "/api/chat-endpoints/{endpointId}/conversations/{conversationId}/publications"
      ].post;
    expect(boardSend.responses["409"]).toBeDefined();
    expect(boardSend.responses["422"]).toBeDefined();
    expect(boardSend.description).toContain(
      "chat_board_send_attachments_already_bound",
    );
    expect(boardSend.description).toContain(
      "Other errors do not establish non-delivery",
    );
    const batchStatus =
      spec.paths[
        "/api/chat-endpoints/{endpointId}/conversations/{conversationId}/publications/{publicationId}/status"
      ].get.responses["200"].content["application/json"].schema;
    expect(batchStatus.required).toEqual(
      expect.arrayContaining([
        "publication",
        "parts",
        "total",
        "published",
        "awaitingConsent",
        "declined",
        "expired",
        "cancelled",
        "settled",
        "canDismiss",
      ]),
    );
    expect(batchStatus.properties.parts.items.properties.fileTransfer).toEqual(
      fileTransfer,
    );
    expect(batchStatus.properties.publication.properties.state.enum).toContain(
      "awaiting_consent",
    );
    const resolvePublication =
      spec.paths[
        "/api/chat-endpoints/{endpointId}/publications/{publicationId}/resolve"
      ].post.requestBody.content["application/json"].schema;
    expect(resolvePublication.properties.fileTransfer).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["phase", "version"],
      properties: {
        phase: { enum: fileTransfer.properties.phase.enum },
        version: { type: "integer", minimum: 0, exclusiveMinimum: true },
      },
    });
    expect(JSON.stringify(batchStatus)).not.toMatch(
      /uploadUrl|privateState|tokenSha256|credentialFingerprint/,
    );

    const replaceResources =
      spec.paths["/api/chat-endpoints/{endpointId}/resources"].put;
    expect(
      replaceResources.requestBody.content["application/json"].schema,
    ).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["resources"],
    });
    expect(replaceResources.responses["409"]).toBeDefined();
    expect(replaceResources.responses["422"]).toBeDefined();

    expect(
      spec.paths[
        "/api/chat-endpoints/{endpointId}/principals/{principalId}/link"
      ].delete.responses["204"],
    ).toBeDefined();
    expect(
      spec.paths[
        "/api/chat-endpoints/{endpointId}/deliveries/{deliveryId}/replay"
      ].post.responses["204"],
    ).toBeDefined();
    expect(
      spec.paths[
        "/api/chat-endpoints/{endpointId}/publications/{publicationId}/replay"
      ].post.responses["204"],
    ).toBeDefined();

    const endpointScopedOperations = operations.filter(
      ([, routePath]) =>
        routePath.includes("{endpointId}") ||
        routePath === "/api/issues/{issueId}/chat-binding",
    );
    for (const [method, routePath] of endpointScopedOperations) {
      expect(
        spec.paths[routePath][method].responses["404"],
        `${method.toUpperCase()} ${routePath} preserves the non-member 404 boundary`,
      ).toBeDefined();
    }

    expect(
      spec.paths["/api/chat-webhooks/{publicId}/{provider}"],
    ).toBeUndefined();
  });

  it("covers the mounted server routes exactly", () => {
    const {
      routes: actualRoutes,
      excludedRoutes,
      unknownRouteFiles,
    } = loadActualRoutes();
    const { routes: specRoutes } = loadSpecRoutes();

    const missingInSpec = [...actualRoutes]
      .filter((route) => !specRoutes.has(route))
      .sort();
    const extraInSpec = [...specRoutes]
      .filter(
        (route) =>
          !actualRoutes.has(route) && !specOnlyContractFirstRoutes.has(route),
      )
      .sort();

    expect({
      unknownRouteFiles,
      missingInSpec,
      extraInSpec,
      excludedRoutes: [...excludedRoutes].sort(),
    }).toEqual({
      unknownRouteFiles: [],
      missingInSpec: [],
      extraInSpec: [],
      excludedRoutes: [...explicitOpenApiOperationCoverageExclusions].sort(),
    });
  });

  it("documents the installation-token permissions body schema with parity to the runtime", () => {
    const { spec } = loadSpecRoutes();
    const body = spec.paths["/api/agents/me/github/installation-tokens"].post.requestBody.content[
      "application/json"
    ].schema;

    expect(body.properties.owner).toEqual({ type: "string", minLength: 1 });
    expect(body.properties.repo).toEqual({ type: "string", minLength: 1 });
    expect(body.required).toEqual(["owner", "repo"]);

    const permissions = body.properties.permissions;
    // The permission key set is a constrained object, not a free-form record: a
    // typo'd name is rejected at the boundary rather than minted as a 502.
    expect(permissions.type).toBe("object");
    expect(permissions.additionalProperties).toBe(false);

    // Parity: the documented key set and per-key value enum match the runtime
    // schema exactly, so the published contract and the runtime cannot drift.
    const runtimeLevels = [...GITHUB_INSTALLATION_PERMISSION_LEVELS];
    expect(Object.keys(permissions.properties).sort()).toEqual(
      [...GITHUB_INSTALLATION_PERMISSION_NAMES].sort(),
    );
    for (const [name, value] of Object.entries(
      permissions.properties as Record<string, { enum?: unknown[] }>,
    )) {
      expect(value.enum, `permissions.${name} value enum`).toEqual(runtimeLevels);
    }
  });

  it("documents board-only repository discovery and selection", () => {
    const { spec } = loadSpecRoutes();
    const discovery = spec.paths["/api/companies/{companyId}/project-repositories"].get;
    const replacement = spec.paths["/api/projects/{id}/repositories"].put;
    for (const operation of [discovery, replacement]) {
      expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board" });
      expect(operation.security).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    }
    expect(replacement.requestBody.content["application/json"].schema.required).toContain("repositoryIds");
    expect(replacement.responses["422"]).toBeDefined();
  });

  it("documents auth and reviewed response-code invariants", () => {
    const { spec } = loadSpecRoutes();

    expect(spec.paths["/api/openapi.json"].get.security).toEqual([]);
    expect(
      spec.paths["/runtime-tools/github/credentials"].post.security,
    ).toEqual([{ RuntimeToolsBearerAuth: [] }]);
    expect(spec.paths["/api/plugins/install"].post.security).toEqual([
      { BoardSessionAuth: [] },
      { BoardApiKeyAuth: [] },
    ]);
    expect(
      spec.paths["/api/plugins/install"].post["x-paperclip-authorization"],
    ).toEqual({
      actor: "board",
      instanceAdmin: true,
    });
    expect(
      spec.paths["/api/execution-workspaces/{id}/reconcile-branch"].post
        .security,
    ).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    expect(
      spec.paths["/api/execution-workspaces/{id}/reconcile-branch"].post[
        "x-paperclip-authorization"
      ],
    ).toEqual({
      actor: "board",
    });
    expect(
      spec.paths["/api/companies/{companyId}/cost-events"].post.responses[
        "201"
      ],
    ).toBeDefined();
    expect(
      spec.paths["/api/companies/{companyId}/cost-events"].post.responses[
        "403"
      ],
    ).toBeDefined();
    expect(
      spec.paths["/api/companies/{companyId}/managed-agent-profiles"].post
        .security,
    ).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    expect(
      spec.paths["/api/companies/{companyId}/remote-agent-profiles"].get
        .security,
    ).toEqual([{ BoardSessionAuth: [] }, { BoardApiKeyAuth: [] }]);
    const remoteAgentProfileBody =
      spec.paths["/api/companies/{companyId}/remote-agent-profiles"].post
        .requestBody.content["application/json"].schema;
    expect(remoteAgentProfileBody.properties.service).toMatchObject({
      type: "string",
      enum: ["aws_bedrock_agentcore_harness"],
    });
    expect(
      remoteAgentProfileBody.properties.credentialSecretId,
    ).toBeUndefined();
    expect(
      spec.paths["/api/instance/database-backups"].post.responses["201"],
    ).toBeDefined();
    expect(
      spec.paths["/api/invites/{token}/accept"].post.responses["202"],
    ).toBeDefined();
    expect(
      spec.paths["/api/board-api-keys"].post.responses["201"],
    ).toBeDefined();
    expect(
      spec.paths["/api/companies/import"].post.responses["202"],
    ).toBeDefined();
    expect(
      spec.paths["/api/routines/{id}/run"].post.responses["422"],
    ).toBeDefined();
  });

  it("documents the company stuck-external-object read with company-access (not board-only) auth", () => {
    const { spec } = loadSpecRoutes();
    const operation = spec.paths["/api/companies/{companyId}/external-objects/stuck"].get;

    expect(operation, "GET /api/companies/{companyId}/external-objects/stuck is registered").toBeDefined();
    expect(
      operation.parameters.some((p: { name: string; in: string }) => p.name === "companyId" && p.in === "path"),
    ).toBe(true);
    // The handler calls assertCompanyAccess (not assertBoard), so the document must
    // publish the company-access actor (board_or_agent, AgentBearerAuth offered)
    // rather than board-only metadata.
    expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board_or_agent" });
    expect(operation.security.some((req: Record<string, unknown>) => "AgentBearerAuth" in req)).toBe(true);
    expect(operation.responses["200"]).toBeDefined();
    expect(operation.responses["401"]).toBeDefined();
    expect(operation.responses["403"]).toBeDefined();
  });

  it("publishes the Claude browser-code grammar and strict setup-token response shapes", () => {
    const { spec } = loadSpecRoutes();
    const base = "/api/companies/{companyId}/setup-token-login-sessions";

    // The submitted browser code carries the bounded printable-ASCII grammar.
    const codeBody =
      spec.paths[`${base}/{sessionId}/code`].post.requestBody.content[
        "application/json"
      ].schema;
    const browserCode = codeBody.properties.browserCode;
    expect(browserCode.minLength).toBe(1);
    expect(browserCode.maxLength).toBe(512);
    expect(typeof browserCode.pattern).toBe("string");
    expect(browserCode.pattern.length).toBeGreaterThan(0);

    // Every Claude request object forbids an unknown property.
    const startBody =
      spec.paths[base].post.requestBody.content["application/json"].schema;
    expect(startBody.additionalProperties).toBe(false);
    expect(codeBody.additionalProperties).toBe(false);

    // The four contract-first routes carry typed strict response schemas.
    const responseSchemas: Record<string, Record<string, unknown>> = {
      start:
        spec.paths[base].post.responses["201"].content["application/json"]
          .schema,
      status:
        spec.paths[`${base}/{sessionId}`].get.responses["200"].content[
          "application/json"
        ].schema,
      prompt:
        spec.paths[`${base}/{sessionId}/prompt`].get.responses["200"].content[
          "application/json"
        ].schema,
      code: spec.paths[`${base}/{sessionId}/code`].post.responses["200"]
        .content["application/json"].schema,
    };
    const forbiddenProperties = ["token", "accountId", "leaseId"];
    for (const [name, schema] of Object.entries(responseSchemas)) {
      expect(schema.type, `${name} response is a typed object`).toBe("object");
      expect(schema.additionalProperties, `${name} response is strict`).toBe(
        false,
      );
      const properties = (schema.properties ?? {}) as Record<string, unknown>;
      expect(
        Object.keys(properties).length,
        `${name} response lists properties`,
      ).toBeGreaterThan(0);
      for (const forbidden of forbiddenProperties) {
        expect(
          properties[forbidden],
          `${name} response hides ${forbidden}`,
        ).toBeUndefined();
      }
      // No property name looks like a raw prompt secret or a token.
      for (const property of Object.keys(properties)) {
        expect(
          /token|secret|accountId|leaseId/i.test(property),
          `${name}.${property} is not secret-adjacent`,
        ).toBe(false);
      }
    }

    // The status and code routes share the public response; it hides the prompt.
    expect(responseSchemas.status.properties).toEqual(
      responseSchemas.code.properties,
    );
    expect(
      (responseSchemas.status.properties as Record<string, unknown>).prompt,
    ).toBeUndefined();
    // The owner start response adds the panel mode and the one-time prompt.
    expect(
      (responseSchemas.start.properties as Record<string, unknown>).panelMode,
    ).toBeDefined();
    expect(
      (responseSchemas.start.properties as Record<string, unknown>).prompt,
    ).toBeDefined();
    // The prompt route returns the authorization URL and the optional transport
    // advisory. The advisory is present on a non-confidential transport, so the
    // client can show a non-blocking disclaimer.
    expect(
      Object.keys(responseSchemas.prompt.properties as Record<string, unknown>),
    ).toEqual(["authorizationUrl", "transportAdvisory"]);
  });

  it("documents the 404 non-member gate on the Claude setup-token cancel route", () => {
    const { spec } = loadSpecRoutes();
    const cancel =
      spec.paths[
        "/api/companies/{companyId}/setup-token-login-sessions/{sessionId}/cancel"
      ].post;
    // The 404 is reachable at run time. The company-access gate returns a fixed
    // 404 for a non-member before the cancel logic runs, so the spec declares
    // it. The idempotent cancel still returns 200 for an owner-scoped missing,
    // terminal, or foreign session id.
    const codes = Object.keys(cancel.responses).sort();
    expect(codes).toEqual(["200", "401", "403", "404"]);
  });

  it("imports no route-handler module (the heartbeat.ts cyclic-import guard)", () => {
    // SUP-16560. `openapi.ts` is reached from
    // services/native-runtime/runner-api-catalog.ts, and the route handlers
    // import services/heartbeat.ts, so a route-handler import here closes the
    // cycle heartbeat.ts -> native-runtime -> runner-api-catalog -> openapi.ts
    // -> route -> heartbeat.ts. Request schemas live in `*-schemas.ts` modules
    // so this file can publish the contract without importing a handler.
    const source = fs.readFileSync(path.join(ROUTES_DIR, "openapi.ts"), "utf8");
    const relativeImports = [...source.matchAll(/from\s+["']\.\/([^"']+)["']/g)].map(
      (match) => match[1].replace(/\.js$/, ".ts"),
    );
    const routeRegistrations = /\brouter\.(get|post|put|patch|delete|use)\(/;
    const handlerImports = relativeImports.filter((specifier) => {
      const target = path.join(ROUTES_DIR, specifier);
      return fs.existsSync(target) && routeRegistrations.test(fs.readFileSync(target, "utf8"));
    });
    expect(handlerImports, "openapi.ts must not import a route-handler module").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// OpenAPI auth-actor parity (SUP-14798)
//
// The published OpenAPI document is the channel agents are told to use for
// schema discovery, so it must agree with what each handler enforces. A route
// whose handler calls assertBoard / assertBoardOrgAccess / assertInstanceAdmin
// must publish actor `board` (never `board_or_agent`) and must not offer
// AgentBearerAuth. The expected actor is derived from the handler's assert*
// helper rather than from openapi.ts's hand-maintained allowlist, so a
// board-only route added without an allowlist entry fails below.
// ---------------------------------------------------------------------------

const AGENT_BEARER = "AgentBearerAuth";
// The two board-only schemes. A route that additionally offers AgentBearerAuth is
// agent-callable and must NOT be used for a board/instance-admin route.
const BOARD_SECURITY = [
  { BoardSessionAuth: [] },
  { BoardApiKeyAuth: [] },
];

// The 54 board-only routes named by SUP-14798 (handler calls assertBoard /
// assertBoardOrgAccess). Kept as an explicit, named closure so the set is
// auditable ("closed, not sampled").
const ISSUE_BOARD_ROUTES = [
  "POST /api/companies/{companyId}/activity",
  "GET /api/adapters",
  "GET /api/adapters/{type}",
  "GET /api/adapters/{type}/config-schema",
  "GET /api/adapters/{type}/ui-parser.js",
  "DELETE /api/agents/{id}",
  "DELETE /api/agents/{id}/keys/{keyId}",
  "GET /api/agents/{id}/keys",
  "GET /api/agents/{id}/runtime-state",
  "GET /api/agents/{id}/task-sessions",
  "POST /api/agents/{id}/approve",
  "POST /api/agents/{id}/claude-login",
  "POST /api/agents/{id}/clear-error",
  "POST /api/agents/{id}/keys",
  "POST /api/agents/{id}/pause",
  "POST /api/agents/{id}/runtime-state/reset-session",
  "POST /api/agents/{id}/terminate",
  "POST /api/heartbeat-runs/{runId}/cancel",
  "POST /api/approvals/{id}/approve",
  "POST /api/approvals/{id}/reject",
  "POST /api/approvals/{id}/request-revision",
  "GET /api/companies/{companyId}/attention",
  "GET /api/companies/{companyId}/costs/quota-windows",
  "PATCH /api/agents/{agentId}/budgets",
  "PATCH /api/companies/{companyId}/budgets",
  "POST /api/companies/{companyId}/budget-incidents/{incidentId}/resolve",
  "POST /api/companies/{companyId}/budgets/policies",
  "POST /api/companies/{companyId}/finance-events",
  "GET /api/companies/{companyId}/decision-training",
  "GET /api/companies/{companyId}/decision-training/export.jsonl",
  "GET /api/decision-training/{id}",
  "GET /api/companies/{companyId}/decisions",
  "GET /api/issues/{id}/tree-control/state",
  "GET /api/issues/{id}/tree-holds",
  "GET /api/issues/{id}/tree-holds/{holdId}",
  "POST /api/issues/{id}/tree-control/preview",
  "POST /api/issues/{id}/tree-holds",
  "POST /api/issues/{id}/tree-holds/{holdId}/release",
  "POST /api/issues/{id}/interactions",
  "POST /api/issues/{id}/interactions/{interactionId}/cancel",
  "POST /api/issues/{id}/recovery-actions/resolve",
  "POST /api/issues/{id}/scheduled-retry/retry-now",
  "POST /api/issues/{id}/stalled-review-decision",
  "DELETE /api/secrets/{id}",
  "GET /api/companies/{companyId}/secret-proposals",
  "GET /api/companies/{companyId}/secret-providers",
  "GET /api/companies/{companyId}/secrets",
  "PATCH /api/secrets/{id}",
  "POST /api/companies/{companyId}/secret-proposals/{id}/reject",
  "POST /api/secrets/{id}/rotate",
  "GET /api/tool-connections/{connectionId}/installs",
  "PUT /api/tool-connections/{connectionId}/installs",
  "GET /api/tool-gateway/audit",
  "GET /api/tool-gateway/runtime-slots",
];

// The 7 instance-admin routes named by SUP-14798 (handler calls assertInstanceAdmin).
const ISSUE_INSTANCE_ADMIN_ROUTES = [
  "POST /api/invites/{inviteId}/revoke",
  "DELETE /api/adapters/{type}",
  "PATCH /api/adapters/{type}",
  "PATCH /api/adapters/{type}/override",
  "POST /api/adapters/install",
  "POST /api/adapters/{type}/reinstall",
  "POST /api/adapters/{type}/reload",
];

// 10 additional board-only routes the regression guard + reviewer live-probe
// surfaced while writing the 54 above: same defect (assertBoard handler,
// published agent-callable), all in companies.ts. The two bare-constant import
// routes were only catchable once the scanner resolved unquoted path constants.
// Closed alongside the ticket's routes so the guard stays green.
const DISCOVERED_BOARD_ROUTES = [
  "GET /api/companies/{companyId}/feedback-traces",
  "POST /api/companies/import",
  "POST /api/companies/import/preview",
  "POST /api/companies/import/transfers",
  "POST /api/companies/{companyId}/archive",
  "DELETE /api/companies/{companyId}",
  "PUT /api/companies/import/transfers/{transferId}/parts/{partIndex}",
  "GET /api/companies/import/transfers/{transferId}",
  "POST /api/companies/import/transfers/{transferId}/preview",
  "POST /api/companies/import/transfers/{transferId}/apply",
];

// SUP-16341: 38 board-reject-guard routes the extended detector surfaced as
// mis-published (agent-callable in the spec) across access/agents/built-in-
// agents/decision-training/environments/issues/folders/inbox-agent-policy/
// inbox-dismissals. Kept as a separate array (mirrors the
// BOARD_ONLY_OPERATIONS block in openapi.ts) so the per-route parity
// assertions below cover them alongside the regression-guard sweep. The
// summary-slot /generate route was already corrected by SUP-16339 and is not
// duplicated here.
const SUP16341_BOARD_ROUTES = [
  "POST /api/cli-auth/challenges/{id}/approve",
  "POST /api/cli-auth/revoke-current",
  "PATCH /api/agents/{id}/instructions-path",
  "POST /api/companies/{companyId}/built-in-agents/{key}/routines/{routineKey}/enable",
  "POST /api/companies/{companyId}/built-in-agents/{key}/routines/{routineKey}/disable",
  "POST /api/companies/{companyId}/built-in-agents/{key}/routines/{routineKey}/run",
  "POST /api/companies/{companyId}/decision-training",
  "POST /api/companies/{companyId}/decision-training/preview",
  "PATCH /api/decision-training/{id}",
  "DELETE /api/decision-training/{id}",
  "GET /api/environments/{environmentId}/custom-image-template",
  "DELETE /api/environments/{environmentId}/custom-image-template",
  "POST /api/environments/{environmentId}/custom-image-setup-sessions",
  "POST /api/environments/{environmentId}/custom-image-template/relink",
  "POST /api/environments/{environmentId}/custom-image-template/rollback",
  "GET /api/environments/{id}/delete-blast-radius",
  "GET /api/environments/{id}/secret-refs",
  "POST /api/environments/{id}/probe",
  "POST /api/companies/{companyId}/environments/probe-config",
  "GET /api/environment-custom-image-setup-sessions/{sessionId}",
  "POST /api/environment-custom-image-setup-sessions/{sessionId}/cancel",
  "POST /api/environment-custom-image-setup-sessions/{sessionId}/finish",
  "POST /api/environment-custom-image-setup-sessions/{sessionId}/terminal-session-token",
  "DELETE /api/issues/{id}/read",
  "POST /api/issues/{id}/read",
  "GET /api/issues/{id}/feedback-votes",
  "GET /api/issues/{id}/feedback-traces",
  "GET /api/feedback-traces/{traceId}",
  "GET /api/feedback-traces/{traceId}/bundle",
  "POST /api/issues/{id}/admin/force-release",
  "POST /api/issues/{id}/documents/{key}/lock",
  "POST /api/issues/{id}/documents/{key}/unlock",
  "POST /api/companies/{companyId}/inbox-dismissals",
  "GET /api/companies/{companyId}/inbox-dismissals",
  "DELETE /api/companies/{companyId}/inbox-dismissals/{itemKey}",
  "GET /api/companies/{companyId}/users/me/inbox-agent-policy",
  "PUT /api/companies/{companyId}/users/me/inbox-agent-policy",
  "POST /api/companies/{companyId}/folders/ensure-my",
];

const BOARD_ROUTES = [...ISSUE_BOARD_ROUTES, ...DISCOVERED_BOARD_ROUTES, ...SUP16341_BOARD_ROUTES];
const INSTANCE_ADMIN_ROUTES = ISSUE_INSTANCE_ADMIN_ROUTES;

// A route registration line: `router.<method>(` (path may be on this line or the
// next, for multi-line registrations).
const ROUTE_BOUNDARY = /^\s{0,2}router\.(get|post|put|patch|delete|all)\(/;
const FIRST_QUOTED_TOKEN = /(["'`])(.+?)\1/;
// A `router.<method>(IDENT, …)` registration whose path is an unquoted constant.
// The quoted-token scan cannot see these, so they must be resolved explicitly or
// surfaced — never silently skipped (AC #2/#3: "fail loudly, never silently skip").
const BARE_PATH_ARG = /router\.(get|post|put|patch|delete|all)\(\s*([A-Za-z_$][A-Za-z0-9_$]*)/;
// Known unquoted path constants. Values come from the shared/route modules so the
// map can never drift from what the handler actually mounts.
const BARE_PATH_CONSTANTS: Record<string, string> = {
  COMPANY_IMPORT_ROUTE_PATH: COMPANY_IMPORT_ROUTE_PATH,
  COMPANY_IMPORT_TRANSFERS_ROUTE_PATH: COMPANY_IMPORT_TRANSFERS_ROUTE_PATH,
  // The values here are mount-relative. This constant is absolute and its
  // registration strips the prefix inline
  // (`router.get(OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH.replace(/^\/api/, ""))`),
  // so mirror that strip rather than hardcoding the stripped literal.
  OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH:
    OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH.replace(/^\/api/, ""),
};

// Strip `if (req.actor.type !== "agent") { ... }` blocks: an assertBoard inside
// such a guard only applies to board actors (agents are allowed through), so it
// does not make the route board-only.
//
// Both spellings of the guarded body must be stripped. The braced form is the
// fork's original; upstream's `POST /api/issues/{id}/runner-goal/actions`
// (#13239) writes the brace-less single-statement form
// `if (req.actor.type !== "agent") assertBoard(req);`, which the braced-only
// pattern missed — the regression guard below then reported that route as a
// board-only handler published as "board_or_agent", which is a false positive:
// the handler does admit agents. Recognising the spelling keeps SUP-14798's
// rule intact rather than allowlisting the route past it. The brace-less arm
// consumes exactly one statement (to end of line), so it cannot swallow a real
// unguarded assertion on a later line.
const AGENT_ALLOW_GUARD =
  /if\s*\(\s*req\.actor\.type\s*!==\s*["'`]agent["'`]\s*\)\s*(?:\{[\s\S]*?\n\s*\}|[^\n{][^\n]*)/g;
const IA_ASSERT = /assertInstanceAdmin\s*\(/;
const BOARD_ASSERT = /assertBoard\s*\(|assertBoardOrgAccess\s*\(/;

type AuthBlock = { file: string; text: string };

function leadingSpaces(line: string): number {
  const m = line.match(/^\s*/);
  return m ? m[0].length : 0;
}

// Resolve the OpenAPI route for a registration that may span a few lines. The
// path literal may sit on the registration line itself or on one of the next
// two lines (multi-line registrations such as `router.post(\n "…", …)`).
function resolveAuthRoute(file: string, prefix: string, candidateLines: string[]): string | null {
  // Unquoted path constant (`router.post(COMPANY_IMPORT_ROUTE_PATH, …)`): the
  // quoted-token scan misses these, so resolve against the known map first.
  const bare = candidateLines[0]?.match(BARE_PATH_ARG);
  if (bare && bare[2] in BARE_PATH_CONSTANTS) {
    const raw = BARE_PATH_CONSTANTS[bare[2]];
    return `${bare[1].toUpperCase()} ${normalizeExpressPath(resolveMountedPath(file, prefix, raw))}`;
  }
  for (const line of candidateLines) {
    if (!line) continue;
    const m = line.match(FIRST_QUOTED_TOKEN);
    if (!m) continue;
    const raw = m[2];
    if (!(raw.startsWith("/") || raw.includes("${"))) continue;
    const normalized = normalizeExpressPath(resolveMountedPath(file, prefix, raw));
    const method = candidateLines[0]?.match(ROUTE_BOUNDARY)?.[1]?.toUpperCase();
    if (!method) return null;
    return `${method} ${normalized}`;
  }
  return null;
}

// Walk every route file and map each registration to the source text of its
// handler. Each block is bounded by the handler's closing `);`/`});`, so helper
// functions defined between routes do not bleed into a route's block.
function buildAuthRouteBlocks(): { byRoute: Map<string, AuthBlock>; unresolvedBareConstants: string[] } {
  const byRoute = new Map<string, AuthBlock>();
  const unresolvedBareConstants: string[] = [];
  const files = fs.readdirSync(ROUTES_DIR).filter((entry) => entry.endsWith(".ts"));

  for (const file of files) {
    const prefix = apiPrefixes[file];
    if (!prefix) continue;
    const lines = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8").split("\n");

    const boundaries = lines
      .map((line, idx) => (ROUTE_BOUNDARY.test(line) ? idx : -1))
      .filter((idx) => idx !== -1);

    boundaries.forEach((startIdx) => {
      const routeIndent = leadingSpaces(lines[startIdx]);
      let endIdx = startIdx + 1;
      while (endIdx < lines.length) {
        if (ROUTE_BOUNDARY.test(lines[endIdx])) break;
        const trimmed = lines[endIdx].trimEnd();
        if (leadingSpaces(lines[endIdx]) <= routeIndent && /\)\;|}\);/.test(trimmed)) break;
        endIdx += 1;
      }
      const bare = lines[startIdx].match(BARE_PATH_ARG);
      const route = resolveAuthRoute(file, prefix, [
        lines[startIdx],
        lines[startIdx + 1],
        lines[startIdx + 2],
      ]);
      const text = lines.slice(startIdx, endIdx).join("\n");
      if (route && !byRoute.has(route)) {
        byRoute.set(route, { file, text });
      } else if (bare && !(bare[2] in BARE_PATH_CONSTANTS)) {
        // A registration whose path is an unquoted constant we do not know. Skip
        // it silently and the guard cannot see a board-only handler behind it, so
        // surface it instead.
        unresolvedBareConstants.push(
          `${file} (line ${startIdx + 1}): router.${bare[1]}(${bare[2]}, …) — path constant not in BARE_PATH_CONSTANTS`,
        );
      }
    });
  }

  return { byRoute, unresolvedBareConstants };
}

// ── req.actor.type !== "board" reject-guard detection (SUP-16341) ──────────
//
// The SUP-14798 detector above only recognises the canonical
// assertBoard / assertBoardOrgAccess / assertInstanceAdmin helpers. A
// board-only route can instead reject non-board actors with
// `if (req.actor.type !== "board") { 403 }` — inline in the handler, or inside
// a same-file helper the handler calls (e.g. requireBoardUser in
// inbox-dismissals.ts). Neither is a base assert call, so the earlier detector
// returned null and the route published as board_or_agent + AgentBearerAuth.
//
// A *hard* board reject is one the route takes on every agent request: the
// `req.actor.type !== "board"` check sits at the top level of an `if`
// condition — as the whole clause or OR-ed onto it — and its then-branch halts
// the request (throw / 4xx response / return). A check AND-ed behind another
// condition (`x === "me" && req.actor.type !== "board"`) is a per-request
// filter, not a route-level guard, and `!== "board" && !== "agent"` lets
// agents through — so neither is a hard reject.

const BOARD_REJECT_NEEDLE = /req\.actor\.type\s*!==\s*["'`]board["'`]/g;

// Index of the paren that closes the paren opened at openIdx, or -1.
function matchingParen(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Index of the brace that closes the brace opened at openIdx, or -1.
function matchingBrace(text: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Paren depth at (not including) position pos.
function parenDepthUpTo(s: string, pos: number): number {
  let depth = 0;
  for (let i = 0; i < pos && i < s.length; i++) {
    if (s[i] === "(") depth += 1;
    else if (s[i] === ")") depth -= 1;
  }
  return depth;
}

// The `||`/`&&` that connects the current top-level clause to the one before it,
// scanning `s[0..pos)` at paren depth 0; null when the clause is the first.
function lastTopLevelOperatorBefore(s: string, pos: number): "||" | "&&" | null {
  let depth = 0;
  let lastOp: "||" | "&&" | null = null;
  for (let i = 0; i < pos; i++) {
    if (s[i] === "(") depth += 1;
    else if (s[i] === ")") depth -= 1;
    else if (depth === 0) {
      if (s.startsWith("||", i)) {
        lastOp = "||";
        i += 1;
      } else if (s.startsWith("&&", i)) {
        lastOp = "&&";
        i += 1;
      }
    }
  }
  return lastOp;
}

// True when `cond` has a top-level clause that is exactly
// `req.actor.type !== "board"` OR-ed in (or the sole clause). Such a clause is
// true for every agent, so the enclosing `if` rejects agents on every request.
function conditionIsHardBoardReject(cond: string): boolean {
  for (const m of cond.matchAll(BOARD_REJECT_NEEDLE)) {
    const pos = m.index ?? 0;
    if (parenDepthUpTo(cond, pos) !== 0) continue;
    const op = lastTopLevelOperatorBefore(cond, pos);
    if (op === null || op === "||") return true;
  }
  return false;
}

// The then-branch of `if (…)` at ifIndex: does it reject the request
// unconditionally? A genuine board reject sends a 4xx or throws directly. A bare
// `return` is not counted: from a helper it is a no-op that lets agents through
// (e.g. `assertBoardCanAssignTasks` skips the board-only task check for agents),
// and nested control flow means the reject is conditional, not a route-level
// guard.
function thenBranchHalts(text: string, ifIndex: number): boolean {
  const openParen = text.indexOf("(", ifIndex);
  if (openParen === -1) return false;
  const closeParen = matchingParen(text, openParen);
  if (closeParen === -1) return false;
  let i = closeParen + 1;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (i >= text.length) return false;
  let body: string;
  if (text[i] === "{") {
    const closeBrace = matchingBrace(text, i);
    body = closeBrace === -1 ? text.slice(i) : text.slice(i, closeBrace);
  } else {
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === "{" || c === "(" || c === "[") depth += 1;
      else if (c === "}" || c === ")" || c === "]") depth = Math.max(0, depth - 1);
      else if ((c === ";" || c === "\n") && depth === 0) break;
    }
    body = text.slice(i, j);
  }
  const halts = /\bthrow\b/.test(body) || /res\s*\.status\s*\(\s*4/.test(body);
  const noNestedControlFlow = !/\b(?:if|for|while|switch)\s*\(/.test(body);
  return halts && noNestedControlFlow;
}

// Brace depth at (not including) position pos in s.
function braceDepthUpTo(s: string, pos: number): number {
  let depth = 0;
  for (let i = 0; i < pos && i < s.length; i++) {
    if (s[i] === "{") depth += 1;
    else if (s[i] === "}") depth -= 1;
  }
  return depth;
}

// True when, within `block`, an `if` sitting at brace depth `depth` (starting the
// scan at fromIdx) is a hard board reject: a top-level clause that rejects board
// and a then-branch that halts unconditionally. Only the top-level depth matches,
// so a board-reject nested inside a sub-branch (`if (param === "me") { if
// (req.actor.type !== "board") … }`) is a per-request filter, not a route-level
// guard, and is ignored.
function hardBoardRejectAtDepth(block: string, depth: number, fromIdx: number): boolean {
  for (const m of block.matchAll(/\bif\s*\(/g)) {
    const ifPos = m.index!;
    if (ifPos < fromIdx) continue;
    if (braceDepthUpTo(block, ifPos) !== depth) continue;
    const open = ifPos + m[0].length - 1;
    const close = matchingParen(block, open);
    if (close === -1) continue;
    const cond = block.slice(open + 1, close);
    if (conditionIsHardBoardReject(cond) && thenBranchHalts(block, ifPos)) return true;
  }
  return false;
}

// Same-file `function NAME(` / `async function NAME(` bodies, memoized. First
// definition wins; names are unique per file in the route modules.
const fileFunctionBodies = new Map<string, Map<string, string>>();
function extractFunctionBodies(source: string): Map<string, string> {
  const bodies = new Map<string, string>();
  const declRe = /\b(?:async\s+function|function)\s+([A-Za-z_$][\w$]*)\s*\(/g;
  for (const m of source.matchAll(declRe)) {
    const name = m[1];
    if (bodies.has(name)) continue;
    const openParen = m.index! + m[0].length - 1;
    const closeParen = matchingParen(source, openParen);
    if (closeParen === -1) continue;
    let i = closeParen + 1;
    while (i < source.length && !/[{;]/.test(source[i])) i += 1;
    if (i >= source.length || source[i] !== "{") continue;
    const closeBrace = matchingBrace(source, i);
    if (closeBrace === -1) continue;
    bodies.set(name, source.slice(i, closeBrace + 1));
  }
  return bodies;
}
function functionBodies(file: string): Map<string, string> {
  let cached = fileFunctionBodies.get(file);
  if (!cached) {
    cached = extractFunctionBodies(fs.readFileSync(path.join(ROUTES_DIR, file), "utf8"));
    fileFunctionBodies.set(file, cached);
  }
  return cached;
}

// A "board-guard" helper rejects board at the top level of its own body (depth 1):
// `requireBoardUser`, `requireHumanUser`, `assertCanControlBuiltInRoutine`, …
function isBoardGuardHelper(helperBody: string): boolean {
  return hardBoardRejectAtDepth(helperBody, 1, 0);
}

// Derive the expected auth level from a route handler.
//   assertInstanceAdmin -> instance_admin
//   assertBoard / assertBoardOrgAccess -> board
//   a top-level `req.actor.type !== "board"` reject in the handler body, or a
//   top-level call to a board-guard helper -> board
//   otherwise -> null (agent-callable, or gated by a domain-specific helper)
//
// Only top-of-body gates count: a board-reject reached only through a sub-branch
// (e.g. `if (filter === "me")`) or an agent-success path leaves the route
// agent-callable, so it is not classified board-only.
function deriveAuthLevel(block: AuthBlock | undefined): "instance_admin" | "board" | null {
  if (!block) return null;
  const text = block.text.replace(AGENT_ALLOW_GUARD, " ");
  let sawBoard = false;
  let sawIa = false;
  if (BOARD_ASSERT.test(text)) sawBoard = true;
  if (IA_ASSERT.test(text)) sawIa = true;
  if (sawIa) return "instance_admin";
  if (sawBoard) return "board";

  const raw = block.text;
  const arrow = raw.lastIndexOf("=>");
  if (arrow === -1) return null;
  const bodyOpen = raw.indexOf("{", arrow);
  if (bodyOpen === -1) return null;
  const bodyDepth = braceDepthUpTo(raw, bodyOpen) + 1;

  if (hardBoardRejectAtDepth(raw, bodyDepth, bodyOpen)) return "board";

  const bodies = functionBodies(block.file);
  for (const m of raw.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const callPos = m.index!;
    if (callPos < bodyOpen) continue;
    if (braceDepthUpTo(raw, callPos) !== bodyDepth) continue;
    if (bodies.has(m[1]) && isBoardGuardHelper(bodies.get(m[1])!)) return "board";
  }
  return null;
}

const { byRoute: authRouteBlocks, unresolvedBareConstants } = buildAuthRouteBlocks();

// ── Design decision (SUP-16341, AC#5) ──────────────────────────────────────
//
// Two designs were considered for keeping the spec's auth metadata honest:
//
//   Design A (chosen): keep the spec's auth level data-driven (the
//   BOARD_ONLY_OPERATIONS / INSTANCE_ADMIN_OPERATIONS / PUBLIC_OPERATIONS sets
//   in openapi.ts) and extend this test's detector so it FAILS whenever a
//   handler enforces a board/instance-admin guard that the spec no longer
//   reflects. Drift is caught at the boundary: the detector classifies each
//   handler, the spec publishes its own level, and the regression guard below
//   asserts the two agree.
//
//   Design B (deferred): make the guard itself the single source of truth —
//   annotate each route with an explicit `auth: "board" | "agent" | …` that
//   both the runtime guard and the OpenAPI generator read, so the two can
//   never diverge.
//
// Design B is the more durable fix (one source of truth, no detector
// heuristics, no allowlist to keep in sync). It was deferred because it touches
// the route-registration surface across every route file plus the OpenAPI
// generator and the guard, which exceeds this ticket's bounded footprint
// (≤5 files, one PR). Design A closes the concrete over-promise (board-reject
// routes advertising AgentBearerAuth) and adds a CI guard so future drift of
// this class fails the build. Revisit Design B when the route-registration
// layer gets a broader refactor that can absorb a per-route auth annotation.

describe("openapi auth parity (SUP-14798)", () => {
  const spec = buildOpenApiSpec();

  function operation(method: string, routePath: string) {
    const pathItem = spec.paths?.[routePath];
    return pathItem?.[method.toLowerCase()];
  }

  function splitAuthRoute(route: string): [string, string] {
    const [method, routePath] = route.split(" ");
    return [method, routePath];
  }

  function authorizationActor(route: string): string | undefined {
    const [method, routePath] = splitAuthRoute(route);
    return operation(method, routePath)?.["x-paperclip-authorization"]?.actor;
  }

  function hasAgentBearerAuth(route: string): boolean {
    const [method, routePath] = splitAuthRoute(route);
    const security = operation(method, routePath)?.security ?? [];
    return security.some((req) => AGENT_BEARER in req);
  }

  it("reproduces the issue's 54 board + 7 instance-admin closure counts", () => {
    expect(ISSUE_BOARD_ROUTES).toHaveLength(54);
    expect(ISSUE_INSTANCE_ADMIN_ROUTES).toHaveLength(7);
    expect(DISCOVERED_BOARD_ROUTES).toHaveLength(10);
    expect(SUP16341_BOARD_ROUTES).toHaveLength(38);
  });

  it("resolves every bare-constant route registration (no silent skips)", () => {
    // A `router.<method>(SOME_CONST, …)` registration whose constant is not in
    // BARE_PATH_CONSTANTS would otherwise slip past the auth-parity guard — exactly
    // how SUP-14798's 61-route blind spot accumulated. Fail loudly, naming it.
    expect(
      unresolvedBareConstants,
      `unresolvable bare-constant route registrations:\n${unresolvedBareConstants.join("\n")}`,
    ).toEqual([]);
  });

  it("publishes the correct actor for every board route and omits AgentBearerAuth", () => {
    for (const route of BOARD_ROUTES) {
      expect(
        authorizationActor(route),
        `${route} should publish x-paperclip-authorization.actor = "board"`,
      ).toBe("board");
      expect(hasAgentBearerAuth(route), `${route} must not offer AgentBearerAuth`).toBe(false);
    }
  });

  it("publishes instance_admin (board + instanceAdmin) for every instance-admin route and omits AgentBearerAuth", () => {
    for (const route of INSTANCE_ADMIN_ROUTES) {
      const [method, routePath] = splitAuthRoute(route);
      const op = operation(method, routePath);
      expect(op?.["x-paperclip-authorization"], `${route} x-paperclip-authorization`).toEqual({
        actor: "board",
        instanceAdmin: true,
      });
      expect(hasAgentBearerAuth(route), `${route} must not offer AgentBearerAuth`).toBe(false);
    }
  });

  it("backs every closure route with a matching base assertion in its handler", () => {
    // Derive the expected level from the handler and require it to match the
    // closure's expectation. A closure route whose handler has no base assertion
    // (after ignoring assert calls gated behind an agent allow-guard) is
    // unclassifiable and fails, naming the route.
    const cases: Array<{ route: string; level: "board" | "instance_admin" }> = [
      ...BOARD_ROUTES.map((route) => ({ route, level: "board" as const })),
      ...INSTANCE_ADMIN_ROUTES.map((route) => ({ route, level: "instance_admin" as const })),
    ];

    for (const { route, level } of cases) {
      const block = authRouteBlocks.get(route);
      expect(
        block,
        `${route}: could not locate its route registration in server/src/routes (cannot classify)`,
      ).toBeDefined();
      const derived = deriveAuthLevel(block);
      expect(
        derived,
        `${route}: handler has no ${
          level === "board" ? "assertBoard/assertBoardOrgAccess" : "assertInstanceAdmin"
        } call (cannot classify as ${level})`,
      ).toBe(level);
    }
  });

  it("does not publish any board/instance-admin handler as agent-callable (regression guard)", () => {
    // For every route the document exposes whose handler unconditionally calls a
    // base board/instance-admin assertion, the document must agree. A NEW
    // board-only route registered without an allowlist entry publishes as
    // "board_or_agent" and fails here. Routes that cannot be classified (named
    // handlers, domain-specific helpers) are not asserted.
    const violations: string[] = [];
    for (const [route, block] of authRouteBlocks) {
      const derived = deriveAuthLevel(block);
      if (derived === null) continue;
      const actor = authorizationActor(route);
      if (actor !== "board") {
        violations.push(
          `${route} in ${block.file}: handler unconditionally calls a ${derived} assertion but publishes actor "${actor}"`,
        );
      }
    }
    expect(violations, `board-only routes published as agent-callable:\n${violations.join("\n")}`).toEqual([]);
  });

  it("publishes board-only auth for the summary-slots generate route (SUP-16339)", () => {
    // The generate handler enforces board-only through a named helper
    // (assertCanGenerateSummary: `if (req.actor.type !== "board") throw
    // forbidden("Only board operators can generate summaries.")`). That guard is
    // invisible to the assertBoard-based detector above, so the route would
    // silently default to board_or_agent + AgentBearerAuth unless pinned here.
    const route = "POST /api/companies/{companyId}/summary-slots/{scopeKind}/{slotKey}/generate";
    const [method, routePath] = splitAuthRoute(route);
    const op = operation(method, routePath);
    expect(op, `${route} must be present in the OpenAPI document`).toBeDefined();
    expect(op?.["x-paperclip-authorization"], `${route} actor`).toEqual({ actor: "board" });
    expect(hasAgentBearerAuth(route), `${route} must not offer AgentBearerAuth`).toBe(false);
    expect(op?.security, `${route} security`).toEqual(BOARD_SECURITY);

    // The advertised board-only requirement must match what the handler enforces.
    // Bind to the generate route's registration block (not the whole file), so the
    // test fails if the route stops invoking its board-only guard.
    const block = authRouteBlocks.get(route);
    expect(
      block,
      `${route}: could not locate its route registration in server/src/routes (cannot bind guard)`,
    ).toBeDefined();
    expect(
      block?.text,
      `${route}: handler must invoke the board-only guard assertCanGenerateSummary inline`,
    ).toMatch(/assertCanGenerateSummary\s*\(\s*req\s*,\s*companyId\s*\)/);

    // …and the guard it invokes must itself be board-only: it rejects any
    // non-board actor with 403 before generation runs.
    const source = fs.readFileSync(path.join(ROUTES_DIR, "summary-slots.ts"), "utf8");
    const guardBody = source.match(/async function assertCanGenerateSummary\b[\s\S]*?\n  \}/)?.[0];
    expect(
      guardBody,
      "assertCanGenerateSummary helper not found in summary-slots.ts",
    ).toBeDefined();
    expect(
      guardBody,
      "assertCanGenerateSummary must reject a non-board actor with 403",
    ).toMatch(/req\.actor\.type\s*!==\s*["'`]board["'`]/);
    expect(guardBody).toContain("Only board operators can generate summaries.");
  });

  it("registers the previously-duplicated stalled-review-decision path exactly once", () => {
    const source = fs.readFileSync(path.join(ROUTES_DIR, "openapi.ts"), "utf8");
    const needle = 'path: "/api/issues/{id}/stalled-review-decision"';
    const count = source.split(needle).length - 1;
    expect(count, `POST /api/issues/{id}/stalled-review-decision should be registered exactly once`).toBe(1);
  });

  it("board and instance-admin routes carry the board-only security requirement", () => {
    for (const route of [...BOARD_ROUTES, ...INSTANCE_ADMIN_ROUTES]) {
      const [method, routePath] = splitAuthRoute(route);
      const security = operation(method, routePath)?.security;
      expect(security, `${route} security`).toEqual(BOARD_SECURITY);
    }
  });
});
