/**
 * PluginToolDispatcher — orchestrates plugin tool discovery, lifecycle
 * integration, and execution routing for the agent service.
 *
 * This service sits between the agent service and the lower-level
 * `PluginToolRegistry` + `PluginWorkerManager`, providing a clean API that:
 *
 * - Discovers tools from loaded plugin manifests and registers them
 *   in the tool registry.
 * - Hooks into `PluginLifecycleManager` events to automatically register
 *   and unregister tools when plugins are enabled or disabled.
 * - Exposes the tool list in an agent-friendly format (with namespaced
 *   names, descriptions, parameter schemas).
 * - Routes `executeTool` calls to the correct plugin worker and returns
 *   structured results.
 * - Validates tool parameters against declared schemas before dispatch.
 *
 * The dispatcher is created once at server startup and shared across
 * the application.
 *
 * @see PLUGIN_SPEC.md §11 — Agent Tools
 * @see PLUGIN_SPEC.md §13.10 — `executeTool`
 */

import { companies, type Db } from "@paperclipai/db";
import type {
  PaperclipPluginManifestV1,
  PluginRecord,
} from "@paperclipai/shared";
import type { ToolRunContext, ToolResult } from "@paperclipai/plugin-sdk";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { PluginLifecycleManager } from "./plugin-lifecycle.js";
import {
  createPluginToolRegistry,
  type PluginToolRegistry,
  type RegisteredTool,
  type ToolListFilter,
  type ToolExecutionResult,
} from "./plugin-tool-registry.js";
import { pluginRegistryService } from "./plugin-registry.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";

/**
 * Stable activity-log `action` emitted when a plugin declares tools that cannot
 * be delivered because it is not in `ready` status. The plugin-tool health
 * route (SUP-15090) reads this row shape:
 * `details = { pluginKey, pluginId, pluginStatus, declaredToolCount }`.
 */
export const UNDELIVERABLE_TOOLS_ACTION = "plugin.tools_undeliverable";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An agent-facing tool descriptor — the shape returned when agents
 * query for available tools.
 *
 * This is intentionally simpler than `RegisteredTool`, exposing only
 * what agents need to decide whether and how to call a tool.
 */
export interface AgentToolDescriptor {
  /** Fully namespaced tool name (e.g. `"acme.linear:search-issues"`). */
  name: string;
  /** Human-readable display name. */
  displayName: string;
  /** Description for the agent — explains when and how to use this tool. */
  description: string;
  /** JSON Schema describing the tool's input parameters. */
  parametersSchema: Record<string, unknown>;
  /** The plugin that provides this tool. */
  pluginId: string;
}

/**
 * Options for creating the plugin tool dispatcher.
 */
export interface PluginToolDispatcherOptions {
  /** The worker manager used to dispatch RPC calls to plugin workers. */
  workerManager?: PluginWorkerManager;
  /** The lifecycle manager to listen for plugin state changes. */
  lifecycleManager?: PluginLifecycleManager;
  /** Database connection for looking up plugin records. */
  db?: Db;
}

// ---------------------------------------------------------------------------
// PluginToolDispatcher interface
// ---------------------------------------------------------------------------

/**
 * The plugin tool dispatcher — the primary integration point between the
 * agent service and the plugin tool system.
 *
 * Agents use this service to:
 * 1. List all available tools (for prompt construction / tool choice)
 * 2. Execute a specific tool by its namespaced name
 *
 * The dispatcher handles lifecycle management internally — when a plugin
 * is loaded or unloaded, its tools are automatically registered or removed.
 */
export interface PluginToolDispatcher {
  /**
   * Initialize the dispatcher — load tools from all currently-ready plugins
   * and start listening for lifecycle events.
   *
   * Must be called once at server startup after the lifecycle manager
   * and worker manager are ready.
   */
  initialize(): Promise<void>;

  /**
   * Tear down the dispatcher — unregister lifecycle event listeners
   * and clear all tool registrations.
   *
   * Called during server shutdown.
   */
  teardown(): void;

  /**
   * List all available tools for agents, optionally filtered.
   *
   * Returns tool descriptors in an agent-friendly format.
   *
   * @param filter - Optional filter criteria
   * @returns Array of agent tool descriptors
   */
  listToolsForAgent(filter?: ToolListFilter): AgentToolDescriptor[];

  /**
   * Look up a tool by its namespaced name.
   *
   * @param namespacedName - e.g. `"acme.linear:search-issues"`
   * @returns The registered tool, or `null` if not found
   */
  getTool(namespacedName: string): RegisteredTool | null;

