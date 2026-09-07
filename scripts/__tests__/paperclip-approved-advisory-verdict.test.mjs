import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

const TEA_CORE = { id: 317012809, login: "tea-core[bot]", type: "Bot" };
const FLEET_ONLY = { id: 999000111, login: "fleet-only[bot]", type: "Bot" };

// A `gh` stand-in, modelled on the attribution test's shim. Two additions that
// this verdict test needs:
//   - every call is logged to $GH_SHIM_DIR/calls.log, so a test can assert the
//     advisory leg issues exactly the two read-only GETs and nothing else (no
//     status write, no review spam);
//   - the combined /status endpoint is still refused: it omits `creator`, so a
//     script reading it cannot see who published the signal it reports.
const GH_SHIM = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "url=\"\"",
  "jqfilter=\"\"",
  "while [ \"$#\" -gt 0 ]; do",
  "  case \"$1\" in",
  "    api|--slurp) ;;",
  "    --paginate) ;;",
  "    -H) shift ;;",
  "    --jq|-q) shift; jqfilter=\"$1\" ;;",
  "    *) [ -n \"$url\" ] || url=\"$1\" ;;",
  "  esac",
  "  shift",
  "done",
  "printf '%s\\n' \"$url\" >> \"${GH_SHIM_DIR}/calls.log\"",
  "case \"$url\" in",
  "  */statuses*) jq -r \"$jqfilter\" \"$GH_SHIM_DIR/statuses.json\" ;;",
  "  */status*)    echo \"gh shim: the combined /status endpoint omits creator and must not be used\" >&2; exit 1 ;;",
  "  */pulls/*)    cat \"$GH_SHIM_DIR/pull.json\" ;;",
  "  *) echo \"gh shim: unexpected call: $url\" >&2; exit 1 ;;",
  "esac",
  "",
].join("\n");

function status(state, creator, context = "paperclip/approved") {
  return { context, state, creator };
}

function makeFixture(statuses) {
  const dir = mkdtempSync(path.join(tmpdir(), "pc-verdict-"));
  writeFileSync(
    path.join(dir, "pull.json"),
    JSON.stringify({
      head: { sha: HEAD_SHA, ref: "SUP-15389-advisory-verdict" },
      body: "an ordinary PR body with no waiver line",
      labels: [],
      user: { login: "fleet-only[bot]" },
    }),
  );
  writeFileSync(path.join(dir, "statuses.json"), JSON.stringify(statuses));
  writeFileSync(path.join(dir, "calls.log"), "");

  const bin = path.join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const gh = path.join(bin, "gh");
  writeFileSync(gh, GH_SHIM);
  chmodSync(gh, 0o755);
  return { dir, bin };
}

// Runs the script against a fixture and returns the exit code, the step's
// stdout (where the warning annotation surfaces), and the job summary the
// script wrote to a runner-supplied GITHUB_STEP_SUMMARY. Simulating the two
// workflow env vars is what exercises the new advisory reporting at all.
function run(statuses, { event = "pull_request" } = {}) {
  const fixture = makeFixture(statuses);
  const summaryPath = path.join(fixture.dir, "summary.md");
  writeFileSync(summaryPath, "");
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
        PAPERCLIP_APPROVED_STATUS_CREATOR_ID: String(TEA_CORE.id),
        PAPERCLIP_APPROVED_STATUS_CREATOR_LOGIN: TEA_CORE.login,
        GITHUB_ACTIONS: "true",
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_REF: event === "merge_group" ? QUEUE_REF : "",
        GITHUB_REF_NAME: event === "merge_group" ? QUEUE_REF.replace("refs/heads/", "") : "",
      },
    });
    const calls = existsSync(path.join(fixture.dir, "calls.log"))
      ? readFileSync(path.join(fixture.dir, "calls.log"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
      : [];
    return {
      code: result.status,
      out: result.stdout ?? "",
      err: result.stderr ?? "",
      summary: readFileSync(summaryPath, "utf8"),
      calls,
    };
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

test("pull_request with the status absent warns and summarises the eviction", () => {
  // The observed defect: the advisory leg reported a bare green while the
  // merge queue was evicting the entry every ~8-13 minutes. The verdict now
  // reaches the checks view two ways without turning the check red.
  const { code, out, summary } = run([]);
  assert.equal(code, 0, "the advisory leg still concludes success");
  // A warning annotation, naming the head sha and stating the eviction.
  assert.match(out, /::warning::/);
  assert.match(out, new RegExp(HEAD_SHA));
  assert.match(out, /evicted from the merge queue/);
  assert.match(out, /paperclip\/approved/);
  // The same verdict, in the job summary.
  assert.match(summary, /not published/);
  assert.match(summary, new RegExp(HEAD_SHA));
  assert.match(summary, /evicted from the merge queue/);
});

test("pull_request with the status present summarises the context state", () => {
  const { code, out, summary } = run([status("success", TEA_CORE)]);
  assert.equal(code, 0, "the advisory leg still concludes success");
  assert.match(summary, /is present on this PR/);
  assert.match(summary, new RegExp(HEAD_SHA));
  assert.match(summary, /tea-core\[bot\]/);
  assert.doesNotMatch(out, /::warning::/, "a present approval must not warn");
});

test("the advisory leg is read-only: exactly the two documented GETs, no status write", () => {
  // Nothing in this repository may create, mock or write `paperclip/approved`.
  // The shim refuses any call it does not recognise, and records every URL, so
  // a stray write or an extra read would surface here.
  const { code, calls } = run([]);
  assert.equal(code, 0);
  assert.equal(calls.length, 2, "the advisory leg makes exactly two API calls");
  assert.match(calls[0], new RegExp(`repos/TEA-Core\\/paperclip/pulls/${PR}$`));
  assert.match(calls[1], /commits\/.*\/statuses\?per_page=100$/);
});

test("a pending status still reads as not-published and warns", () => {
  const { code, out, summary } = run([status("pending", TEA_CORE)]);
  assert.equal(code, 0, "advisory never fails the PR");
  assert.match(out, /::warning::/);
  assert.match(out, /pending/);
  assert.match(summary, /pending/);
});

test("merge_group stays fail-closed and does not emit the advisory verdict", () => {
  const { code, out, summary } = run([], { event: "merge_group" });
  assert.equal(code, 1, "a missing approval still blocks the merge");
  assert.doesNotMatch(out, /::warning::/, "the enforcing leg must not warn");
  assert.equal(summary, "", "no advisory job summary on the enforcing leg");
});

test("push is a no-op that reports success and emits no verdict", () => {
  const { code, out, summary } = run([], { event: "push" });
  assert.equal(code, 0);
  assert.doesNotMatch(out, /::warning::/);
  assert.equal(summary, "");
});

// Guards against the advisory verdict leaking into a forged pull_request: even
// there the leg is green, and the forged path is a separate finding, not the
// "not published yet" eviction this feature reports.
test("pull_request with a forged status stays green", () => {
  const { code } = run([status("success", FLEET_ONLY)]);
  assert.equal(code, 0);
});
