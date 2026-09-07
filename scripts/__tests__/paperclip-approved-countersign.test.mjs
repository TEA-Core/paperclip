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
  "    if [ \"$paginate\" != \"1\" ]; then",
  "      echo \"gh shim: the statuses read must be paginated\" >&2",
  "      exit 1",
  "    fi",
  "    jq -r \"$jqfilter\" \"$GH_SHIM_DIR/statuses.json\" ;;",
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
// on this branch class the waiver is the default route on the riskiest change
// in the repository -- and the `fleet-only` grant carries
// `pull_requests:write`, so the identity that opens the PR can author either
// waiver form for itself. These tests pin the countersignature that puts a
// person on that path.

test("an uncountersigned body waiver on a fold-sync head does not merge", () => {
  withFixture({}, ({ code, err }) => {
    assert.equal(code, 1);
    assert.match(err, /fold-sync branch/);
    assert.match(err, /approving review\n?.*human GitHub account|human GitHub account/s);
  });
});

test("a human approval on the current head SHA countersigns the waiver", () => {
  withFixture({ reviews: [review()] }, ({ code, out }) => {
    assert.equal(code, 0);
    assert.match(out, /countersigned: body waiver/);
    assert.match(out, /@kronik187/);
  });
});

test("a Bot approval does not countersign", () => {
  withFixture(
    { reviews: [review({ user: { login: "fleet-only[bot]", type: "Bot" } })] },
    ({ code, err }) => {
      // The whole point is an identity the fleet's own installation token
      // cannot produce. An App review reports user.type "Bot".
      assert.equal(code, 1);
      assert.match(err, /fold-sync branch/);
    },
  );
});

test("an approval carried over from an earlier commit does not countersign", () => {
  withFixture({ reviews: [review({ commit_id: OLD_SHA })] }, ({ code, err }) => {
    // pr.yml's stale-merge-base check hard-fails past 20 commits behind or 24h,
    // so a fold PR is pushed to its FINAL SHA and only then approved. An
    // approval against an earlier commit reviewed a different tree.
    assert.equal(code, 1);
    assert.match(err, /FINAL head SHA/);
  });
});

test("a later CHANGES_REQUESTED from the same account supersedes its approval", () => {
  withFixture(
    { reviews: [review(), review({ state: "CHANGES_REQUESTED" })] },
    ({ code }) => assert.equal(code, 1),
  );
});

test("a retraction targeting an older commit still supersedes the approval", () => {
  // A review may target any commit associated with the PR. Filtering by
  // commit_id while accumulating each reviewer's state would discard this
  // CHANGES_REQUESTED as "not on the head SHA" and leave the superseded
  // approval standing -- the countersignature would survive its own retraction.
  withFixture(
    { reviews: [review(), review({ state: "CHANGES_REQUESTED", commit_id: OLD_SHA })] },
    ({ code }) => assert.equal(code, 1),
  );
});

test("an approval superseded on an old commit and re-approved on head counts", () => {
  // The mirror case: the final state is what matters, and it is an approval of
  // the current head.
  withFixture(
    {
      reviews: [
        review({ state: "CHANGES_REQUESTED", commit_id: OLD_SHA }),
        review(),
      ],
    },
    ({ code }) => assert.equal(code, 0),
  );
});

test("a COMMENTED review after an approval leaves the approval standing", () => {
  withFixture(
    { reviews: [review(), review({ state: "COMMENTED" })] },
    ({ code }) => assert.equal(code, 0),
  );
});

test("an unaffiliated account's approval does not countersign", () => {
  // TEA-Core/paperclip is a PUBLIC repository, so any GitHub account can submit
  // an approving review on any PR. `user.type == "User"` proves the reviewer is
  // a person, not that they have any standing here -- without the association
  // check a drive-by APPROVED would countersign a fold waiver on the branch
  // that auto-deploys to production.
  for (const assoc of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE", ""]) {
    withFixture(
      {
        reviews: [
          review({ user: { login: "passer-by", type: "User" }, author_association: assoc }),
        ],
      },
      ({ code }) => assert.equal(code, 1, `author_association ${assoc || "<empty>"} must not count`),
    );
  }
});

test("owners and collaborators countersign as well as members", () => {
  for (const assoc of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    withFixture(
      { reviews: [review({ author_association: assoc })] },
      ({ code }) => assert.equal(code, 0, `author_association ${assoc} must count`),
    );
  }
});

test("the PR author's own approval does not countersign", () => {
  withFixture(
    {
      author: "kronik187",
      reviews: [review({ user: { login: "kronik187", type: "User" } })],
    },
    ({ code }) => assert.equal(code, 1),
  );
});

test("the no-paperclip-card label is countersigned on a fold-sync head too", () => {
  // Leaving one of the two waiver forms uncountersigned would leave the gate
  // exactly as open as before: `pull_requests:write` covers labels.
  withFixture({ body: "no waiver line here", labels: ["no-paperclip-card"] }, ({ code, err }) => {
    assert.equal(code, 1);
    assert.match(err, /no-paperclip-card/);
  });
  withFixture(
    { body: "no waiver line here", labels: ["no-paperclip-card"], reviews: [review()] },
    ({ code, out }) => {
      assert.equal(code, 0);
      assert.match(out, /countersigned: the 'no-paperclip-card' label/);
    },
  );
});

test("a non-fold head keeps the unmodified waiver", () => {
  // Scoped deliberately: cardless doctrine-sync, rescue and router-only PRs are
  // ~26/day and must not acquire a review requirement.
  withFixture({ headRef: "SUP-15270-context-snapshot-size-bound" }, ({ code, out }) => {
    assert.equal(code, 0);
    assert.match(out, /waived: PR body declares/);
  });
});

test("an uncountersigned waiver still falls through to the status check", () => {
  // The countersignature gates the waiver, not the ordinary gate. A fold PR
  // that somehow does carry paperclip/approved must still pass.
  withFixture({ approvedState: "success" }, ({ code, out }) => {
    assert.equal(code, 0);
    assert.match(out, /pass: paperclip\/approved = success/);
  });
});

test("a failure reading the reviews never reads as countersigned", () => {
  withFixture({ reviewsFail: true }, ({ code, err }) => {
    assert.equal(code, 1);
    assert.match(err, /could not read the PR's reviews/);
  });
});

test("pull_request stays advisory for an uncountersigned fold waiver", () => {
  // The merge queue is the enforcement point. A fail-closed pull_request arm
  // would make every fold PR red for its whole working life, and GitHub does
  // not re-run a pull_request workflow when a review lands later.
  withFixture({}, ({ code }) => assert.equal(code, 0), { event: "pull_request" });
});
