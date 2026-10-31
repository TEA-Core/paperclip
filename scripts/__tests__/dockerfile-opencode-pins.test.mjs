import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  assert.match(productionStage, /opencode-ai@1\.19\.5/);
  assert.doesNotMatch(
    productionStage,
    /npm install --global[^\n]*\sopencode-ai(?!@1\.19\.5)\b/,
  );
  // npm 11 ships a stub bin/opencode.exe; the real binary only exists after
  // the postinstall runs, so the install must carry an explicit allow-scripts.
  assert.match(
    productionStage,
    /npm install --global[^\n]*--allow-scripts=opencode-ai[^\n]*opencode-ai@1\.19\.5/,
  );
  assert.match(
    productionStage,
    /test "\$\(\/usr\/local\/bin\/opencode --version\)" = "1\.19\.5"/,
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
  assert.match(productionStage, /OPENCODE_V2_VERSION=2\.2\.4/);
  assert.match(productionStage, /OPENCODE_V2_PACKAGE=@opencode\/cli@2\.2\.4/);
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
    /OPENCODE_V2_SHA256=25facd7099c19018e83dce858f3ab922cd2d49ad29b144bc36968418ca6eb5aa/,
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

test("V1 router-plugin fixture is the pinned fleet copy (baseline launch evidence)", () => {
  // Fixture of the V1 router plugin from TEA-Core/sectoid-stack-admin
  // paperclip-docker/config/opencode-plugin @ 2664878e38f33e84a3789a277c6f2c4bb352ec22,
  // with the internal router endpoint defaults replaced by placeholders and
  // internal statistics dropped from comments (this repo is public).
  // That repo is private, so the CI launch assertion cannot fetch the plugin
  // and ships this copy instead. If the fleet plugin changes, update this pin
  // deliberately: the baseline assertion is only meaningful against a recorded
  // plugin revision, so silent drift must fail here rather than in CI.
  const fixtureDir = path.join(repoRoot, "scripts", "opencode-v1-plugin-fixture");
  const pins = [
    ["plugin/router-catalog.js", "cb190e262b684e7cf8ba12846238743ba49eae4ea979433fe6a60d0d1dc3f298"],
    ["router-catalog/lib.mjs", "f91851810329bf27a7b0ff835a8a0c1311020aec421e6332c3af152e9663ba64"],
  ];
  for (const [rel, sha] of pins) {
    const digest = createHash("sha256")
      .update(readFileSync(path.join(fixtureDir, rel)))
      .digest("hex");
    assert.equal(
      digest,
      sha,
      `scripts/opencode-v1-plugin-fixture/${rel} drifted from the pinned fleet revision`,
    );
  }
});

test("CI launches the baseline V1 agent with the V1 router plugin on every PR", () => {
  // An assertion nobody runs is worse than no assertion: pin the wiring of the
  // in-image launch probe, not just its existence.
  const dockerWorkflow = readFileSync(path.join(repoRoot, ".github", "workflows", "docker.yml"), "utf8");
  const job = dockerWorkflow.slice(dockerWorkflow.indexOf("docker-build-assert:"));
  assert.match(job, /Assert baseline V1 agent launch with the V1 router plugin/);
  assert.match(job, /assert-opencode-v1-baseline-launch\.sh:\/probe\.sh:ro/);
  assert.match(job, /opencode-v1-plugin-fixture:\/v1-plugin-fixture:ro/);
  assert.match(job, /paperclip:pr \/probe\.sh/);
  // The probe must keep launching the PATH V1 as the agent principal, not the
  // off-PATH V2.
  const probe = readFileSync(
    path.join(repoRoot, "scripts", "assert-opencode-v1-baseline-launch.sh"),
    "utf8",
  );
  assert.match(probe, /V1_BIN="\$\{V1_BIN:-\/usr\/local\/bin\/opencode\}"/);
  assert.match(probe, /V1_LAUNCH_GOSU="\$\{V1_LAUNCH_GOSU-gosu node-agent\}"/);
  assert.match(probe, /test "\$\(command -v opencode\)" = \/usr\/local\/bin\/opencode/);
  assert.match(probe, /test "\$V1_VERSION" = "1\.19\.5"/);
  assert.match(probe, /--model router\/coder/);
  assert.doesNotMatch(probe, /opencode-v2/);
});
