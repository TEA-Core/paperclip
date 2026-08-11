import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readBuildStage() {
  const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const buildStage = dockerfile.split(/^FROM .* AS build$/m)[1]?.split(/^FROM /m)[0] ?? "";
  assert.ok(buildStage.trim(), "expected the Dockerfile to declare a `FROM ... AS build` stage");
  return buildStage;
}

function filterBuildIndex(buildStage, packageName) {
  return buildStage.indexOf(`pnpm --filter ${packageName} build`);
}

/** Maps every workspace package name to its directory, scanning `packages/` two levels deep. */
function workspacePackageDirs() {
  const dirs = new Map();

  const visit = (absolute, depth) => {
    const manifest = path.join(absolute, "package.json");
    if (existsSync(manifest)) {
      const { name } = JSON.parse(readFileSync(manifest, "utf8"));
      if (name && !dirs.has(name)) dirs.set(name, absolute);
    }
    if (depth === 0) return;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules") continue;
      visit(path.join(absolute, entry.name), depth - 1);
    }
  };

  visit(path.join(repoRoot, "packages"), 2);
  for (const topLevel of ["server", "ui", "cli"]) {
    visit(path.join(repoRoot, topLevel), 0);
  }

  return dirs;
}

test("the Dockerfile build stage compiles @paperclipai/mcp-server", () => {
  // The image resolves the MCP server from its compiled `dist/` (its bin entry is
  // ./dist/stdio.js), so an unbuilt package ships an MCP server that cannot serve
  // any tool to a connecting client.
  assert.ok(
    filterBuildIndex(readBuildStage(), "@paperclipai/mcp-server") >= 0,
    "expected the build stage to build @paperclipai/mcp-server",
  );
});

test("every workspace dependency of @paperclipai/mcp-server is built before it", () => {
  const buildStage = readBuildStage();
  const packageDirs = workspacePackageDirs();

  const mcpServerDir = packageDirs.get("@paperclipai/mcp-server");
  assert.ok(mcpServerDir, "expected to locate the @paperclipai/mcp-server package");

  const mcpServerBuildIndex = filterBuildIndex(buildStage, "@paperclipai/mcp-server");
  const { dependencies = {} } = JSON.parse(
    readFileSync(path.join(mcpServerDir, "package.json"), "utf8"),
  );

  const workspaceDeps = Object.entries(dependencies)
    .filter(([, range]) => typeof range === "string" && range.startsWith("workspace:"))
    .map(([name]) => name);

  assert.ok(workspaceDeps.length > 0, "expected @paperclipai/mcp-server to have workspace deps");

  for (const dep of workspaceDeps) {
    const depDir = packageDirs.get(dep);
    assert.ok(depDir, `expected to locate the ${dep} package`);

    const { scripts = {} } = JSON.parse(readFileSync(path.join(depDir, "package.json"), "utf8"));
    if (!scripts.build) continue;

    const depBuildIndex = filterBuildIndex(buildStage, dep);
    assert.ok(
      depBuildIndex >= 0,
      `@paperclipai/mcp-server depends on ${dep}, but the build stage never builds it`,
    );
    assert.ok(
      depBuildIndex < mcpServerBuildIndex,
      `expected the build stage to build ${dep} before @paperclipai/mcp-server`,
    );
  }
});
