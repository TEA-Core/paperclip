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
// Wiring: the workflow posts on merge_group failure and keeps enforcement
// ---------------------------------------------------------------------------

test("the enforcer job grants pull-requests write and captures the verdict", () => {
  const text = readFileSync(workflow, "utf8");
  const block = text.match(/\n {2}paperclip-approved-enforcer:((?: {4}.*\n|\n)*?)(?=\n {2}[A-Za-z_]|$)/)[1];
  assert.match(block, /^ {6}pull-requests: write$/m);
  assert.match(block, /MERGE_EJECTION_VERDICT: \$\{\{ runner\.temp \}\}\/paperclip-approved-verdict/);
});

test("the runner.temp verdict path is declared at step level, never job-level env", () => {
  // `runner` is a step-only context in GitHub Actions: `${{ runner.temp }}` in a
  // job-level `env:` block makes the whole workflow fail validation before any
  // job starts (actionlint: workflow-job-env-runner-context-invalid). The path
  // must be declared on the step(s) that use it — env keys on a step are
  // indented 10 spaces (job-level env keys are 6).
  for (const file of [workflow, prWorkflow]) {
    const text = readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      if (/MERGE_EJECTION_VERDICT: \$\{\{ runner\.temp \}\}/.test(line)) {
        assert.match(
          line,
          /^ {10}MERGE_EJECTION_VERDICT/,
          `runner.temp env must be step-level (10-space indent): ${line}`,
        );
      }
    }
    // Every runner.temp path lives under a step, and no job-level env key
    // references the runner context.
    assert.doesNotMatch(text, /^ {6}MERGE_EJECTION_VERDICT/m, "job-level env must not reference runner.temp");
  }
});

