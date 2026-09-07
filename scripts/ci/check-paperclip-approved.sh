#!/usr/bin/env bash
# Paperclip-approved enforcer (SUP-13589 / SUP-13590; ported to the
# TEA-Core/paperclip fold under SUP-13629).
#
# Approval gate: an approving review from an identity other than the pusher
# is required before a PR can merge. The signal is the control-plane
# `paperclip/approved` commit status on the PR head; this script CONSUMES it
# (read-only) and enforces it at the merge boundary.
#
# Consume-contract (pinned — do not change, do not write this status):
#   context: "paperclip/approved"
#   state:   "success"
#
# The producer is the CONTROL PLANE (publishApprovalStatus), which fires when
# a card's `review` stage records an `approved` decision AND the card has
# exactly one linked, open PR. Nothing in this repository may create, mock,
# or write that context — a local write is a contract violation that
# manufactures a fake signal. This script makes two read-only API calls:
#   GET repos/{owner}/{repo}/pulls/{n}
#   GET repos/{owner}/{repo}/commits/{head-sha}/statuses
#   GET repos/{owner}/{repo}/pulls/{n}/reviews   (only when a waiver is
#                                                 present on a fold-sync head)
#
# ATTRIBUTION. `paperclip/approved` is a plain commit status and the
# `fleet-only` installation grants `statuses:write` to every Paperclip-assigned
# agent, so possession of the signal proves nothing on its own — any agent could
# publish a success on its own head SHA. A `success` is therefore accepted only
# when its `creator` is the control-plane App's bot user (id
# $APPROVED_STATUS_CREATOR_ID). The LIST endpoint is used rather than the
# combined `/status` one because the combined endpoint omits `creator`
# entirely, which is why this hole stood open.
#
# Behaviour, by event:
#   pull_request -> advisory: log the observed state, exit 0 (green). The
#                 control plane publishes paperclip/approved only at
#                 review-stage approval, which happens AFTER CI first runs on
#                 the PR; a fail-closed pull_request would make every PR red
#                 for its whole working life. The queue entry is the
#                 enforcement point — the last gate before the commit lands
#                 on main.
#   merge_group  -> fail-closed: missing / pending / failed = exit 1, blocks
#                 the merge.
#   push (main)  -> no-op: log, exit 0.
#
# merge_group resolves the PR number from the queue ref
# (refs/heads/gh-readonly-queue/main/pr-<N>-<sha> on paperclip-agent-tools;
# refs/heads/gh-readonly-queue/fold/tea-patches-v2026.722.0/pr-<N>-<sha> on the
# TEA-Core/paperclip fold, whose base branch name itself contains slashes) —
# and from that source only. An unresolvable identity must never read as
# approved.
#
# Waiver (either one) for PRs with no Paperclip card (doctrine sync, rescue,
# router-only):
#   1. PR body contains a line:  Paperclip-Approved-Waiver: <reason>
#   2. PR carries the label:     no-paperclip-card
#
# COUNTERSIGNATURE on fold-sync heads -- ADVISORY SINCE 2026-09-07, NOT ENFORCED.
# A PR whose head ref starts with `fold-sync/` cannot earn `paperclip/approved`
# at all -- the head must stay `fold-sync/*` for pr.yml's lockfile exemption,
# which is mutually exclusive with the execution-workspace branch match
# `isDeliveredByCard()` requires -- so on that branch class the waiver is not an
# escape hatch, it is the only route.
#
# From 2026-09-07 the waiver STANDS ALONE on a fold-sync head. The operator
# ruling and its reasoning are in the fork design doc, D3; the short version is
# that TEA-Core/paperclip has two collaborators and the fold PR is opened by the
# operator, so the rule required a second account that in practice was the same
# person -- a formality this gate cannot detect, which is worse than no gate
# because it reads as a safety property in write-ups.
#
# The countersignature is still COMPUTED and REPORTED on every fold waiver, as
# telemetry only. It gates nothing. Do not cite the note as an approval control;
# it answers "did a human look at this fold", which the design doc lists as a
# metric, and nothing more. Re-enabling is a one-line change: make
# `require_countersignature` return the advisory result instead of 0.
#
# The resolution logic behind the note is deliberately kept intact and tested --
# APPROVED and still approved (a later CHANGES_REQUESTED or DISMISSED from the
# same login supersedes), `user.type == "User"`, on the current head SHA, not the
# PR author, and `author_association` in OWNER / MEMBER / COLLABORATOR. It costs
# one read-only call:
#   GET repos/{owner}/{repo}/pulls/{n}/reviews
# Every other head ref keeps the unmodified waiver behaviour.
#
# Usage:
#   check-paperclip-approved.sh <event> [pr-number]
#
#   <event>      pull_request | merge_group | push
#   [pr-number]  numeric PR number. pull_request: pass it explicitly (the CI
#                job passes github.event.pull_request.number). merge_group:
#                not used — the number is resolved from the queue ref.
#
# Environment:
#   GH_REPO            owner/repo (default: parsed from `git remote get-url origin`)
#   GITHUB_REF         fully-qualified ref (refs/heads/gh-readonly-queue/...)
#   GITHUB_REF_NAME    short ref (gh-readonly-queue/main/pr-<N>-<sha>)
#   PR_NUMBER          explicit PR number (pull_request only)
#   GITHUB_PR_NUMBER   explicit PR number (pull_request only)
#
# Exit codes:
#   0  approved, OR advisory (pull_request), OR push no-op, OR valid waiver
#      (on a fold-sync head, "valid" additionally means countersigned)
#   1  enforcement failure on merge_group: status missing/pending/failed,
#      unresolvable PR identity, unresolvable repository, or API failure —
#      fail-closed: an error must never read as approved
#   2  usage error (bad/unknown event, non-numeric pr-number, missing dependency)
set -euo pipefail