  /**
   * Execute a tool by its namespaced name, routing to the correct
   * plugin worker.
   *
   * @param namespacedName - Fully qualified tool name
   * @param parameters - Input parameters matching the tool's schema
   * @param runContext - Agent run context
   * @returns The execution result with routing metadata
   * @throws {Error} if the tool is not found, the worker is not running,
   *   or the tool execution fails
   */
  executeTool(
    namespacedName: string,
    parameters: unknown,
    runContext: ToolRunContext,
  ): Promise<ToolExecutionResult>;

  /**
   * Register all tools from a plugin manifest.
   *
   * This is called automatically when a plugin transitions to `ready`.
   * Can also be called manually for testing or recovery scenarios.
   *
   * @param pluginKey - The plugin's namespaced key (e.g. `acme.linear`).
   *   Used as the lookup key for tool registration.
   * @param manifest - The plugin manifest containing tool declarations.
   * @param pluginDbId - The plugin's database UUID. Required:
   *   `workerManager` keys running workers by DB UUID, not by pluginKey, so
   *   without this `workerManager.isRunning(...)` always returns false and
   *   every tool dispatch fails with `worker for plugin X is not running`.
   */
  registerPluginTools(
    pluginKey: string,
    manifest: PaperclipPluginManifestV1,
    pluginDbId: string,
  ): void;

  /**
   * Unregister all tools for a plugin.
   *
   * Called automatically when a plugin is disabled or unloaded.
   *
   * @param pluginId - The plugin to unregister
   */
  unregisterPluginTools(pluginId: string): void;

  /**
   * Get the total number of registered tools, optionally scoped to a plugin.
   *
   * @param pluginId - If provided, count only this plugin's tools
   */
  toolCount(pluginId?: string): number;

  /**
   * Access the underlying tool registry for advanced operations.
   *
   * This escape hatch exists for internal use (e.g. diagnostics).
   * Prefer the dispatcher's own methods for normal operations.
   */
  getRegistry(): PluginToolRegistry;
}

// ---------------------------------------------------------------------------
// Factory: createPluginToolDispatcher
// ---------------------------------------------------------------------------

/**
 * Create a new `PluginToolDispatcher`.
 *
 * The dispatcher:
 * 1. Creates and owns a `PluginToolRegistry` backed by the given worker manager.
 * 2. Listens for lifecycle events (plugin.enabled, plugin.disabled, plugin.unloaded)
 *    to automatically register and unregister tools.
 * 3. On `initialize()`, loads tools from all currently-ready plugins via the DB.
 *
 * @param options - Configuration options
 *
 * @example
 * ```ts
 * // At server startup
 * const dispatcher = createPluginToolDispatcher({
 *   workerManager,
 *   lifecycleManager,
 *   db,
 * });
 * await dispatcher.initialize();
 *
 * // In agent service — list tools for prompt construction
 * const tools = dispatcher.listToolsForAgent();
 *
 * // In agent service — execute a tool
 * const result = await dispatcher.executeTool(
 *   "acme.linear:search-issues",
 *   { query: "auth bug" },
 *   { agentId: "a-1", runId: "r-1", companyId: "c-1", projectId: "p-1" },
 * );
 * ```
 */
