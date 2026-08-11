import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

test("Dockerfile packs both shared and mcp-server via npm pack", () => {
  assert.match(
    dockerfile,
    /cd packages\/shared && npm pack --pack-destination \/opt\/paperclip-mcp-tarballs/,
    "Dockerfile must npm pack @paperclipai/shared into the tarballs directory",
  );
  assert.match(
    dockerfile,
    /cd packages\/mcp-server && npm pack --pack-destination \/opt\/paperclip-mcp-tarballs/,
    "Dockerfile must npm pack @paperclipai/mcp-server into the tarballs directory",
  );
});

test("Dockerfile applies publishConfig by hand (npm pack does NOT apply it)", () => {
  assert.match(
    dockerfile,
    /pkg\.publishConfig/,
    "Dockerfile must read publishConfig from the packed package.json",
  );
  assert.match(
    dockerfile,
    /for \(const k of \["exports","main","types","bin"\]\)/,
    "Dockerfile must copy publishConfig exports/main/types/bin into real fields",
  );
});

test("Dockerfile pins @paperclipai/shared via file: tarball, not a semver", () => {
  assert.match(
    dockerfile,
    /"file:" \+ sharedTgz/,
    "Dockerfile must rewrite @paperclipai/shared dependency to a file: tarball path",
  );
  assert.doesNotMatch(
    dockerfile,
    /sed -i.*"workspace:\*"/,
    "Dockerfile must NOT use sed workspace:* -> semver rewrite (stale registry shadow)",
  );
});

test("Dockerfile installs mcp-server globally with resolved dependencies", () => {
  assert.match(
    dockerfile,
    /npm install --global --omit=dev --prefix \/opt\/paperclip-mcp/,
    "Dockerfile must npm install --global --omit=dev --prefix /opt/paperclip-mcp",
  );
});

test("Dockerfile build stage includes a JSON-RPC handshake checking for paperclipOpenWorkSession", () => {
  assert.match(
    dockerfile,
    /paperclip-mcp-server/,
    "Dockerfile handshake must reference the installed binary",
  );
  assert.match(
    dockerfile,
    /tools\/list/,
    "Dockerfile handshake must send tools/list",
  );
  assert.match(
    dockerfile,
    /paperclipOpenWorkSession/,
    "Dockerfile handshake must assert paperclipOpenWorkSession is present",
  );
});

test("Dockerfile production stage copies /opt/paperclip-mcp from build stage", () => {
  const productionStage = dockerfile.split(/^FROM .* AS production$/m)[1];
  assert.ok(productionStage, "Dockerfile must have a production stage");
  assert.match(
    productionStage,
    /COPY --chown=node:node --from=build \/opt\/paperclip-mcp \/opt\/paperclip-mcp/,
    "Production stage must COPY --from=build /opt/paperclip-mcp /opt/paperclip-mcp",
  );
});

test("Dockerfile does not leave the tarballs directory in the image", () => {
  assert.match(
    dockerfile,
    /rm -rf \/opt\/paperclip-mcp-tarballs/,
    "Dockerfile must clean up the tarballs directory after install",
  );
});