CONTEXT="paperclip/approved"
STATE="success"

# A literal backtick, so the job-summary blocks below can render inline code
# without an unquoted delimiter treating backticks as command substitution.
BT='`'

# The ONLY identity whose `paperclip/approved` status counts: the control-plane
# GitHub App's bot user. A bot user's numeric id is stable for the life of the
# App and cannot be re-registered, which a login can. Overridable so the same
# script can run against a differently-installed control plane; the default is
# this repository's.
APPROVED_STATUS_CREATOR_ID="${PAPERCLIP_APPROVED_STATUS_CREATOR_ID:-317012809}"
APPROVED_STATUS_CREATOR_LOGIN="${PAPERCLIP_APPROVED_STATUS_CREATOR_LOGIN:-tea-core[bot]}"

err() { echo "[paperclip-approved][error] $*" >&2; }
note() { echo "[paperclip-approved] $*"; }

usage() {
  err "usage: $(basename "$0") <pull_request|merge_group|push> [pr-number]"
  exit 2
}

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || usage
EVENT="$1"
PR_NUMBER_ARG="${2:-}"

case "$EVENT" in
  pull_request|merge_group|push) ;;
  *) usage ;;
esac

if [ -n "$PR_NUMBER_ARG" ] && ! [[ "$PR_NUMBER_ARG" =~ ^[0-9]+$ ]]; then
  usage
fi

command -v jq >/dev/null 2>&1 || { err "jq is required but not on PATH"; exit 2; }
command -v gh >/dev/null 2>&1 || { err "gh is required but not on PATH"; exit 2; }

# Advisory (pull_request) vs enforcing (merge_group). Fail-closed default:
# only pull_request is advisory.
MODE="advisory"
[ "$EVENT" = "merge_group" ] && MODE="enforcing"

# fail: in enforcing mode exit 1 (blocks the merge); in advisory mode log and
# exit 0 — pull_request is non-blocking by design, the merge queue enforces
# at the merge boundary.
fail() {
  if [ "$MODE" = "enforcing" ]; then
    err "$*"
    exit 1
  fi
  note "ADVISORY: $* — pull_request is non-blocking; the merge queue enforces at the merge boundary"
  exit 0
}

