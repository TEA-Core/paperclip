import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts/ci/check-paperclip-approved.sh");

const REPO = "TEA-Core/paperclip";
const PR = 4242;
const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLD_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const QUEUE_REF = `refs/heads/gh-readonly-queue/fold/tea-patches-v2026.722.0/pr-${PR}-0123456789abcdef`;

// The control-plane App's bot user — the only identity whose
// `paperclip/approved` the enforcer accepts.
const TEA_CORE = { id: 317012809, login: "tea-core[bot]", type: "Bot" };

// A `gh` stand-in. The enforcer makes three read-only calls and nothing else,
// so the shim can be exact: an unrecognised call is a hard failure rather than
// a silently empty payload, which is what would let a test pass for the wrong
// reason.
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
  "  */pulls/*/reviews*)",
  "    if [ \"$GH_SHIM_REVIEWS_FAIL\" = \"1\" ]; then",
  "      echo \"gh: HTTP 502 (shim)\" >&2",
  "      exit 1",
  "    fi",
  "    jq -r \"$jqfilter\" \"$GH_SHIM_DIR/reviews.json\" ;;",
  "  */pulls/*)   cat \"$GH_SHIM_DIR/pull.json\" ;;",
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
  "  */status*)   echo \"gh shim: the combined /status endpoint omits creator and must not be used\" >&2; exit 1 ;;",
  "  *) echo \"gh shim: unexpected call: $url\" >&2; exit 1 ;;",
  "esac",
  "",
].join("\n");

function makeFixture({
  headRef = "fold-sync/2026-09-06",
  body = "Paperclip-Approved-Waiver: fold PR, no card is reachable",
  labels = [],
  author = "fleet-only[bot]",
  reviews = [],
  approvedState = null,
  reviewsFail = false,
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "pc-approved-"));
  writeFileSync(
    path.join(dir, "pull.json"),
    JSON.stringify({
      head: { sha: HEAD_SHA, ref: headRef },
      body,
      labels: labels.map((name) => ({ name })),
      user: { login: author },
    }),
  );
  // List-shaped, and carrying the control-plane App's creator: the enforcer
  // reads `/commits/{sha}/statuses` (the combined `/status` endpoint omits
  // `creator`) and refuses a `success` published by anyone else.
  writeFileSync(
    path.join(dir, "statuses.json"),
    JSON.stringify(
      approvedState
        ? [
            {
              context: "paperclip/approved",
              state: approvedState,
              creator: TEA_CORE,
            },
          ]
        : [],
    ),
  );
  writeFileSync(path.join(dir, "reviews.json"), JSON.stringify(reviews));

  const bin = path.join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  const gh = path.join(bin, "gh");
  writeFileSync(gh, GH_SHIM);
  chmodSync(gh, 0o755);
  return { dir, bin, reviewsFail };
}

function run(fixture, { event = "merge_group" } = {}) {
  const args = event === "merge_group" ? [script, event] : [script, event, String(PR)];
  const result = spawnSync("bash", args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      GH_SHIM_DIR: fixture.dir,
      GH_SHIM_REVIEWS_FAIL: fixture.reviewsFail ? "1" : "0",
      GH_REPO: REPO,
      // Pin the producer identity the fixtures emit. Inheriting a
      // PAPERCLIP_APPROVED_STATUS_CREATOR_ID from the surrounding environment
      // would fail every approval case for a reason that has nothing to do
      // with the code under test.
      PAPERCLIP_APPROVED_STATUS_CREATOR_ID: String(TEA_CORE.id),
      PAPERCLIP_APPROVED_STATUS_CREATOR_LOGIN: TEA_CORE.login,
      GITHUB_REF: event === "merge_group" ? QUEUE_REF : "",
      GITHUB_REF_NAME: event === "merge_group" ? QUEUE_REF.replace("refs/heads/", "") : "",
    },
  });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "" };
}

function review(overrides = {}) {
  return {
    state: "APPROVED",
    commit_id: HEAD_SHA,
    user: { login: "kronik187", type: "User" },
    author_association: "MEMBER",
    ...overrides,
  };
}

