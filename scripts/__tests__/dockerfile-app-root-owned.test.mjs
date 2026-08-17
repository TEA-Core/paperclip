import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const dockerWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/docker.yml"), "utf8");

// Negative assertions run against instructions only: the Dockerfile comments
// spell out the modes that must NOT be applied, so matching prose would fail
// the test for documenting the hazard.
const dockerfileInstructions = dockerfile
  .split("\n")
  .filter(line => !line.trimStart().startsWith("#"))
  .join("\n");

const productionStage = dockerfileInstructions.slice(
  dockerfileInstructions.indexOf("FROM base AS production"),
);

// The runtime tree at /app holds the code the control plane actually executes.
// The server runs as uid 1000 and agent runs land on the same or a neighbouring
// unprivileged uid, so anything writable there is code an agent can rewrite --
// including forging content-based deploy probes. Root ownership is the property;
// what is pinned here is the set of edits that would silently void it while
// leaving a working-looking image behind.

test("the copy into the production stage does not hand /app to the runtime user", () => {
  const copy = productionStage.match(/^COPY .*--from=build \/app \/app$/m);
  assert.ok(copy, "the production stage must copy the built tree from the build stage");
  assert.doesNotMatch(
    copy[0],
    /--chown=/,
    "COPY must not --chown the runtime tree: node:node ownership is the write path this closes",
  );
});

test("/app is chowned to root recursively in the production stage", () => {
  assert.match(
    productionStage,
    /chown -R root:root \/app/,
    "the production stage must recursively root-own /app",
  );
});

test("group and other lose write on /app", () => {
  assert.match(
    productionStage,
    /chmod -R go-w \/app/,
    "the production stage must strip group/other write from /app",
  );
});

test("hardening does not strip executable bits from the runtime tree", () => {
  // /app ships files that must stay executable: the esbuild binary the tsx
  // loader in CMD spawns, node_modules/.bin targets, and the bundled skill
  // helpers agents invoke directly (doc/AGENT-ARTIFACTS.md). A blanket file
  // chmod leaves a readable tree that fails with EACCES on first exec, which is
  // an image that boots and then breaks rather than one that fails the build.
  assert.doesNotMatch(
    productionStage,
    /find \/app -type f[^\n]*chmod\s+0?644/,
    "must not normalise every file under /app to 0644 -- that strips exec bits",
  );
  assert.doesNotMatch(
    productionStage,
    /chmod -R (?:0?644|a-x|ugo-x|go-x)\b[^\n]*\/app/,
    "must not recursively drop exec bits on /app",
  );
});

test("the image itself proves both halves of the property on every PR", () => {
  const job = dockerWorkflow.slice(dockerWorkflow.indexOf("docker-build-assert:"));
  assert.match(job, /target: production/, "the assert job must build the production stage");

  // Write path closed.
  assert.match(
    job,
    /docker run --rm -u 1000:1000 [^\n]*touch \/app\//,
    "must prove uid 1000 cannot create files under /app",
  );
  assert.match(
    job,
    /docker run --rm -u 1000:1000 [^\n]*execute\.ts/,
    "must prove uid 1000 cannot overwrite executed source under /app",
  );

  // Read+exec path intact. Without this, a hardening change that bricks the
  // image passes every remaining assertion in the job.
  assert.match(
    job,
    /probe\.ts/,
    "must run a real tsx transform under uid 1000, which is what spawns the esbuild binary",
  );
  assert.match(
    job,
    /test -x \/app\/skills\/paperclip\/scripts\/paperclip-upload-artifact\.sh/,
    "must prove a bundled skill helper is still executable under uid 1000",
  );
});

test("the docker workflow runs on pull requests that touch the image", () => {
  const trigger = dockerWorkflow.slice(0, dockerWorkflow.indexOf("permissions:"));
  assert.match(trigger, /pull_request:/, "image changes must be asserted before merge, not after");
  assert.match(trigger, /- "Dockerfile"/, "Dockerfile edits must trigger the assert job");
  assert.match(
    trigger,
    /- "\.github\/workflows\/docker\.yml"/,
    "edits to the assert job itself must trigger it",
  );
});
