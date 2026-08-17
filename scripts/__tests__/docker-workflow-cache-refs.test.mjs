import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/docker.yml"), "utf8");

// `github.repository` expands with the owner's original casing (for example
// `TEA-Core/paperclip`). `docker/metadata-action` lowercases its `images:`
// input, but buildx passes `cache-from`/`cache-to` refs straight to the
// registry cache exporter, which rejects uppercase:
//
//   invalid reference format: repository name (TEA-Core/paperclip) must be lowercase
//
// Both image builds fail at the cache step, so no image is published. The fix
// computes a lowercase slug into `REPO_SLUG` per job and uses it in every
// registry cache ref. These tests pin that shape.

const lines = dockerWorkflow.split("\n");

function cacheRefLines() {
  return lines
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /^\s*cache-(from|to):/.test(line));
}

// Split the workflow into jobs so slug-definition can be checked per job: each
// job runs on its own runner, so a `GITHUB_ENV` write in one job is not visible
// in another.
function jobs() {
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (match) found.push({ name: match[1], start: i });
  }
  return found.map((job, index) => ({
    name: job.name,
    body: lines.slice(job.start, found[index + 1]?.start ?? lines.length).join("\n"),
  }));
}

test("no registry cache ref uses the raw mixed-case github.repository", () => {
  const offenders = cacheRefLines().filter(({ line }) => /github\.repository/.test(line));
  assert.deepEqual(
    offenders.map(({ number, line }) => `${number}: ${line.trim()}`),
    [],
    "cache refs must use the lowercase slug: an uppercase owner fails the registry cache exporter",
  );
});

test("every registry cache ref resolves through the lowercase slug", () => {
  const registryRefs = cacheRefLines().filter(({ line }) => /type=registry/.test(line));
  assert.ok(registryRefs.length > 0, "docker.yml must still publish a registry-backed build cache");
  for (const { number, line } of registryRefs) {
    assert.match(
      line,
      /env\.REPO_SLUG/,
      `line ${number} must build its registry ref from REPO_SLUG: ${line.trim()}`,
    );
  }
});

test("each job that reads REPO_SLUG also computes it from github.repository", () => {
  const consumers = jobs().filter(job => /env\.REPO_SLUG/.test(job.body));
  assert.ok(consumers.length > 0, "at least one job must consume the lowercase slug");
  for (const job of consumers) {
    // `tr '[:upper:]' '[:lower:]'` on `github.repository`, written to
    // `GITHUB_ENV` so later steps in the same job can read it.
    assert.match(
      job.body,
      /REPO_SLUG=\$\(echo '\$\{\{ github\.repository \}\}' \| tr '\[:upper:\]' '\[:lower:\]'\)[^\n]*GITHUB_ENV/,
      `job \`${job.name}\` reads env.REPO_SLUG but never writes it to GITHUB_ENV`,
    );
  }
});

test("the slug is computed before the first step that reads it", () => {
  for (const job of jobs()) {
    const definition = job.body.indexOf("REPO_SLUG=$(echo");
    const firstUse = job.body.indexOf("env.REPO_SLUG");
    if (firstUse === -1) continue;
    assert.ok(
      definition !== -1 && definition < firstUse,
      `job \`${job.name}\` must compute REPO_SLUG before the step that uses it`,
    );
  }
});
