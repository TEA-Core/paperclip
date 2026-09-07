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
#   GET repos/{owner}/{repo}/commits/{head-sha}/status
#   GET repos/{owner}/{repo}/pulls/{n}/reviews   (only when a waiver is
#                                                 present on a fold-sync head)
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
# COUNTERSIGNATURE on fold-sync heads. A PR whose head ref starts with
# `fold-sync/` cannot earn `paperclip/approved` at all — the head must stay
# `fold-sync/*` for pr.yml's lockfile exemption, which is mutually exclusive
# with the execution-workspace branch match `isDeliveredByCard()` requires — so
# on that branch class the waiver is not an escape hatch, it is the default
# route on the riskiest change in the repository, and the fleet's own
# `pull_requests:write` grant lets the identity that opens the PR author either
# waiver form. On a `fold-sync/` head, EITHER waiver stands only if the PR also
# carries an approving review from a human GitHub account (`user.type == "User"`)
# on the CURRENT head SHA, from someone other than the PR author, not later
# superseded by that same account. This makes one read-only call:
#   GET repos/{owner}/{repo}/pulls/{n}/reviews
# An uncountersigned waiver is not an immediate failure: it falls through to the
# ordinary `paperclip/approved` status check, which can still pass on its own.
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
  local reviews state commit login utype approver
  reviews="$(gh api --paginate \
    "repos/${REPO}/pulls/${PR_NUMBER}/reviews?per_page=100" \
    --jq '.[] | [(.state // ""), (.commit_id // ""), (.user.login // ""), (.user.type // "")] | @tsv' 2>&1)" \
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
  while IFS=$'\t' read -r state commit login utype; do
    [ -n "$state" ] || continue
    [ "$utype" = "User" ] || continue
    [ -n "$login" ] || continue
    [ "$login" != "$PR_AUTHOR" ] || continue
    # COMMENTED reviews do not change an approval either way.
    [ "$state" != "COMMENTED" ] || continue
    final_state["$login"]="$state"
    final_commit["$login"]="$commit"
  done <<<"$reviews"

  for approver in "${!final_state[@]}"; do
    if [ "${final_state[$approver]}" = "APPROVED" ] \
      && [ "${final_commit[$approver]}" = "$HEAD_SHA" ]; then
      printf '%s' "$approver"
      return 0
    fi
  done
  return 1
}

# Set by the waiver blocks below when a waiver is present but uncountersigned,
# so the final failure message can say which of the two things is missing.
WAIVER_UNCOUNTERSIGNED=""

# require_countersignature <waiver-description>
#   0 -> the waiver stands (not a fold head, or a human countersigned it)
#   1 -> the waiver is present but uncountersigned; fall through to the status
#        check, which is the ordinary gate and can still pass on its own
require_countersignature() {
  local what="$1" approver rc
  [ "$FOLD_HEAD" = "1" ] || return 0

  approver="$(human_countersigner)" && rc=0 || rc=$?
  if [ "${rc:-1}" = "0" ] && [ -n "$approver" ]; then
    note "countersigned: ${what}, approved on head ${HEAD_SHA} by @${approver} (human account)"
    return 0
  fi
  if [ "${rc:-1}" = "2" ]; then
    # An API failure must never read as countersigned.
    WAIVER_UNCOUNTERSIGNED="${what} (could not read the PR's reviews)"
    return 1
  fi
  WAIVER_UNCOUNTERSIGNED="$what"
  note "NOT countersigned: ${what} on fold head '${PR_HEAD_REF}' carries no approving review from a human account on head ${HEAD_SHA}"
  return 1
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
STATUSES_JSON="$(gh api "repos/${REPO}/commits/${HEAD_SHA}/status" 2>&1)" \
  || fail "API failure: GET repos/${REPO}/commits/${HEAD_SHA}/status — ${STATUSES_JSON}"
jq -e . >/dev/null 2>&1 <<<"$STATUSES_JSON" \
  || fail "malformed commit-status payload for ${HEAD_SHA}"

APPROVAL_STATE="$(jq -r --arg c "$CONTEXT" \
  '[(.statuses // [])[] | select(.context == $c) | .state] | if length == 0 then "missing" else .[0] end' \
  <<<"$STATUSES_JSON")"

if [ "$APPROVAL_STATE" = "$STATE" ]; then
  note "pass: ${CONTEXT} = ${STATE} on PR #${PR_NUMBER} head ${HEAD_SHA}"
  exit 0
fi

if [ "$MODE" = "advisory" ]; then
  note "ADVISORY: ${CONTEXT} is ${APPROVAL_STATE}, expected ${STATE}; pull_request is non-blocking — the merge queue enforces at the merge boundary"
  exit 0
fi

err "FAIL: ${CONTEXT} is ${APPROVAL_STATE}, expected ${STATE} — PR #${PR_NUMBER} head ${HEAD_SHA} is not approved"
err "  an approval is produced by the control plane when the card's review stage records 'approved'"
err "  (a hand PATCH of the card status skips publishApprovalStatus — no status is ever published)"
err "  or waive a cardless PR: body line 'Paperclip-Approved-Waiver: <reason>' or the 'no-paperclip-card' label"
if [ -n "$WAIVER_UNCOUNTERSIGNED" ]; then
  err "  this PR DOES carry a waiver — ${WAIVER_UNCOUNTERSIGNED} — but its head ref '${PR_HEAD_REF}' is a fold-sync branch,"
  err "  and on a fold-sync head a waiver stands only when the PR also carries an approving review"
  err "  from a human GitHub account on the current head SHA ${HEAD_SHA}."
  err "  A fold PR cannot earn paperclip/approved (the head must stay fold-sync/* for pr.yml's lockfile"
  err "  exemption, which is mutually exclusive with the card branch match isDeliveredByCard() requires),"
  err "  so the countersignature is the human on the path — not an obstacle to route around."
  err "  Push the FINAL head SHA first, then approve: an approval made against an earlier commit does not count."
fi
exit 1