# --- reporting the verdict to the PR checks view (advisory leg) -------------
# The pull_request leg is green on purpose (advisory), so a bare exit 0 is all
# an operator sees in the PR checks view even when the merge queue is about to
# evict this entry. The two surfaces that reach the checks view WITHOUT a red
# check are the runner's job summary and this step's annotations, so the verdict
# is written to both. Both no-op safely when the script runs outside a workflow.
job_summary() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "$1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

# A GitHub Actions warning annotation is parsed from this step's stdout and shown
# on the step in the PR checks view even though the step (and the job) still
# report success. The message must be a single line. Outside a workflow
# (GITHUB_ACTIONS unset) fall back to a plain log line so a local run still
# surfaces the verdict.
warn_annotation() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then
    printf '::warning::%s\n' "$1"
  else
    note "WARNING: $1"
  fi
}

# Job-summary block for the two advisory outcomes. Kept in functions so the
# scratch variable stays out of the global scope of this linear script.
advisory_summary_present() {
  local block
  block="$(
    printf '%s\n' \
      "### ${BT}${CONTEXT}${BT} is present on this PR" \
      "" \
      "- **PR:** #${PR_NUMBER}" \
      "- **Head SHA:** ${BT}${HEAD_SHA}${BT}" \
      "- **Context state:** ${BT}${STATE}${BT} (published by ${APPROVAL_CREATOR_LOGIN})" \
      "" \
      "${BT}${CONTEXT}${BT} = ${STATE} is present on head ${BT}${HEAD_SHA}${BT}, published by the control" \
      "plane. The merge queue will admit this entry, subject to every other required check. This" \
      "check is advisory on ${BT}pull_request${BT} and reports ${BT}success${BT}."
  )"
  job_summary "$block"
}

advisory_summary_absent() {
  local block
  block="$(
    printf '%s\n' \
      "### ${BT}${CONTEXT}${BT} is not published on this PR" \
      "" \
      "- **PR:** #${PR_NUMBER}" \
      "- **Head SHA:** ${BT}${HEAD_SHA}${BT}" \
      "- **Observed state:** ${BT}${APPROVAL_STATE:-missing}${BT} (expected ${BT}${STATE}${BT})" \
      "" \
      "This check is **advisory** on ${BT}pull_request${BT} and reports **success**. The merge queue" \
      "enforces the same gate at the merge boundary (${BT}merge_group${BT})." \
      "" \
      "Until the control plane publishes ${BT}${CONTEXT}${BT} = ${STATE} on head ${BT}${HEAD_SHA}${BT}," \
      "**this PR will be evicted from the merge queue** on every entry."
  )"
  job_summary "$block"
}

# --- push (main): no-op ------------------------------------------------------
if [ "$EVENT" = "push" ]; then
  note "push:main — no-op, reporting success: the commit already passed this gate at merge_group"
  exit 0
fi

# --- PR number ---------------------------------------------------------------
# The queue ref embeds the base branch, which on the TEA-Core/paperclip fold
# itself contains slashes (gh-readonly-queue/fold/tea-patches-v2026.722.0/...),
# so the branch segment is one-or-more path components, never assumed to be a
# single component (SUP-13629 — a single-component regex silently fails to
# resolve every fold queue entry and deadlocks the fold merge queue).
QUEUE_REF_RE='^gh-readonly-queue/.+/pr-([0-9]+)-[0-9a-f]+$'

pr_from_queue_ref() {
  local ref short
  for ref in "${GITHUB_REF_NAME:-}" "${GITHUB_REF:-}"; do
    [ -n "$ref" ] || continue
    short="${ref#refs/heads/}"
    if [[ "$short" =~ $QUEUE_REF_RE ]]; then
      printf '%s' "${BASH_REMATCH[1]}"
      return 0
    fi
  done
  return 1
}

