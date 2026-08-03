import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const LIB_PATH = resolve(REPO_ROOT, "scripts", "release-lib.sh");
const RELEASE_SH_PATH = resolve(REPO_ROOT, "scripts", "release.sh");

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "release-source-branch-"));

function fixtureGit(...args) {
  return execFileSync("git", args, {
    cwd: FIXTURE_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

let mainSha;
let masterSha;
let ancestorSha;

before(() => {
  fixtureGit("init", "-q", "-b", "main");
  fixtureGit("config", "user.email", "test@example.com");
  fixtureGit("config", "user.name", "Test");
  fixtureGit("config", "commit.gpgsign", "false");

  writeFileSync(join(FIXTURE_DIR, "ancestor.txt"), "ancestor\n");
  fixtureGit("add", "ancestor.txt");
  fixtureGit("commit", "-q", "-m", "ancestor commit");
  ancestorSha = fixtureGit("rev-parse", "HEAD").toString().trim();

  writeFileSync(join(FIXTURE_DIR, "main.txt"), "main\n");
  fixtureGit("add", "main.txt");
  fixtureGit("commit", "-q", "-m", "main commit");
  mainSha = fixtureGit("rev-parse", "HEAD").toString().trim();

  fixtureGit("checkout", "-q", "-b", "master", ancestorSha);
  writeFileSync(join(FIXTURE_DIR, "master.txt"), "master\n");
  fixtureGit("add", "master.txt");
  fixtureGit("commit", "-q", "-m", "master commit");
  masterSha = fixtureGit("rev-parse", "HEAD").toString().trim();

  fixtureGit("update-ref", "refs/remotes/origin/main", mainSha);
  fixtureGit("update-ref", "refs/remotes/origin/master", masterSha);
});

after(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

function evalGate(remote, sha, env = {}) {
  const script = `
    REPO_ROOT="${FIXTURE_DIR}"
    RELEASE_SOURCE_BRANCH="${env.RELEASE_SOURCE_BRANCH ?? "main"}"
    . "${LIB_PATH}"
    require_on_release_source_branch "${remote}" "${sha}"
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

test("require_on_release_source_branch accepts a commit on the authoritative main lineage", () => {
  const result = evalGate("origin", mainSha);
  assert.equal(result.ok, true);
});

test("require_on_release_source_branch accepts a detached commit that is an ancestor of origin/main", () => {
  const result = evalGate("origin", ancestorSha);
  assert.equal(result.ok, true);
});

test("require_on_release_source_branch rejects the divergent master commit", () => {
  const result = evalGate("origin", masterSha);
  assert.equal(result.ok, false);
  assert.match(result.message, /authoritative source lineage origin\/main/);
  assert.match(result.message, /not an ancestor/);
});

test("require_on_release_source_branch fails closed when the authoritative ref cannot be resolved", () => {
  const result = evalGate("origin", mainSha, { RELEASE_SOURCE_BRANCH: "missing" });
  assert.equal(result.ok, false);
  assert.match(result.message, /origin\/missing cannot be resolved/);
});

test("require_on_release_source_branch honors RELEASE_SOURCE_BRANCH override", () => {
  const result = evalGate("origin", masterSha, { RELEASE_SOURCE_BRANCH: "master" });
  assert.equal(result.ok, true);
});

test("require_on_release_source_branch rejects a non-ancestor under override", () => {
  const result = evalGate("origin", mainSha, { RELEASE_SOURCE_BRANCH: "master" });
  assert.equal(result.ok, false);
  assert.match(result.message, /authoritative source lineage origin\/master/);
});

test("release.sh invokes the source-lineage gate once before the canary/stable conditional", () => {
  const releaseSh = readFileSync(RELEASE_SH_PATH, "utf8");
  const gateCalls = releaseSh.match(/require_on_release_source_branch/g) ?? [];
  assert.equal(gateCalls.length, 1, "release.sh must invoke require_on_release_source_branch exactly once");

  const gateIndex = releaseSh.indexOf("require_on_release_source_branch");
  const canaryConditional = releaseSh.indexOf('if [ "$channel" = "canary" ]');
  assert.ok(canaryConditional !== -1, "release.sh must contain the canary/stable conditional");
  assert.ok(
    gateIndex < canaryConditional,
    "the gate must run before the canary/stable conditional so both channels are gated",
  );

  assert.match(
    releaseSh,
    /require_on_release_source_branch "\$PUBLISH_REMOTE" "\$CURRENT_SHA"/,
    "the gate must be called with the publish remote and resolved current SHA",
  );
});

test("the lineage gate can only be bypassed by an explicit opt-in on a dry run", () => {
  const releaseSh = readFileSync(RELEASE_SH_PATH, "utf8");

  assert.match(
    releaseSh,
    /if \[ "\$dry_run" = true \] && \[ "\$\{RELEASE_ALLOW_DIVERGENT_SOURCE:-\}" = "1" \]; then/,
    "the bypass must require both --dry-run and RELEASE_ALLOW_DIVERGENT_SOURCE=1",
  );

  const bypassIndex = releaseSh.indexOf('"${RELEASE_ALLOW_DIVERGENT_SOURCE:-}"');
  const gateIndex = releaseSh.indexOf("require_on_release_source_branch");
  assert.ok(
    bypassIndex !== -1 && bypassIndex < gateIndex,
    "the bypass condition must guard the gate call, not follow it",
  );
});

test("the PR workflow dry run opts out of the lineage gate instead of forging a branch name", () => {
  const prWorkflow = readFileSync(resolve(REPO_ROOT, ".github", "workflows", "pr.yml"), "utf8");

  assert.match(
    prWorkflow,
    /RELEASE_ALLOW_DIVERGENT_SOURCE: "1"/,
    "the PR canary dry run must opt out of the lineage gate explicitly",
  );
  assert.doesNotMatch(
    prWorkflow,
    /git checkout -B (main|master) HEAD/,
    "the PR canary dry run must not fake the release source branch name",
  );
  assert.match(
    prWorkflow,
    /\.\/scripts\/release\.sh canary --skip-verify --dry-run/,
    "the PR canary dry run must still run release.sh in dry-run mode",
  );
});

test("the release workflow never opts out of the lineage gate", () => {
  const releaseWorkflow = readFileSync(resolve(REPO_ROOT, ".github", "workflows", "release.yml"), "utf8");

  assert.doesNotMatch(
    releaseWorkflow,
    /RELEASE_ALLOW_DIVERGENT_SOURCE/,
    "publish and stable preview jobs must stay gated on main lineage",
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

function extractSchemaInitializer(source, schemaName) {
  const marker = `export const ${schemaName} = z.object({`;
  const start = source.indexOf(marker);
  if (start === -1) return null;
  const openBrace = source.indexOf("{", start);
  if (openBrace === -1) return null;
  let depth = 0;
  let i = openBrace;
  for (; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) return null;
  return source.slice(start, i + 1);
}

function assertBuiltPolicySchema(source) {
  const initializer = extractSchemaInitializer(source, "issueExecutionPolicySchema");
  assert.ok(
    initializer,
    "compiled shared artifact must define export const issueExecutionPolicySchema = z.object({ ... })",
  );
  assert.match(
    initializer,
    /returnAssigneeAgentId:\s*z\.string\(\)\.trim\(\)\.uuid\(\)\.optional\(\)\.nullable\(\)/,
    "issueExecutionPolicySchema must declare returnAssigneeAgentId with the optional nullable UUID validator chain",
  );
  return initializer;
}

test("built @paperclipai/shared issueExecutionPolicySchema exposes optional nullable UUID returnAssigneeAgentId", () => {
  const source = readFileSync(SHARED_DIST, "utf8");
  const initializer = assertBuiltPolicySchema(source);
  assert.match(initializer, /export const issueExecutionPolicySchema = z\.object\(\{/);
});

test("built-artifact assertion rejects a wrong validator inside the schema even with a decoy field outside", () => {
  const source = readFileSync(SHARED_DIST, "utf8");
  const malformed = source
    .replace(
      "returnAssigneeAgentId: z.string().trim().uuid().optional().nullable()",
      "returnAssigneeAgentId: z.boolean().optional()",
    )
    .concat(
      "\nconst decoy = { returnAssigneeAgentId: z.string().trim().uuid().optional().nullable() };\n",
    );
  assert.throws(
    () => assertBuiltPolicySchema(malformed),
    /returnAssigneeAgentId with the optional nullable UUID validator chain/,
  );
});
