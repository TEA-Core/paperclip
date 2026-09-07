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

# Waiver 1: body line "Paperclip-Approved-Waiver: <reason>" with a non-empty
# reason (a cardless PR never gets a paperclip/approved status, so the
# waiver is checked before the status lookup).
reason_line="$(grep -E '^[[:space:]]*Paperclip-Approved-Waiver:[[:space:]]*[^[:space:]]' <<<"$PR_BODY" | head -1 || true)"
if [ -n "$reason_line" ]; then
  reason="$(sed -E 's/^[[:space:]]*Paperclip-Approved-Waiver:[[:space:]]*//' <<<"$reason_line")"
  note "waived: PR body declares 'Paperclip-Approved-Waiver: ${reason}' (no Paperclip card)"
  exit 0
fi

# Waiver 2: exact "no-paperclip-card" label (whole-element match; no substrings).
if [ -n "$PR_LABELS" ] && printf '%s' "$PR_LABELS" | jq -e --arg l 'no-paperclip-card' 'index($l)' >/dev/null 2>&1; then
  note "waived: PR carries the 'no-paperclip-card' label (no Paperclip card)"
  exit 0
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
exit 1