if [ "$EVENT" = "merge_group" ]; then
  # Pinned by SUP-13590: on merge_group the PR number comes from the queue
  # ref ONLY. An unresolvable identity must never read as approved.
  if ! PR_NUMBER="$(pr_from_queue_ref)"; then
    err "merge_group: cannot resolve the PR number from the merge-queue ref"
    err "  expected GITHUB_REF(_NAME) = refs/heads/gh-readonly-queue/<base>/pr-<N>-<sha>"
    err "  (on the TEA-Core/paperclip fold the <base> itself contains slashes, e.g. gh-readonly-queue/fold/tea-patches-v2026.722.0/pr-<N>-<sha>)"
    err "  got GITHUB_REF='${GITHUB_REF:-<unset>}' GITHUB_REF_NAME='${GITHUB_REF_NAME:-<unset>}'"
    exit 1
  fi
else
  # pull_request: explicit argument (the CI job passes it), then the
  # PR_NUMBER / GITHUB_PR_NUMBER environment, then the queue ref (defensive).
  PR_NUMBER="$PR_NUMBER_ARG"
  [ -n "$PR_NUMBER" ] || PR_NUMBER="${PR_NUMBER:-${GITHUB_PR_NUMBER:-}}"
  [ -n "$PR_NUMBER" ] || PR_NUMBER="$(pr_from_queue_ref || true)"
  if [ -z "$PR_NUMBER" ]; then
    fail "could not resolve the PR number (no argument, no PR_NUMBER/GITHUB_PR_NUMBER, no merge-queue ref)"
  fi
fi

# --- repository --------------------------------------------------------------
resolve_repo() {
  local repo="${GH_REPO:-}" remote cand
  if [ -n "$repo" ]; then
    if [[ "$repo" =~ ^[^/]+/[^/]+$ ]]; then
      printf '%s' "$repo"
      return 0
    fi
    return 1
  fi
  remote="$(git remote get-url origin 2>/dev/null || true)"
  remote="${remote%.git}"
  if [[ "$remote" =~ github\.com[/:]([^/]+/[^/]+)$ ]]; then
    cand="${BASH_REMATCH[1]}"
    if [[ "$cand" =~ ^[^/]+/[^/]+$ ]]; then
      printf '%s' "$cand"
      return 0
    fi
  fi
  return 1
}

if ! REPO="$(resolve_repo)"; then
  fail "could not determine the repository (owner/repo); set GH_REPO"
fi
note "checking ${REPO} PR #${PR_NUMBER} (mode: ${MODE})"

# --- PR head SHA + waiver metadata (one read-only call) ----------------------
PR_JSON="$(gh api "repos/${REPO}/pulls/${PR_NUMBER}" 2>&1)" \
  || fail "API failure: GET repos/${REPO}/pulls/${PR_NUMBER} — ${PR_JSON}"
jq -e . >/dev/null 2>&1 <<<"$PR_JSON" \
  || fail "malformed PR payload from GET repos/${REPO}/pulls/${PR_NUMBER}"

HEAD_SHA="$(jq -r '.head.sha // empty' <<<"$PR_JSON")"
[ -n "$HEAD_SHA" ] || fail "could not resolve the head SHA for PR #${PR_NUMBER}"
note "PR #${PR_NUMBER} head SHA: ${HEAD_SHA}"

PR_BODY="$(jq -r '.body // ""' <<<"$PR_JSON")"
PR_LABELS="$(jq -c '(.labels // []) | map(.name)' <<<"$PR_JSON")"

PR_HEAD_REF="$(jq -r '.head.ref // ""' <<<"$PR_JSON")"
PR_AUTHOR="$(jq -r '.user.login // ""' <<<"$PR_JSON")"

