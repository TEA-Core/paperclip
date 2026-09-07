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
# superseded by that same account, AND whose `author_association` is one of
# OWNER / MEMBER / COLLABORATOR. That last condition is not optional: this
# repository is PUBLIC, so any GitHub account can submit an approving review on
# any PR, and without it a drive-by APPROVED from an unaffiliated account would
# countersign a fold waiver. Note the honest limit — `author_association`
# establishes org or collaborator standing, NOT write access; a read-only
# collaborator still satisfies it. Checking the actual permission level needs
# `GET /repos/{o}/{r}/collaborators/{u}/permission`, which requires push access
# the workflow token deliberately does not have. This makes one read-only call:
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
  while IFS=$'\t' read -r state commit login utype assoc; do
    [ -n "$state" ] || continue
    [ "$utype" = "User" ] || continue
    [ -n "$login" ] || continue
    [ "$login" != "$PR_AUTHOR" ] || continue
    # TEA-Core/paperclip is a PUBLIC repository, so any GitHub account can
    # submit an approving review on any PR. `user.type == "User"` proves the
    # reviewer is a person rather than an App; it proves nothing about their
    # standing here, and a drive-by APPROVED from an unaffiliated account would
    # otherwise countersign a fold waiver.
    case "$assoc" in
      OWNER|MEMBER|COLLABORATOR) ;;
      *) continue ;;
    esac
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
  err "  from a human GitHub account on the current head SHA ${HEAD_SHA}, whose author_association"
  err "  is OWNER, MEMBER or COLLABORATOR (this repository is public — an unaffiliated account's"
  err "  approval does not count)."
  err "  A fold PR cannot earn paperclip/approved (the head must stay fold-sync/* for pr.yml's lockfile"
  err "  exemption, which is mutually exclusive with the card branch match isDeliveredByCard() requires),"
  err "  so the countersignature is the human on the path — not an obstacle to route around."
  err "  Push the FINAL head SHA first, then approve: an approval made against an earlier commit does not count."
fi
exit 1
