import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const LIB_PATH = resolve(REPO_ROOT, "scripts", "release-lib.sh");
const RELEASE_SH_PATH = resolve(REPO_ROOT, "scripts", "release.sh");

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

const SHARED_DIST = resolve(
  REPO_ROOT,
  "packages",
  "shared",
  "dist",
  "validators",
  "issue.js",
);

const REQUIRED_VALIDATOR =
  /returnAssigneeAgentId:\s*z\.string\(\)\.trim\(\)\.uuid\(\)\.optional\(\)\.nullable\(\)/;

function assertArtifactHasValidReturnAssigneeAgentId(source) {
  const match = source.match(/export const issueExecutionPolicySchema = z\.object\(\{([\s\S]*?)\}\);/);
  assert.ok(match, "built shared artifact must define issueExecutionPolicySchema as z.object({...})");
  assert.match(
    match[1],
    REQUIRED_VALIDATOR,
    "issueExecutionPolicySchema initializer must contain returnAssigneeAgentId: z.string().trim().uuid().optional().nullable()",
  );
}

test("built @paperclipai/shared issueExecutionPolicySchema exposes returnAssigneeAgentId as optional nullable UUID", () => {
  const source = execFileSync("bash", ["-c", `cat "${SHARED_DIST}"`], { encoding: "utf8" });
  assertArtifactHasValidReturnAssigneeAgentId(source);
});

test("built artifact assertion rejects a malformed returnAssigneeAgentId validator", () => {
  const source = execFileSync("bash", ["-c", `cat "${SHARED_DIST}"`], { encoding: "utf8" });

  const malformed = source
    .replace(
      /returnAssigneeAgentId:\s*z\.string\(\)\.trim\(\)\.uuid\(\)\.optional\(\)\.nullable\(\)/,
      "returnAssigneeAgentId: z.boolean()",
    )
    .replace(
      /(\}\);)(\s*\n\s*export const issueReviewRequestSchema)/,
      "$1\nexport const returnAssigneeAgentId = z.string().trim().uuid().optional().nullable();$2",
    );

  assert.throws(
    () => assertArtifactHasValidReturnAssigneeAgentId(malformed),
    /issueExecutionPolicySchema initializer must contain returnAssigneeAgentId/,
    "malformed fixture with z.boolean() in the policy schema and a correctly shaped decoy field outside the schema initializer must be rejected",
  );
});