test("control code is never executed from a PR-controlled checkout", () => {
  // SUP-15375 round 5 (security, merge-group-comment-token-executes-pr-code):
  // the jobs that hold `pull-requests: write` must not run repo scripts from
  // the entry's own (gh-readonly-queue / PR-controlled) tree. The enforcer
  // workflow must have NO checkout at all; the gate and surface scripts are
  // fetched from the pinned protected base SHA via the contents API instead.
  const enforcer = readFileSync(workflow, "utf8");
  const enforcerJob = enforcer.match(/\n {2}paperclip-approved-enforcer:((?: {4}.*\n|\n)*?)(?=\n {2}[A-Za-z_]|$)/)[1];
  assert.doesNotMatch(enforcerJob, /actions\/checkout/, "the write-token job must not checkout the PR-controlled tree");
  assert.doesNotMatch(enforcerJob, /bash scripts\/ci\//, "repo scripts must not run from the checkout");
  // The gate (enforcer) and the surface are fetched from the base SHA.
  assert.match(enforcerJob, /MERGE_EJECTION_BASE_SHA:/, "the trusted base SHA is pinned for the control code");
  assert.match(
    enforcerJob,
    /contents\/scripts\/ci\/check-paperclip-approved\.sh\?ref=\$\{MERGE_EJECTION_BASE_SHA\}/,
    "the enforcer gate script is fetched from the base SHA",
  );
  assert.match(
    enforcerJob,
    /contents\/scripts\/ci\/surface-merge-queue-ejection\.sh\?ref=\$\{MERGE_EJECTION_BASE_SHA\}/,
    "the surface script is fetched from the base SHA",
  );
  // Same for pr.yml's write-token aggregate jobs: no checkout in verify/e2e.
  const pr = readFileSync(prWorkflow, "utf8");
  for (const jobName of ["verify", "e2e"]) {
    const job = pr.match(new RegExp(`\\n {2}${jobName}:\\n((?: {4}.*\\n|\\n)*?)(?=\\n {2}(?:build|[a-z_]+):|\\s*$)`))[1];
    assert.doesNotMatch(job, /actions\/checkout/, `${jobName} aggregate must not checkout the PR-controlled tree`);
    assert.match(job, /MERGE_EJECTION_BASE_SHA:/, `${jobName} pins the trusted base SHA`);
    assert.match(
      job,
      /contents\/scripts\/ci\/surface-merge-queue-ejection\.sh\?ref=\$\{MERGE_EJECTION_BASE_SHA\}/,
      `${jobName} fetches the surface from the base SHA`,
    );
  }
});

test("no surface step may carry an inline write-token fallback poster", () => {
  // SUP-15375 round 7 (merge-group-comment-token-executes-pr-code): a
  // merge_group run executes this workflow file from the queue ref, whose tree
  // a queued PR controls — including any rewrite of `.github/workflows/*`. An
  // inline shell block that POST/PATCHes a comment with the job's write-capable
  // GH_TOKEN is therefore code a queued PR can repurpose to post or update
  // arbitrary repository comments. The ENTIRE posting implementation must live
  // in the base-pinned helper; each workflow step may only fetch that helper
  // and run it. The round-6 inline find-or-upsert is the round-7 defect.
  const surfaces = [
    { file: workflow, stepName: "- name: Surface the merge-queue ejection reason on the PR", checkName: "paperclip-approved-enforcer" },
    { file: prWorkflow, stepName: "- name: Surface the merge-queue ejection reason on the PR (verify)", checkName: "verify" },
    { file: prWorkflow, stepName: "- name: Surface the merge-queue ejection reason on the PR (e2e)", checkName: "e2e" },
  ];
  for (const { file, stepName, checkName } of surfaces) {
    const text = readFileSync(file, "utf8");
    const idx = text.indexOf(stepName);
    assert.ok(idx >= 0, `surface step must exist (${checkName})`);
    const rest = text.slice(idx);
    const next = rest.match(/\n      - (?:name|uses): /);
    const block = next ? rest.slice(0, next.index) : rest;
    // The step fetches the base-pinned helper and runs it — nothing else.
    assert.match(
      block,
      /contents\/scripts\/ci\/surface-merge-queue-ejection\.sh\?ref=\$\{MERGE_EJECTION_BASE_SHA\}/,
      `must fetch the base-pinned helper (${checkName})`,
    );
    assert.match(block, /bash "\$surface"/, `must run the fetched helper, not inline logic (${checkName})`);
    // Round-6 inline find-or-upsert is gone: no inline poster announcement, no
    // inline issue-comment write, no inline comment-body POST/PATCH.
    assert.doesNotMatch(block, /inline fallback poster/, `no inline fallback poster (${checkName})`);
    assert.doesNotMatch(block, /issues\/\$\{pr\}\/comments/, `no inline issue-comment write (${checkName})`);
    assert.doesNotMatch(block, /gh api -X POST/, `no inline POST (${checkName})`);
    assert.doesNotMatch(block, /gh api -X PATCH/, `no inline PATCH (${checkName})`);
  }
  // Whole-job scan: the write-token jobs (enforcer/verify/e2e) must not carry
  // any inline comment-posting shell at all — the helper performs the write at
  // runtime from base-pinned bytes, so the verb never appears in the workflow.
  for (const { file, jobName } of [
    { file: workflow, jobName: "paperclip-approved-enforcer" },
    { file: prWorkflow, jobName: "verify" },
    { file: prWorkflow, jobName: "e2e" },
  ]) {
    const text = readFileSync(file, "utf8");
    const m = text.match(new RegExp(`\\n {2}${jobName}:((?: {4}.*\\n|\\n)*?)(?=\\n {2}[A-Za-z_]|$)`));
    const job = m ? m[1] : "";
    assert.ok(job.length > 0, `write-token job must exist (${jobName})`);
    assert.doesNotMatch(job, /gh api -X POST/, `${jobName} must not POST inline`);
    assert.doesNotMatch(job, /gh api -X PATCH/, `${jobName} must not PATCH inline`);
  }
});

test("a surface step whose base-fetched helper is unavailable fails loudly (never an inline fallback, never a silent skip)", () => {
  // SUP-15375 round 7: the trusted posting helper reaches the protected base
  // only when the rollout PR merges, so a pre-merge ejection finds no helper to
  // fetch. That path must neither exit 0 silently (round-6 defect: the required
  // artefact vanishes with no trace) nor run inline shell (round-7 defect): it
  // emits an ::error:: annotation and fails the step, making the missing
  // artefact visible in the run. Enforcement is unaffected — the gate step the
  // surface gates on has already failed.
  const surfaces = [
    { file: workflow, stepName: "- name: Surface the merge-queue ejection reason on the PR", checkName: "paperclip-approved-enforcer" },
    { file: prWorkflow, stepName: "- name: Surface the merge-queue ejection reason on the PR (verify)", checkName: "verify" },
    { file: prWorkflow, stepName: "- name: Surface the merge-queue ejection reason on the PR (e2e)", checkName: "e2e" },
  ];
  for (const { file, stepName, checkName } of surfaces) {
    const text = readFileSync(file, "utf8");
    const idx = text.indexOf(stepName);
    assert.ok(idx >= 0, `surface step must exist (${checkName})`);
    const rest = text.slice(idx);
    const next = rest.match(/\n      - (?:name|uses): /);
    const block = next ? rest.slice(0, next.index) : rest;
    assert.match(block, /::error::/, `missing helper must be loud (::error::) (${checkName})`);
    assert.match(block, /exit 1/, `missing helper must fail the step, not exit 0 silently (${checkName})`);
    assert.doesNotMatch(block, /inline fallback poster/, `no inline fallback reintroduced (${checkName})`);
    assert.doesNotMatch(block, /gh api -X POST/, `no inline POST fallback (${checkName})`);
  }
});

test("the enforcer gate still fails closed and quotes a fetched verdict", () => {
  const text = readFileSync(workflow, "utf8");
  // The gate runs the base-fetched enforcer script and must still exit with its
  // rc — the fail-closed merge_group verdict is what turns the check-run red
  // and ejects the entry.
  assert.match(text, /bash "\$ENFORCER_SCRIPT" merge_group >"\$MERGE_EJECTION_VERDICT" 2>&1/);
  assert.match(text, /\[ "\$rc" -eq 0 \] \|\| exit "\$rc"/);
});

test("the surface step runs only on merge_group gate failure and posts via the base-fetched script", () => {
  const text = readFileSync(workflow, "utf8");
  const m = text.match(/- name: Surface the merge-queue ejection reason on the PR\n\s*if: ([^\n]+)/);
  assert.ok(m, "the surface step must carry an `if` condition");
  const ifExpr = m[1];
  // A step-level `if` without a status-check function gets an implicit
  // `success()` prepended — false right after the gate step fails, which would
  // skip this step on the exact path (merge-group ejection) it exists for. The
  // condition must therefore name an explicit status function (`failure()`,
  // which also disables the implicit success()), plus the event and the gate
  // outcome terms that scope it to the ejection case.
  assert.match(ifExpr, /\$\{\{/, "the condition must be an explicit ${{ }} expression");
  assert.match(ifExpr, /failure\(\)/, "the condition must name an explicit status-check function");
  assert.match(ifExpr, /github\.event_name == 'merge_group'/, "the condition must be scoped to merge_group");
  assert.match(ifExpr, /steps\.gate\.outcome == 'failure'/, "the condition must be scoped to the gate step's failure");
  // A naive condition without a status function must never come back: GitHub
  // would silently add `success()` and the artefact would never be posted.
  assert.doesNotMatch(ifExpr, /^if: github\.event_name/, "a bare (implicit-success) condition is the round-1 defect");
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

// ---------------------------------------------------------------------------
// Wiring: pr.yml's verify/e2e aggregates (the other required merge_group checks)
// ---------------------------------------------------------------------------

test("pr.yml verify aggregate gates a surface step on merge_group gate failure", () => {
  const text = readFileSync(prWorkflow, "utf8");
  // The `verify` job is an always() aggregator whose gate keeps its fail-closed
  // assertions unchanged and tees the lane results before they run.
  const job = text.match(/\n {2}verify:\n((?: {4}.*\n|\n)*?)(?=\n {2}build:)/)[1];
  assert.match(job, /if: \$\{\{ always\(\) \}\}/, "verify stays an always() aggregator");
  assert.match(job, /id: verify_gate/);
  assert.match(job, /> "\$MERGE_EJECTION_VERDICT"/, "lane results are teed for the surface step");
  assert.match(job, /test "\$TYPECHECK_RELEASE_REGISTRY_RESULT" = "success"/, "fail-closed assertion unchanged");
  // The surface step carries an explicit status function + the event/gate scope,
  // and posts through the base-fetched shared script with its own --check-name.
  assert.match(
    job,
    /- name: Surface the merge-queue ejection reason on the PR \(verify\)\n {8}if: \$\{\{ failure\(\) && github\.event_name == 'merge_group' && steps\.verify_gate\.outcome == 'failure' \}\}/,
  );
  assert.match(job, /bash "\$surface" --check-name verify --verdict "\$MERGE_EJECTION_VERDICT"/);
});

test("pr.yml e2e aggregate gates a surface step on merge_group gate failure", () => {
  const text = readFileSync(prWorkflow, "utf8");
  const job = text.match(/\n {2}e2e:\n((?: {4}.*\n|\n)*)/)[1];
  assert.match(job, /if: \$\{\{ always\(\) \}\}/, "e2e stays an always() aggregator");
  assert.match(job, /id: e2e_gate/);
  assert.match(job, /> "\$MERGE_EJECTION_VERDICT"/, "the e2e_shards result is teed for the surface step");
  assert.match(job, /test "\$E2E_SHARDS_RESULT" = "success"/, "fail-closed assertion unchanged");
  assert.match(
    job,
    /- name: Surface the merge-queue ejection reason on the PR \(e2e\)\n {8}if: \$\{\{ failure\(\) && github\.event_name == 'merge_group' && steps\.e2e_gate\.outcome == 'failure' \}\}/,
  );
  assert.match(job, /bash "\$surface" --check-name e2e --verdict "\$MERGE_EJECTION_VERDICT"/);
});

test("verify/e2e surfaces capture a bounded failing-lane reason, not status only", () => {
  const text = readFileSync(prWorkflow, "utf8");
  // SUP-15375 round 5 (merge-group-surface-reason-is-status-only): the gate
  // steps fetch a bounded tail of the genuinely-failed lane's OWN job log from
  // this run and append it to the verdict file, so the PR artefact names the
  // underlying failure. This requires the read-only `actions: read` scope.
  const verifyJob = text.match(/\n {2}verify:\n((?: {4}.*\n|\n)*?)(?=\n {2}build:)/)[1];
  assert.match(verifyJob, /^ {6}actions: read$/m, "verify needs actions: read for the lane-log tail");
  assert.match(verifyJob, /actions\/runs\/\$\{GITHUB_RUN_ID\}\/jobs/, "verify lists this run's jobs to find the failed lane");
  assert.match(verifyJob, /actions\/jobs\/\$\{jid\}\/logs/, "verify fetches the failed lane's own job log");
  assert.match(verifyJob, /failing output \(bounded tail\)/, "verify labels the appended lane output");
  const e2eJob = text.match(/\n {2}e2e:\n((?: {4}.*\n|\n)*)/)[1];
  assert.match(e2eJob, /^ {6}actions: read$/m, "e2e needs actions: read for the shard-log tail");
  assert.match(e2eJob, /actions\/jobs\/\$\{jid\}\/logs/, "e2e fetches the failed shard's own job log");
  assert.match(e2eJob, /failing shard log \(bounded tail\)/, "e2e labels the appended shard output");
});

test("pr.yml surface steps only post on a genuine failure, not skipped/cancelled lanes", () => {
  const text = readFileSync(prWorkflow, "utf8");
  // Both surface run blocks gate on a `: failure` verdict line, so an approval
  // collapse (lanes skipped/cancelled → the paperclip-approved surface owns the
  // story) does not stack verify/e2e comments.
  assert.match(
    text,
    /Surface the merge-queue ejection reason on the PR \(verify\)\n {8}if: \$\{\{ failure\(\) && github\.event_name == 'merge_group' && steps\.verify_gate\.outcome == 'failure' \}\}\n(?: {8}env:\n(?: {10}.*\n)*?)? {8}run: \|\n(?: {10}.*\n)*? {10}if ! grep -q ': failure\$' "\$MERGE_EJECTION_VERDICT"/,
  );
  assert.match(
    text,
    /Surface the merge-queue ejection reason on the PR \(e2e\)\n {8}if: \$\{\{ failure\(\) && github\.event_name == 'merge_group' && steps\.e2e_gate\.outcome == 'failure' \}\}\n(?: {8}env:\n(?: {10}.*\n)*?)? {8}run: \|\n(?: {10}.*\n)*? {10}if ! grep -q ': failure\$' "\$MERGE_EJECTION_VERDICT"/,
  );
});