# --- fold-sync heads: a waiver must be countersigned by a human ---------------
# A fold PR cannot earn `paperclip/approved` at all. `isDeliveredByCard()`
# matches the PR head ref against the card's execution-workspace branch, but the
# head must stay `fold-sync/*` for pr.yml's lockfile exemption (an exact
# `startsWith`), and no execution workspace has ever carried a `fold-sync/`
# name. The two requirements are mutually exclusive, so the waiver is not an
# escape hatch on this branch class -- it is the only route, taken by default,
# on the single riskiest change class in the repository.
#
# Left as-is that means the automation writes its own exemption for a fold: the
# `fleet-only` installation grants `pull_requests:write` to any Paperclip
# assigned agent, so the same identity that opens the PR can author both waiver
# forms. Requiring a countersignature puts a person on the only irreversible
# path without touching the other ~26 PRs/day, and needs no ruleset change and
# no control-plane plumbing.
#
# Scoped to `fold-sync/` heads deliberately. Cardless doctrine-sync, rescue and
# router-only PRs keep the unmodified waiver.
FOLD_HEAD=0
case "$PR_HEAD_REF" in
  fold-sync/*) FOLD_HEAD=1 ;;
esac

# The countersigning review must be:
#   APPROVED       -- and still approved: a later CHANGES_REQUESTED or DISMISSED
#                     from the same login supersedes it, so only each login's
#                     final state on the head SHA counts.
#   user.type User -- a GitHub App review reports type "Bot". The whole point is
#                     an identity the fleet's own token cannot produce.
#   on HEAD_SHA    -- pr.yml's "Reject stale merge base" hard-fails past 20
#                     commits behind or 24h, so a fold PR is pushed to its final
#                     SHA and only then approved. An approval carried over from
#                     an earlier commit reviewed a different tree.
#   not the author -- GitHub already refuses author self-approval; asserted here
#                     because this gate is what a compromised token would aim at.
human_countersigner() {
  local reviews state commit login utype assoc approver
  reviews="$(gh api --paginate \
    "repos/${REPO}/pulls/${PR_NUMBER}/reviews?per_page=100" \
    --jq '.[] | [(.state // ""), (.commit_id // ""), (.user.login // ""), (.user.type // ""), (.author_association // "")] | @tsv' 2>&1)" \
    || { err "API failure: GET repos/${REPO}/pulls/${PR_NUMBER}/reviews — ${reviews}"; return 2; }

  # Reviews come back in submission order, so a later state for a login
  # supersedes an earlier one. Resolve each login's FINAL state across every
  # eligible review FIRST, and only then ask whether that final state is an
  # approval of the current head.
  #
  # The head-SHA test cannot live in this loop. A review may target any commit
  # associated with the PR, so a reviewer can approve on HEAD_SHA and then
  # submit CHANGES_REQUESTED against an older commit: filtering by commit while
  # accumulating would discard the retraction and leave the superseded approval
  # standing. Record the state and the commit it was made on, and judge both at
  # the end.
  declare -A final_state=()
  declare -A final_commit=()
  declare -A final_assoc=()
  while IFS=$'\t' read -r state commit login utype assoc; do
    [ -n "$state" ] || continue
    [ "$utype" = "User" ] || continue
    [ -n "$login" ] || continue
    [ "$login" != "$PR_AUTHOR" ] || continue
    # COMMENTED reviews do not change an approval either way.
    [ "$state" != "COMMENTED" ] || continue
    final_state["$login"]="$state"
    final_commit["$login"]="$commit"
    final_assoc["$login"]="$assoc"
  done <<<"$reviews"

  # Every condition is applied HERE, to each login's final review, and none of
  # them inside the loop above. `author_association` is computed per review at
  # submission time, so it can differ between two reviews by the same account —
  # someone who leaves the org submits their next review as CONTRIBUTOR. Filter
  # on it while accumulating and a later CHANGES_REQUESTED gets skipped as
  # "untrusted" instead of superseding, leaving the earlier approval standing.
  # That is the same shape as the commit_id bug fixed just above; the rule for
  # this loop is accumulate first, judge last.
  for approver in "${!final_state[@]}"; do
    [ "${final_state[$approver]}" = "APPROVED" ] || continue
    [ "${final_commit[$approver]}" = "$HEAD_SHA" ] || continue
    # TEA-Core/paperclip is a PUBLIC repository, so any GitHub account can
    # submit an approving review on any PR. `user.type == "User"` proves the
    # reviewer is a person rather than an App; it proves nothing about their
    # standing here, and a drive-by APPROVED from an unaffiliated account would
    # otherwise countersign a fold waiver.
    case "${final_assoc[$approver]}" in
      OWNER|MEMBER|COLLABORATOR) ;;
      *) continue ;;
    esac
    printf '%s' "$approver"
    return 0
  done
  return 1
}

# require_countersignature <waiver-description>
#   0 -> the waiver stands (not a fold head, or a human countersigned it)
#   1 -> the waiver is present but uncountersigned; fall through to the status
#        check, which is the ordinary gate and can still pass on its own
# ALWAYS RETURNS 0. The countersignature is telemetry as of 2026-09-07, not a
# gate; see the header. It is still resolved so the log records whether a human
# looked at the fold, and so the resolution logic does not rot before anyone
# decides to re-enable it. A failure reading the reviews is reported and then
# ignored, because an advisory signal must not be able to fail a build.
require_countersignature() {
  local what="$1" approver rc
  [ "$FOLD_HEAD" = "1" ] || return 0

  approver="$(human_countersigner)" && rc=0 || rc=$?
  if [ "${rc:-1}" = "0" ] && [ -n "$approver" ]; then
    note "countersigned (advisory): ${what}, approved on head ${HEAD_SHA} by @${approver} (human account)"
  elif [ "${rc:-1}" = "2" ]; then
    note "countersignature UNKNOWN (advisory): could not read the reviews for ${what} — not enforced, so the waiver stands"
  else
    note "NOT countersigned (advisory): ${what} on fold head '${PR_HEAD_REF}' carries no approving review from a human account on head ${HEAD_SHA} — not enforced, so the waiver stands"
  fi
  return 0
}

# Waiver 1: body line "Paperclip-Approved-Waiver: <reason>" with a non-empty
# reason (a cardless PR never gets a paperclip/approved status, so the
# waiver is checked before the status lookup).
reason_line="$(grep -E '^[[:space:]]*Paperclip-Approved-Waiver:[[:space:]]*[^[:space:]]' <<<"$PR_BODY" | head -1 || true)"
if [ -n "$reason_line" ]; then
  reason="$(sed -E 's/^[[:space:]]*Paperclip-Approved-Waiver:[[:space:]]*//' <<<"$reason_line")"
  if require_countersignature "body waiver 'Paperclip-Approved-Waiver: ${reason}'"; then
    note "waived: PR body declares 'Paperclip-Approved-Waiver: ${reason}' (no Paperclip card)"
    exit 0
  fi
