/**
 * Unit coverage for the `plugin.tools_undeliverable` diagnostic (SUP-15087).
 *
 * The plugin tool dispatcher registers agent tools only from plugins in
 * `ready` status. A plugin that is installed, declares `manifest.tools`, and is
 * not `ready` (e.g. `status: "error"`) otherwise contributes zero tools and
 * nothing anywhere names it. This test proves the dispatcher now records a
 * durable, company-attributed activity-log diagnostic for exactly that case —
 * and stays silent for plugins that are ready, or that declare no tools.
 *
 * Plugin tools are instance-scoped (the `plugins` table, tool registry, and
 * lifecycle events carry no company dimension), but the activity log requires a
 * valid `company_id`, so the diagnostic is recorded once per company.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { PaperclipPluginManifestV1, PluginRecord, PluginStatus } from "@paperclipai/shared";
import {
  createPluginToolDispatcher,
  UNDELIVERABLE_TOOLS_ACTION,
} from "../services/plugin-tool-dispatcher.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { PluginLifecycleManager } from "../services/plugin-lifecycle.js";

const harness = vi.hoisted(() => ({
  logActivity: vi.fn(async () => ({ id: "activity-row" })),
  // Populated per-test by each `it` before the dispatcher is built.
  registry: null as unknown,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: harness.logActivity,
}));
vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => harness.registry,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = "c0000000-0000-4000-8000-000000000001";
const SECOND_COMPANY_ID = "d0000000-0000-4000-8000-000000000002";

/**
 * Minimal `db` stub: the only real (non-mocked) `db` call the dispatcher makes
 * is `resolveCompanyIds()` → `db.select({ id }).from(companies)`. Everything
 * else (`listInstalled` / `getById`) is served by the mocked
 * `pluginRegistryService`.
 */
function makeDbStub(companyIds: string[] = [COMPANY_ID]): Db {
  const rows = companyIds.map((id) => ({ id }));
  return {
    select: (_fields?: unknown) => ({
      from: (_table?: unknown) => Promise.resolve(rows),
    }),
  } as unknown as Db;
}

function makeWorkerManager(): PluginWorkerManager {
  return {
    startWorker: vi.fn(),
    stopWorker: vi.fn(),
    getWorker: vi.fn(),
    isRunning: vi.fn(() => false),
    stopAll: vi.fn(),
    diagnostics: vi.fn(() => []),
    call: vi.fn(async () => ({ ok: true })),
  } as unknown as PluginWorkerManager;
}

function makeManifest(pluginKey: string, toolCount: number): PaperclipPluginManifestV1 {
  return {
    id: pluginKey,
    apiVersion: 1,
    version: "1.0.0",
    displayName: pluginKey,
    description: "undeliverable-diagnostic fixture",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: [],
    entrypoints: { worker: "dist/worker.js" },
    tools: Array.from({ length: toolCount }, (_, i) => ({
      name: `tool-${i}`,
      displayName: `Tool ${i}`,
      description: "fixture tool",
      parametersSchema: { type: "object", properties: {} },
    })),
  } as unknown as PaperclipPluginManifestV1;
}

function makePlugin(
  id: string,
  pluginKey: string,
  status: PluginStatus,
  toolCount: number,
): PluginRecord {
  return {
    id,
    pluginKey,
    packageName: `@test/${pluginKey}`,
    version: "1.0.0",
    apiVersion: 1,
    categories: [],
    manifestJson: makeManifest(pluginKey, toolCount),
    status,
    installOrder: 1,
    packagePath: null,
    lastError: null,
    installedAt: new Date(),
    updatedAt: new Date(),
  } as unknown as PluginRecord;
}

function setRegistry(plugins: PluginRecord[]): void {
  harness.registry = {
    listInstalled: async () => plugins,
    getById: async (id: string) => plugins.find((p) => p.id === id) ?? null,
  };
}

function undeliverableInputs(): Array<Record<string, unknown>> {
  return harness.logActivity.mock.calls
    .map((call) => call[1])
    .filter((input: Record<string, unknown>) => input.action === UNDELIVERABLE_TOOLS_ACTION);
}

beforeEach(() => {
  harness.logActivity.mockClear();
});

afterEach(() => {
  harness.registry = null;
});

// ---------------------------------------------------------------------------
// initialize()
// ---------------------------------------------------------------------------

