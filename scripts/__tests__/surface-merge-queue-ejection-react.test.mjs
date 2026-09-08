import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts/ci/surface-merge-queue-ejection-react.sh");

const REPO = "TEA-Core/paperclip";
const RUN_ID = "987654321";
const PR = 4242;
const QUEUE_REF = `gh-readonly-queue/fold/tea-patches-v2026.722.0/pr-${PR}-0123456789abcdef`;

// A `gh` stand-in for the react runner. The runner reads the completed run, its
// failing jobs, and the failed job's log — all read-only actions API routes.
// Dry-run mode never reaches the comment-posting helper, so no comment routes
// are needed here; an unrecognised call is a hard failure.
function makeShim(dir) {
  const bin = path.join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  const gh = path.join(bin, "gh");
  const shim = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'shim_dir="${GH_SHIM_DIR}"',
    'url=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    "    api) shift ;;",
    "    -X) shift 2 ;;",
    "    --paginate) shift ;;",
    '    *) if [ -z "$url" ]; then url="$1"; fi; shift ;;',
    "  esac",
    "done",
    'case "$url" in',
    `  */actions/runs/${RUN_ID}/jobs*) cat "${dir}/jobs.json" ;;`,
    `  */actions/runs/${RUN_ID}) cat "${dir}/run.json" ;;`,
    "  */actions/jobs/*/logs)",
    '    jid="${url##*/jobs/}"; jid="${jid%%/logs*}"',
    `    if [ -f "${dir}/\${jid}.log" ]; then cat "${dir}/\${jid}.log"; else echo "(no log for job \${jid})"; fi ;;`,
    '  *) echo "gh shim: unexpected call: $url" >&2; exit 1 ;;',
    "esac",
    "",
  ].join("\n");
  writeFileSync(gh, shim);
  chmodSync(gh, 0o755);
}

function makeFixture({ event = "merge_group", conclusion = "failure", headBranch = QUEUE_REF, jobs = [] }) {
  const dir = mkdtempSync(path.join(tmpdir(), "mme-react-"));
  writeFileSync(
    path.join(dir, "run.json"),
    JSON.stringify({ event, conclusion, head_branch: headBranch }),
  );
  writeFileSync(path.join(dir, "jobs.json"), JSON.stringify({ jobs }));
  makeShim(dir);
  return dir;
}

