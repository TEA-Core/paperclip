import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts/ci/surface-merge-queue-ejection.sh");
const workflow = path.join(repoRoot, ".github/workflows/paperclip-approved.yml");

const REPO = "TEA-Core/paperclip";
const PR = 4242;
// A fold merge-queue ref whose base branch itself contains slashes — the exact
// shape that broke the single-component regex on the agent-tools repo.
const QUEUE_REF_NAME = `gh-readonly-queue/fold/tea-patches-v2026.722.0/pr-${PR}-0123456789abcdef`;

// The enforcer's trailing failure block — what the gate step tees into the
// verdict file and the surface script is expected to quote verbatim.
const VERDICT = [
  "[paperclip-approved] checking TEA-Core/paperclip PR #4242 (mode: enforcing)",
  "[paperclip-approved] PR #4242 head SHA: 0123456789abcdef0123456789abcdef01234567",
  "[paperclip-approved][error] FAIL: paperclip/approved is missing, expected success — PR #4242 head 0123456789abcdef0123456789abcdef01234567 is not approved",
  "[paperclip-approved][error]   an approval is produced by the control plane when the card's review stage records 'approved'",
].join("\n");

// A `gh` stand-in. The surface script makes a list call and then exactly one
// create-or-update call; the shim records verb/url/body and returns canned
// payloads so the assertions can inspect the exact HTTP the script would send.
// An unrecognised call is a hard failure rather than a silently empty payload.
const GH_SHIM = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "shim_dir=\"${GH_SHIM_DIR}\"",
  "mkdir -p \"${shim_dir}/calls\"",
  "n=\"$(find \"${shim_dir}/calls\" -maxdepth 1 -type f -name 'call_*.txt' 2>/dev/null | wc -l | tr -d ' ')\"",
  "verb=\"\"",
  "url=\"\"",
  "body=\"\"",
  "while [ \"$#\" -gt 0 ]; do",
  "  case \"$1\" in",
  "    api) shift ;;",
  "    -X) verb=\"$2\"; shift 2 ;;",
  "    --input)",
  "      v=\"$2\"",
  "      if [ \"$v\" = \"-\" ]; then body=\"$(cat)\"; fi",
  "      shift 2 ;;",
  "    --paginate) shift ;;",
  "    *) if [ -z \"$url\" ]; then url=\"$1\"; fi; shift ;;",
  "  esac",
  "done",
  "{",
  "  echo \"verb=${verb}\"",
  "  echo \"url=${url}\"",
  "  printf '%s\\n' \"$body\"",
  "} > \"${shim_dir}/calls/call_${n}.txt\"",
  "case \"$url\" in",
  "  */pulls/*/comments*) cat \"${shim_dir}/comments.json\" ;;",
  "  */issues/*/comments*) printf '{ \"id\": 424242 }\\n' ;;",
  "  *) echo \"gh shim: unexpected call: $url\" >&2; exit 1 ;;",
  "esac",
  "",
].join("\n");

function makeFixture({ comments = [], verdict = VERDICT } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mme-ejection-"));
  writeFileSync(path.join(dir, "comments.json"), JSON.stringify(comments));
  const verdictPath = path.join(dir, "verdict.txt");
  if (verdict !== null) writeFileSync(verdictPath, verdict);
  const bin = path.join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  const gh = path.join(bin, "gh");
  writeFileSync(gh, GH_SHIM);
  chmodSync(gh, 0o755);
  return { dir, bin, verdictPath };
}

function readCalls(dir) {
  const callsDir = path.join(dir, "calls");
  if (!existsSync(callsDir)) return [];
  return readdirSync(callsDir)
    .filter((f) => f.endsWith(".txt"))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((f) => {
      const lines = readFileSync(path.join(callsDir, f), "utf8").split("\n");
      return {
        verb: lines[0].slice("verb=".length),
        url: lines[1].slice("url=".length),
        body: lines.slice(2).join("\n"),
      };
    });
}

function run(fixture, { refName = "", prNumber = String(PR), withVerdict = true } = {}) {
  const args = [script];
  if (withVerdict && existsSync(fixture.verdictPath)) args.push("--verdict", fixture.verdictPath);
  const result = spawnSync("bash", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      GH_SHIM_DIR: fixture.dir,
      GH_REPO: REPO,
      GITHUB_PR_NUMBER: prNumber,
      GITHUB_REF_NAME: refName,
      GITHUB_REF: refName ? `refs/heads/${refName}` : "",
    },
  });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