describe("dispatcher.initialize() — plugin.tools_undeliverable diagnostic", () => {
  it("emits the diagnostic for a plugin in `status: error` that declares tools", async () => {
    setRegistry([makePlugin("p-error", "acme.wiki", "error", 6)]);
    const dispatcher = createPluginToolDispatcher({
      workerManager: makeWorkerManager(),
      db: makeDbStub(),
    });

    await dispatcher.initialize();

    expect(harness.logActivity).toHaveBeenCalledTimes(1);
    const [dbArg, input] = harness.logActivity.mock.calls[0];
    expect(dbArg).toBeTypeOf("object");
    expect(input).toMatchObject({
      companyId: COMPANY_ID,
      actorType: "system",
      action: UNDELIVERABLE_TOOLS_ACTION,
      entityType: "plugin",
      entityId: "p-error",
      details: {
        pluginKey: "acme.wiki",
        pluginId: "p-error",
        pluginStatus: "error",
        declaredToolCount: 6,
        trigger: "initialize",
      },
    });

    // The error plugin's tools are NOT registered — nothing is silently
    // pretending to deliver them.
    expect(dispatcher.toolCount()).toBe(0);
  });

  it("does NOT emit the diagnostic for a `ready` plugin that declares tools", async () => {
    setRegistry([makePlugin("p-ready", "acme.ok", "ready", 3)]);
    const dispatcher = createPluginToolDispatcher({
      workerManager: makeWorkerManager(),
      db: makeDbStub(),
    });

    await dispatcher.initialize();

    expect(undeliverableInputs()).toHaveLength(0);
    // Ready plugin's tools ARE registered.
    expect(dispatcher.toolCount()).toBe(3);
  });

  it("does NOT emit the diagnostic for a non-ready plugin that declares no tools", async () => {
    setRegistry([makePlugin("p-notool", "acme.empty", "error", 0)]);
    const dispatcher = createPluginToolDispatcher({
      workerManager: makeWorkerManager(),
      db: makeDbStub(),
    });

    await dispatcher.initialize();

    expect(undeliverableInputs()).toHaveLength(0);
  });

  it("records one diagnostic only for the tool-declaring plugin, and registers ready tools", async () => {
    setRegistry([
      makePlugin("p-ready", "acme.ok", "ready", 2),
      makePlugin("p-error", "acme.wiki", "error", 4),
      makePlugin("p-notool", "acme.empty", "error", 0),
    ]);
    const dispatcher = createPluginToolDispatcher({
      workerManager: makeWorkerManager(),
      db: makeDbStub(),
    });

    await dispatcher.initialize();

    // Exactly one undeliverable diagnostic: only the error plugin that
    // declared tools. The ready plugin registers; the no-tools plugin is
    // skipped without a diagnostic.
    expect(undeliverableInputs()).toHaveLength(1);
    expect(dispatcher.toolCount()).toBe(2);
  });

  it("records one diagnostic row per company for a single undeliverable plugin", async () => {
    setRegistry([makePlugin("p-error", "acme.wiki", "error", 2)]);
    const dispatcher = createPluginToolDispatcher({
      workerManager: makeWorkerManager(),
      db: makeDbStub([COMPANY_ID, SECOND_COMPANY_ID]),
    });

    await dispatcher.initialize();

    const inputs = undeliverableInputs();
    expect(inputs).toHaveLength(2);
    const companyIds = inputs.map((input) => input.companyId).sort();
    expect(companyIds).toEqual([SECOND_COMPANY_ID, COMPANY_ID].sort());
    for (const input of inputs) {
      expect(input.details).toMatchObject({
        pluginKey: "acme.wiki",
        pluginId: "p-error",
        pluginStatus: "error",
        declaredToolCount: 2,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// lifecycle handlers — disabled / unloaded
// ---------------------------------------------------------------------------

describe("dispatcher — lifecycle handlers record the undeliverable diagnostic", () => {
  it("emits the diagnostic when a tool-declaring plugin is disabled", async () => {
    const lifecycle = new EventEmitter();
    setRegistry([makePlugin("p-wiki", "acme.wiki", "error", 5)]);
    const dispatcher = createPluginToolDispatcher({
      workerManager: makeWorkerManager(),
      db: makeDbStub(),
      lifecycleManager: lifecycle as unknown as PluginLifecycleManager,
    });
    await dispatcher.initialize();
    harness.logActivity.mockClear();

    lifecycle.emit("plugin.disabled", { pluginId: "p-wiki", pluginKey: "acme.wiki", reason: "operator" });
    // Settle the fire-and-forget diagnostic (getById → resolveCompanyIds → logActivity).
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const inputs = undeliverableInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      companyId: COMPANY_ID,
      action: UNDELIVERABLE_TOOLS_ACTION,
      entityType: "plugin",
      entityId: "p-wiki",
      details: {
        pluginKey: "acme.wiki",
        pluginId: "p-wiki",
        declaredToolCount: 5,
        trigger: "disabled",
      },
    });
  });

  it("emits the diagnostic when a tool-declaring plugin is unloaded", async () => {
    const lifecycle = new EventEmitter();
    setRegistry([makePlugin("p-wiki", "acme.wiki", "error", 3)]);
    const dispatcher = createPluginToolDispatcher({
      workerManager: makeWorkerManager(),
      db: makeDbStub(),
      lifecycleManager: lifecycle as unknown as PluginLifecycleManager,
    });
    await dispatcher.initialize();
    harness.logActivity.mockClear();

    lifecycle.emit("plugin.unloaded", { pluginId: "p-wiki", pluginKey: "acme.wiki", removeData: false });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const inputs = undeliverableInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0].details).toMatchObject({
      pluginKey: "acme.wiki",
      pluginId: "p-wiki",
      declaredToolCount: 3,
      trigger: "unloaded",
    });
  });

  it("does NOT emit the diagnostic on disable for a plugin that declared no tools", async () => {
    const lifecycle = new EventEmitter();
    setRegistry([makePlugin("p-empty", "acme.empty", "disabled", 0)]);
    const dispatcher = createPluginToolDispatcher({
      workerManager: makeWorkerManager(),
      db: makeDbStub(),
      lifecycleManager: lifecycle as unknown as PluginLifecycleManager,
    });
    await dispatcher.initialize();
    harness.logActivity.mockClear();

    lifecycle.emit("plugin.disabled", { pluginId: "p-empty", pluginKey: "acme.empty", reason: "operator" });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(undeliverableInputs()).toHaveLength(0);
  });
});
