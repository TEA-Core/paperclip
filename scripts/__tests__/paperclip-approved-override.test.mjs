import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const LABEL = "override:paperclip-approval";
const QUEUE_REF = `refs/heads/gh-readonly-queue/fold/tea-patches-v2026.722.0/pr-${PR}-0123456789abcdef`;
const TEA_CORE = { id: 317012809, login: "tea-core[bot]", type: "Bot" };

const PUSHED = "2026-10-23T10:00:00Z";
const LABELED = "2026-10-23T10:05:00Z";
const LATER = "2026-10-23T10:10:00Z";

// A `gh` stand-in for the override path. It answers only the calls the enforcer
// is allowed to make; check runs are a hard failure so no test can pass by
// binding the override to check-run association, which carries no PR on
// merge_group and is what ejected labeled PRs from the queue elsewhere. Every
// call is appended to calls.log so a test can assert which endpoints ran.
const GH_SHIM = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  "url=\"\"",
  "jqfilter=\"\"",
  "while [ \"$#\" -gt 0 ]; do",
  "  case \"$1\" in",
  "    api|--paginate) ;;",
  "    -H) shift ;;",
  "    --jq|-q) shift; jqfilter=\"$1\" ;;",
  "    *) [ -n \"$url\" ] || url=\"$1\" ;;",
  "  esac",
  "  shift",
  "done",
  "echo \"$url\" >> \"$GH_SHIM_DIR/calls.log\"",
  "fail() { echo \"gh: HTTP 403 (shim)\" >&2; exit 1; }",
  "case \"$url\" in",
  "  */check-runs*|*/check-suites*) echo \"gh shim: check runs must not be used to bind the override\" >&2; exit 1 ;;",
  "  */issues/*/events*)",
  "    [ \"$GH_SHIM_FAIL\" != \"events\" ] || fail",
  "    jq -r \"$jqfilter\" \"$GH_SHIM_DIR/events.json\" ;;",
  "  */collaborators/*/permission)",
  "    [ \"$GH_SHIM_FAIL\" != \"permission\" ] || fail",
  "    login=\"$(printf '%s' \"$url\" | sed -n 's|.*/collaborators/\\([^/]*\\)/permission|\\1|p')\"",
  "    jq -r --arg l \"$login\" \".[\\$l] // {} | ($jqfilter)\" \"$GH_SHIM_DIR/permissions.json\" ;;",
  "  */activity?*)",
  "    [ \"$GH_SHIM_FAIL\" != \"activity\" ] || fail",
  "    ref=\"$(printf '%s' \"$url\" | sed -n 's/.*[?&]ref=\\([^&]*\\).*/\\1/p' | sed 's/%2F/\\//g')\"",
  "    jq -r --arg r \"$ref\" \"[.[] | select(.ref == \\$r)] | ($jqfilter)\" \"$GH_SHIM_DIR/activity.json\" ;;",
  "  */pulls/*/reviews*) echo '' ;;",
  "  */pulls/*) cat \"$GH_SHIM_DIR/pull.json\" ;;",
  "  */statuses*) jq -r \"$jqfilter\" \"$GH_SHIM_DIR/statuses.json\" ;;",
  "  *) echo \"gh shim: unexpected call: $url\" >&2; exit 1 ;;",
  "esac",
  "",
].join("\n");

const labeled = (login, at = LABELED, type = "User", label = LABEL) => ({
  event: "labeled",
  created_at: at,
  label: { name: label },
  actor: { login, type },
});
const unlabeled = (login, at) => ({ ...labeled(login, at), event: "unlabeled" });

