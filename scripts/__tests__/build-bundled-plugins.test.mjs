import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { listBundledPluginPackages } from "../build-bundled-plugins.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function writePackage(pluginsRoot, dirName, pkgJson) {
  const packageRoot = path.join(pluginsRoot, dirName);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify(pkgJson), "utf8");
  return packageRoot;
}

test("selects only top-level packages that declare paperclipPlugin entrypoints", () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-bundled-plugins-"));
  try {
    writePackage(tempRoot, "plugin-alpha", {
      name: "@paperclipai/plugin-alpha",
      paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" },
    });
    writePackage(tempRoot, "sdk", { name: "@paperclipai/plugin-sdk" });
    writePackage(tempRoot, "create-paperclip-plugin", { name: "@paperclipai/create-paperclip-plugin" });
    // Nested groups are out of scope by construction, not by an exclusion list:
    // examples are never copied into the image and sandbox-providers are not pnpm
    // workspace members, so `pnpm --filter` cannot resolve either.
    writePackage(tempRoot, path.join("examples", "plugin-sample-example"), {
      name: "@paperclipai/plugin-sample-example",
      paperclipPlugin: { manifest: "./dist/manifest.js" },
    });
    writePackage(tempRoot, path.join("sandbox-providers", "acme"), {
      name: "@paperclipai/plugin-acme",
      paperclipPlugin: { manifest: "./dist/manifest.js" },
    });

    const selected = listBundledPluginPackages(tempRoot).map((entry) => entry.name);
    assert.deepEqual(selected, ["@paperclipai/plugin-alpha"]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("returns an empty list for a plugins root that does not exist", () => {
  assert.deepEqual(listBundledPluginPackages(path.join(os.tmpdir(), "paperclip-missing-plugins-root")), []);
});

test("covers every bundled plugin whose manifest the Dockerfile deps stage copies", () => {
  // The deps stage copy list is the set of plugin packages that exist in the image at
  // all. Anything copied there and left unbuilt ships broken, so the two must agree.
  const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const copiedPluginDirs = [...dockerfile.matchAll(/^COPY\s+packages\/plugins\/([^/\s]+)\/package\.json/gm)]
    .map((match) => match[1]);

  const selected = listBundledPluginPackages();
  const selectedDirs = new Set(selected.map((entry) => entry.dirName));

  assert.ok(selected.length > 0, "expected at least one bundled plugin package");

  for (const dirName of copiedPluginDirs) {
    const pkgJsonPath = path.join(repoRoot, "packages", "plugins", dirName, "package.json");
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    if (!pkgJson.paperclipPlugin) continue;
    assert.ok(
      selectedDirs.has(dirName),
      `Dockerfile deps stage copies packages/plugins/${dirName} but the bundled plugin build skips it`,
    );
  }
});

test("the Dockerfile build stage runs the bundled plugin build after the SDK build", () => {
  const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const buildStage = dockerfile.split(/^FROM .* AS build$/m)[1]?.split(/^FROM /m)[0] ?? "";

  const sdkBuildIndex = buildStage.indexOf("pnpm --filter @paperclipai/plugin-sdk build");
  const pluginBuildIndex = buildStage.indexOf("node scripts/build-bundled-plugins.mjs");

  assert.ok(sdkBuildIndex >= 0, "expected the build stage to build @paperclipai/plugin-sdk");
  assert.ok(pluginBuildIndex >= 0, "expected the build stage to run scripts/build-bundled-plugins.mjs");
  // Each plugin's prebuild depends on the SDK's build output.
  assert.ok(sdkBuildIndex < pluginBuildIndex, "expected the SDK build to precede the bundled plugin build");
});
