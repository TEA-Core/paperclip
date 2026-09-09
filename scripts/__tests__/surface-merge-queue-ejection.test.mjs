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
const prWorkflow = path.join(repoRoot, ".github/workflows/pr.yml");

const REPO = "TEA-Core/paperclip";
const PR = 4242;
// A fold merge-queue ref whose base branch itself contains slashes — the exact
// shape that broke the single-component regex on the agent-tools repo.
const QUEUE_REF_NAME = `gh-readonly-queue/fold/tea-patches-v2026.722.0/pr-${PR}-0123456789abcdef`;

// Every required merge_group check has its own surface marker, so a comment for
// one failing check is never mistaken for another's and each updates in place
// on re-queue.
const ENFORCER_CHECK = "paperclip-approved-enforcer";
const markerFor = (checkName) => `<!-- paperclip:merge-queue-ejection:${checkName} -->`;
const ENFORCER_MARKER = markerFor(ENFORCER_CHECK);
const VERIFY_MARKER = markerFor("verify");
const E2E_MARKER = markerFor("e2e");

// The enforcer's trailing failure block — what the gate step tees into the
// verdict file and the surface script is expected to quote verbatim.
const VERDICT = [
  "[paperclip-approved] checking TEA-Core/paperclip PR #4242 (mode: enforcing)",
  "[paperclip-approved] PR #4242 head SHA: 0123456789abcdef0123456789abcdef01234567",
  "[paperclip-approved][error] FAIL: paperclip/approved is missing, expected success — PR #4242 head 0123456789abcdef0123456789abcdef01234567 is not approved",
  "[paperclip-approved][error]   an approval is produced by the control plane when the card's review stage records 'approved'",
].join("\n");

// A `gh` stand-in. The surface script lists existing markers and then makes
// exactly one create-or-update call; the shim records verb/url/body and returns
// canned payloads so the assertions can inspect the exact HTTP the script would
// send. An unrecognised call is a hard failure rather than a silently empty
// payload.
// Endpoint-family discipline (SUP-15375 round 2): BOTH the list and the write go
// to the issue-comment family (`issues/{n}/comments`) — the write posts a
// marker that the read must be able to find again, which would not hold if the
// read used the pull *review*-comment family (`pulls/{n}/comments`). The shim
// therefore serves the list only from `issues/…/comments` GETs (an empty or
// absent `-X` verb) and refuses every `pulls/…/comments` route. A write
// (`-X POST/PATCH`) returns a created-comment object; the list returns the
// fixture's `comments.json` array. A `fail_list` sentinel makes the list call
// fail (403) to exercise the best-effort skip path.
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
  "  */pulls/*/comments*) echo \"gh shim: pull review-comment endpoint must not be used: $url\" >&2; exit 1 ;;",
  "  */issues/*/comments*)",
  "    if [ -z \"$verb\" ]; then",
  "      if [ -f \"${shim_dir}/fail_list\" ]; then echo \"gh: HTTP 403 (shim)\" >&2; exit 1; fi",
  "      cat \"${shim_dir}/comments.json\"",
  "    else",
  "      printf '{ \"id\": 424242 }\\n'",
  "    fi ;;",
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

