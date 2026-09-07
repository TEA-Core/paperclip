import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts/ci/check-paperclip-approved.sh");

const REPO = "TEA-Core/paperclip";
const PR = 4242;
const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const QUEUE_REF = `refs/heads/gh-readonly-queue/fold/tea-patches-v2026.722.0/pr-${PR}-0123456789abcdef`;

// The real control-plane App bot, read off a published status on
// TEA-Core/paperclip. A bot user's numeric id is stable for the life of the App.
const TEA_CORE = { id: 317012809, login: "tea-core[bot]", type: "Bot" };
// Any Paperclip-assigned agent holds a `fleet-only` installation token, and that
// installation grants `statuses:write`.
const FLEET_ONLY = { id: 999000111, login: "fleet-only[bot]", type: "Bot" };

// A `gh` stand-in. It refuses the COMBINED status endpoint outright: that
// endpoint omits `creator` from every entry, so a script reading it cannot see
// who published the signal it is enforcing. Refusing it here is what stops this
// hole being reopened by a well-meaning revert to the simpler URL.
const GH_SHIM = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  'url=""',
  'while [ "$#" -gt 0 ]; do',
  '  case "$1" in',
  "    api|--paginate|--slurp) ;;",
  "    -H) shift ;;",
  "    --jq|-q) shift ;;",
  '    *) [ -n "$url" ] || url="$1" ;;',
  "  esac",
  "  shift",
  "done",
  'case "$url" in',
  '  */statuses*)  cat "$GH_SHIM_DIR/statuses.json" ;;',
  '  */status*)    echo "gh shim: the combined /status endpoint omits creator and must not be used" >&2; exit 1 ;;',
  '  */pulls/*)    cat "$GH_SHIM_DIR/pull.json" ;;',
  '  *) echo "gh shim: unexpected call: $url" >&2; exit 1 ;;',
  "esac",
  "",
].join("\n");

function makeFixture(statuses) {
  const dir = mkdtempSync(path.join(tmpdir(), "pc-attribution-"));
  writeFileSync(
    path.join(dir, "pull.json"),
    JSON.stringify({
      head: { sha: HEAD_SHA, ref: "SUP-15270-some-card-branch" },
      body: "an ordinary PR body with no waiver line",
      labels: [],
      user: { login: "fleet-only[bot]" },
    }),
  );
  writeFileSync(path.join(dir, "statuses.json"), JSON.stringify(statuses));

  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const gh = path.join(bin, "gh");
  writeFileSync(gh, GH_SHIM);
  chmodSync(gh, 0o755);
  return { dir, bin };
}

function status(state, creator, context = "paperclip/approved") {
  return { context, state, creator };
}

function run(statuses, { event = "merge_group" } = {}) {
  const fixture = makeFixture(statuses);
  try {
    const args = event === "merge_group" ? [script, event] : [script, event, String(PR)];
    const result = spawnSync("bash", args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.bin}:${process.env.PATH}`,
        GH_SHIM_DIR: fixture.dir,
        GH_REPO: REPO,
        GITHUB_REF: event === "merge_group" ? QUEUE_REF : "",
        GITHUB_REF_NAME: event === "merge_group" ? QUEUE_REF.replace("refs/heads/", "") : "",
      },
    });
    return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

test("a success published by the control-plane App passes", () => {
  const { code, out } = run([status("success", TEA_CORE)]);
  assert.equal(code, 0);
  assert.match(out, /pass: paperclip\/approved = success/);
  assert.match(out, /tea-core\[bot\]/);
});

test("a success published by any other identity is refused as forged", () => {
  // This is the whole hole: `paperclip/approved` is a plain commit status and
  // the fleet installation grants statuses:write to every Paperclip-assigned
  // agent, so before this check an agent could publish its own approval.
  const { code, err } = run([status("success", FLEET_ONLY)]);
  assert.equal(code, 1);
  assert.match(err, /FORGED/);
  assert.match(err, /fleet-only\[bot\]/);
});

test("a success with no creator at all is refused, not trusted", () => {
  const { code, err } = run([status("success", null)]);
  assert.equal(code, 1);
  assert.match(err, /FORGED/);
});

test("the newest status for the context decides, even when an older one is genuine", () => {
  // The list endpoint returns entries newest-first, which is what makes the
  // first match equivalent to the combined endpoint's reported value. A forged
  // status published after a genuine one must not be masked by the genuine one.
  const { code, err } = run([status("success", FLEET_ONLY), status("success", TEA_CORE)]);
  assert.equal(code, 1);
  assert.match(err, /FORGED/);
});

test("an older forged status does not taint a current genuine one", () => {
  const { code } = run([status("success", TEA_CORE), status("success", FLEET_ONLY)]);
  assert.equal(code, 0);
});

test("statuses for other contexts are ignored", () => {
  const { code } = run([
    status("failure", FLEET_ONLY, "verify"),
    status("success", TEA_CORE),
  ]);
  assert.equal(code, 0);
});

test("a pending approval still fails as not-approved, not as forged", () => {
  const { code, err } = run([status("pending", TEA_CORE)]);
  assert.equal(code, 1);
  assert.match(err, /is pending, expected success/);
  assert.doesNotMatch(err, /FORGED/);
});

test("a missing approval fails as missing", () => {
  const { code, err } = run([]);
  assert.equal(code, 1);
  assert.match(err, /is missing, expected success/);
});

test("pull_request stays advisory even for a forged status", () => {
  // The merge queue is the enforcement point; a fail-closed pull_request arm
  // would make every PR red for its whole working life.
  const { code } = run([status("success", FLEET_ONLY)], { event: "pull_request" });
  assert.equal(code, 0);
});
