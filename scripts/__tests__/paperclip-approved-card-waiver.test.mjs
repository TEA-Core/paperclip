import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// SUP-20772: the free-text waiver and the no-paperclip-card label stop working
// on a card-bound (SUP-<n>-...) head once PAPERCLIP_CARD_WAIVER_RETIRED=1, and
// the board release (a head-bound paperclip/approved from the control plane)
// is what lands such a PR instead. Cardless PRs keep both, for a person or
// github-actions[bot] author only.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts/ci/check-paperclip-approved.sh");

const REPO = "TEA-Core/paperclip";
const PR = 4242;
const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const QUEUE_REF = `refs/heads/gh-readonly-queue/fold/tea-patches-v2026.722.0/pr-${PR}-0123456789abcdef`;
const TEA_CORE = { id: 317012809, login: "tea-core[bot]", type: "Bot" };

const GH_SHIM = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "url=\"\"",
  "jqfilter=\"\"",
  "while [ \"$#\" -gt 0 ]; do",
  "  case \"$1\" in",
  "    api|--slurp|--paginate) ;;",
  "    -H) shift ;;",
  "    --jq|-q) shift; jqfilter=\"$1\" ;;",
  "    *) [ -n \"$url\" ] || url=\"$1\" ;;",
  "  esac",
  "  shift",
  "done",
  "case \"$url\" in",
  "  */statuses*) jq -r \"$jqfilter\" \"$GH_SHIM_DIR/statuses.json\" ;;",
  "  */pulls/*/reviews*) echo '[]' ;;",
  "  */pulls/*)    cat \"$GH_SHIM_DIR/pull.json\" ;;",
  "  *) echo \"gh shim: unexpected call: $url\" >&2; exit 1 ;;",
  "esac",
  "",
].join("\n");

const WAIVER_BODY = "Paperclip-Approved-Waiver: sync with no card";

function run({ ref, author, body = "", title = "", labels = [], statuses = [], retired = true, retiredValue }) {
  const dir = mkdtempSync(path.join(tmpdir(), "pc-card-waiver-"));
  try {
    writeFileSync(
      path.join(dir, "pull.json"),
      JSON.stringify({
        head: { sha: HEAD_SHA, ref },
        title,
        body,
        labels: labels.map((name) => ({ name })),
        user: author,
      }),
    );
    writeFileSync(path.join(dir, "statuses.json"), JSON.stringify(statuses));
    const bin = path.join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "gh"), GH_SHIM);
    chmodSync(path.join(bin, "gh"), 0o755);
    const result = spawnSync("bash", [script, "merge_group"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_SHIM_DIR: dir,
        GH_REPO: REPO,
        PAPERCLIP_APPROVED_STATUS_CREATOR_ID: String(TEA_CORE.id),
        PAPERCLIP_APPROVED_STATUS_CREATOR_LOGIN: TEA_CORE.login,
        PAPERCLIP_CARD_WAIVER_RETIRED: retiredValue ?? (retired ? "1" : ""),
        GITHUB_REF: QUEUE_REF,
        GITHUB_REF_NAME: QUEUE_REF.replace("refs/heads/", ""),
      },
    });
    return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PERSON = { login: "release-operator", type: "User" };
const FLEET_APP = { login: "fleet-only[bot]", type: "Bot" };
const TEA_CORE_APP = { login: TEA_CORE.login, type: "Bot", id: TEA_CORE.id };
const UNKNOWN_BOT = { login: "mystery[bot]", type: "Bot", id: 42 };
const ACTIONS_BOT = { login: "github-actions[bot]", type: "Bot" };
const CARD_BRANCH = "SUP-20772-stamp-merge-release-d";
const CARDLESS_BRANCH = "doctrine-sync-2026-10-22";
const release = { id: 7001, context: "paperclip/approved", state: "success", creator: TEA_CORE, description: `released by user:u1 for ${HEAD_SHA}: no receipt` };
// The control plane writes this after it has committed the confirmation of the release above (newest first).
const confirmedMarker = { id: 7002, context: "paperclip/release-confirmed", state: "success", creator: TEA_CORE, description: "confirms status 7001" };

test("a body waiver on a SUP-prefixed branch is refused", () => {
  const { code, out } = run({ ref: CARD_BRANCH, author: PERSON, body: WAIVER_BODY });
  assert.equal(code, 1);
  assert.match(out, /REFUSED: body waiver/);
  assert.doesNotMatch(out, /waived:/);
});

test("the no-paperclip-card label on a SUP-prefixed branch is refused", () => {
  const { code, out } = run({ ref: CARD_BRANCH, author: PERSON, labels: ["no-paperclip-card"] });
  assert.equal(code, 1);
  assert.match(out, /REFUSED: the 'no-paperclip-card' label/);
});

test("the SUP prefix match is case-insensitive and also covers a bare SUP-<n>", () => {
  for (const ref of ["sup-20772-lowercase", "SUP-20772"]) {
    assert.equal(run({ ref, author: PERSON, body: WAIVER_BODY }).code, 1, ref);
  }
});