fi

# Waiver 2: exact "no-paperclip-card" label (whole-element match; no substrings).
# Countersigned on a fold head for the same reason as the body waiver: the
# `fleet-only` grant carries `pull_requests:write`, so an agent can apply this
# label to its own PR. Leaving one of the two waiver forms uncountersigned would
# leave the gate exactly as open as before.
if [ -n "$PR_LABELS" ] && printf '%s' "$PR_LABELS" | jq -e --arg l 'no-paperclip-card' 'index($l)' >/dev/null 2>&1; then
  if require_countersignature "the 'no-paperclip-card' label"; then
    note "waived: PR carries the 'no-paperclip-card' label (no Paperclip card)"
    exit 0
  fi
fi

# --- the consume-contract itself ----------------------------------------------
# Read the LIST endpoint, not the combined one. `GET /commits/{sha}/status`
# omits `creator` from every entry it returns — verified against a real
# published status — so on that endpoint the enforcer structurally cannot see
# who wrote the signal it is enforcing. `GET /commits/{sha}/statuses` carries
# `creator`, and returns entries newest-first, so the first entry matching the
# context is the same value the combined endpoint would have reported.
# `--paginate`, not a bare first page. Anything holding `statuses:write` can
# add a context to this commit, and the list is not filtered server-side; 100
# newer unrelated statuses would push the approval onto page two, where an
# unpaginated read sees `missing` and — this leg being fail-closed — blocks an
# approved entry out of the queue. Pagination preserves order across pages, so
# the first matching row is still the newest.
STATUSES_TSV="$(gh api --paginate \
  "repos/${REPO}/commits/${HEAD_SHA}/statuses?per_page=100" \
  --jq '.[] | [(.context // ""), (.state // ""), ((.creator.id // "") | tostring), (.creator.login // "")] | @tsv' 2>&1)" \
  || fail "API failure: GET repos/${REPO}/commits/${HEAD_SHA}/statuses — ${STATUSES_TSV}"

