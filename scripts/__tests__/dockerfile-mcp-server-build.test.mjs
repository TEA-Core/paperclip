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

test("Dockerfile packs shared and mcp-server into self-contained tarballs", () => {
  assert.match(
    dockerfile,
    /npm pack --pack-destination \/opt\/paperclip-mcp-tarballs/,
    "Dockerfile must npm pack both packages into a tarballs directory"
  );
  assert.match(
    dockerfile,
    /packages\/shared/,
    "Dockerfile must pack the shared package"
  );
  assert.match(
    dockerfile,
    /packages\/mcp-server/,
    "Dockerfile must pack the mcp-server package"
  );
});

test("Dockerfile installs packed tarballs into a global prefix with --omit=dev", () => {
  assert.match(
    dockerfile,
    /npm install --global --omit=dev --prefix \/opt\/paperclip-mcp/,
    "Dockerfile must npm install --global --omit=dev --prefix /opt/paperclip-mcp"
  );
  assert.match(
    dockerfile,
    /paperclipai-shared-\*\.tgz/,
    "Dockerfile must install the shared tarball"
  );
  assert.match(
    dockerfile,
    /paperclipai-mcp-server-\*\.tgz/,
    "Dockerfile must install the mcp-server tarball"
  );
});

test("Dockerfile patches workspace:* in the mcp-server tarball before installing it", () => {
  assert.match(
    dockerfile,
    /SHARED_VER=\$\(node -p "require\('\/opt\/paperclip-mcp\/lib\/node_modules\/@paperclipai\/shared\/package\.json'\)\.version"\)/,
    "Dockerfile must extract the shared version from the installed package"
  );
  assert.match(
    dockerfile,
    /sed -i.*workspace.*SHARED_VER.*\/tmp\/mcp-patch\/package\/package\.json/,
    "Dockerfile must sed-replace workspace:* with the shared version in the tarball"
  );
});

test("Dockerfile build stage includes a JSON-RPC handshake that verifies the binary starts", () => {
  assert.match(
    dockerfile,
    /paperclip-mcp-server/,
    "Dockerfile handshake must reference the installed binary"
  );
  assert.match(
    dockerfile,
    /tools\/list/,
    "Dockerfile handshake must send tools/list"
  );
  assert.match(
    dockerfile,
    /paperclipOpenWorkSession/,
    "Dockerfile handshake must assert paperclipOpenWorkSession is present"
  );
});

test("Dockerfile production stage copies the self-contained MCP tree", () => {
  const productionStage = dockerfile.split(/^FROM .* AS production$/m)[1];
  assert.ok(productionStage, "Dockerfile must have a production stage");
  assert.match(
    productionStage,
    /COPY --chown=node:node --from=build \/opt\/paperclip-mcp \/opt\/paperclip-mcp/,
    "Production stage must COPY --from=build /opt/paperclip-mcp /opt/paperclip-mcp"
  );
});

test("entrypoint copies the self-contained MCP tree into the npm-global volume", () => {
  assert.match(
    entrypoint,
    /MCP_PREFIX=\/opt\/paperclip-mcp/,
    "entrypoint must define MCP_PREFIX pointing to the build-time install"
  );
  assert.match(
    entrypoint,
    /NPM_GLOBAL=\/paperclip\/\.npm-global/,
    "entrypoint must define NPM_GLOBAL"
  );
  assert.match(
    entrypoint,
    /cp -a "\$1\/\." "\$2\/"/,
    "entrypoint must cp -a the MCP tree into the npm-global prefix"
  );
});

test("entrypoint no longer does loose-file-copy of bare dist/ and package.json", () => {
  assert.doesNotMatch(
    entrypoint,
    /cp.*packages\/shared\/dist/,
    "entrypoint must not copy bare shared dist/ (no node_modules tree)"
  );
  assert.doesNotMatch(
    entrypoint,
    /cp.*packages\/mcp-server\/dist/,
    "entrypoint must not copy bare mcp-server dist/ (no node_modules tree)"
  );
  assert.doesNotMatch(
    entrypoint,
    /publishConfig\.exports/,
    "entrypoint must not rewrite shared package.json exports (npm pack handles this)"
  );
});

test("entrypoint only refreshes when the MCP prefix exists", () => {
  assert.match(
    entrypoint,
    /if \[ -d "\$MCP_PREFIX\/lib\/node_modules\/@paperclipai\/mcp-server" \]; then/,
    "entrypoint must guard on the MCP prefix directory existing"
  );
});

test("entrypoint does not manually create bin symlinks (npm install --global handles this)", () => {
  assert.doesNotMatch(
    entrypoint,
    /ln -sf.*paperclip-mcp-server/,
    "entrypoint must not manually symlink paperclip-mcp-server (npm install --global creates the bin entry)"
  );
});

test("entrypoint guards mkdir -p before cp -a on cold volume", () => {
  assert.match(
    entrypoint,
    /mkdir -p/,
    "entrypoint must mkdir -p the target before cp -a"
  );
});