function withFixture(options, assertions, runOptions) {
  const fixture = makeFixture(options);
  try {
    const result = run(fixture, runOptions);
    assertions(readCalls(fixture.dir), result, fixture);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The artefact itself
// ---------------------------------------------------------------------------

test("posts an ejection comment naming the check and quoting the reason", () => {
  withFixture(
    { comments: [] },
    (calls, { code, out }) => {
      assert.equal(code, 0);
      assert.match(out, /posted merge-queue ejection comment on TEA-Core\/paperclip PR #4242/);
      // call 0 is the read (list), call 1 is the write (create).
      assert.equal(calls.length, 2);
      assert.match(calls[0].url, /pulls\/4242\/comments/);
      const create = calls[1];
      assert.equal(create.verb, "POST");
      assert.match(create.url, new RegExp(`issues/4242/comments$`));
      // The body is a JSON payload {body}; it carries the stable marker, the
      // failing check name, and the enforcer's reason verbatim.
      assert.match(create.body, /paperclip:merge-queue-ejection/);
      assert.match(create.body, /paperclip-approved-enforcer/);
      assert.match(create.body, /paperclip\/approved is missing/);
    },
  );
});

test("updates the existing comment in place instead of stacking a new one", () => {
  withFixture(
    { comments: [{ id: 555, body: "…<!-- paperclip:merge-queue-ejection -->… old reason" }] },
    (calls, { code, out }) => {
      assert.equal(code, 0);
      assert.match(out, /updated merge-queue ejection comment 555/);
      assert.equal(calls.length, 2);
      const update = calls[1];
      assert.equal(update.verb, "PATCH");
      assert.match(update.url, /issues\/4242\/comments\/555$/);
      assert.match(update.body, /paperclip:merge-queue-ejection/);
    },
  );
});

test("resolves the PR number from the merge-queue ref (fold ref with slashes)", () => {
  withFixture(
    { comments: [] },
    (calls, { code }) => {
      assert.equal(code, 0);
      const create = calls[1];
      assert.match(create.url, new RegExp(`issues/${PR}/comments$`));
    },
    { refName: QUEUE_REF_NAME, prNumber: "" },
  );
});

test("falls back to a generic reason when there is no verdict file", () => {
  withFixture(
    { comments: [], verdict: null },
    (calls, { code }) => {
      assert.equal(code, 0);
      const create = calls[1];
      assert.match(create.body, /paperclip:merge-queue-ejection/);
      assert.match(create.body, /failed on the merge-group commit/);
    },
    { withVerdict: false },
  );
});

// ---------------------------------------------------------------------------
// Best-effort: a post failure must never read as a pass, nor crash
// ---------------------------------------------------------------------------

test("skips (exit 0) when the PR number cannot be resolved", () => {
  withFixture(
    { comments: [] },
    (calls, { code, out }) => {
      assert.equal(code, 0);
      assert.match(out, /could not resolve the PR number/);
      // No HTTP at all: nothing to write without a PR to write on.
      assert.equal(calls.length, 0);
    },
    { refName: "some-other-branch", prNumber: "" },
  );
});

test("skips (exit 0) when the comment list call fails — enforcement is unaffected", () => {
  // Point the shim at a fixture whose list endpoint is missing: make the
  // comments file a directory-shaped failure by failing the list call.
  const fixture = makeFixture({ comments: [] });
  try {
    // Replace the shim so the pulls/comments call fails.
    const gh = path.join(fixture.bin, "gh");
    writeFileSync(
      gh,
      [
        "#!/usr/bin/env bash",
        "case \"$1\" in",
        "  api) url=\"$3\"; case \"$url\" in",
        "    */pulls/*) echo \"gh: HTTP 403 (shim)\" >&2; exit 1 ;;",
        "  esac ;;",
        "esac",
        "cat \"${GH_SHIM_DIR}/comments.json\"",
        "",
      ].join("\n"),
    );
    const r = run(fixture, { refName: "", prNumber: String(PR) });
    assert.equal(r.code, 0);
    assert.match(r.out + r.err, /could not list the PR.s comments/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Wiring: the workflow posts on merge_group failure and keeps enforcement
// ---------------------------------------------------------------------------

test("the enforcer job grants pull-requests write and captures the verdict", () => {
  const text = readFileSync(workflow, "utf8");
  const block = text.match(/\n {2}paperclip-approved-enforcer:((?: {4}.*\n|\n)*?)(?=\n {2}[A-Za-z_]|$)/)[1];
  assert.match(block, /^ {6}pull-requests: write$/m);
  assert.match(block, /MERGE_EJECTION_VERDICT: \$\{\{ runner\.temp \}\}\/paperclip-approved-verdict/);
});

test("the gate step still runs the enforcer and exits with its rc", () => {
  const text = readFileSync(workflow, "utf8");
  assert.match(text, /bash scripts\/ci\/check-paperclip-approved\.sh merge_group >"\$MERGE_EJECTION_VERDICT" 2>&1/);
  // The job must still exit with the enforcer's rc — the fail-closed merge_group
  // verdict is what turns the check-run red and ejects the entry.
  assert.match(text, /\[ "\$rc" -eq 0 \] \|\| exit "\$rc"/);
});

test("the surface step runs only on merge_group gate failure and calls the script", () => {
  const text = readFileSync(workflow, "utf8");
  assert.match(text, /if: github\.event_name == 'merge_group' && steps\.gate\.outcome == 'failure'/);
  assert.match(text, /bash scripts\/ci\/surface-merge-queue-ejection\.sh --verdict "\$MERGE_EJECTION_VERDICT"/);
  // It is gated on the gate step's failure, not `always()` — so it can never run
  // on a green entry and turn one red, and it is not required for a conclusion.
  assert.match(text, /- name: Check the paperclip\/approved status/);
  assert.match(text, /^\s*id: gate\s*$/m, "the gate step must carry id: gate for the surface step to gate on");
});

test("the surface step is not on the enforcement path (best-effort)", () => {
  // The comment step has no `id` the gate depends on and no `continue-on-error`
  // that would mask the gate; it simply runs after the gate has already failed.
  const text = readFileSync(workflow, "utf8");
  assert.doesNotMatch(text, /needs:.*surface/i, "nothing depends on the surface step");
});
