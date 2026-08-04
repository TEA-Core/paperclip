/**
 * SUP-10856 — scheduled plugin jobs must be dispatched with a company scope.
 *
 * Before this, `plugin_jobs` had no company: dispatch sent `{ job: {...} }` with
 * nothing `deriveInvocationScope` could read, so no invocation scope was
 * registered and every company-scoped host call from a job handler failed with
 * "company context is required". That made `instanceConfigSchema` decorative
 * for any plugin whose work happens on a schedule.
 *
 * These tests pin the two halves of the fix: the fan-out that creates one job
 * row per enabled company, and the dispatch that carries that company through
 * to a real invocation scope.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  pluginCompanySettings,
  pluginJobs,
  pluginJobRuns,
  plugins,
} from "@paperclipai/db";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import { deriveInvocationScope } from "../services/plugin-worker-manager.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin job company-scope tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describeEmbeddedPostgres("plugin scheduled jobs carry a company scope (SUP-10856)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-job-scope-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginJobRuns);
    await db.delete(pluginJobs);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPlugin() {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.job-scope-test",
      packageName: "@paperclipai/plugin-job-scope-test",
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.job-scope-test",
        apiVersion: 1,
        version: "0.0.1",
        displayName: "Job Scope Test",
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
    return pluginId;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Tenant ${companyId.slice(0, 6)}`,
      issuePrefix: issuePrefix(companyId),
    });
    return companyId;
  }

  const declarations = [{ jobKey: "sync", schedule: "* * * * *" }] as never;

  // -----------------------------------------------------------------------
  // Fan-out
  // -----------------------------------------------------------------------

  it("treats a company with no plugin_company_settings row as enabled", async () => {
    const pluginId = await seedPlugin();
    const companyId = await seedCompany();
    const registry = pluginRegistryService(db);

    // No plugin_company_settings row is inserted for this company at all — the
    // schema's documented default is "no row means enabled". An inner join here
    // would return nothing and silently disable every job on a fresh instance.
    const enabled = await registry.listEnabledCompanyIds(pluginId);

    expect(enabled).toContain(companyId);
  });

  it("excludes a company whose plugin_company_settings row is disabled", async () => {
    const pluginId = await seedPlugin();
    const enabledCompany = await seedCompany();
    const disabledCompany = await seedCompany();

    await db.insert(pluginCompanySettings).values({
      pluginId,
      companyId: disabledCompany,
      enabled: false,
      settingsJson: {},
    });

    const enabled = await pluginRegistryService(db).listEnabledCompanyIds(pluginId);

    expect(enabled).toContain(enabledCompany);
    expect(enabled).not.toContain(disabledCompany);
  });

  it("fans one manifest declaration out to one job row per enabled company", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const jobStore = pluginJobStore(db);

    await jobStore.syncJobDeclarations(pluginId, declarations, [companyA, companyB]);

    const rows = await jobStore.listJobs(pluginId);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.companyId).sort()).toEqual([companyA, companyB].sort());
    expect(rows.every((row) => row.jobKey === "sync" && row.status === "active")).toBe(true);
  });

  it("pauses a legacy row that has no company instead of deleting its history", async () => {
    const pluginId = await seedPlugin();
    const companyId = await seedCompany();
    const jobStore = pluginJobStore(db);

    // A row as it exists on an instance that upgraded across the migration.
    const [legacy] = await db
      .insert(pluginJobs)
      .values({ pluginId, jobKey: "sync", schedule: "* * * * *", status: "active" })
      .returning();
    await db.insert(pluginJobRuns).values({
      jobId: legacy!.id,
      pluginId,
      trigger: "schedule",
      status: "succeeded",
    });

    await jobStore.syncJobDeclarations(pluginId, declarations, [companyId]);

    const after = await jobStore.getJobById(legacy!.id);
    expect(after?.status).toBe("paused");
    expect(after?.companyId).toBeNull();

    // The run history survives — pausing, not deleting, is the point.
    const runs = await jobStore.listRunsByJob(legacy!.id);
    expect(runs).toHaveLength(1);

    // …and a properly scoped row now exists alongside it.
    const scoped = (await jobStore.listJobs(pluginId)).filter((row) => row.companyId === companyId);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.status).toBe("active");
  });

  it("pauses rows for a company that is no longer enabled", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const jobStore = pluginJobStore(db);

    await jobStore.syncJobDeclarations(pluginId, declarations, [companyA, companyB]);
    // companyB is switched off; the next sync sees only companyA.
    await jobStore.syncJobDeclarations(pluginId, declarations, [companyA]);

    const rows = await jobStore.listJobs(pluginId);
    const byCompany = new Map(rows.map((row) => [row.companyId, row.status]));

    expect(byCompany.get(companyA)).toBe("active");
    expect(byCompany.get(companyB)).toBe("paused");
  });

  // -----------------------------------------------------------------------
  // Dispatch
  // -----------------------------------------------------------------------

  it("dispatches a due job with params that resolve to an invocation scope", async () => {
    const pluginId = await seedPlugin();
    const companyId = await seedCompany();
    const jobStore = pluginJobStore(db);

    await jobStore.syncJobDeclarations(pluginId, declarations, [companyId]);
    const [job] = await jobStore.listJobs(pluginId);
    // Make it due.
    await jobStore.updateRunTimestamps(job!.id, new Date(0), new Date(Date.now() - 60_000));

    const call = vi.fn().mockResolvedValue(undefined);
    const scheduler = createPluginJobScheduler({
      db,
      jobStore,
      workerManager: { call, isRunning: () => true } as never,
    });

    await scheduler.tick();

    expect(call).toHaveBeenCalledTimes(1);
    const [calledPluginId, method, params] = call.mock.calls[0]!;
    expect(calledPluginId).toBe(pluginId);
    expect(method).toBe("runJob");

    // The actual assertion the bug was about: these params, fed to the real
    // scope-derivation the worker manager uses, produce a scope for this
    // company. Without it the handler's config.get()/issues.list() fail closed.
    expect(deriveInvocationScope("runJob", params)).toEqual({ companyId });

    // The handler can also read its own company without inferring it.
    expect((params as { job: { companyId?: string } }).job.companyId).toBe(companyId);

    // The run row is attributed to the company too.
    const runs = await jobStore.listRunsByJob(job!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.companyId).toBe(companyId);
  });

  it("never dispatches a legacy row that has no company", async () => {
    const pluginId = await seedPlugin();
    const jobStore = pluginJobStore(db);

    const [legacy] = await db
      .insert(pluginJobs)
      .values({
        pluginId,
        jobKey: "sync",
        schedule: "* * * * *",
        status: "active",
        nextRunAt: new Date(Date.now() - 60_000),
      })
      .returning();

    const call = vi.fn().mockResolvedValue(undefined);
    const scheduler = createPluginJobScheduler({
      db,
      jobStore,
      workerManager: { call, isRunning: () => true } as never,
    });

    await scheduler.tick();

    // Dispatching it would create a run that can do nothing but fail closed.
    expect(call).not.toHaveBeenCalled();
    expect(await jobStore.listRunsByJob(legacy!.id)).toHaveLength(0);
  });

  it("refuses to hand-trigger a job that has no company", async () => {
    const pluginId = await seedPlugin();
    const jobStore = pluginJobStore(db);

    const [legacy] = await db
      .insert(pluginJobs)
      .values({ pluginId, jobKey: "sync", schedule: "* * * * *", status: "active" })
      .returning();

    const call = vi.fn().mockResolvedValue(undefined);
    const scheduler = createPluginJobScheduler({
      db,
      jobStore,
      workerManager: { call, isRunning: () => true } as never,
    });

    await expect(scheduler.triggerJob(legacy!.id)).rejects.toThrow(/no company scope/);
    expect(call).not.toHaveBeenCalled();
  });
});