function makeFixture({
  headRef = "SUP-20897-paperclip-approval-override-label",
  headRepo = REPO,
  body = "no waiver here",
  labels = [LABEL],
  events = [labeled("captain")],
  permissions = { captain: { role_name: "admin", permission: "admin" } },
  activity = [{ ref: `refs/heads/${headRef}`, activity_type: "push", before: OLD_SHA, after: HEAD_SHA, timestamp: PUSHED }],
  status = null,
  statusCreator = TEA_CORE,
  fail = "",
} = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "pc-override-"));
  writeFileSync(
    path.join(dir, "pull.json"),
    JSON.stringify({
      head: { sha: HEAD_SHA, ref: headRef, repo: headRepo ? { full_name: headRepo } : null },
      body,
      labels: labels.map((name) => ({ name })),
      user: { login: "fleet-only[bot]" },
    }),
  );
  writeFileSync(
    path.join(dir, "statuses.json"),
    JSON.stringify(status ? [{ context: "paperclip/approved", state: status, creator: statusCreator }] : []),
  );
  writeFileSync(path.join(dir, "events.json"), JSON.stringify(events));
  writeFileSync(path.join(dir, "permissions.json"), JSON.stringify(permissions));
  writeFileSync(path.join(dir, "activity.json"), JSON.stringify(activity));
  writeFileSync(path.join(dir, "calls.log"), "");
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const gh = path.join(bin, "gh");
  writeFileSync(gh, GH_SHIM);
  chmodSync(gh, 0o755);
  return { dir, bin, fail };
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
      GH_SHIM_FAIL: fixture.fail,
      GH_REPO: REPO,
      PAPERCLIP_APPROVED_STATUS_CREATOR_ID: String(TEA_CORE.id),
      PAPERCLIP_APPROVED_STATUS_CREATOR_LOGIN: TEA_CORE.login,
      GITHUB_ACTIONS: "",
      GITHUB_STEP_SUMMARY: "",
      GITHUB_REF: event === "merge_group" ? QUEUE_REF : "",
      GITHUB_REF_NAME: event === "merge_group" ? QUEUE_REF.replace("refs/heads/", "") : "",
    },
  });
  const calls = readFileSync(path.join(fixture.dir, "calls.log"), "utf8");
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}`, calls };
}

function withFixture(options, assertions, runOptions) {
  const fixture = makeFixture(options);
  try {
    assertions(run(fixture, runOptions));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
}

// --- honored ------------------------------------------------------------------

test("merge_group honors a head pushed before a write-access labeler's label", () => {
  // The case that matters: the queue entry's check runs carry no PR, and the
  // override must still hold. The PR is resolved from the queue ref.
  withFixture({}, ({ code, out, calls }) => {
    assert.equal(code, 0, out);
    assert.match(out, /OVERRIDE HONORED: override:paperclip-approval applied by @captain at 2026-10-23T10:05:00Z/);
    assert.match(calls, /pulls\/4242\n/);
    assert.doesNotMatch(calls, /check-runs|check-suites/);
  });
});

test("pull_request honors the same override", () => {
  withFixture({}, ({ code, out }) => {
    assert.equal(code, 0, out);
    assert.match(out, /OVERRIDE HONORED/);
  }, { event: "pull_request" });
});

test("the most recent labeled event decides, not the first", () => {
  withFixture(
    { events: [labeled("drive-by", "2026-10-23T09:00:00Z"), labeled("captain")], permissions: { captain: { role_name: "write" } } },
    ({ code, out }) => assert.equal(code, 0, out),
  );
  withFixture(
    { events: [labeled("captain", "2026-10-23T09:00:00Z"), labeled("drive-by")], permissions: { captain: { role_name: "admin" }, "drive-by": { role_name: "read" } } },
    ({ code, out }) => {
      assert.equal(code, 1, out);
      assert.match(out, /labeler 'drive-by' has role 'read'/);
    },
  );
});

test("maintain counts as write access", () => {
  withFixture({ permissions: { captain: { role_name: "maintain" } } }, ({ code, out }) => assert.equal(code, 0, out));
});

// --- authority ------------------------------------------------------------------

test("a label applied by a bot or App is refused", () => {
  withFixture(
    { events: [labeled("fleet-only[bot]", LABELED, "Bot")] },
    ({ code, out, calls }) => {
      assert.equal(code, 1, out);
      assert.match(out, /type 'Bot', not User/);
      assert.doesNotMatch(calls, /collaborators/);
    },
  );
});

test("a labeler without write access is refused", () => {
  for (const role of ["triage", "read", "none"]) {
    withFixture({ permissions: { captain: { role_name: role } } }, ({ code, out }) => {
      assert.equal(code, 1, out);
      assert.match(out, new RegExp(`role '${role}'`));
    });
  }
});

test("a labeler the permission API does not know is refused", () => {
  withFixture({ permissions: {} }, ({ code, out }) => {
    assert.equal(code, 1, out);
    assert.match(out, /has role 'none'/);
  });
});

// --- head binding -----------------------------------------------------------------

test("a head pushed after the label is refused", () => {
  withFixture(
    { activity: [{ ref: "refs/heads/SUP-20897-paperclip-approval-override-label", activity_type: "push", before: OLD_SHA, after: HEAD_SHA, timestamp: LATER }] },
    ({ code, out }) => {
      assert.equal(code, 1, out);
      assert.match(out, /override voided: head .* was pushed at 2026-10-23T10:10:00Z/);
    },
  );
});

test("a push in the same second as the label is not strictly before it", () => {
  withFixture(
    { activity: [{ ref: "refs/heads/SUP-20897-paperclip-approval-override-label", activity_type: "push", before: OLD_SHA, after: HEAD_SHA, timestamp: LABELED }] },
    ({ code, out }) => assert.equal(code, 1, out),
  );
});

test("a branch that was reset or fast-forwarded to another head is refused", () => {
  // The newest push left the branch somewhere other than the PR head: the head
  // the label saw is not the head being merged.
  withFixture(
    { activity: [{ ref: "refs/heads/SUP-20897-paperclip-approval-override-label", activity_type: "force_push", before: HEAD_SHA, after: OLD_SHA, timestamp: LATER }] },
    ({ code, out }) => {
      assert.equal(code, 1, out);
      assert.match(out, /left bbbbbbbb.*not the PR head/);
    },
  );
});

test("an older push of the head does not cover a newer push of another commit", () => {
  withFixture(
    {
      activity: [
        { ref: "refs/heads/SUP-20897-paperclip-approval-override-label", activity_type: "push", before: HEAD_SHA, after: OLD_SHA, timestamp: LATER },
        { ref: "refs/heads/SUP-20897-paperclip-approval-override-label", activity_type: "push", before: OLD_SHA, after: HEAD_SHA, timestamp: PUSHED },
      ],
    },
    ({ code, out }) => assert.equal(code, 1, out),
  );
});

test("a branch with no recorded activity is unverifiable and refused", () => {
  withFixture({ activity: [] }, ({ code, out }) => {
    assert.equal(code, 1, out);
    assert.match(out, /push time of head .* is unverifiable/);
  });
});

test("a non-push newest activity on the branch is refused", () => {
  withFixture(
    { activity: [{ ref: "refs/heads/SUP-20897-paperclip-approval-override-label", activity_type: "branch_deletion", before: HEAD_SHA, after: "0".repeat(40), timestamp: PUSHED }] },
    ({ code, out }) => assert.equal(code, 1, out),
  );
});

test("a fork head is refused", () => {
  withFixture({ headRepo: "someone/paperclip" }, ({ code, out, calls }) => {
    assert.equal(code, 1, out);
    assert.match(out, /is not TEA-Core\/paperclip; a fork head cannot be bound/);
    assert.doesNotMatch(calls, /activity|events/);
  });
  withFixture({ headRepo: null }, ({ code, out }) => assert.equal(code, 1, out));
});

test("a removed label is refused even if an earlier labeled event exists", () => {
  withFixture({ events: [labeled("captain"), unlabeled("captain", LATER)] }, ({ code, out }) => {
    assert.equal(code, 1, out);
    assert.match(out, /most recent override:paperclip-approval event is 'unlabeled'/);
  });
});

// --- fail closed ---------------------------------------------------------------------

test("an API failure on any lookup fails closed on merge_group", () => {
  for (const fail of ["events", "permission", "activity"]) {
    withFixture({ fail }, ({ code, out }) => {
      assert.equal(code, 1, out);
      assert.match(out, /override not honored: API failure/);
    });
  }
});

test("a PR that has the label in its JSON but no labeled event is refused", () => {
  withFixture({ events: [] }, ({ code, out }) => {
    assert.equal(code, 1, out);
    assert.match(out, /no labeled event/);
  });
});

test("an event with no created_at cannot be audited and is refused", () => {
  withFixture({ events: [{ event: "labeled", label: { name: LABEL }, actor: { login: "captain", type: "User" } }] }, ({ code, out }) => {
    assert.equal(code, 1, out);
    assert.match(out, /no valid created_at/);
  });
});

test("a different label's events never count", () => {
  withFixture({ events: [labeled("captain", LABELED, "User", "no-paperclip-card")] }, ({ code, out }) => {
    assert.equal(code, 1, out);
    assert.match(out, /no labeled event/);
  });
});

test("the label alone is not enough when the PR JSON does not carry it", () => {
  withFixture({ labels: [], body: "no waiver" }, ({ code, out, calls }) => {
    assert.equal(code, 1, out);
    assert.doesNotMatch(calls, /events|activity|collaborators/);
  });
});

// --- what the override must not become ---------------------------------------------

test("a card-bound or override-looking branch name never self-overrides", () => {
  for (const headRef of ["SUP-20897-paperclip-approval-override-label", "override/paperclip-approval", "override:paperclip-approval"]) {
    withFixture(
      { headRef, labels: [], events: [], activity: [{ ref: `refs/heads/${headRef}`, activity_type: "push", before: OLD_SHA, after: HEAD_SHA, timestamp: PUSHED }] },
      ({ code, out, calls }) => {
        assert.equal(code, 1, `${headRef}\n${out}`);
        assert.doesNotMatch(out, /OVERRIDE HONORED/);
        assert.doesNotMatch(calls, /events|activity|collaborators/);
      },
    );
  }
});

test("a forged paperclip/approved still fails even with a valid override label", () => {
  withFixture(
    { status: "success", statusCreator: { id: 1, login: "kronik187", type: "User" } },
    ({ code, out }) => {
      assert.equal(code, 1, out);
      assert.match(out, /FORGED/);
      assert.doesNotMatch(out, /OVERRIDE HONORED/);
    },
  );
});

test("a genuine stamp passes without consulting the override", () => {
  withFixture({ status: "success" }, ({ code, out, calls }) => {
    assert.equal(code, 0, out);
    assert.match(out, /pass: paperclip\/approved = success/);
    assert.doesNotMatch(calls, /events|activity|collaborators/);
  });
});

test("a body waiver is unchanged and does not consult the override", () => {
  withFixture({ body: "Paperclip-Approved-Waiver: cardless", labels: [LABEL] }, ({ code, out, calls }) => {
    assert.equal(code, 0, out);
    assert.match(out, /waived: PR body declares/);
    assert.doesNotMatch(calls, /events|activity|collaborators/);
  });
});

test("an unlabeled PR with no stamp still fails on merge_group", () => {
  withFixture({ labels: [], events: [] }, ({ code, out }) => {
    assert.equal(code, 1, out);
    assert.match(out, /FAIL: paperclip\/approved is missing/);
    assert.match(out, /apply the 'override:paperclip-approval' label AFTER the last push/);
  });
});

test("pull_request stays advisory when the override is refused, and says why", () => {
  withFixture({ permissions: { captain: { role_name: "read" } } }, ({ code, out }) => {
    assert.equal(code, 0, out);
    assert.match(out, /override NOT honored: labeler 'captain' has role 'read'/);
    assert.match(out, /ADVISORY: paperclip\/approved is missing/);
  }, { event: "pull_request" });
});