function run(dir, { workflowName = "PR", headBranch = QUEUE_REF, dryRun = true, prNumber = "" } = {}) {
  const env = {
    ...process.env,
    PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
    GH_SHIM_DIR: dir,
    GH_REPO: REPO,
    GH_TOKEN: "unused-by-shim",
    WORKFLOW_RUN_ID: RUN_ID,
    WORKFLOW_NAME: workflowName,
    WORKFLOW_HEAD_BRANCH: headBranch,
  };
  if (dryRun) env.REACT_DRY_RUN = "1";
  if (prNumber) env.PR_NUMBER = prNumber;
  const result = spawnSync("bash", [script], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

function job(id, name, conclusion) {
  return { id, name, conclusion };
}

test("react: enforcer-workflow failure surfaces check paperclip-approved-enforcer on the resolved PR", () => {
  const dir = makeFixture({
    jobs: [job(1, "paperclip-approved-enforcer", "failure")],
  });
  try {
    writeFileSync(path.join(dir, "1.log"), "[paperclip-approved][error] FAIL: paperclip/approved is missing\napproval guidance line\n");
    const r = run(dir, { workflowName: "Paperclip Approval Enforcer" });
    assert.equal(r.code, 0);
    const all = r.out + r.err;
    assert.match(all, /would surface check 'paperclip-approved-enforcer' on TEA-Core\/paperclip PR #4242/);
    assert.match(all, /failing job\(s\) on the merge-group commit:/);
    assert.match(all, /- paperclip-approved-enforcer/);
    assert.match(all, /--- paperclip-approved-enforcer failing output \(bounded tail\) ---/);
    assert.match(all, /FAIL: paperclip\/approved is missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("react: an approval-precondition collapse is not misattributed to a required check — skipped, deferring to the enforcer artefact", () => {
  // `Approval precondition` is an internal fast-gate, NOT a required merge_group
  // context (those are verify/e2e/paperclip-approved-enforcer). A PR-run whose
  // precondition failed collapsed before the required contexts could genuinely
  // run — verify/e2e conclusions are cascade. Naming any of them would
  // misattribute the ejection (merge-group-required-check-attribution); the
  // enforcer workflow's own reactor comment owns the approval story.
  const dir = makeFixture({
    jobs: [
      job(1, "Approval precondition", "failure"),
      job(2, "verify", "failure"),
      job(3, "e2e", "failure"),
    ],
  });
  try {
    const r = run(dir, { workflowName: "PR" });
    assert.equal(r.code, 0);
    assert.match(r.out + r.err, /collapsed on the approval precondition.*skipping this workflow.s surface/);
    assert.doesNotMatch(r.out + r.err, /would surface check/, "a collapse must not post a verify/e2e/precondition artefact");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("react: PR-workflow failure names verify (first required context) when a lane genuinely failed", () => {
  const dir = makeFixture({
    jobs: [
      job(1, "Approval precondition", "success"),
      job(2, "verify", "failure"),
      job(3, "e2e", "failure"),
    ],
  });
  try {
    writeFileSync(path.join(dir, "2.log"), "verify aggregate output\n");
    const r = run(dir, { workflowName: "PR" });
    assert.equal(r.code, 0);
    const all = r.out + r.err;
    assert.match(all, /would surface check 'verify' on TEA-Core\/paperclip PR #4242/);
    assert.doesNotMatch(all, /would surface check 'Approval precondition'/, "a non-required check must never be named");
    assert.doesNotMatch(all, /would surface check 'e2e'/, "verify precedes e2e in workflow order");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("react: PR-workflow failure names verify when only the verify context failed", () => {
  const dir = makeFixture({
    jobs: [job(1, "typecheck_release_registry", "success"), job(2, "verify", "failure")],
  });
  try {
    writeFileSync(path.join(dir, "2.log"), "general_tests lane failed\nsome real failure detail\n");
    const r = run(dir, { workflowName: "PR" });
    assert.equal(r.code, 0);
    const all = r.out + r.err;
    assert.match(all, /would surface check 'verify' on TEA-Core\/paperclip PR #4242/);
    assert.match(all, /--- verify failing output \(bounded tail\) ---/);
    assert.match(all, /some real failure detail/);
    assert.doesNotMatch(all, /typecheck_release_registry failing output/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("react: a verify aggregate failure quotes the genuinely-failed lane, not the thin aggregate log", () => {
  const dir = makeFixture({
    jobs: [
      job(1, "Approval precondition", "success"),
      job(2, "General tests (server (2/5))", "failure"),
      job(3, "verify", "failure"),
    ],
  });
  try {
    writeFileSync(path.join(dir, "2.log"), "server (2/5) real failure trace\nassertion failed on line 42\n");
    writeFileSync(path.join(dir, "3.log"), "verify aggregate\n");
    const r = run(dir, { workflowName: "PR" });
    assert.equal(r.code, 0);
    const all = r.out + r.err;
    assert.match(all, /would surface check 'verify' on TEA-Core\/paperclip PR #4242/);
    // The quoted reason must be the lane's real failure, not status-only.
    assert.match(all, /--- General tests \(server \(2\/5\)\) failing output \(bounded tail\) ---/);
    assert.match(all, /server \(2\/5\) real failure trace/);
    assert.doesNotMatch(all, /verify aggregate\n--- verify failing output/, "the thin aggregate log must not be quoted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("react: PR-workflow failure names e2e when only e2e failed", () => {
  const dir = makeFixture({
    jobs: [job(1, "e2e", "failure")],
  });
  try {
    writeFileSync(path.join(dir, "1.log"), "e2e shard 3 failure output\n");
    const r = run(dir, { workflowName: "PR" });
    assert.equal(r.code, 0);
    assert.match(r.out + r.err, /would surface check 'e2e' on TEA-Core\/paperclip PR #4242/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("react: a non-merge_group run is skipped (best-effort exit 0)", () => {
  const dir = makeFixture({ event: "pull_request", jobs: [job(1, "verify", "failure")] });
  try {
    const r = run(dir, { workflowName: "PR" });
    assert.equal(r.code, 0);
    assert.match(r.out + r.err, /not a merge_group run — skipping/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("react: a successful run is skipped", () => {
  const dir = makeFixture({ conclusion: "success", jobs: [job(1, "verify", "success")] });
  try {
    const r = run(dir, { workflowName: "PR" });
    assert.equal(r.code, 0);
    assert.match(r.out + r.err, /did not conclude failure — skipping/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("react: an unresolvable PR is skipped (best-effort exit 0)", () => {
  const dir = makeFixture({
    headBranch: "some/random/branch",
    jobs: [job(1, "paperclip-approved-enforcer", "failure")],
  });
  try {
    const r = run(dir, { workflowName: "Paperclip Approval Enforcer" });
    assert.equal(r.code, 0);
    assert.match(r.out + r.err, /could not resolve a PR/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("react: no failing job means nothing to name — best-effort skip", () => {
  const dir = makeFixture({ jobs: [job(1, "verify", "skipped")] });
  try {
    const r = run(dir, { workflowName: "PR" });
    assert.equal(r.code, 0);
    assert.match(r.out + r.err, /failed but no job concluded failure/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
