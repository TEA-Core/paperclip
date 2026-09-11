import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readWorkflow(name) {
  return readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
}

test("release workflow delegates stable and canary verification to the reusable workflow", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  assert.match(
    releaseWorkflow,
    /verify_canary:\n\s+if: github\.event_name == 'push'\n\s+uses: \.\/\.github\/workflows\/release-verify\.yml\n\s+with:\n\s+ref: \$\{\{ github\.sha \}\}/,
  );
  // The stable lane is gated on the stable channel since the nightly lane
  // was added; a `needs:` line (for example a preflight job) may sit between
  // the gate and the delegation.
  // The stable preflight resolves source_ref to an immutable SHA exactly
  // once; verification must consume that pin, not re-resolve the ref.
  assert.match(
    releaseWorkflow,
    /verify_stable:\n\s+if: github\.event_name == 'workflow_dispatch' && inputs\.channel == 'stable'\n(?:\s+needs: [^\n]+\n)?\s+uses: \.\/\.github\/workflows\/release-verify\.yml\n\s+with:\n\s+ref: \$\{\{ needs\.preflight_stable\.outputs\.sha \}\}/,
  );
  assert.doesNotMatch(releaseWorkflow, /verify_(?:canary|stable):[\s\S]*?pnpm test:run(?:\n|$)/);
});

test("onboard smoke container binds beyond loopback so the mapped port is reachable", () => {
  const dockerfile = readFileSync(path.join(repoRoot, "docker/Dockerfile.onboard-smoke"), "utf8");

  // `onboard --yes` without an explicit --bind prefers trusted-local
  // defaults and writes a loopback bind, which Docker port mapping cannot
  // reach. The smoke container must pin a non-loopback preset.
  assert.match(dockerfile, /onboard --yes --bind lan/);
});

test("promotion selection guards against sources that predate their channel tooling", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // Promotions run the source commit's release.sh, so selection must reject
  // sources whose tooling does not know the target channel yet.
  assert.match(releaseWorkflow, /git show "\$\{sha\}:scripts\/release\.sh" \| grep -qF 'canary\|nightly'/);
  assert.match(releaseWorkflow, /git show "\$\{sha\}:scripts\/release\.sh" \| grep -qF 'canary\|nightly\|beta\|stable\)'/);
});

test("candidate-branch betas are validated and fully verified before publish", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // Candidate heads are new commits: selection must pin the naming
  // convention and publication must be gated on full verification.
  assert.match(releaseWorkflow, /candidate\/beta-\*\)/);
  assert.match(
    releaseWorkflow,
    /verify_beta_candidate:\n\s+needs: select_beta\n\s+if: needs\.select_beta\.outputs\.mode == 'candidate'\n\s+uses: \.\/\.github\/workflows\/release-verify\.yml/,
  );
  assert.match(releaseWorkflow, /needs\.verify_beta_candidate\.result == 'success'/);
});

test("post-publish beta smoke survives the skipped candidate-verification ancestor", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // publish_beta's needs chain contains verify_beta_candidate, which is
  // skipped on promote-mode betas. An `if:` without a status-check function
  // gets an implicit success() that evaluates that chain transitively and
  // silently skips the smoke. The condition must stay explicit.
  assert.match(
    releaseWorkflow,
    /smoke_beta:\n\s+needs: publish_beta\n\s+if: \$\{\{ !cancelled\(\) && needs\.publish_beta\.result == 'success' && !inputs\.dry_run \}\}/,
  );
});

test("every lane's tag push degrades to recovery instructions when rejected", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // GITHUB_TOKEN may not create refs pointing at workflow-modifying commits
  // from dispatch or scheduled runs; a rejected tag push after a successful
  // npm publish must surface runbook recovery commands, not a bare error.
  const occurrences = releaseWorkflow.match(/## Tag push rejected/g) ?? [];
  assert.equal(occurrences.length, 3, "nightly, beta, and stable each carry the recovery summary");
});

test("release smoke workflow extends the container readiness budget for CI", () => {
  const smokeWorkflow = readWorkflow("release-smoke.yml");
  const harness = readFileSync(path.join(repoRoot, "scripts/docker-onboard-smoke.sh"), "utf8");

  // CI containers cold-install paperclipai and embedded postgres, so the
  // workflow must extend the harness's local-default readiness budget.
  assert.match(smokeWorkflow, /SMOKE_READY_TIMEOUT_SECONDS=\d+/);
  const ciBudget = Number(smokeWorkflow.match(/SMOKE_READY_TIMEOUT_SECONDS=(\d+)/)[1]);
  assert.ok(ciBudget >= 300, `CI readiness budget ${ciBudget}s should be at least 300s`);

  assert.match(harness, /SMOKE_READY_TIMEOUT_SECONDS="\$\{SMOKE_READY_TIMEOUT_SECONDS:-\d+\}"/);
  assert.match(harness, /wait_for_http "\$PAPERCLIP_PUBLIC_URL\/api\/health" "\$SMOKE_READY_TIMEOUT_SECONDS" 1/);
});

