import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const dockerfile = readFileSync(resolve(repoRoot, "Dockerfile"), "utf8");
const entrypoint = readFileSync(resolve(repoRoot, "scripts", "docker-entrypoint.sh"), "utf8");

test("Dockerfile builds the mcp-server package", () => {
  assert.match(
    dockerfile,
    /RUN pnpm --filter @paperclipai\/mcp-server build/,
    "Dockerfile must build @paperclipai/mcp-server"
  );
});

test("Dockerfile builds the shared package (mcp-server dependency)", () => {
  assert.match(
    dockerfile,
    /RUN pnpm --filter @paperclipai\/shared build/,
    "Dockerfile must build @paperclipai/shared before mcp-server"
  );
});

test("Dockerfile has a verify guard for mcp-server build output", () => {
  assert.match(
    dockerfile,
    /RUN test -f packages\/mcp-server\/dist\/stdio\.js \|\| \(echo "ERROR: mcp-server build output missing" && exit 1\)/,
    "Dockerfile must guard mcp-server dist/stdio.js"
  );
});

test("Dockerfile mcp-server build comes after the shared build", () => {
  const sharedIdx = dockerfile.indexOf("RUN pnpm --filter @paperclipai/shared build");
  const mcpIdx = dockerfile.indexOf("RUN pnpm --filter @paperclipai/mcp-server build");
  assert.notEqual(sharedIdx, -1, "shared build line must exist");
  assert.notEqual(mcpIdx, -1, "mcp-server build line must exist");
  assert.ok(
    sharedIdx < mcpIdx,
    "shared build must precede mcp-server build"
  );
});

test("Dockerfile verify guard comes after the mcp-server build", () => {
  const buildIdx = dockerfile.indexOf("RUN pnpm --filter @paperclipai/mcp-server build");
  const guardIdx = dockerfile.indexOf('test -f packages/mcp-server/dist/stdio.js');
  assert.notEqual(buildIdx, -1, "mcp-server build line must exist");
  assert.notEqual(guardIdx, -1, "mcp-server guard must exist");
  assert.ok(
    buildIdx < guardIdx,
    "verify guard must come after mcp-server build"
  );
});

test("entrypoint refreshes MCP packages into the npm-global prefix", () => {
  assert.match(
    entrypoint,
    /MCP_SERVER_DIST=\/app\/packages\/mcp-server\/dist/,
    "entrypoint must define MCP_SERVER_DIST"
  );
  assert.match(
    entrypoint,
    /SHARED_DIST=\/app\/packages\/shared\/dist/,
    "entrypoint must define SHARED_DIST"
  );
  assert.match(
    entrypoint,
    /NPM_GLOBAL=\/paperclip\/\.npm-global/,
    "entrypoint must define NPM_GLOBAL"
  );
});

test("entrypoint symlinks the bin entry for paperclip-mcp-server", () => {
  assert.match(
    entrypoint,
    /ln -sf \.\.\/lib\/node_modules\/@paperclipai\/mcp-server\/dist\/stdio\.js "\$1\/bin\/paperclip-mcp-server"/,
    "entrypoint must symlink paperclip-mcp-server bin"
  );
});

test("entrypoint only refreshes when both dist artifacts exist", () => {
  assert.match(
    entrypoint,
    /if \[ -f "\$MCP_SERVER_DIST\/stdio\.js" \] && \[ -f "\$SHARED_DIST\/index\.js" \]; then/,
    "entrypoint must guard on both stdio.js and index.js"
  );
});
