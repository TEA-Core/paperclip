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

test("entrypoint guards the key-absent case with a gated generation path", () => {
  // The export must be conditional on the file existing; when absent, nothing
  // is exported and the existing ALLOW_KEY_GENERATION guard in the server
  // behaves exactly as before. When the operator has explicitly opted in via
  // PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION=1, the entrypoint's root phase must
  // generate the key as root:root 0600 — not leave it absent, and not create it
  // as node.
  assert.match(
    entrypoint,
    /if \[ -z "\$\{PAPERCLIP_SECRETS_MASTER_KEY:-}" \] && \[ -f \/etc\/paperclip\/secrets\/master\.key \];/,
    "must only export the key when the env key is empty and the file exists",
  );
  assert.match(
    entrypoint,
    /PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION/,
    "must reference the opt-in flag for the generation gate",
  );
  assert.match(
    entrypoint,
    /head -c 32 \/dev\/urandom \| base64/,
    "must generate 32 random bytes base64 to match the provider's key format",
  );
  assert.match(
    entrypoint,
    /chown root:root \/etc\/paperclip\/secrets\/master\.key/,
    "must write the generated key as root:root",
  );
  assert.match(
    entrypoint,
    /chmod 0600 \/etc\/paperclip\/secrets\/master\.key/,
    "must write the generated key with mode 0600",
  );
});

test("entrypoint generation block requires env key to be empty (SUP-13129)", () => {
  // The generation `if` must carry a third conjunct: never mint a key when the
  // operator supplied PAPERCLIP_SECRETS_MASTER_KEY. Precedence: env > file >
  // (opt-in) generated.
  assert.match(
    entrypoint,
    /if \[ ! -f \/etc\/paperclip\/secrets\/master\.key \] && \[ "\$\{PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION:-0\}" = "1" \] && \[ -z "\$\{PAPERCLIP_SECRETS_MASTER_KEY:-}" \];/,
    "generation block must require PAPERCLIP_SECRETS_MASTER_KEY to be empty/unset before minting",
  );
});

test("entrypoint export block requires env key to be empty (SUP-13129)", () => {
  // The export `if` must only fire when PAPERCLIP_SECRETS_MASTER_KEY is
  // empty/unset — an explicitly-provided env key always wins over the file.
  assert.match(
    entrypoint,
    /if \[ -z "\$\{PAPERCLIP_SECRETS_MASTER_KEY:-}" \] && \[ -f \/etc\/paperclip\/secrets\/master\.key \];/,
    "export block must require PAPERCLIP_SECRETS_MASTER_KEY to be empty/unset before reading the file",
  );
});

test("entrypoint warns on env/file disagreement without echoing the key (SUP-13129)", () => {
  // When both the env key is set and the file exists and they differ, the
  // entrypoint must emit ONE warning line to stderr with only 12-hex sha256
  // fingerprints — never the key material.
  assert.match(
    entrypoint,
    /differs from master\.key/,
    "must emit a disagreement warning when env key and file key differ",
  );
  assert.match(
    entrypoint,
    /sha256sum/,
    "must use sha256sum to compute fingerprints for the warning",
  );
  assert.match(
    entrypoint,
    /cut -c1-12/,
    "must truncate fingerprints to 12 hex chars",
  );
  // The warning must go to stderr, not stdout.
  assert.match(
    entrypoint,
    />&2/,
    "the disagreement warning must be written to stderr",
  );
  // Must never echo the key value in the warning.
  assert.doesNotMatch(
    entrypoint,
    /echo.*differs.*PAPERCLIP_SECRETS_MASTER_KEY/,
    "the warning must not echo the env key value",
  );
});

test("entrypoint never runs under set -x (SUP-13129)", () => {
  const entrypointInstructions = entrypoint
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(
    entrypointInstructions,
    /^set -x\b/m,
    "must never run under set -x — that would leak the key on assignment",
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

test("the docker workflow asserts /etc/paperclip/secrets ownership with a failing step", () => {
  const job = dockerWorkflow.slice(dockerWorkflow.indexOf("docker-build-assert:"));
  assert.match(
    job,
    /stat -c[^\n]*root:root 700/,
    "the root-owned step must fail on regressed ownership, not just print",
  );
  assert.doesNotMatch(
    job,
    /ls -ld \/etc\/paperclip\/secrets.*\|\| true/,
    "the root-owned step must not be a print-only step that swallows failures",
  );
  // A `run: |` block keeps its newlines, so a trailing backslash inside the
  // single-quoted `sh -c` script is passed through literally and splices the
  // whole script onto one line: `sh: Syntax error: word unexpected`, which is a
  // step failure that says nothing about the invariant.
  const rootOwnedStep = job.slice(
    job.indexOf("Assert /etc/paperclip/secrets is root-owned"),
    job.indexOf("Assert entrypoint hardens secrets against uid 1000"),
  );
  assert.doesNotMatch(
    rootOwnedStep,
    /\\\n/,
    "the root-owned step's sh -c script must not use backslash line continuations",
  );
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

test("the probe covers the absent-key generation arm", () => {
  assert.match(
    probe,
    /PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION=1/,
    "must run the entrypoint with the opt-in flag to test the generation arm",
  );
  assert.match(
    probe,
    /did not generate master\.key with ALLOW_KEY_GENERATION=1/,
    "must assert the key was generated when the flag is set",
  );
  assert.match(
    probe,
    /did not generate master\.key when ALLOW_KEY_GENERATION is unset/,
    "must assert no key was generated when the flag is absent",
  );
});

test("the probe covers the env-wins matrix (SUP-13129)", () => {
  // Case 1: env set + file present, differing — server must receive env key;
  //         disagreement warning with two 12-hex fingerprints.
  assert.match(
    probe,
    /env-set \+ file-present/,
    "must cover matrix row 1: env set + file present, differing",
  );
  assert.match(
    probe,
    /disagreement warning/,
    "must assert the disagreement warning fires for row 1",
  );
  assert.match(
    probe,
    /server received env key/,
    "must assert the server received the env key for row 1",
  );

  // Case 2: env set + no file + ALLOW_KEY_GENERATION=1 — no file created.
  assert.match(
    probe,
    /env-set \+ no-file \+ generation/,
    "must cover matrix row 2: env set + no file + generation",
  );
  assert.match(
    probe,
    /no file created/,
    "must assert no file was created when env key is set with generation",
  );

  // Case 3: no env + file present — server receives file key (unchanged).
  assert.match(
    probe,
    /no-env \+ file-present/,
    "must cover matrix row 3: no env + file present",
  );
  assert.match(
    probe,
    /server received file key/,
    "must assert the server received the file key for row 3",
  );

  // The probe must print only digests, never key material.
  assert.doesNotMatch(
    probe,
    /echo[^\n]*\$\{?PAPERCLIP_SECRETS_MASTER_KEY|echo[^\n]*\$\{?ENV_KEY|echo[^\n]*\$\{?EXPECTED_KEY/,
    "must never echo the key value in the env-wins matrix",
  );
});