export function createPluginToolDispatcher(
  options: PluginToolDispatcherOptions = {},
): PluginToolDispatcher {
  const { workerManager, lifecycleManager, db } = options;
  const log = logger.child({ service: "plugin-tool-dispatcher" });

  // Create the underlying tool registry, backed by the worker manager
  const registry = createPluginToolRegistry(workerManager);

  // Track lifecycle event listeners so we can remove them on teardown
  let enabledListener: ((payload: { pluginId: string; pluginKey: string }) => void) | null = null;
  let disabledListener: ((payload: { pluginId: string; pluginKey: string; reason?: string }) => void) | null = null;
  let unloadedListener: ((payload: { pluginId: string; pluginKey: string; removeData: boolean }) => void) | null = null;

  let initialized = false;

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Attempt to register tools for a plugin by looking up its manifest
   * from the DB. No-ops gracefully if the plugin or manifest is missing.
   */
  async function registerFromDb(pluginId: string): Promise<void> {
    if (!db) {
      log.warn(
        { pluginId },
        "cannot register tools from DB — no database connection configured",
      );
      return;
    }

    const pluginRegistry = pluginRegistryService(db);
    const plugin = await pluginRegistry.getById(pluginId) as PluginRecord | null;

    if (!plugin) {
      log.warn({ pluginId }, "plugin not found in registry, cannot register tools");
      return;
    }

    const manifest = plugin.manifestJson;
    if (!manifest) {
      log.warn({ pluginId }, "plugin has no manifest, cannot register tools");
      return;
    }

    registry.registerPlugin(plugin.pluginKey, manifest, plugin.id);
  }

  /**
   * Convert a `RegisteredTool` to an `AgentToolDescriptor`.
   */
  function toAgentDescriptor(tool: RegisteredTool): AgentToolDescriptor {
    return {
      name: tool.namespacedName,
      displayName: tool.displayName,
      description: tool.description,
      parametersSchema: tool.parametersSchema,
      pluginId: tool.pluginDbId,
    };
  }

  /**
   * Resolve the ids of all companies on the instance.
   *
   * Plugin tools are instance-scoped: the `plugins` table, the in-memory tool
   * registry, and the lifecycle events carry no company dimension, and a
   * ready plugin's tools are delivered to every company's agents. The
   * activity log, however, is company-scoped (a required `company_id` FK), so
   * an undeliverable-tool diagnostic must be recorded once per company for
   * the per-company plugin-tool health route to read it.
   */
  async function resolveCompanyIds(): Promise<string[]> {
    if (!db) return [];
    const rows = await db.select({ id: companies.id }).from(companies);
    return rows.map((row) => row.id);
  }

  /**
   * Record a `plugin.tools_undeliverable` activity-log row — once per company —
   * for a plugin that declared tools but is not `ready` (or is being
   * unregistered). No-ops when the plugin declared no tools or no companies
   * exist, and when no database is configured.
   */
  async function emitUndeliverableToolDiagnostic(
    plugin: PluginRecord,
    declaredToolCount: number,
    trigger: "initialize" | "disabled" | "unloaded",
    companyIds: string[],
  ): Promise<void> {
    if (!db || declaredToolCount === 0 || companyIds.length === 0) return;
    const details: Record<string, unknown> = {
      pluginKey: plugin.pluginKey,
      pluginId: plugin.id,
      pluginStatus: plugin.status,
      declaredToolCount,
      trigger,
    };
    for (const companyId of companyIds) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "plugin-tool-dispatcher",
        action: UNDELIVERABLE_TOOLS_ACTION,
        entityType: "plugin",
        entityId: plugin.id,
        details,
      });
    }
  }

  /**
   * Fire-and-forget helper for the lifecycle handlers: look up a plugin and,
   * if it declared tools, record the undeliverable diagnostic. Errors are
   * logged, never thrown — the lifecycle handler itself must stay synchronous.
   */
  async function diagnoseUndeliverablePlugin(
    pluginId: string,
    trigger: "disabled" | "unloaded",
  ): Promise<void> {
    if (!db) return;
    const pluginRegistry = pluginRegistryService(db);
    const plugin = await pluginRegistry.getById(pluginId) as PluginRecord | null;
    if (!plugin) return;
    const declaredToolCount = plugin.manifestJson?.tools?.length ?? 0;
    if (declaredToolCount === 0) return;
    const companyIds = await resolveCompanyIds();
    await emitUndeliverableToolDiagnostic(plugin, declaredToolCount, trigger, companyIds);
  }

  // -----------------------------------------------------------------------
  // Lifecycle event handlers
  // -----------------------------------------------------------------------

  function handlePluginEnabled(payload: { pluginId: string; pluginKey: string }): void {
    log.debug({ pluginId: payload.pluginId, pluginKey: payload.pluginKey }, "plugin enabled — registering tools");
    // Async registration from DB — we fire-and-forget since the lifecycle
    // event handler must be synchronous. Any errors are logged.
    void registerFromDb(payload.pluginId).catch((err) => {
      log.error(
        { pluginId: payload.pluginId, err: err instanceof Error ? err.message : String(err) },
        "failed to register tools after plugin enabled",
      );
    });
  }

  function handlePluginDisabled(payload: { pluginId: string; pluginKey: string; reason?: string }): void {
    log.debug({ pluginId: payload.pluginId, pluginKey: payload.pluginKey }, "plugin disabled — unregistering tools");
    registry.unregisterPlugin(payload.pluginKey);
    // If the plugin had declared tools, record that they are now undeliverable.
    void diagnoseUndeliverablePlugin(payload.pluginId, "disabled").catch((err) => {
      log.error(
        { pluginId: payload.pluginId, err: err instanceof Error ? err.message : String(err) },
        "failed to record undeliverable tool diagnostic for disabled plugin",
      );
    });
  }

  function handlePluginUnloaded(payload: { pluginId: string; pluginKey: string; removeData: boolean }): void {
    log.debug({ pluginId: payload.pluginId, pluginKey: payload.pluginKey }, "plugin unloaded — unregistering tools");
    registry.unregisterPlugin(payload.pluginKey);
    // If the plugin had declared tools, record that they are now undeliverable.
    void diagnoseUndeliverablePlugin(payload.pluginId, "unloaded").catch((err) => {
      log.error(
        { pluginId: payload.pluginId, err: err instanceof Error ? err.message : String(err) },
        "failed to record undeliverable tool diagnostic for unloaded plugin",
      );
    });
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    async initialize(): Promise<void> {
      if (initialized) {
        log.warn("dispatcher already initialized, skipping");
        return;
      }

      log.info("initializing plugin tool dispatcher");

      // Step 1: Load tools from all currently-ready plugins, and record a
      // durable diagnostic for every installed plugin that declares tools but
      // is not in `ready` status. Those plugins contribute zero tools and —
      // without this — nothing anywhere names them (SUP-15087).
      if (db) {
        const pluginRegistry = pluginRegistryService(db);
        const installedPlugins = await pluginRegistry.listInstalled() as PluginRecord[];
        const companyIds = await resolveCompanyIds();

        let totalTools = 0;
        let readyCount = 0;
        let skippedPluginCount = 0;
        let skippedToolCount = 0;
        for (const plugin of installedPlugins) {
          const manifest = plugin.manifestJson;
          const declaredTools = manifest?.tools ?? [];
          if (plugin.status === "ready") {
            readyCount += 1;
            if (declaredTools.length > 0) {
              registry.registerPlugin(plugin.pluginKey, manifest, plugin.id);
              totalTools += declaredTools.length;
            }
          } else if (declaredTools.length > 0) {
            // Declared tools, but the plugin cannot deliver them. Record who
            // was dropped so the next probe names the plugin instead of
            // costing a run to discover it.
            skippedPluginCount += 1;
            skippedToolCount += declaredTools.length;
            await emitUndeliverableToolDiagnostic(
              plugin,
              declaredTools.length,
              "initialize",
              companyIds,
            );
          }
        }

        log.info(
          {
            readyPlugins: readyCount,
            registeredTools: totalTools,
            skippedPlugins: skippedPluginCount,
            skippedTools: skippedToolCount,
          },
          "loaded tools from ready plugins; recorded diagnostics for non-ready plugins that declare tools",
        );
      }

      // Step 2: Subscribe to lifecycle events for dynamic updates
      if (lifecycleManager) {
        enabledListener = handlePluginEnabled;
        disabledListener = handlePluginDisabled;
        unloadedListener = handlePluginUnloaded;

        lifecycleManager.on("plugin.enabled", enabledListener);
        lifecycleManager.on("plugin.disabled", disabledListener);
        lifecycleManager.on("plugin.unloaded", unloadedListener);

        log.debug("subscribed to lifecycle events");
      } else {
        log.warn("no lifecycle manager provided — tools will not auto-update on plugin state changes");
      }

      initialized = true;
      log.info(
        { totalTools: registry.toolCount() },
        "plugin tool dispatcher initialized",
      );
    },

    teardown(): void {
      if (!initialized) return;

      // Unsubscribe from lifecycle events
      if (lifecycleManager) {
        if (enabledListener) lifecycleManager.off("plugin.enabled", enabledListener);
        if (disabledListener) lifecycleManager.off("plugin.disabled", disabledListener);
        if (unloadedListener) lifecycleManager.off("plugin.unloaded", unloadedListener);

        enabledListener = null;
        disabledListener = null;
        unloadedListener = null;
      }

      // Note: we do NOT clear the registry here because teardown may be
      // called during graceful shutdown where in-flight tool calls should
      // still be able to resolve their tool entries.

      initialized = false;
      log.info("plugin tool dispatcher torn down");
    },

    listToolsForAgent(filter?: ToolListFilter): AgentToolDescriptor[] {
      return registry.listTools(filter).map(toAgentDescriptor);
    },

    getTool(namespacedName: string): RegisteredTool | null {
      return registry.getTool(namespacedName);
    },

    async executeTool(
      namespacedName: string,
      parameters: unknown,
      runContext: ToolRunContext,
    ): Promise<ToolExecutionResult> {
      log.debug(
        {
          tool: namespacedName,
          agentId: runContext.agentId,
          runId: runContext.runId,
        },
        "dispatching tool execution",
      );

      const result = await registry.executeTool(
        namespacedName,
        parameters,
        runContext,
      );

      log.debug(
        {
          tool: namespacedName,
          pluginId: result.pluginId,
          hasContent: !!result.result.content,
          hasError: !!result.result.error,
        },
        "tool execution completed",
      );

      return result;
    },

    registerPluginTools(
      pluginKey: string,
      manifest: PaperclipPluginManifestV1,
      pluginDbId: string,
    ): void {
      registry.registerPlugin(pluginKey, manifest, pluginDbId);
    },

    unregisterPluginTools(pluginId: string): void {
      registry.unregisterPlugin(pluginId);
    },

    toolCount(pluginId?: string): number {
      return registry.toolCount(pluginId);
    },

    getRegistry(): PluginToolRegistry {
      return registry;
    },
  };
}
