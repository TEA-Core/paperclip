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
  // npm 11 ships a stub bin/opencode.exe; the real binary only exists after
  // the postinstall runs, so the install must carry an explicit allow-scripts.
  assert.match(
    productionStage,
    /npm install --global[^\n]*--allow-scripts=opencode-ai[^\n]*opencode-ai@1\.18\.33/,
  );
  assert.match(
    productionStage,
    /test "\$\(\/usr\/local\/bin\/opencode --version\)" = "1\.18\.33"/,
  );
  // npm links global bins as symlinks into lib/node_modules, so the resolution
  // check must accept that layout instead of demanding a real file at
  // /usr/local/bin/opencode.
  assert.match(
    productionStage,
    /test "\$\(command -v opencode\)" = "\/usr\/local\/bin\/opencode"/,
  );
  assert.match(
    productionStage,
    /case "\$\(readlink -f \/usr\/local\/bin\/opencode\)" in[\s\S]{0,300}\/usr\/local\/lib\/node_modules\/opencode-ai\/bin\/\*/,
  );
  assert.match(productionStage, /test ! -e \/usr\/local\/bin\/opencode2/);
});

test("OpenCode V2 is installed off PATH at a pinned version and digest", () => {
  assert.match(productionStage, /OPENCODE_V2_VERSION=2\.0\.26/);
  assert.match(productionStage, /OPENCODE_V2_PACKAGE=@opencode\/cli@2\.0\.26/);
  assert.match(
    productionStage,
    /npm install --global --omit=dev --allow-scripts=@opencode\/cli --prefix \/opt\/opencode-v2/,
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
  // The V2 exec probe must point HOME at /tmp: V2 (bun) creates
  // $HOME/.local/share/opencode/log even for --version, and /paperclip is
  // node-owned at build time.
  assert.match(
    productionStage,
    /gosu node-agent env HOME=\/tmp \/opt\/opencode-v2\/bin\/opencode --version/,
  );
});
