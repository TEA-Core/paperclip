import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(
  path.join(repoRoot, ".github", "workflows", "fold-deploy-gate.yml"),
  "utf8",
);

test("fold-deploy-gate workflow triggers on fold/** branches", () => {
  assert.match(
    workflow,
    /branches:\n\s+- 'fold\/\*\*'\n/,
    "workflow must trigger on fold/** branches",
  );
});

test("fold-deploy-gate workflow runs docker build", () => {
  assert.match(
    workflow,
    /docker\/build-push-action@v7/,
    "workflow must use docker/build-push-action to build the image",
  );
});

test("fold-deploy-gate docker build step loads the image (does not push)", () => {
  assert.match(
    workflow,
    /load: true/,
    "docker build step must use load: true (no push to registry)",
  );
});

test("fold-deploy-gate docker build step uses the repository context", () => {
  assert.match(
    workflow,
    /context: \./,
    "docker build step must use the repository root as context",
  );
});

test("fold-deploy-gate docker build step has a failure report", () => {
  assert.match(
    workflow,
    /Report — docker build/,
    "workflow must have a report step for docker build failures",
  );
  assert.match(
    workflow,
    /paperclipOpenWorkSession/,
    "docker build failure report must mention paperclipOpenWorkSession",
  );
});

test("fold-deploy-gate workflow timeout accommodates docker build", () => {
  const timeoutMatch = workflow.match(/timeout-minutes:\s+(\d+)/);
  assert.ok(timeoutMatch, "workflow must set a timeout-minutes");
  const timeout = parseInt(timeoutMatch[1], 10);
  assert.ok(
    timeout >= 60,
    `workflow timeout (${timeout}) must be at least 60 minutes to accommodate docker build`,
  );
});
