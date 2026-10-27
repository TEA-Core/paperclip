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
const DECISION_ID = "11111111-2222-4333-8444-555555555555";
const CARD_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EVIDENCE = "b".repeat(64);
const raTarget = (sha = HEAD_SHA, pr = PR) =>
  `https://paperclip.example/api/issues/${CARD_ID}/release-decisions?repo=TEA-Core%2Fpaperclip&pr=${pr}&head=${sha}&decision=${DECISION_ID}&evidence=${EVIDENCE}`;

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
  "url=\"\"",
  "jqfilter=\"\"",
  "paginate=0",
  "while [ \"$#\" -gt 0 ]; do",
  "  case \"$1\" in",
  "    api|--slurp) ;;",
  "    --paginate) paginate=1 ;;",
  "    -H) shift ;;",
  "    --jq|-q) shift; jqfilter=\"$1\" ;;",
  "    *) [ -n \"$url\" ] || url=\"$1\" ;;",
  "  esac",
  "  shift",
  "done",
  "case \"$url\" in",
  "  */statuses*)",
  "    # Emulate what `gh --paginate` does rather than guarding on the flag: an",
  "    # unpaginated read sees only the first page. That way the 100-noise case",
  "    # fails because the approval is genuinely out of reach, which is the real",
  "    # failure mode, instead of failing on an artificial refusal.",
  "    per_page=\"$(printf '%s' \"$url\" | sed -n 's/.*[?&]per_page=\\([0-9]*\\).*/\\1/p')\"",
  "    [ -n \"$per_page\" ] || per_page=30",
  "    if [ \"$paginate\" = \"1\" ]; then",
  "      jq -r \"$jqfilter\" \"$GH_SHIM_DIR/statuses.json\"",
  "    else",
  "      jq -r \".[0:$per_page] | ($jqfilter)\" \"$GH_SHIM_DIR/statuses.json\"",
  "    fi ;;",
  "  */status*)    echo \"gh shim: the combined /status endpoint omits creator and must not be used\" >&2; exit 1 ;;",
  "  */pulls/*)    cat \"$GH_SHIM_DIR/pull.json\" ;;",
  "  *) echo \"gh shim: unexpected call: $url\" >&2; exit 1 ;;",
  "esac",
  "",
].join("\n");