test("a branch that merely contains SUP- is cardless and keeps its waiver", () => {
  assert.equal(run({ ref: "fix/SUP-1-in-the-middle", author: PERSON, body: WAIVER_BODY }).code, 0);
});

test("a board release on the head lands a SUP-prefixed PR and is named in the log", () => {
  const { code, out } = run({ ref: CARD_BRANCH, author: PERSON, body: WAIVER_BODY, statuses: [confirmedMarker, release] });
  assert.equal(code, 0);
  assert.match(out, /pass: paperclip\/approved = success/);
  assert.match(out, new RegExp(`board release: released by user:u1 for ${HEAD_SHA}`));
});

// Round 8: CI consumes a release only beside the control plane's confirmation marker, switch on or off.
test("with the switch on, a release the control plane has not marked confirmed is not an approval", () => {
  const { code, out } = run({ ref: CARD_BRANCH, author: PERSON, statuses: [release] });
  assert.equal(code, 1);
  assert.match(out, /UNCONFIRMED RELEASE/);
  assert.match(out, /FAIL: paperclip\/approved is unconfirmed-release/);
});

test("with the switch off, a release-described success is judged like any other success, marker or not", () => {
  for (const statuses of [[release], [confirmedMarker, release]]) {
    const { code, out } = run({ ref: CARD_BRANCH, author: PERSON, statuses, retired: false });
    assert.equal(code, 0);
    assert.doesNotMatch(out, /UNCONFIRMED|board release/);
  }
});

test("a marker written by anyone but the control plane does not confirm a release", () => {
  const forgedMarker = { ...confirmedMarker, creator: { id: 1, login: "fleet-only[bot]", type: "Bot" } };
  const { code, out } = run({ ref: CARD_BRANCH, author: PERSON, statuses: [forgedMarker, release] });
  assert.equal(code, 1);
  assert.match(out, /UNCONFIRMED RELEASE/);
});

test("a marker that names another status does not confirm this release", () => {
  const other = { ...confirmedMarker, description: "confirms status 9999" };
  assert.equal(run({ ref: CARD_BRANCH, author: PERSON, statuses: [other, release] }).code, 1);
});

test("a marker whose description is not a bare status id confirms nothing", () => {
  for (const description of ["confirms status 7001 and more", "confirms status 70x1", "confirms status ", "7001"]) {
    const marker = { ...confirmedMarker, description };
    assert.equal(run({ ref: CARD_BRANCH, author: PERSON, statuses: [marker, release] }).code, 1, description);
  }
});

test("a failure written after the release voids it, marker or not", () => {
  const voided = { id: 7003, context: "paperclip/approved", state: "failure", creator: TEA_CORE, description: "voided: x" };
  const { code, out } = run({ ref: CARD_BRANCH, author: PERSON, statuses: [voided, confirmedMarker, release] });
  assert.equal(code, 1);
  assert.match(out, /paperclip\/approved is failure/);
});

test("with the switch on, a success that is not a board release needs no marker, as before", () => {
  const ordinary = { id: 5, context: "paperclip/approved", state: "success", creator: TEA_CORE, description: "SUP-1 approved via Paperclip" };
  for (const retired of [true, false]) {
    assert.equal(run({ ref: CARD_BRANCH, author: PERSON, statuses: [ordinary], retired }).code, 0, `retired=${retired}`);
  }
});

test("a release status written by another creator is still refused as forged, not as unconfirmed", () => {
  const forged = { ...release, creator: { id: 1, login: "fleet-only[bot]", type: "Bot" } };
  const { code, out } = run({ ref: CARD_BRANCH, author: PERSON, statuses: [confirmedMarker, forged] });
  assert.equal(code, 1);
  assert.match(out, /FORGED/);
});

test("a waiver on a SUP-prefixed branch does not hide a forged status", () => {
  const forged = { ...release, creator: { id: 1, login: "fleet-only[bot]", type: "Bot" } };
  const { code, out } = run({ ref: CARD_BRANCH, author: PERSON, body: WAIVER_BODY, statuses: [forged] });
  assert.equal(code, 1);
  assert.match(out, /FORGED/);
});

test("a cardless PR by a person keeps both the body waiver and the label", () => {
  assert.equal(run({ ref: CARDLESS_BRANCH, author: PERSON, body: WAIVER_BODY }).code, 0);
  assert.equal(run({ ref: CARDLESS_BRANCH, author: PERSON, labels: ["no-paperclip-card"] }).code, 0);
});

test("a cardless PR by github-actions[bot] keeps its waiver (the lockfile refresh)", () => {
  assert.equal(run({ ref: "chore/refresh-lockfile", author: ACTIONS_BOT, body: WAIVER_BODY }).code, 0);
});

test("a cardless PR opened by the tea-core App keeps its waiver (the lockfile refresh)", () => {
  assert.equal(run({ ref: "chore/refresh-lockfile-123", author: TEA_CORE_APP, body: "Paperclip-Approved-Waiver: automated lockfile refresh" }).code, 0);
});

