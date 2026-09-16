import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// BOTH image-publishing workflows. Upstream 5c660a32f relocated the cloud
// build out of docker.yml into docker-cloud.yml and took its registry cache
// refs with it; a guard that reads docker.yml alone stayed green while the
// invariant below was broken in the relocated job. Any workflow that pushes
// to ghcr belongs in this list.
const workflowPaths = [".github/workflows/docker.yml", ".github/workflows/docker-cloud.yml"];
const workflows = workflowPaths.map(relativePath => ({
  path: relativePath,
  text: readFileSync(path.join(repoRoot, relativePath), "utf8"),
}));

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

function linesOf(workflow) {
  return workflow.text.split("\n").map((line, index) => ({ line, number: index + 1 }));
}

function cacheRefLines(workflow) {
  return linesOf(workflow).filter(({ line }) => /^\s*cache-(from|to):/.test(line));
}

// Split the workflow into jobs so slug-definition can be checked per job: each
// job runs on its own runner, so a `GITHUB_ENV` write in one job is not visible
// in another.
function jobs(workflow) {
  const lines = workflow.text.split("\n");
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

for (const workflow of workflows) {
  test(`${workflow.path}: no registry cache ref uses the raw mixed-case github.repository`, () => {
    const offenders = cacheRefLines(workflow).filter(({ line }) => /github\.repository/.test(line));
    assert.deepEqual(
      offenders.map(({ number, line }) => `${number}: ${line.trim()}`),
      [],
      "cache refs must use the lowercase slug: an uppercase owner fails the registry cache exporter",
    );
  });

  test(`${workflow.path}: every registry cache ref resolves through the lowercase slug`, () => {
    const registryRefs = cacheRefLines(workflow).filter(({ line }) => /type=registry/.test(line));
    for (const { number, line } of registryRefs) {
      assert.match(
        line,
        /env\.REPO_SLUG/,
        `line ${number} must build its registry ref from REPO_SLUG: ${line.trim()}`,
      );
    }
  });

  // The cloud job never names a registry ref on its `cache-from:` line: it
  // builds the import list in a shell step from a `CACHE_IMAGE:` env var, and
  // BuildKit rejects an uppercase reference on IMPORT as well as export. Line
  // shape alone therefore cannot express the invariant. What actually holds is
  // that the raw mixed-case expression may appear ONLY where something
  // downstream lowercases it for us: `docker/metadata-action`'s `images:`
  // input, `github.repository_owner` (the ghcr login user, case-insensitive),
  // and the slug computation itself.
  test(`${workflow.path}: no raw ghcr reference is built from github.repository`, () => {
    const offenders = linesOf(workflow).filter(({ line }) => {
      if (!/github\.repository\s*\}\}/.test(line)) return false;
      if (/^\s*images:\s/.test(line)) return false;
      if (/REPO_SLUG=\$\(echo/.test(line)) return false;
      return /ghcr\.io|CACHE_IMAGE|type=registry|imagetools|push-by-digest/.test(line);
    });
    assert.deepEqual(
      offenders.map(({ number, line }) => `${number}: ${line.trim()}`),
      [],
      "raw ghcr references must use env.REPO_SLUG: BuildKit and the daemon reject an uppercase repository name",
    );
  });

  test(`${workflow.path}: each job that reads REPO_SLUG also computes it from github.repository`, () => {
    const consumers = jobs(workflow).filter(job => /env\.REPO_SLUG/.test(job.body));
    assert.ok(consumers.length > 0, `${workflow.path} must consume the lowercase slug somewhere`);
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

  test(`${workflow.path}: the slug is computed before the first step that reads it`, () => {
    for (const job of jobs(workflow)) {
      const definition = job.body.indexOf("REPO_SLUG=$(echo");
      const firstUse = job.body.indexOf("env.REPO_SLUG");
      if (firstUse === -1) continue;
      assert.ok(
        definition !== -1 && definition < firstUse,
        `job \`${job.name}\` must compute REPO_SLUG before the step that uses it`,
      );
    }
  });
}

// Kept whole-repo rather than per-workflow: the point of the list above is
// that it stays complete, and the failure mode this file exists for is a
// publishing job moving to a workflow nobody added here.
test("every workflow with a registry-backed build cache is covered", () => {
  const covered = new Set(workflowPaths);
  const missing = readdirSync(path.join(repoRoot, ".github/workflows"))
    .filter(name => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map(name => `.github/workflows/${name}`)
    .filter(relativePath => !covered.has(relativePath))
    .filter(relativePath =>
      /type=registry,ref=ghcr\.io/.test(readFileSync(path.join(repoRoot, relativePath), "utf8")),
    );
  assert.deepEqual(
    missing,
    [],
    "these workflows push a registry build cache but are not checked for the lowercase slug",
  );
});

// At least one registry-backed cache must survive somewhere, or the tests
// above would pass vacuously on a repo that quietly dropped the cache.
test("the registry-backed build cache still exists", () => {
  const registryRefs = workflows.flatMap(workflow =>
    cacheRefLines(workflow).filter(({ line }) => /type=registry/.test(line)),
  );
  assert.ok(registryRefs.length > 0, "the image builds must still publish a registry-backed build cache");
});
