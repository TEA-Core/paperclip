import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const entrypoint = readFileSync(path.join(repoRoot, "scripts/docker-entrypoint.sh"), "utf8");
const dockerWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/docker.yml"), "utf8");
const probe = readFileSync(path.join(repoRoot, "scripts/assert-secrets-hardening.sh"), "utf8");

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

test("the docker workflow runs the secrets hardening probe on every PR", () => {
  const job = dockerWorkflow.slice(dockerWorkflow.indexOf("docker-build-assert:"));
  assert.match(job, /target: production/, "the assert job must build the production stage");
  assert.match(
    job,
    /scripts\/assert-secrets-hardening\.sh:\/probe\.sh:ro/,
    "must mount and run scripts/assert-secrets-hardening.sh inside the built image",
  );
  assert.match(job, /-e EXPECTED_KEY=/, "must pass the expected key value to the probe");
});

test("the secrets probe does not run the container as uid 1000 directly", () => {
  // Regression guard for the shape this replaced: `docker run -u 1000:1000` makes
  // the entrypoint take its unprivileged branch, so /etc/paperclip/secrets is
  // never created and the probes measure ENOENT instead of EACCES — `rm -f` on a
  // missing path even exits 0. The hardening only exists after the root phase, so
  // the probe must start as root and drop through the entrypoint.
  const job = dockerWorkflow.slice(dockerWorkflow.indexOf("docker-build-assert:"));
  const secretsProbeStep = job.slice(job.indexOf("assert-secrets-hardening.sh"));
  assert.doesNotMatch(
    secretsProbeStep.split("- name:")[0],
    /-u 1000:1000/,
    "the secrets probe must not bypass the entrypoint's root phase with -u 1000:1000",
  );
});

test("the probe asserts the hardened state, the denials, and the key handoff", () => {
  assert.match(
    probe,
    /chown -R node:node \/etc\/paperclip/,
    "must seed the pre-fix node-owned state so a no-op entrypoint cannot pass",
  );
  assert.match(probe, /!= "0 0 700"/, "must assert the directory is root:root mode 0700");
  assert.match(probe, /!= "0 0 600"/, "must assert master.key is root:root mode 0600");
  assert.match(probe, /\[ "\$uid" != "1000" \]/, "must assert the probe phase runs as uid 1000");

  for (const denial of [
    /must_fail "read of master\.key" cat/,
    /must_fail "listing of \$SECRETS_DIR" ls/,
    /must_fail "create in \$SECRETS_DIR" touch/,
    /must_fail "unlink of master\.key" rm -f/,
  ]) {
    assert.match(probe, denial, `must probe the denial: ${denial}`);
  }

  assert.match(
    probe,
    /"\$\{PAPERCLIP_SECRETS_MASTER_KEY:-\}" != "\$EXPECTED_KEY"/,
    "must prove the server still inherits the key across the gosu drop",
  );
  assert.doesNotMatch(
    probe,
    /echo[^\n]*\$\{?PAPERCLIP_SECRETS_MASTER_KEY|echo[^\n]*\$\{?EXPECTED_KEY/,
    "must never echo the key value",
  );
});