function run(fixture, { refName = "", prNumber = String(PR), withVerdict = true, checkName = ENFORCER_CHECK, extraArgs = [] } = {}) {
  const args = [script];
  if (checkName) args.push("--check-name", checkName);
  if (withVerdict && existsSync(fixture.verdictPath)) args.push("--verdict", fixture.verdictPath);
  args.push(...extraArgs);
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
      // The read and the write must share the issue-comment endpoint family so
      // a posted marker is found again on the next queue attempt — never the
      // pull *review*-comment family, whose payloads the write cannot see.
      assert.match(calls[0].url, new RegExp(`issues/${PR}/comments`));
      assert.doesNotMatch(calls[0].url, /\/pulls\//);
      assert.equal(calls[0].verb, "", "the list is a GET — no -X verb");
      const create = calls[1];
      assert.equal(create.verb, "POST");
      assert.match(create.url, new RegExp(`issues/${PR}/comments$`));
      assert.doesNotMatch(create.url, /\/pulls\//);
      // The body is a JSON payload {body}; it carries the per-check marker, the
      // failing check name, and the enforcer's reason verbatim.
      assert.match(create.body, new RegExp(ENFORCER_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(create.body, /paperclip-approved-enforcer/);
      assert.match(create.body, /paperclip\/approved is missing/);
    },
  );
});

test("posts a verify-check comment naming verify, not the enforcer", () => {
  const verifyVerdict = "general_tests: failure\nbuild: success";
  withFixture(
    { comments: [], verdict: verifyVerdict },
    (calls, { code }) => {
      assert.equal(code, 0);
      const create = calls[1];
      assert.equal(create.verb, "POST");
      assert.match(create.body, /paperclip:merge-queue-ejection:verify/);
      assert.doesNotMatch(create.body, /paperclip:merge-queue-ejection:paperclip-approved-enforcer/);
      assert.match(create.body, /\*\*`verify`\*\* check failed on this entry's merge-group commit/);
      assert.match(create.body, /general_tests: failure/, "the lane-summary verdict file is quoted verbatim");
    },
    { checkName: "verify" },
  );
});

test("posts an e2e-check comment naming e2e", () => {
  const e2eVerdict = "e2e_shards: failure";
  withFixture(
    { comments: [], verdict: e2eVerdict },
    (calls, { code }) => {
      assert.equal(code, 0);
      const create = calls[1];
      assert.equal(create.verb, "POST");
      assert.match(create.body, /paperclip:merge-queue-ejection:e2e/);
      assert.match(create.body, /\*\*`e2e`\*\* check failed on this entry's merge-group commit/);
      assert.match(create.body, /e2e_shards: failure/, "the lane-summary verdict file is quoted verbatim");
    },
    { checkName: "e2e" },
  );
});

test("upserts only the same check's comment — verify never clobbers the enforcer's", () => {
  // The PR already carries an enforcer marker AND a verify marker; a verify run
  // must find and PATCH only its own comment, leaving the enforcer's alone.
  withFixture(
    {
      comments: [
        { id: 111, body: `enforcer …${ENFORCER_MARKER}…` },
        { id: 222, body: `verify …${VERIFY_MARKER}… old verify reason` },
      ],
    },
    (calls, { code, out }) => {
      assert.equal(code, 0);
      assert.match(out, /updated merge-queue ejection comment 222/);
      assert.equal(calls.length, 2);
      const update = calls[1];
      assert.equal(update.verb, "PATCH");
      assert.match(update.url, /issues\/4242\/comments\/222$/);
      assert.doesNotMatch(calls.map((c) => c.verb).join(","), /POST/, "the verify marker was found; no stack");
    },
    { checkName: "verify" },
  );
});

test("updates the existing comment in place instead of stacking a new one", () => {
  withFixture(
    { comments: [{ id: 555, body: `…${ENFORCER_MARKER}… old reason` }] },
    (calls, { code, out }) => {
      assert.equal(code, 0);
      assert.match(out, /updated merge-queue ejection comment 555/);
      // A marker served back from the *issue*-comment list is found and PATCHed:
      // exactly two calls, the second an update, never a fresh POST — that is
      // the in-place behaviour the endpoint-family fix restores.
      assert.equal(calls.length, 2);
      assert.match(calls[0].url, new RegExp(`issues/${PR}/comments`));
      const update = calls[1];
      assert.equal(update.verb, "PATCH");
      assert.match(update.url, /issues\/4242\/comments\/555$/);
      assert.match(update.body, /paperclip:merge-queue-ejection/);
      assert.doesNotMatch(calls.map((c) => c.verb).join(","), /POST/, "re-queue must not stack a new comment");
    },
  );
});

test("finds a marker previously posted as an issue comment (round-trip after a real POST)", () => {
  // A real POST writes to `issues/{n}/comments`; the response id (424242) is the
  // id a subsequent list on the SAME endpoint returns. Feed that back and assert
  // the script PATCHes id 424242 rather than creating a second comment.
  withFixture(
    { comments: [{ id: 424242, body: `hello ${ENFORCER_MARKER} world` }] },
    (calls, { code, out }) => {
      assert.equal(code, 0);
      assert.match(out, /updated merge-queue ejection comment 424242/);
      assert.equal(calls.length, 2);
      const update = calls[1];
      assert.equal(update.verb, "PATCH");
      assert.match(update.url, /issues\/4242\/comments\/424242$/);
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
  // The `fail_list` sentinel makes the standard shim's issue-comment GET fail
  // with a 403-shaped error; the script must log the skip and exit 0 before
  // attempting any write.
  const fixture = makeFixture({ comments: [] });
  try {
    writeFileSync(path.join(fixture.dir, "fail_list"), "");
    const r = run(fixture, { refName: "", prNumber: String(PR) });
    assert.equal(r.code, 0);
    assert.match(r.out + r.err, /could not list the PR.s comments/);
    const calls = readCalls(fixture.dir);
    assert.equal(calls.length, 1, "the list call was attempted and failed; no write follows");
    assert.match(calls[0].url, new RegExp(`issues/${PR}/comments`));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Wiring (SUP-15375 round 9): the write token must NEVER run PR-controlled code
// ---------------------------------------------------------------------------
// A merge_group run loads the workflow file from the gh-readonly-queue ref — a
// tree the queued PR controls. Any write-capable token granted to a job inside
// pr.yml / paperclip-approved.yml therefore executes code a queued PR can
// rewrite (merge-group-comment-token-executes-pr-code, rounds 7-9). Those
// gating workflows must carry NO write permission and NO posting code. The
// write-capable posting lives exclusively in the `workflow_run` reactor
// (paperclip-ejection-surface.yml), which GitHub loads from the protected
// default branch a queued PR cannot modify.
const reactorWorkflow = path.join(repoRoot, ".github/workflows/paperclip-ejection-surface.yml");

test("the gating workflows grant no write-capable permission to any job", () => {
  for (const file of [workflow, prWorkflow]) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /pull-requests: write/, `${file} must not grant pull-requests: write`);
    assert.doesNotMatch(text, /statuses: write/, `${file} must not grant statuses: write`);
    assert.doesNotMatch(text, /checks: write/, `${file} must not grant checks: write`);
  }
});

test("the gating workflows carry no merge-group ejection posting code at all", () => {
  for (const file of [workflow, prWorkflow]) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /surface-merge-queue-ejection/, `${file} must not reference the surface helper`);
    assert.doesNotMatch(text, /MERGE_EJECTION/, `${file} must not carry ejection-surface plumbing`);
    assert.doesNotMatch(text, /paperclip:merge-queue-ejection/, `${file} must not post the ejection marker inline`);
    assert.doesNotMatch(text, /gh api -X POST/, `${file} must not POST inline`);
    assert.doesNotMatch(text, /gh api -X PATCH/, `${file} must not PATCH inline`);
    assert.doesNotMatch(text, /issues\/\$\{pr\}\/comments/, `${file} must not write comments inline`);
  }
});

test("the reactor workflow is the only workflow that grants pull-requests: write", () => {
  const files = ["paperclip-approved.yml", "pr.yml", "paperclip-ejection-surface.yml"];
  const writers = files.filter((f) =>
    /pull-requests: write/.test(readFileSync(path.join(repoRoot, ".github/workflows", f), "utf8")),
  );
  assert.deepEqual(writers, ["paperclip-ejection-surface.yml"], "only the trusted reactor may hold the write token");
});

test("the reactor triggers on workflow_run completion of the required check workflows", () => {
  const text = readFileSync(reactorWorkflow, "utf8");
  assert.match(text, /name: Merge-Queue Ejection Surface/);
  const trigger = text.match(
    /on:\n\s+workflow_run:\n\s+workflows:\n((?:\s+- .*\n)+)\s+types:\n\s+- completed/,
  );
  assert.ok(trigger, "reactor must trigger on workflow_run with types: [completed]");
  assert.match(trigger[1], /- PR\n/);
  assert.match(trigger[1], /- Paperclip Approval Enforcer\n/);
});

test("the reactor job is scoped to a failed merge_group run", () => {
  const text = readFileSync(reactorWorkflow, "utf8");
  assert.match(
    text,
    /if: \$\{\{ github\.event\.workflow_run\.conclusion == 'failure' && github\.event\.workflow_run\.event == 'merge_group' \}\}/,
    "the reactor job must run only for a failed merge_group run",
  );
});

test("the reactor executes only trusted default-branch code, never the triggering run's tree", () => {
  const text = readFileSync(reactorWorkflow, "utf8");
  assert.match(
    text,
    /bash scripts\/ci\/surface-merge-queue-ejection-react\.sh/,
    "the reactor must run the trusted react script",
  );
  // pwn-request guard: the reactor must never checkout or target the triggering
  // run's PR-controlled ref/commit. The default checkout resolves to GITHUB_REF,
  // which for a workflow_run run is the protected default branch. `head_branch`
  // may only travel as env data to the runner (for PR resolution), never select
  // a checkout ref.
  assert.doesNotMatch(text, /workflow_run\.head_branch\s*\n\s*ref:/,
    "the reactor must not select its checkout from the triggering run's head branch");
  assert.doesNotMatch(text, /workflow_run\.head_sha/,
    "the reactor must not target the triggering run's commit");
  assert.ok(
    /WORKFLOW_HEAD_BRANCH: \$\{\{ github\.event\.workflow_run\.head_branch \}\}/.test(text),
    "the head branch travels to the runner as data for PR resolution",
  );
});

test("the reactor does not add a merge_group trigger (no new PR-controlled surface)", () => {
  const text = readFileSync(reactorWorkflow, "utf8");
  assert.doesNotMatch(text, /^\s{2}merge_group:/m, "the reactor must not run on merge_group");
  assert.doesNotMatch(text, /^\s{2}pull_request:/m, "the reactor must not run on pull_request");
});
