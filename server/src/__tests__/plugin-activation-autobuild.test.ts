import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, plugins } from "@paperclipai/db";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginLoader, REPO_ROOT } from "../services/plugin-loader.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin activation auto-build tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const repoPluginRoot = path.join(REPO_ROOT, "packages", "plugins");

type FixturePlugin = {
  packageName: string;
  pluginKey: string;
  packageRoot: string;
  distDir: string;
  manifest: PaperclipPluginManifestV1;
  /**
   * Written once per build-script invocation. Its absence is direct evidence that no
   * build was spawned, without reaching into how `ensureLocalPluginBuilt` shells out.
   * It lives outside `dist/` so that deleting `dist/` does not erase the evidence.
   */
  buildMarkerPath: string;
};

/**
 * A plugin package whose declared entrypoints are all build outputs, mirroring every
 * real bundled plugin. `rootDir` decides whether it counts as repo-bundled: inside
 * `packages/plugins` it is eligible for auto-build, anywhere else it stands in for an
 * npm-installed package.
 */
async function createPluginFixture(
  nameSuffix: string,
  options: { rootDir?: string; buildDistImmediately?: boolean; declareManifestEntrypoint?: boolean } = {},
): Promise<FixturePlugin> {
  const slug = `plugin-activation-${nameSuffix}-${randomUUID().slice(0, 8)}`;
  const packageName = `@paperclipai/${slug}`;
  const pluginKey = `paperclip.${slug.replace(/^plugin-/, "").replace(/-/g, "_")}`;
  const packageRoot = path.join(options.rootDir ?? repoPluginRoot, slug);
  const distDir = path.join(packageRoot, "dist");
  const buildMarkerPath = path.join(packageRoot, "build-ran.txt");
  const declareManifestEntrypoint = options.declareManifestEntrypoint !== false;

  const manifest: PaperclipPluginManifestV1 = {
    id: pluginKey,
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Activation Fixture",
    description: "Bundled plugin fixture for activation-time auto-build coverage.",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["companies.read"],
    entrypoints: { worker: "./dist/worker.js" },
  };

  await mkdir(path.join(packageRoot, "scripts"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: packageName,
      version: "0.1.0",
      private: true,
      type: "module",
      scripts: { build: "node ./scripts/build.mjs" },
      ...(declareManifestEntrypoint
        ? {
          paperclipPlugin: {
            manifest: "./dist/manifest.js",
            worker: "./dist/worker.js",
          },
        }
        : { paperclipPlugin: { worker: "./dist/worker.js" } }),
    }, null, 2),
    "utf8",
  );

  await writeFile(
    path.join(packageRoot, "scripts", "build.mjs"),
    [
      "import { appendFile, mkdir, writeFile } from \"node:fs/promises\";",
      "import path from \"node:path\";",
      "import { fileURLToPath } from \"node:url\";",
      "",
      "const scriptDir = path.dirname(fileURLToPath(import.meta.url));",
      "const packageRoot = path.resolve(scriptDir, \"..\");",
      "const distDir = path.join(packageRoot, \"dist\");",
      `const manifest = ${JSON.stringify(manifest, null, 2)};`,
      "",
      "await mkdir(distDir, { recursive: true });",
      "await writeFile(path.join(distDir, \"manifest.js\"), `export default ${JSON.stringify(manifest, null, 2)};\\n`, \"utf8\");",
      "await writeFile(path.join(distDir, \"worker.js\"), \"export {};\\n\", \"utf8\");",
      "await appendFile(path.join(packageRoot, \"build-ran.txt\"), \"build\\n\", \"utf8\");",
    ].join("\n"),
    "utf8",
  );

  if (options.buildDistImmediately) {
    await mkdir(distDir, { recursive: true });
    await writeFile(path.join(distDir, "worker.js"), "export {};\n", "utf8");
    // `resolveManifestPath` falls back to dist/manifest.js by convention, so a package
    // that declares no manifest entrypoint must not have one lying there either —
    // otherwise the fallback finds it and the package is not the case under test.
    if (declareManifestEntrypoint) {
      await writeFile(path.join(distDir, "manifest.js"), `export default ${JSON.stringify(manifest, null, 2)};\n`, "utf8");
    }
  }

  return { packageName, pluginKey, packageRoot, distDir, manifest, buildMarkerPath };
}

async function countBuilds(fixture: FixturePlugin): Promise<number> {
  if (!existsSync(fixture.buildMarkerPath)) return 0;
  const contents = await readFile(fixture.buildMarkerPath, "utf8");
  return contents.split("\n").filter((line) => line.length > 0).length;
}