function withFixture(options, assertions, runOptions) {
  const fixture = makeFixture(options);
  try {
    assertions(run(fixture, runOptions), fixture);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

// A `fold-sync/*` PR cannot earn `paperclip/approved`: the head must stay
// `fold-sync/*` for pr.yml's lockfile exemption, and that is mutually exclusive
// with the execution-workspace branch match `isDeliveredByCard()` requires. So
// on this branch class the waiver is the only route.
//
// 2026-09-07: the countersignature that used to gate that route is now ADVISORY.
// TEA-Core/paperclip has two collaborators and the operator opens the fold PR, so
// the rule demanded a second account that in practice was the same person — a
// formality the gate cannot detect, and one that read as a safety property in
// write-ups. Operator ruling; see the fork design doc, D3.
//
// These tests pin BOTH halves of that decision:
//   1. the waiver now stands on a fold head with no review at all, and
//   2. the advisory resolution is still correct, so the log keeps answering
//      "did a human look at this fold" and the logic does not rot before anyone
//      decides to re-enable it.
// Deleting the second half would leave a note nobody can trust.

// --- 1. the gate is gone ------------------------------------------------------

test("an uncountersigned body waiver on a fold-sync head now merges", () => {
  withFixture({ reviews: [] }, ({ code, out, err }) => {
    assert.equal(code, 0, `expected the waiver to stand alone\n${out}${err}`);
    assert.match(`${out}${err}`, /NOT countersigned \(advisory\)/);
    assert.match(`${out}${err}`, /not enforced, so the waiver stands/);
  });
});

test("an uncountersigned no-paperclip-card label on a fold-sync head now merges", () => {
  withFixture(
    { body: "no waiver line here", labels: ["no-paperclip-card"], reviews: [] },
    ({ code, out, err }) => {
      assert.equal(code, 0, `expected the label waiver to stand alone\n${out}${err}`);
      assert.match(`${out}${err}`, /NOT countersigned \(advisory\)/);
    },
  );
});

test("a failure reading the reviews cannot fail the build", () => {
  // An advisory signal that can break CI is worse than no signal: it would make
  // every fold hostage to a transient 502 on a call whose answer is not used.
  withFixture({ reviews: [], reviewsFail: true }, ({ code, out, err }) => {
    assert.equal(code, 0, `a reviews API failure must not gate\n${out}${err}`);
    assert.match(`${out}${err}`, /countersignature UNKNOWN \(advisory\)/);
  });
});

test("a non-fold head still keeps the unmodified waiver", () => {
  withFixture({ headRef: "docs/sync", reviews: [] }, ({ code, out, err }) => {
    assert.equal(code, 0, `${out}${err}`);
    assert.doesNotMatch(`${out}${err}`, /advisory/, "no countersignature note belongs on a non-fold head");
  });
});

// --- 2. the gate that REMAINS -------------------------------------------------

test("a fold head with no waiver and no approval still fails", () => {
  // The waiver is what stands alone now — not the absence of one. If this ever
  // passes, the change went further than the ruling.
  withFixture({ body: "no waiver line here", labels: [], reviews: [] }, ({ code }) => {
    assert.equal(code, 1, "a fold PR with neither a waiver nor an approval must not merge");
  });
});

// --- 3. the advisory resolution is still correct ------------------------------

const advisoryCases = [
  ["a human approval on the current head SHA", [review()], /countersigned \(advisory\)/],
  ["a Bot approval", [review({ user: { login: "tea-core[bot]", type: "Bot" } })], /NOT countersigned/],
  ["an approval carried over from an earlier commit", [review({ commit_id: OLD_SHA })], /NOT countersigned/],
  [
    "a later CHANGES_REQUESTED from the same account",
    [review(), review({ state: "CHANGES_REQUESTED" })],
    /NOT countersigned/,
  ],
  [
    "a retraction targeting an older commit",
    [review(), review({ state: "CHANGES_REQUESTED", commit_id: OLD_SHA })],
    /NOT countersigned/,
  ],
  [
    "an approval superseded on an old commit and re-approved on head",
    [review(), review({ state: "CHANGES_REQUESTED", commit_id: OLD_SHA }), review()],
    /countersigned \(advisory\)/,
  ],
  [
    "a COMMENTED review after an approval",
    [review(), review({ state: "COMMENTED" })],
    /countersigned \(advisory\)/,
  ],
  [
    "an unaffiliated account's approval",
    [review({ user: { login: "passer-by", type: "User" }, author_association: "CONTRIBUTOR" })],
    /NOT countersigned/,
  ],
  ["an OWNER's approval", [review({ author_association: "OWNER" })], /countersigned \(advisory\)/],
  [
    "a COLLABORATOR's approval",
    [review({ author_association: "COLLABORATOR" })],
    /countersigned \(advisory\)/,
  ],
];

for (const [label, reviews, expected] of advisoryCases) {
  test(`advisory note: ${label}`, () => {
    withFixture({ reviews }, ({ code, out, err }) => {
      // Every one of these merges now. Only the NOTE differs.
      assert.equal(code, 0, `the waiver stands regardless of the review\n${out}${err}`);
      assert.match(`${out}${err}`, expected);
    });
  });
}

test("advisory note: the PR author's own approval does not count", () => {
  // GitHub already refuses author self-approval. Asserted because the note would
  // otherwise claim a human reviewed a fold the author waived for themselves —
  // which is exactly the shape the ruling accepted knowingly, and the log must
  // not overstate it.
  withFixture(
    { author: "kronik187", reviews: [review({ user: { login: "kronik187", type: "User" } })] },
    ({ code, out, err }) => {
      assert.equal(code, 0, `${out}${err}`);
      assert.match(`${out}${err}`, /NOT countersigned/);
    },
  );
});

test("advisory note: a retraction whose association has since downgraded still supersedes", () => {
  // `author_association` is computed per review at submission time, so someone
  // who leaves the org submits their next review as CONTRIBUTOR. Filtering on it
  // while accumulating would drop the retraction and leave the approval standing.
  withFixture(
    {
      reviews: [
        review(),
        review({ state: "CHANGES_REQUESTED", author_association: "CONTRIBUTOR" }),
      ],
    },
    ({ code, out, err }) => {
      assert.equal(code, 0, `${out}${err}`);
      assert.match(`${out}${err}`, /NOT countersigned/);
    },
  );
});

test("pull_request stays advisory for a fold waiver", () => {
  withFixture({ reviews: [] }, ({ code }) => {
    assert.equal(code, 0);
  }, { event: "pull_request" });
});