test("a SUP-prefixed branch authored by the tea-core App is still refused", () => {
  const { code, out } = run({ ref: CARD_BRANCH, author: TEA_CORE_APP, body: WAIVER_BODY });
  assert.equal(code, 1);
  assert.match(out, /REFUSED: body waiver/);
});

test("a cardless PR authored by an unknown bot cannot waive itself", () => {
  const { code, out } = run({ ref: CARDLESS_BRANCH, author: UNKNOWN_BOT, body: WAIVER_BODY });
  assert.equal(code, 1);
  assert.match(out, /may waive a cardless PR/);
});

test("a cardless PR authored by the fleet App cannot waive itself", () => {
  for (const input of [{ body: WAIVER_BODY }, { labels: ["no-paperclip-card"] }]) {
    const { code, out } = run({ ref: CARDLESS_BRANCH, author: FLEET_APP, ...input });
    assert.equal(code, 1);
    assert.match(out, /may waive a cardless PR/);
  }
});

test("with the switch off a genuine board release is not announced, and the denial has no board hint", () => {
  const passed = run({ ref: CARD_BRANCH, author: PERSON, statuses: [confirmedMarker, release], retired: false });
  assert.equal(passed.code, 0);
  assert.match(passed.out, /pass: paperclip\/approved = success/);
  assert.doesNotMatch(passed.out, /board release/);
  const denied = run({ ref: CARD_BRANCH, author: PERSON, retired: false });
  assert.equal(denied.code, 1);
  assert.match(denied.out, /FAIL: paperclip\/approved is missing/);
  assert.doesNotMatch(denied.out, /merge-arming\/release/);
});

test("only the exact value 1 arms the switch (and its board-release output)", () => {
  for (const value of ["", "0", "true", "TRUE", "false", " 1 ", "yes"]) {
    const { out } = run({ ref: CARD_BRANCH, author: PERSON, statuses: [confirmedMarker, release], retiredValue: value });
    assert.doesNotMatch(out, /board release/, JSON.stringify(value));
  }
  assert.match(run({ ref: CARD_BRANCH, author: PERSON, statuses: [confirmedMarker, release], retiredValue: "1" }).out, /board release/);
});

test("with the switch on the denial points at the board release route", () => {
  const { code, out } = run({ ref: CARD_BRANCH, author: PERSON });
  assert.equal(code, 1);
  assert.match(out, /POST \/api\/issues\/:id\/merge-arming\/release/);
});

test("with the switch off (the shipped default) every waiver behaves as before", () => {
  for (const [ref, author] of [[CARD_BRANCH, PERSON], [CARDLESS_BRANCH, FLEET_APP]]) {
    assert.equal(run({ ref, author, body: WAIVER_BODY, retired: false }).code, 0, `${ref} ${author.login}`);
  }
});

// KNOWN RESIDUAL BYPASS (see the header of the script and docs/branch-protection.md).
// The check reads GitHub only, so card binding (head ref) and "person" (user.type)
// are author-chosen. These tests pin what the check does today with the switch on, so
// the residual cannot be widened or closed by accident; they are not an endorsement.

test("residual: a card work item pushed to a non-SUP branch keeps its waiver, logged UNVERIFIED", () => {
  const { code, out } = run({
    ref: "agent/renamed-away-from-the-card",
    author: PERSON,
    title: "feat(SUP-20772): the card's real work item",
    body: `Card SUP-20772.\n${WAIVER_BODY}`,
  });
  assert.equal(code, 0);
  assert.match(out, /waived:/);
  assert.match(out, /UNVERIFIED: body waiver .* honoured on head 'agent\/renamed-away-from-the-card'/);
  assert.match(out, /no card binding was checked against the control plane/);
});

test("residual: a machine token typed User passes as a person for the body waiver and the label, logged UNVERIFIED", () => {
  const machineUser = { login: "fleet-token-user", type: "User" };
  for (const input of [{ body: WAIVER_BODY }, { labels: ["no-paperclip-card"] }]) {
    const { code, out } = run({ ref: CARDLESS_BRANCH, author: machineUser, ...input });
    assert.equal(code, 0);
    assert.match(out, /UNVERIFIED: .* by author fleet-token-user \(type User\)/);
  }
});

test("the same machine token typed User is still refused on a SUP-prefixed branch", () => {
  const { code, out } = run({ ref: CARD_BRANCH, author: { login: "fleet-token-user", type: "User" }, body: WAIVER_BODY });
  assert.equal(code, 1);
  assert.match(out, /REFUSED: body waiver/);
  assert.doesNotMatch(out, /UNVERIFIED/);
});

test("UNVERIFIED is only logged for a waiver honoured with the switch on", () => {
  const off = run({ ref: CARDLESS_BRANCH, author: PERSON, body: WAIVER_BODY, retired: false });
  assert.equal(off.code, 0);
  assert.doesNotMatch(off.out, /UNVERIFIED/);
  const refused = run({ ref: CARDLESS_BRANCH, author: FLEET_APP, body: WAIVER_BODY });
  assert.equal(refused.code, 1);
  assert.doesNotMatch(refused.out, /UNVERIFIED/);
});