test("release verify workflow covers the same split test surface as stable PR verification", () => {
  const verifyWorkflow = readWorkflow("release-verify.yml");

  assert.match(verifyWorkflow, /workflow_call:/);
  assert.match(verifyWorkflow, /node \.\/scripts\/release-package-map\.mjs check/);
  assert.match(verifyWorkflow, /pnpm -r typecheck/);
  assert.match(verifyWorkflow, /pnpm build/);
  assert.match(verifyWorkflow, /pnpm --filter @paperclipai\/paperclip-runner check:all/);

  for (const group of ["general-server", "general-workspaces-a", "general-workspaces-b"]) {
    assert.match(verifyWorkflow, new RegExp(`group: ${group}`));
  }

  for (const shardIndex of [0, 1, 2]) {
    assert.match(
      verifyWorkflow,
      new RegExp(`group: general-server[\\s\\S]*?shard_index: ${shardIndex}[\\s\\S]*?shard_count: 3`),
    );
  }

  for (const shardIndex of [0, 1, 2, 3, 4]) {
    assert.match(verifyWorkflow, new RegExp(`shard_index: ${shardIndex}[\\s\\S]*?shard_count: 5`));
  }

  // workspaces-a splits with Vitest native --shard in pr.yml; release
  // verification must keep the same two-shard coverage.
  for (const shardIndex of [0, 1]) {
    assert.match(
      verifyWorkflow,
      new RegExp(`group: general-workspaces-a[\\s\\S]*?shard_index: ${shardIndex}\\n\\s+shard_count: 2`),
    );
  }

  assert.match(verifyWorkflow, /pnpm test:run:general -- --group/);
  assert.match(verifyWorkflow, /pnpm test:run:serialized -- --shard-index/);
});

// Step names per job, read from each job's `steps:` list. A step's `name` can
// sit on its `- ` line or on any later key line of that step, so this tracks
// step boundaries instead of matching `- name:` alone. Keys nested deeper than
// the step's own keys (a `with: name:` input, say) are not step names, and
// neither are `- name:` entries outside `steps:` (a matrix `include:` list).
// Line-based on purpose: the policy job runs this before any install, and a
// YAML parser would be a new dependency, which means a lockfile edit.
function stepNamesByJob(text) {
  const lines = text.split("\n");
  const jobs = new Map();
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt === -1) return jobs;
  const unquote = (value) => value.replace(/^(["'])(.*)\1$/, "$2");
  let names = null;
  let stepsIndent = -1;
  let itemIndent = -1;
  for (const line of lines.slice(jobsAt + 1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.search(/\S/);
    const job = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (job) {
      names = [];
      jobs.set(job[1], names);
      stepsIndent = -1;
      itemIndent = -1;
      continue;
    }
    if (!names) continue;
    const item = line.match(/^(\s*)-\s+(.*)$/);
    if (stepsIndent !== -1) {
      const leftSteps = indent < stepsIndent || (indent === stepsIndent && !item);
      if (leftSteps) {
        stepsIndent = -1;
        itemIndent = -1;
      }
    }
    if (stepsIndent === -1) {
      const steps = line.match(/^(\s+)steps:\s*$/);
      if (steps) stepsIndent = steps[1].length;
      continue;
    }
    if (item && (itemIndent === -1 || item[1].length === itemIndent)) {
      itemIndent = item[1].length;
      const inline = item[2].match(/^name:\s*(.+?)\s*$/);
      if (inline) names.push(unquote(inline[1]));
      continue;
    }
    const key = line.match(/^(\s*)name:\s*(.+?)\s*$/);
    if (key && key[1].length === itemIndent + 2) names.push(unquote(key[2]));
  }
  return jobs;
}

function duplicateStepNames(text) {
  const offenders = [];
  for (const [job, names] of stepNamesByJob(text)) {
    const seen = new Map();
    for (const name of names) seen.set(name, (seen.get(name) ?? 0) + 1);
    for (const [name, count] of seen) {
      if (count > 1) offenders.push(`${job}: "${name}" x${count}`);
    }
  }
  return offenders;
}

test("no workflow repeats a step name within one job", () => {
  // A 3-way merge that resolves a conflicted region by keeping BOTH sides
  // leaves a whole step twice, back to back, with no conflict marker. YAML
  // accepts it and Actions runs both copies. Fold 1446a58c0 (2026-08-30) did
  // exactly that to publish_stable's "Build Docker images for the stable tag"
  // step, so every stable release dispatched docker.yml twice at the same tag.
  // A repeated step name inside one job is how that defect shows up in a
  // workflow, and no workflow here repeats one on purpose. If a future step
  // genuinely needs the same label, rename one of them.
  const workflowsDir = path.join(repoRoot, ".github/workflows");
  const offenders = [];
  for (const file of readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name))) {
    for (const offender of duplicateStepNames(readWorkflow(file))) {
      offenders.push(`${file} > ${offender}`);
    }
  }
  assert.deepEqual(offenders, [], `duplicated steps:\n${offenders.join("\n")}`);
});

test("the step-name parser reads names in any key order and skips non-step names", () => {
  const workflow = [
    "jobs:",
    "  build:",
    "    strategy:",
    "      matrix:",
    "        include:",
    "          - name: linux",
    "          - name: linux",
    "    steps:",
    "      - name: Checkout",
    "        uses: actions/checkout@v4",
    "      - uses: actions/upload-artifact@v4",
    "        name: Upload",
    "        with:",
    "          name: Upload",
    "      - run: echo done",
    "        name: 'Upload'",
    "  other:",
    "    steps:",
    "    - name: Upload",
    "",
  ].join("\n");

  // `name` after `uses:`/`run:` counts, a quoted name matches an unquoted one,
  // the `with: name:` input does not count, the matrix entries do not count,
  // and a list written at the same indent as `steps:` still parses.
  assert.deepEqual([...stepNamesByJob(workflow)], [
    ["build", ["Checkout", "Upload", "Upload"]],
    ["other", ["Upload"]],
  ]);
  assert.deepEqual(duplicateStepNames(workflow), ['build: "Upload" x2']);
});