APPROVAL_STATE="missing"
APPROVAL_CREATOR_ID=""
APPROVAL_CREATOR_LOGIN=""
while IFS=$'\t' read -r status_context status_state status_creator_id status_creator_login; do
  [ "$status_context" = "$CONTEXT" ] || continue
  APPROVAL_STATE="${status_state:-missing}"
  APPROVAL_CREATOR_ID="$status_creator_id"
  APPROVAL_CREATOR_LOGIN="$status_creator_login"
  break
done <<<"$STATUSES_TSV"

if [ "$APPROVAL_STATE" = "$STATE" ]; then
  # `paperclip/approved` is a plain commit status, and the `fleet-only`
  # installation grants `statuses:write` to any Paperclip-assigned agent. So
  # until this check existed the gate was forgeable by capability, whatever the
  # header above asserts: any agent in the fleet could publish a success on its
  # own head SHA and merge. The producer is the control plane, which acts as the
  # `tea-core` App — a different installation, whose bot identity the fleet
  # token cannot assume.
  if [ "$APPROVAL_CREATOR_ID" != "$APPROVED_STATUS_CREATOR_ID" ]; then
    err "FORGED: ${CONTEXT} on ${HEAD_SHA} was written by ${APPROVAL_CREATOR_LOGIN:-<unknown>} (id ${APPROVAL_CREATOR_ID:-<none>})"
    err "  the only accepted producer is the control-plane App ${APPROVED_STATUS_CREATOR_LOGIN} (id ${APPROVED_STATUS_CREATOR_ID})"
    err "  the fleet installation grants statuses:write to every Paperclip-assigned agent, so a"
    err "  ${CONTEXT} status from any other identity is a self-published approval, not an approval"
    fail "${CONTEXT} on ${HEAD_SHA} was not published by the control plane"
  fi
  note "pass: ${CONTEXT} = ${STATE} on PR #${PR_NUMBER} head ${HEAD_SHA} (published by ${APPROVAL_CREATOR_LOGIN})"
  if [ "$MODE" = "advisory" ]; then
    advisory_summary_present
  fi
  exit 0
fi

if [ "$MODE" = "advisory" ]; then
  note "ADVISORY: ${CONTEXT} is ${APPROVAL_STATE}, expected ${STATE}; pull_request is non-blocking — the merge queue enforces at the merge boundary"
  advisory_summary_absent
  warn_annotation "${CONTEXT} is ${APPROVAL_STATE:-missing} on head ${HEAD_SHA} (PR #${PR_NUMBER}): this PR will be evicted from the merge queue until the control plane publishes ${CONTEXT} = ${STATE}. This check is advisory and reports success."
  exit 0
fi

err "FAIL: ${CONTEXT} is ${APPROVAL_STATE}, expected ${STATE} — PR #${PR_NUMBER} head ${HEAD_SHA} is not approved"
err "  an approval is produced by the control plane when the card's review stage records 'approved'"
err "  (a hand PATCH of the card status skips publishApprovalStatus — no status is ever published)"
err "  or waive a cardless PR: body line 'Paperclip-Approved-Waiver: <reason>' or the 'no-paperclip-card' label"
exit 1