function makeFixture(statuses, { body = "an ordinary PR body with no waiver line", labels = [] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "pc-attribution-"));
  writeFileSync(
    path.join(dir, "pull.json"),
    JSON.stringify({
      head: { sha: HEAD_SHA, ref: "SUP-15270-some-card-branch" },
      body,
      labels: labels.map((name) => ({ name })),
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

function status(state, creator, context = "paperclip/approved", extra = {}) {
  return { context, state, creator, ...extra };
}

function raStatus(state = "success", creator = TEA_CORE, extra = {}) {
  return status(state, creator, "release-assurance/approved", {
    description: `released by release-assurance for ${HEAD_SHA}`,
    target_url: raTarget(),
    ...extra,
  });
}

function run(statuses, { event = "merge_group", ...fixtureOptions } = {}) {
  const fixture = makeFixture(statuses, fixtureOptions);
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
        // Pin the producer identity the fixtures emit. Inheriting a
        // PAPERCLIP_APPROVED_STATUS_CREATOR_ID from the surrounding
        // environment would fail every approval case for a reason that has
        // nothing to do with the code under test.
        PAPERCLIP_APPROVED_STATUS_CREATOR_ID: String(TEA_CORE.id),
        PAPERCLIP_APPROVED_STATUS_CREATOR_LOGIN: TEA_CORE.login,
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

for (const [label, row] of [
  ["null creator and numeric description", status("success", null, "paperclip/approved", { description: String(TEA_CORE.id) })],
  ["missing creator and numeric description", { context: "paperclip/approved", state: "success", description: String(TEA_CORE.id) }],
  ["empty creator and numeric description", status("success", {}, "paperclip/approved", { description: String(TEA_CORE.id) })],
  ["null creator ID and numeric description", status("success", { id: null }, "paperclip/approved", { description: String(TEA_CORE.id) })],
  ["empty creator ID and numeric description", status("success", { id: "" }, "paperclip/approved", { description: String(TEA_CORE.id) })],
  ["null creator and numeric target", status("success", null, "paperclip/approved", { target_url: String(TEA_CORE.id) })],
  ["missing creator and numeric target", { context: "paperclip/approved", state: "success", target_url: String(TEA_CORE.id) }],
  ["schema-complete null creator", status("success", null, "paperclip/approved", { description: String(TEA_CORE.id), target_url: null, id: 1, url: "https://api.github.com/statuses/1", created_at: "2026-10-26T00:00:00Z", updated_at: "2026-10-26T00:00:00Z" })],
]) {
  test(`unattributed ordinary success is refused with ${label}`, () => {
    const { code, err } = run([row]);
    assert.equal(code, 1);
    assert.match(err, /FORGED/);
  });
}

for (const [label, row] of [
  ["null creator", raStatus("success", null)],
  ["missing creator", { context: "release-assurance/approved", state: "success", description: `released by release-assurance for ${HEAD_SHA}`, target_url: raTarget() }],
]) {
  test(`unattributed release-assurance success is refused with ${label}`, () => {
    const { code, err } = run([row, status("success", TEA_CORE)]);
    assert.equal(code, 1);
    assert.match(err, /FORGED/);
  });
}

// Non-scalar projected fields must fail the whole status response rather than
// turning into printable text and leaving a trusted ordinary success admissible.
for (const [label, rows] of [
  ["ordinary creator login array", [status("success", { ...TEA_CORE, login: [] })]],
  ["ordinary creator login object", [status("success", { ...TEA_CORE, login: {} })]],
  ["ordinary creator login nonempty array", [status("success", { ...TEA_CORE, login: ["success"] })]],
  ["ordinary creator login nonempty object", [status("success", { ...TEA_CORE, login: { value: "success" } })]],
  ["unrelated context array", [status("success", FLEET_ONLY, []), status("success", TEA_CORE)]],
  ["unrelated context object", [status("success", FLEET_ONLY, {}), status("success", TEA_CORE)]],
  ["unrelated state array", [status([], FLEET_ONLY, "ci/unrelated"), status("success", TEA_CORE)]],
  ["unrelated state object", [status({}, FLEET_ONLY, "ci/unrelated"), status("success", TEA_CORE)]],
  ["unrelated creator login array", [status("success", { ...FLEET_ONLY, login: [] }, "ci/unrelated"), status("success", TEA_CORE)]],
  ["unrelated creator login object", [status("success", { ...FLEET_ONLY, login: {} }, "ci/unrelated"), status("success", TEA_CORE)]],
]) {
  test(`non-scalar ${label} refuses the entire status response`, () => {
    const { code, err } = run(rows);
    assert.equal(code, 1);
    assert.match(err, /API failure/);
  });
}

test("the newest status for the context decides, even when an older one is genuine", () => {
  // The list endpoint returns entries newest-first, which is what makes the
  // first match equivalent to the combined endpoint's reported value. A forged
  // status published after a genuine one must not be masked by the genuine one.
  const { code, err } = run([status("success", FLEET_ONLY), status("success", TEA_CORE)]);
  assert.equal(code, 1);
  assert.match(err, /FORGED/);
});

for (const [latestState, olderState, expectedCode] of [
  ["success", "failure", 0],
  ["pending", "success", 1],
  ["failure", "success", 1],
  ["missing", "success", 1], // Invalid GitHub state must not expose an older success.
]) {
  test(`the latest ordinary ${latestState} state decides ahead of an older ${olderState}`, () => {
    const { code } = run([status(latestState, TEA_CORE), status(olderState, TEA_CORE)]);
    assert.equal(code, expectedCode);
  });
}

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

test("the approval is found behind a page's worth of newer unrelated statuses", () => {
  // Anything holding `statuses:write` can add a context to the head commit, and
  // this list is not filtered server-side. 100 newer unrelated statuses push the
  // approval past the first page, where an unpaginated read reports `missing` --
  // and this leg is fail-closed, so it would block an approved entry out of the
  // queue rather than merely mis-reporting.
  //
  // Pagination itself is `gh --paginate`'s job and cannot be exercised through a
  // shim, which has no way to emit a `Link: rel="next"` header. So this is
  // covered from both ends: the shim refuses the call outright unless
  // `--paginate` is passed, and the selection below is proven correct with a
  // full page of newer rows ahead of the one that matters.
  const noise = Array.from({ length: 100 }, (_, i) =>
    status("success", FLEET_ONLY, `ci/unrelated-${i}`),
  );
  const { code, out } = run([...noise, status("success", TEA_CORE)]);
  assert.equal(code, 0);
  assert.match(out, /pass: paperclip\/approved = success/);
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

test("current-head release assurance from the trusted App and bound decision admits without a board stamp", () => {
  const { code, out } = run([raStatus()]);
  assert.equal(code, 0);
  assert.match(out, /pass: release-assurance\/approved = success/);
});

test("a later pending or failed release decision vetoes an earlier valid GO and board approval", () => {
  for (const state of ["pending", "failure"]) {
    const { code } = run([raStatus(state), raStatus(), status("success", TEA_CORE)]);
    assert.equal(code, 1, `${state} must veto older approvals`);
  }
});

test("an untrusted release-assurance success cannot replace a genuine board approval", () => {
  const { code, err } = run([raStatus("success", FLEET_ONLY), status("success", TEA_CORE)]);
  assert.equal(code, 1);
  assert.match(err, /FORGED/);
});

test("a release-assurance success must bind the live head, repository, PR and decision", () => {
  for (const candidate of [
    raStatus("success", TEA_CORE, { description: `released by release-assurance for ${"c".repeat(40)}` }),
    raStatus("success", TEA_CORE, { target_url: raTarget("c".repeat(40)) }),
    raStatus("success", TEA_CORE, { target_url: raTarget(HEAD_SHA, PR + 1) }),
    raStatus("success", TEA_CORE, { target_url: `https://paperclip.example/api/issues/${CARD_ID}/release-decisions` }),
    raStatus("success", TEA_CORE, { target_url: raTarget().replace("TEA-Core%2Fpaperclip", "attacker%2Frepo") }),
    raStatus("success", TEA_CORE, { target_url: raTarget().replace(DECISION_ID, "not-a-decision") }),
  ]) {
    const { code } = run([candidate]);
    assert.equal(code, 1, `unbound release assurance must fail: ${JSON.stringify(candidate)}`);
  }
});

test("an older forged release status cannot override a newer genuine GO", () => {
  const { code } = run([raStatus(), raStatus("success", FLEET_ONLY)]);
  assert.equal(code, 0);
});

test("a release-assurance hold cannot be bypassed with either cardless waiver", () => {
  for (const options of [
    { body: "Paperclip-Approved-Waiver: self declared" },
    { labels: ["no-paperclip-card"] },
  ]) {
    const { code } = run([raStatus("pending"), status("success", TEA_CORE)], options);
    assert.equal(code, 1);
  }
});

test("a missing-state latest RA record never falls back to an older GO or board stamp", () => {
  const { code } = run([raStatus(null), raStatus(), status("success", TEA_CORE)]);
  assert.equal(code, 1);
});

test("the latest release-assurance GO is found after a full page of unrelated statuses", () => {
  const noise = Array.from({ length: 100 }, (_, i) =>
    status("success", FLEET_ONLY, `ci/unrelated-${i}`),
  );
  const { code } = run([...noise, raStatus()]);
  assert.equal(code, 0);
});

test("the advisory PR leg observes the RA GO without publishing a status", () => {
  const { code, out } = run([raStatus()], { event: "pull_request" });
  assert.equal(code, 0);
  assert.match(out, /pass: release-assurance\/approved = success/);
});
