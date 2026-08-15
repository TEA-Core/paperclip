import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const entrypoint = readFileSync(path.join(repoRoot, "scripts/docker-entrypoint.sh"), "utf8");
const dockerWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/docker.yml"), "utf8");

// The secrets directory at /etc/paperclip/secrets holds master.key. The server
// and agent runs both run as uid 1000, so DAC cannot distinguish them — the
// directory must be root-owned and the key handed to the server via the
// environment before the gosu drop. This test pins the entrypoint shape that
// enforces that property, so a regression that re-chowns to node or drops the
// env export fails the build.

test("entrypoint root-owns /etc/paperclip/secrets with mode 0700", () => {
  assert.match(
    entrypoint,
    /install -d -m 0700 -o root -g root \/etc\/paperclip\/secrets/,
    "must create the secrets directory as root:root with mode 0700",
  );
});

test("entrypoint does not chown /etc/paperclip/secrets to node", () => {
  assert.doesNotMatch(
    entrypoint,
    /chown\s+node:node\s+\/etc\/paperclip\/secrets/,
    "must not chown the secrets directory to node — that re-opens the write path for agent runs",
  );
});

test("entrypoint exports PAPERCLIP_SECRETS_MASTER_KEY from the file before gosu drop", () => {
  assert.match(
    entrypoint,
    /PAPERCLIP_SECRETS_MASTER_KEY="\$\([^)]*cat \/etc\/paperclip\/secrets\/master\.key[^)]*\)"/,
    "must read the master key from the file and assign it to the env var",
  );
  assert.match(
    entrypoint,
    /export PAPERCLIP_SECRETS_MASTER_KEY/,
    "must export the env var so gosu inherits it",
  );
});

test("entrypoint does not echo the master key", () => {
  // The key must never appear in logs. `set -x` is not used in this script
  // (it starts with `set -e`), but guard against any echo/cat of the var.
  assert.doesNotMatch(
    entrypoint,
    /echo.*\$\{?PAPERCLIP_SECRETS_MASTER_KEY/,
    "must never echo the master key value",
  );
  // Check for `set -x` as a command (not in a comment). The entrypoint starts
  // with `set -e`; `set -x` would leak the key value on assignment.
  const entrypointInstructions = entrypoint
    .split("\n")
    .filter(line => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(
    entrypointInstructions,
    /^set -x\b/m,
    "must never run under set -x — that would leak the key on assignment",
  );
});

test("entrypoint guards the key-absent case (no generation path)", () => {
  // The export must be conditional on the file existing; when absent, nothing
  // is exported and the existing ALLOW_KEY_GENERATION guard in the server
  // behaves exactly as before.
  assert.match(
    entrypoint,
    /if \[ -f \/etc\/paperclip\/secrets\/master\.key \]/,
    "must only export the key when the file exists",
  );
  assert.doesNotMatch(
    entrypoint,
    /PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION|generate.*key|openssl/gi,
    "must not introduce a key-generation path in the entrypoint",
  );
});

test("entrypoint exports before the gosu drop", () => {
  const exportIdx = entrypoint.indexOf("export PAPERCLIP_SECRETS_MASTER_KEY");
  const gosuIdx = entrypoint.indexOf('exec gosu node "$@"');
  assert.ok(exportIdx !== -1, "must export the key");
  assert.ok(gosuIdx !== -1, "must exec gosu node");
  assert.ok(
    exportIdx < gosuIdx,
    "the env export must come before exec gosu node so gosu inherits it",
  );
});

test("the docker workflow proves both secrets EACCES assertions on every PR", () => {
  const job = dockerWorkflow.slice(dockerWorkflow.indexOf("docker-build-assert:"));
  assert.match(job, /target: production/, "the assert job must build the production stage");

  // Write path closed: uid 1000 cannot create files in the secrets directory.
  assert.match(
    job,
    /docker run --rm -u 1000:1000 [^\n]*touch \/etc\/paperclip\/secrets\/\.probe/,
    "must prove uid 1000 cannot create files under /etc/paperclip/secrets",
  );

  // Unlink path closed: uid 1000 cannot remove master.key.
  assert.match(
    job,
    /docker run --rm -u 1000:1000 [^\n]*rm -f \/etc\/paperclip\/secrets\/master\.key/,
    "must prove uid 1000 cannot unlink master.key",
  );
});
