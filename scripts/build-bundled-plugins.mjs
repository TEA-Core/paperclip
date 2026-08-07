#!/usr/bin/env node

/**
 * Build every repo-bundled Paperclip plugin and verify its declared entrypoints exist.
 *
 * SUP-11330: bundled plugins declare their `paperclipPlugin` entrypoints as build
 * outputs under a gitignored `dist/`. The Docker build stage built `@paperclipai/ui`,
 * `@paperclipai/plugin-sdk` and `@paperclipai/server` and no plugin, so every image
 * shipped with those entrypoints absent. A plugin only worked until the next image
 * rebuild, because its `dist/` had been produced by install-time auto-build into the
 * running container's writable layer — which dies with the container.
 *
 * Verification is per plugin and per declared entrypoint rather than a single
 * `test -f`: a plugin that builds but drops one of its three entrypoints fails the
 * image build here instead of at activation on a live instance.
 *
 * Scope: the top level of `packages/plugins/`. That is deliberately the same set the
 * Dockerfile deps stage copies package manifests for, and it excludes two nested
 * groups by construction:
 *
 *   - `packages/plugins/examples/*` — authoring samples, not shipped in the image and
 *     not copied by the deps stage, so their dependencies are never installed.
 *   - `packages/plugins/sandbox-providers/*` — excluded from the pnpm workspace on
 *     purpose (see pnpm-workspace.yaml), so `pnpm --filter` cannot resolve them and
 *     they carry their own standalone install/build path.
 *
 * `@paperclipai/plugin-fake-sandbox` IS in scope. It declares real runtime entrypoints
 * and registers as a sandbox provider like any other plugin; leaving it unbuilt keeps
 * the same trap armed for whoever registers it next. Its build is one `tsc`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PLUGINS_ROOT = path.join(REPO_ROOT, "packages", "plugins");
const SDK_PACKAGE_NAME = "@paperclipai/plugin-sdk";
const SDK_BUILD_MARKER = path.join(PLUGINS_ROOT, "sdk", "dist", "index.js");

/**
 * Package names deliberately kept out of the image build. Exclusions live here by
 * name so that dropping a plugin from the build is a visible decision rather than an
 * omission nobody notices until activation fails.
 */
const EXCLUDED_PACKAGE_NAMES = new Set();

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Every top-level `packages/plugins/*` package declaring `paperclipPlugin`
 * entrypoints, minus the explicit exclusions, sorted for a stable build order.
 */
export function listBundledPluginPackages(pluginsRoot = PLUGINS_ROOT) {
  if (!existsSync(pluginsRoot)) return [];

  const packages = [];
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;

    const packageRoot = path.join(pluginsRoot, entry.name);
    const pkgJson = readJsonFile(path.join(packageRoot, "package.json"));
    if (!pkgJson) continue;

    const entrypoints = pkgJson.paperclipPlugin;
    if (entrypoints === null || typeof entrypoints !== "object" || Array.isArray(entrypoints)) continue;

    const name = typeof pkgJson.name === "string" ? pkgJson.name : null;
    if (!name || EXCLUDED_PACKAGE_NAMES.has(name)) continue;

    packages.push({ name, dirName: entry.name, packageRoot, entrypoints });
  }

  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Declared entrypoints that are still absent after a build. A trailing `/` marks a
 * directory entrypoint (`"ui": "./dist/ui/"`), which counts as missing when it is
 * absent OR empty — an empty `dist/ui` loads nothing at runtime.
 */
function listMissingEntrypoints(pluginPackage) {
  const missing = [];

  for (const [key, relativePath] of Object.entries(pluginPackage.entrypoints)) {
    if (typeof relativePath !== "string" || relativePath.length === 0) continue;

    const absolutePath = path.resolve(pluginPackage.packageRoot, relativePath);
    if (!existsSync(absolutePath)) {
      missing.push({ key, absolutePath, reason: "missing" });
      continue;
    }

    if (relativePath.endsWith("/") || statSync(absolutePath).isDirectory()) {
      if (readdirSync(absolutePath).length === 0) {
        missing.push({ key, absolutePath, reason: "empty directory" });
      }
    }
  }

  return missing;
}

function runPnpmBuild(packageName) {
  const result = spawnSync(
    "pnpm",
    ["--filter", packageName, "build"],
    { cwd: REPO_ROOT, stdio: "inherit", env: process.env },
  );

  if (result.error) return `spawn failed: ${result.error.message}`;
  if (result.status !== 0) return `exited with status ${result.status ?? "unknown"}`;
  return null;
}

function main() {
  const pluginPackages = listBundledPluginPackages();

  // A silently empty build is the exact failure this script exists to prevent: it
  // would produce a green image build and an image with no plugin built in it.
  if (pluginPackages.length === 0) {
    console.error(
      `ERROR: no bundled plugin packages found under ${path.relative(REPO_ROOT, PLUGINS_ROOT)}. `
        + "Expected at least one package declaring paperclipPlugin entrypoints.",
    );
    process.exit(1);
  }

  // The SDK must be built before any plugin: each plugin's `prebuild` runs
  // `pnpm --filter @paperclipai/plugin-sdk ensure-build-deps`, which relies on the
  // SDK's own build output. Make that ordering explicit instead of inherited.
  if (!existsSync(SDK_BUILD_MARKER)) {
    console.log(`> building ${SDK_PACKAGE_NAME} (prerequisite)`);
    const sdkFailure = runPnpmBuild(SDK_PACKAGE_NAME);
    if (sdkFailure) {
      console.error(`ERROR: ${SDK_PACKAGE_NAME} build ${sdkFailure}`);
      process.exit(1);
    }
  }

  let failed = false;
  for (const pluginPackage of pluginPackages) {
    console.log(`> building ${pluginPackage.name}`);
    const buildFailure = runPnpmBuild(pluginPackage.name);
    if (buildFailure) {
      console.error(`ERROR: ${pluginPackage.name} build ${buildFailure}`);
      failed = true;
      continue;
    }

    const missing = listMissingEntrypoints(pluginPackage);
    if (missing.length > 0) {
      for (const entrypoint of missing) {
        console.error(
          `ERROR: ${pluginPackage.name} declares "${entrypoint.key}" entrypoint `
            + `${path.relative(REPO_ROOT, entrypoint.absolutePath)} — ${entrypoint.reason} after build.`,
        );
      }
      failed = true;
      continue;
    }

    console.log(`  ok: ${Object.keys(pluginPackage.entrypoints).join(", ")}`);
  }

  if (failed) {
    console.error(
      "Bundled plugin build failed. The image must not ship a plugin whose declared "
        + "entrypoints are absent — it would fail at activation instead.",
    );
    process.exit(1);
  }

  console.log(`PASS: built ${pluginPackages.length} bundled plugin package(s).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