describeEmbeddedPostgres("plugin activation auto-build", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const cleanupPaths = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-activation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await db.delete(plugins);
    for (const cleanupPath of cleanupPaths) {
      await rm(cleanupPath, { recursive: true, force: true });
    }
    cleanupPaths.clear();
    delete process.env["PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD"];
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedReadyPlugin(fixture: FixturePlugin): Promise<string> {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: fixture.pluginKey,
      packageName: fixture.packageName,
      packagePath: fixture.packageRoot,
      version: fixture.manifest.version,
      apiVersion: fixture.manifest.apiVersion,
      categories: fixture.manifest.categories,
      manifestJson: fixture.manifest,
      status: "ready",
      installOrder: 1,
    });
    return pluginId;
  }

  function createActivationLoader() {
    const workerManager = {
      startWorker: vi.fn().mockResolvedValue(undefined),
      stopAll: vi.fn().mockResolvedValue(undefined),
    };
    const lifecycleManager = { markError: vi.fn().mockResolvedValue(undefined) };
    const loader = pluginLoader(db, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
    }, {
      workerManager,
      eventBus: {
        forPlugin: vi.fn(() => ({})),
        subscriptionCount: vi.fn(() => 0),
      },
      jobScheduler: {
        registerPlugin: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
      },
      jobStore: {
        syncJobDeclarations: vi.fn().mockResolvedValue(undefined),
      },
      toolDispatcher: { registerPluginTools: vi.fn() },
      lifecycleManager,
      buildHostHandlers: vi.fn(() => ({})),
      instanceInfo: {
        instanceId: "test-instance",
        hostVersion: "1.0.0",
        deploymentMode: "authenticated",
        deploymentExposure: "public",
      },
    } as never);

    return { loader, workerManager, lifecycleManager };
  }

  it("rebuilds a repo-bundled plugin whose dist died with the previous container", async () => {
    // The live failure: the image ships the package unbuilt, the dist/ that had served
    // it since install lived in the previous container's writable layer, and activation
    // fails on a package that never changed.
    const fixture = await createPluginFixture("rebuild");
    cleanupPaths.add(fixture.packageRoot);
    const pluginId = await seedReadyPlugin(fixture);
    expect(existsSync(path.join(fixture.distDir, "manifest.js"))).toBe(false);

    const { loader, workerManager } = createActivationLoader();
    const result = await loader.loadSingle(pluginId);

    expect(result.error ?? null).toBeNull();
    expect(result.success).toBe(true);
    expect(existsSync(path.join(fixture.distDir, "manifest.js"))).toBe(true);
    expect(existsSync(path.join(fixture.distDir, "worker.js"))).toBe(true);
    expect(await countBuilds(fixture)).toBe(1);
    expect(workerManager.startWorker).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("does not build a plugin whose declared entrypoints are all present", async () => {
    const fixture = await createPluginFixture("already-built", { buildDistImmediately: true });
    cleanupPaths.add(fixture.packageRoot);
    const pluginId = await seedReadyPlugin(fixture);

    const { loader } = createActivationLoader();
    const result = await loader.loadSingle(pluginId);

    expect(result.success).toBe(true);
    // `ensureLocalPluginBuilt` short-circuits on missingEntrypoints.length === 0, so
    // activation must not pay a pnpm spawn on the common path.
    expect(await countBuilds(fixture)).toBe(0);
  }, 30_000);

  it("leaves packages outside the repo plugin root untouched", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-npm-"));
    cleanupPaths.add(tempRoot);
    const fixture = await createPluginFixture("npm-installed", { rootDir: tempRoot });
    const pluginId = await seedReadyPlugin(fixture);

    const { loader } = createActivationLoader();
    const result = await loader.loadSingle(pluginId);

    // An npm-installed package ships its own build output; rebuilding it is not this
    // host's business, so activation reports the fault instead of acting on it.
    expect(result.success).toBe(false);
    expect(await countBuilds(fixture)).toBe(0);
    expect(existsSync(path.join(fixture.distDir, "manifest.js"))).toBe(false);
    expect(result.error).toContain("the package is not built");
    expect(result.error).not.toContain("from the repo root and retry");
  }, 30_000);

  it("names the unbuilt manifest path instead of claiming the package changed", async () => {
    process.env["PAPERCLIP_DISABLE_PLUGIN_AUTOBUILD"] = "1";
    const fixture = await createPluginFixture("unbuilt-message");
    cleanupPaths.add(fixture.packageRoot);
    const pluginId = await seedReadyPlugin(fixture);

    const { loader } = createActivationLoader();
    const result = await loader.loadSingle(pluginId);

    expect(result.success).toBe(false);
    expect(result.error).toContain(path.join(fixture.distDir, "manifest.js"));
    expect(result.error).toContain("the package is not built");
    expect(result.error).toContain(`pnpm --filter ${fixture.packageName} build`);
    // The old message asserted a change in a package that had not changed.
    expect(result.error).not.toContain("no longer exposes a Paperclip manifest");
  }, 30_000);

  it("keeps the manifest-contract message for a package that declares no manifest", async () => {
    const fixture = await createPluginFixture("no-manifest-entrypoint", {
      declareManifestEntrypoint: false,
      buildDistImmediately: true,
    });
    cleanupPaths.add(fixture.packageRoot);
    const pluginId = await seedReadyPlugin(fixture);

    const { loader } = createActivationLoader();
    const result = await loader.loadSingle(pluginId);

    expect(result.success).toBe(false);
    expect(result.error).toContain("no longer exposes a Paperclip manifest");
    expect(await countBuilds(fixture)).toBe(0);
  }, 30_000);

  it("reports an unreadable package.json as its own fault", async () => {
    const fixture = await createPluginFixture("no-package-json");
    cleanupPaths.add(fixture.packageRoot);
    await rm(path.join(fixture.packageRoot, "package.json"), { force: true });
    const pluginId = await seedReadyPlugin(fixture);

    const { loader } = createActivationLoader();
    const result = await loader.loadSingle(pluginId);

    expect(result.success).toBe(false);
    expect(result.error).toContain("has no readable package.json at");
    expect(result.error).toContain(fixture.packageRoot);
    expect(result.error).not.toContain("no longer exposes a Paperclip manifest");
  }, 30_000);
});
