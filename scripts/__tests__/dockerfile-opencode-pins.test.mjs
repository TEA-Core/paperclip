import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const instructions = dockerfile
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");
const productionStage = instructions.slice(instructions.indexOf("FROM base AS production"));

test("PATH OpenCode stays the pinned V1 package and is version-checked", () => {
  assert.match(productionStage, /opencode-ai@1\.18\.33/);
  assert.doesNotMatch(
    productionStage,
    /npm install --global[^\n]*\sopencode-ai(?!@1\.18\.33)\b/,
  );
  assert.match(
    productionStage,
    /test "\$\(\/usr\/local\/bin\/opencode --version\)" = "1\.18\.33"/,
  );
  assert.match(productionStage, /test ! -e \/usr\/local\/bin\/opencode2/);
});

test("OpenCode V2 is installed off PATH at a pinned version and digest", () => {
  assert.match(productionStage, /OPENCODE_V2_VERSION=2\.0\.26/);
  assert.match(productionStage, /OPENCODE_V2_PACKAGE=@opencode\/cli@2\.0\.26/);
  assert.match(
    productionStage,
    /npm install --global --omit=dev --prefix \/opt\/opencode-v2/,
  );
  assert.doesNotMatch(
    productionStage,
    /npm install --global(?![^\n]*--prefix \/opt\/opencode-v2)[^\n]*@opencode\/cli/,
  );
  assert.match(
    productionStage,
    /test "\$\(\/opt\/opencode-v2\/bin\/opencode --version\)" = "opencode v\$\{OPENCODE_V2_VERSION\}"/,
  );
  assert.match(
    productionStage,
    /OPENCODE_V2_SHA256=d9123b9bcdb0a31f7ab9fe9812b58a9dc1768ad6d97e7b276dff1181813218c9/,
  );
  assert.match(
    productionStage,
    /sha256sum \/opt\/opencode-v2\/lib\/node_modules\/@opencode\/cli\/bin\/opencode\.exe/,
  );
  assert.match(
    productionStage,
    /test "\$\(cat \/opt\/opencode-v2\/OPENCODE_V2_SHA256\)" = "\$\{OPENCODE_V2_SHA256\}"/,
  );
  assert.match(productionStage, /> \/opt\/opencode-v2\/OPENCODE_V2_SHA256/);
  assert.match(productionStage, /chown -R root:root \/opt\/opencode-v2/);
  assert.match(productionStage, /chmod -R a-w \/opt\/opencode-v2/);
  assert.match(
    productionStage,
    /gosu node-agent test -x \/opt\/opencode-v2\/bin\/opencode/,
  );
  assert.match(
    productionStage,
    /gosu node-agent test ! -w \/opt\/opencode-v2\/bin\/opencode/,
  );
});
