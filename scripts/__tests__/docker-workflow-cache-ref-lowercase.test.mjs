import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(
  path.join(repoRoot, ".github", "workflows", "docker.yml"),
  "utf8",
);

// Registry cache refs are OCI references, so they must be lowercase. The raw
// `github.repository` context keeps the owner casing (e.g. TEA-Core/paperclip),
// which makes BuildKit fail with "repository name must be lowercase".
const CACHE_REF_LINE = /^\s*cache-(?:from|to):\s*(\S.*)$/gm;

function cacheRefLines() {
  return [...workflow.matchAll(CACHE_REF_LINE)].map(m => m[1].trim());
}

test("docker.yml has registry cache refs to check", () => {
  assert.ok(cacheRefLines().length > 0, "expected at least one cache-from/cache-to line");
});

test("docker.yml registry cache refs never use raw github.repository", () => {
  for (const line of cacheRefLines()) {
    assert.doesNotMatch(
      line,
      /\$\{\{\s*github\.repository\s*\}\}/,
      `cache ref must not use raw github.repository (not lowercase): ${line}`,
    );
  }
});

test("docker.yml lowercases the repo before using it in cache refs", () => {
  assert.match(
    workflow,
    /repo=\$\{GITHUB_REPOSITORY,,\}/,
    "workflow must compute a lowercased repo from GITHUB_REPOSITORY",
  );

  for (const line of cacheRefLines()) {
    if (!line.includes("type=registry")) continue;
    assert.match(
      line,
      /ghcr\.io\/\$\{\{\s*steps\.image-repo\.outputs\.repo\s*\}\}:/,
      `registry cache ref must use the lowercased repo output: ${line}`,
    );
  }
});
