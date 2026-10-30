import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// SUP-20772 round 16: the arm gate. The control plane writes `paperclip/arm-gate` = failure on a head before it arms
// auto-merge for it, and a success once the arm is settled. A head whose newest control-plane arm-gate status is not a
// success is refused by the real script (merge_group exits non-zero) whatever else it carries; a head with no such status
// is judged as before; a status from anyone but the control plane can neither open the gate nor clear it.

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
function run({ ref, author, body = "", title = "", labels = [], statuses = [], retired = true, retiredValue, event = "merge_group" }) {
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
    const result = spawnSync("bash", [script, event, ...(event === "pull_request" ? [String(PR)] : [])], {
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
        GITHUB_REF: event === "pull_request" ? `refs/pull/${PR}/merge` : QUEUE_REF,
        GITHUB_REF_NAME: event === "pull_request" ? `${PR}/merge` : QUEUE_REF.replace("refs/heads/", ""),
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


const GATE = "paperclip/arm-gate";
let nextId = 1000;
const status = (context, state, { creator = TEA_CORE, description = "" } = {}) => ({ id: nextId++, context, state, description, creator });
// newest first, as the GitHub list endpoint returns them
const stamped = (...newerFirst) => [...newerFirst, status("paperclip/approved", "success")];
const CARD_REF = "SUP-20772-arm";

function runWith(options) {
  return run({ ref: CARD_REF, author: { login: "operator", type: "User" }, ...options });
}

for (const retired of [false, true]) {
  const mode = retired ? "switch on" : "switch off";
  test(`${mode}: a stamped head whose newest arm gate is open is refused`, () => {
    const result = runWith({ retired, statuses: stamped(status(GATE, "failure", { description: "unsettled" })) });
    assert.notEqual(result.code, 0);
    assert.match(result.out, /ARM GATE OPEN/);
  });

  test(`${mode}: a pending arm gate is not a success either`, () => {
    const result = runWith({ retired, statuses: stamped(status(GATE, "pending")) });
    assert.notEqual(result.code, 0);
  });

  test(`${mode}: the control plane's closing success clears the gate`, () => {
    const result = runWith({ retired, statuses: stamped(status(GATE, "success"), status(GATE, "failure")) });
    assert.equal(result.code, 0, result.out);
  });

  test(`${mode}: a head with no arm gate is judged as before`, () => {
    const result = runWith({ retired, statuses: stamped() });
    assert.equal(result.code, 0, result.out);
  });

  test(`${mode}: an arm gate written by anyone else is ignored, in either direction`, () => {
    const stranger = { id: 1, login: "some-agent[bot]", type: "Bot" };
    assert.equal(runWith({ retired, statuses: stamped(status(GATE, "failure", { creator: stranger })) }).code, 0);
    const forgedClear = runWith({ retired, statuses: stamped(status(GATE, "success", { creator: stranger }), status(GATE, "failure")) });
    assert.notEqual(forgedClear.code, 0);
  });

  test(`${mode}: an open arm gate refuses a waiver as well (a card-bound head with the waiver line honoured, and a cardless one)`, () => {
    const open = [status(GATE, "failure")];
    assert.notEqual(runWith({ retired, body: WAIVER_BODY, statuses: open }).code, 0);
    assert.notEqual(run({ ref: "docs-sync", author: { login: "operator", type: "User" }, retired, body: WAIVER_BODY, statuses: open }).code, 0);
    assert.notEqual(run({ ref: "docs-sync", author: { login: "operator", type: "User" }, retired, labels: ["no-paperclip-card"], statuses: open }).code, 0);
  });

  test(`${mode}: a cardless waiver still lands when the gate is closed or absent`, () => {
    for (const statuses of [[], [status(GATE, "success"), status(GATE, "failure")]]) {
      const result = run({ ref: "docs-sync", author: { login: "operator", type: "User" }, retired, body: WAIVER_BODY, statuses });
      assert.equal(result.code, 0, result.out);
    }
  });
}

test("the pull_request leg stays advisory: an open arm gate is reported and the job is green", () => {
  const result = runWith({ event: "pull_request", statuses: stamped(status(GATE, "failure")) });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /ARM GATE OPEN/);
});
