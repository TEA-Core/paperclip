import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const LIB_PATH = resolve(REPO_ROOT, "scripts", "release-lib.sh");
const RELEASE_SH_PATH = resolve(REPO_ROOT, "scripts", "release.sh");
const PR_WORKFLOW_PATH = resolve(REPO_ROOT, ".github", "workflows", "pr.yml");
const PACKAGE_JSON_PATH = resolve(REPO_ROOT, "package.json");

const DIVERGENT_SOURCE_GUARD_HEAD =
  'if [ "$dry_run" = true ] && [ "${RELEASE_ALLOW_DIVERGENT_SOURCE:-}" = "1" ]; then';

/**
 * Extracts the dry-run bypass guard verbatim from release.sh so the cases below
 * exercise the shipped conditional rather than a copy of it. A drift in the
 * script's guard shape surfaces here instead of silently passing.
 */
function extractDivergentSourceGuard() {
  const lines = readFileSync(RELEASE_SH_PATH, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === DIVERGENT_SOURCE_GUARD_HEAD);
  assert.notEqual(start, -1, `release.sh must contain the guard head: ${DIVERGENT_SOURCE_GUARD_HEAD}`);
  const end = lines.findIndex((line, index) => index > start && line.trim() === "fi");
  assert.notEqual(end, -1, "release.sh divergent-source guard must be terminated by fi");
  return lines.slice(start, end + 1).join("\n");
}

/**
 * Runs the extracted guard with the gate and warning helpers stubbed, so the
 * assertions observe which branch the guard takes without needing a git
 * lineage, an npm registry, or a real publish.
 */
function runDivergentSourceGuard({ dryRun, allowDivergentSource }) {
  const script = [
    'release_warn() { echo "WARN:$*"; }',
    'require_on_release_source_branch() { echo "GATE:$1:$2"; }',
    `dry_run=${dryRun ? "true" : "false"}`,
    'CURRENT_SHA="deadbeefcafe"',
    'PUBLISH_REMOTE="origin"',
    extractDivergentSourceGuard(),
  ].join("\n");

  const env = { ...process.env };
  delete env.RELEASE_ALLOW_DIVERGENT_SOURCE;
  if (allowDivergentSource !== undefined) {
    env.RELEASE_ALLOW_DIVERGENT_SOURCE = allowDivergentSource;
  }

  const stdout = execFileSync("bash", ["-c", script], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    gateRan: stdout.includes("GATE:origin:deadbeefcafe"),
    warned: stdout.includes("WARN:"),
    stdout,
  };
}

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "release-lineage-"));
  const git = (args, opts = {}) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);

  writeFileSync(join(dir, "README.md"), "main\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "main commit"]);
  const mainSha = git(["rev-parse", "HEAD"]).trim();

  git(["checkout", "-q", "-b", "master"]);
  writeFileSync(join(dir, "README.md"), "master divergent\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "master divergent commit"]);
  const masterSha = git(["rev-parse", "HEAD"]).trim();

  git(["remote", "add", "origin", dir]);
  git(["fetch", "-q", "origin", "main", "master"]);

  return { dir, mainSha, masterSha, git };
}

function evalGateInRepo(repoDir, currentSha, env = {}) {
  const script = `
    REPO_ROOT="${repoDir}"
    RELEASE_SOURCE_BRANCH="${env.RELEASE_SOURCE_BRANCH ?? "main"}"
    PUBLISH_REMOTE="origin"
    CURRENT_SHA="${currentSha}"
    . "${LIB_PATH}"
    require_on_release_source_branch "$PUBLISH_REMOTE" "$CURRENT_SHA"
    `;
  try {
    execFileSync("bash", ["-c", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.stderr?.toString().trim() ?? err.message };
  }
}

test("require_on_release_source_branch accepts a commit on the main lineage", () => {
  const repo = makeTempRepo();
  try {
    const result = evalGateInRepo(repo.dir, repo.mainSha);
    assert.equal(result.ok, true);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("require_on_release_source_branch accepts a detached commit that is an ancestor of origin/main", () => {
  const repo = makeTempRepo();
  try {
    const ancestor = execFileSync("git", ["-C", repo.dir, "rev-list", "--max-parents=0", "main"], {
      encoding: "utf8",
    }).trim();
    const result = evalGateInRepo(repo.dir, ancestor);
    assert.equal(result.ok, true);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("require_on_release_source_branch rejects the divergent master commit", () => {
  const repo = makeTempRepo();
  try {
    const result = evalGateInRepo(repo.dir, repo.masterSha);
    assert.equal(result.ok, false);
    assert.match(result.message, /authoritative source lineage/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("require_on_release_source_branch fails closed when the authoritative remote ref cannot be resolved", () => {
  const repo = makeTempRepo();
  try {
    const script = `
      REPO_ROOT="${repo.dir}"
      RELEASE_SOURCE_BRANCH="nonexistent-branch"
      PUBLISH_REMOTE="origin"
      CURRENT_SHA="${repo.mainSha}"
      . "${LIB_PATH}"
      require_on_release_source_branch "$PUBLISH_REMOTE" "$CURRENT_SHA"
      `;
    let threw = false;
    let message = "";
    try {
      execFileSync("bash", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      threw = true;
      message = err.stderr?.toString().trim() ?? err.message;
    }
    assert.equal(threw, true);
    assert.match(message, /authoritative source lineage/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("release.sh invokes require_on_release_source_branch before the canary/stable conditional", () => {
  const source = execFileSync("bash", ["-c", `cat "${RELEASE_SH_PATH}"`], {
    encoding: "utf8",
  });

  const gateCallIndex = source.indexOf('require_on_release_source_branch "$PUBLISH_REMOTE" "$CURRENT_SHA"');
  assert.notEqual(gateCallIndex, -1, "release.sh must call require_on_release_source_branch with PUBLISH_REMOTE and CURRENT_SHA");

  const canaryConditionalIndex = source.indexOf('if [ "$channel" = "canary" ]; then');
  assert.notEqual(canaryConditionalIndex, -1, "release.sh must contain the canary/stable conditional");

  assert.ok(
    gateCallIndex < canaryConditionalIndex,
    "require_on_release_source_branch must be called before the canary/stable conditional so both channels are gated",
  );

  assert.equal(
    source.indexOf("require_on_master_branch"),
    -1,
    "release.sh must not call the legacy require_on_master_branch",
  );
});

test("release.sh bypasses the lineage gate only for a dry run that opts in via RELEASE_ALLOW_DIVERGENT_SOURCE", () => {
  const result = runDivergentSourceGuard({ dryRun: true, allowDivergentSource: "1" });
  assert.equal(result.gateRan, false, "the lineage gate must not run for an opted-in dry run");
  assert.equal(result.warned, true, "the bypass must be announced so the skip is visible in CI logs");
});

test("release.sh still enforces the lineage gate for a real publish even when RELEASE_ALLOW_DIVERGENT_SOURCE is set", () => {
  const result = runDivergentSourceGuard({ dryRun: false, allowDivergentSource: "1" });
  assert.equal(
    result.gateRan,
    true,
    "the env var must never bypass the gate outside --dry-run, or a divergent lineage could be published",
  );
  assert.equal(result.warned, false);
});

test("release.sh still enforces the lineage gate for a dry run that did not opt in", () => {
  for (const allowDivergentSource of [undefined, "", "0", "true"]) {
    const result = runDivergentSourceGuard({ dryRun: true, allowDivergentSource });
    assert.equal(
      result.gateRan,
      true,
      `dry run with RELEASE_ALLOW_DIVERGENT_SOURCE=${JSON.stringify(allowDivergentSource)} must still be gated`,
    );
  }
});

test("the PR canary dry run opts into the bypass instead of forging a local master branch", () => {
  const workflow = readFileSync(PR_WORKFLOW_PATH, "utf8");

  assert.equal(
    /git\s+checkout\s+-B\s+master/.test(workflow),
    false,
    "pr.yml must not forge a local master branch to satisfy the release source lineage gate",
  );
  assert.match(
    workflow,
    /RELEASE_ALLOW_DIVERGENT_SOURCE:\s*"1"/,
    "the canary dry run must opt into the documented dry-run bypass",
  );
});

test("the PR workflow runs the release source lineage gate suite", () => {
  const workflow = readFileSync(PR_WORKFLOW_PATH, "utf8");
  assert.match(
    workflow,
    /pnpm run test:release-source/,
    "pr.yml must run test:release-source so the lineage gate is covered on every PR",
  );

  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
  assert.equal(
    typeof pkg.scripts?.["test:release-source"],
    "string",
    "package.json must define the test:release-source script the workflow invokes",
  );
  assert.match(
    pkg.scripts["test:release-source"],
    /scripts\/release-source-branch\.test\.mjs/,
    "test:release-source must run this suite",
  );
});

const SHARED_DIST = resolve(
  REPO_ROOT,
  "packages",
  "shared",
  "dist",
  "validators",
  "issue.js",
);

function ensureSharedBuilt() {
  try {
    execFileSync("test", ["-f", SHARED_DIST]);
    return;
  } catch {
  }
  execFileSync("bash", ["-c", `cd "${resolve(REPO_ROOT, "packages", "shared")}" && npx tsc`], {
    stdio: "pipe",
  });
}

const REQUIRED_VALIDATOR =
  /returnAssigneeAgentId:\s*z\.string\(\)\.trim\(\)\.uuid\(\)\.optional\(\)\.nullable\(\)/;

const ISSUE_EXECUTION_POLICY_INITIALIZER_RE =
  /export const issueExecutionPolicySchema = z\.object\(\{([\s\S]*?)\}\);/;

function assertArtifactHasValidReturnAssigneeAgentId(source) {
  const match = source.match(ISSUE_EXECUTION_POLICY_INITIALIZER_RE);
  assert.ok(match, "built shared artifact must define issueExecutionPolicySchema as z.object({...})");
  assert.match(
    match[1],
    REQUIRED_VALIDATOR,
    "issueExecutionPolicySchema initializer must contain returnAssigneeAgentId: z.string().trim().uuid().optional().nullable()",
  );
}

test("built @paperclipai/shared issueExecutionPolicySchema exposes returnAssigneeAgentId as optional nullable UUID", () => {
  ensureSharedBuilt();
  const source = execFileSync("bash", ["-c", `cat "${SHARED_DIST}"`], { encoding: "utf8" });
  assertArtifactHasValidReturnAssigneeAgentId(source);
});

test("built artifact assertion rejects a malformed returnAssigneeAgentId validator", () => {
  ensureSharedBuilt();
  const source = execFileSync("bash", ["-c", `cat "${SHARED_DIST}"`], { encoding: "utf8" });

  const malformed = source
    .replace(
      /returnAssigneeAgentId:\s*z\.string\(\)\.trim\(\)\.uuid\(\)\.optional\(\)\.nullable\(\)/,
      "returnAssigneeAgentId: z.boolean()",
    )
    .replace(
      /(\}\);)(\s*\n\s*export const issueReviewRequestSchema)/,
      "$1\nexport const decoySchema = z.object({ returnAssigneeAgentId: z.string().trim().uuid().optional().nullable() });$2",
    );

  assert.throws(
    () => assertArtifactHasValidReturnAssigneeAgentId(malformed),
    /issueExecutionPolicySchema initializer must contain returnAssigneeAgentId/,
    "malformed fixture with z.boolean() in the policy schema and a correctly shaped decoy field outside the schema initializer must be rejected",
  );
});
