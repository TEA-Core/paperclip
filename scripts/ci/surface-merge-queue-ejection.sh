#!/usr/bin/env bash
# Surface a merge-queue ejection on the PR (SUP-15375).
#
# When the merge queue ejects an entry because a required `merge_group` check
# failed, the PR reverts to autoMergeRequest:null / isInMergeQueue:false —
# identical to a PR that was never queued. The failing check-run lives on the
# `gh-readonly-queue/…` ref, which agent tokens do not think to query, and
# `GET /branches/{b}/protection` is 403 for the platform token. This script
# makes the reason reachable from the PR itself: it posts — or updates in
# place — a single PR comment naming the failing check and quoting the
# enforcer's verdict, using only `pull-requests: read|write`. No `checks:read`,
# no admin escalation.
#
# BEST-EFFORT BY DESIGN. This is a diagnostic surface, not enforcement. The
# merge decision is made by the `paperclip-approved-enforcer` check-run
# (fail-closed on `merge_group`, unchanged by this script). This step runs only
# AFTER that check has already failed, so it cannot turn a green entry red; and
# if the comment cannot be posted (unresolvable identity, API error) it logs and
# exits 0 — the absence of the artefact must never change whether the merge is
# blocked.
#
# Consume/write contract:
#   READ:  GET repos/{o}/{r}/issues/{n}/comments   (find an existing artefact)
#   WRITE: POST/PATCH repos/{o}/{r}/issues/{n}/comments[/{id}]
#   Both use the issue-comment family (the PR's conversation thread), never the
#   pull-request *review*-comment family (`pulls/{n}/comments`): the marker the
#   write posts must be found again by the read, or re-queueing stacks a comment
#   per attempt instead of updating the one in place.
#   The artefact is a plain PR comment carrying a stable HTML marker
#   (`<!-- paperclip:merge-queue-ejection -->`), so re-queueing updates the one
#   comment in place rather than stacking one per attempt.
#
# Usage:
#   surface-merge-queue-ejection.sh [--verdict <path>]
#
#   --verdict <path>   File with the enforcer's captured stdout+stderr. The
#                      trailing lines (the reason) are quoted verbatim. Optional:
#                      without it a generic reason is posted.
#
# Environment:
#   GH_REPO                   owner/repo (default: parsed from `git remote get-url origin`)
#   GITHUB_PR_NUMBER          PR number (pull_request events; unused on merge_group)
#   PR_NUMBER                 explicit PR number
#   GITHUB_REF / GITHUB_REF_NAME
#                              merge-queue ref (merge_group), resolved from
#                              refs/heads/gh-readonly-queue/<base>/pr-<N>-<sha>
#
# Exit codes:
#   0  comment posted/updated, OR a best-effort skip (could not post; logged)
#   2  usage / missing-dependency error
set -euo pipefail

MARKER="<!-- paperclip:merge-queue-ejection -->"
CHECK_NAME="paperclip-approved-enforcer"

VERDICT_FILE=""
if [ "${1:-}" = "--verdict" ] && [ -n "${2:-}" ]; then
  VERDICT_FILE="$2"
elif [ -n "${1:-}" ]; then
  echo "usage: $(basename "$0") [--verdict <path>]" >&2
  exit 2
fi

command -v jq >/dev/null 2>&1 || { echo "[merge-queue-ejection] jq is required but not on PATH" >&2; exit 2; }
command -v gh >/dev/null 2>&1 || { echo "[merge-queue-ejection] gh is required but not on PATH" >&2; exit 2; }

log() { echo "[merge-queue-ejection] $*"; }

# --- PR number ---------------------------------------------------------------
# The queue ref embeds the base branch, which on the TEA-Core/paperclip fold
# itself contains slashes (gh-readonly-queue/fold/tea-patches-v2026.722.0/...),
# so the branch segment is one-or-more path components — never assumed to be a
# single component. Same regex the enforcer uses, so the two never disagree
# about which PR an entry belongs to.
QUEUE_REF_RE='^gh-readonly-queue/.+/pr-([0-9]+)-[0-9a-f]+$'

resolve_pr() {
  local ref short
  if [ -n "${GITHUB_PR_NUMBER:-}" ]; then
    printf '%s' "$GITHUB_PR_NUMBER"
    return 0
  fi
  if [ -n "${PR_NUMBER:-}" ]; then
    printf '%s' "$PR_NUMBER"
    return 0
  fi
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

PR_NUMBER="$(resolve_pr || true)"
if ! [[ "${PR_NUMBER:-}" =~ ^[0-9]+$ ]]; then
  log "could not resolve the PR number — skipping (best-effort); enforcement is unaffected"
  exit 0
fi
if ! REPO="$(resolve_repo)"; then
  log "could not determine the repository (owner/repo) for PR #${PR_NUMBER} — skipping (best-effort); enforcement is unaffected"
  exit 0
fi
log "surfacing merge-queue ejection on ${REPO} PR #${PR_NUMBER}"

# --- verdict (the reason) ----------------------------------------------------
# Quote the enforcer's trailing lines verbatim. On a failure these are the
# `FAIL: …` / remediation err block — the reason the entry was ejected.
REASON=""
if [ -n "$VERDICT_FILE" ] && [ -f "$VERDICT_FILE" ] && [ -s "$VERDICT_FILE" ]; then
  REASON="$(tr -d '\r' <"$VERDICT_FILE" | tail -c 4096 | sed -e '/^[[:space:]]*$/d')"
fi
if [ -z "$REASON" ]; then
  REASON="(the paperclip-approved-enforcer check failed on the merge-group commit; see its merge_group run for the full log)"
fi

# --- comment body ------------------------------------------------------------
# A quoted heredoc keeps every backtick literal; the three placeholders are
# substituted afterwards with bash parameter expansion.
body_template="$(cat <<'EOF'
__MARKER__
## Ejected from the merge queue

The required **`__CHECK_NAME__`** check failed on this entry's merge-group commit, so the merge queue removed it.

This check is **advisory on `pull_request`** (the `paperclip/approved` status is published only at review-stage approval, after CI first runs) but **fail-closed on `merge_group`** — so it can still read green on the PR head even when the entry was not approved. The enforcing verdict lives on the `gh-readonly-queue/…` ref, which is not surfaced on the PR head; this comment is the agent-reachable artefact.

**Failing check:** `__CHECK_NAME__`

**Reason (verbatim from the enforcer):**

```
__REASON__
```

**To land this PR:** get the card's review stage to `approved` (the control plane then publishes `paperclip/approved` on the head SHA), or — for a cardless PR — add a `Paperclip-Approved-Waiver: <reason>` body line / the `no-paperclip-card` label. Then re-arm the merge.
EOF
)"
BODY="${body_template//__MARKER__/$MARKER}"
BODY="${BODY//__CHECK_NAME__/$CHECK_NAME}"
BODY="${BODY//__REASON__/$REASON}"

# --- find-or-upsert the comment ----------------------------------------------
# One artefact per PR: if a comment already carries the marker, update it in
# place; otherwise create it. Re-queueing a PR therefore refreshes the existing
# note instead of stacking a new one per attempt.
comments_json="$(gh api --paginate "repos/${REPO}/issues/${PR_NUMBER}/comments?per_page=100" 2>&1)" \
  || { log "could not list the PR's comments — skipping (best-effort); enforcement is unaffected"; exit 0; }
existing_id="$(jq -r '.[] | select((.body // "") | contains("paperclip:merge-queue-ejection")) | .id' <<<"$comments_json" 2>/dev/null | head -1 || true)"

payload() { jq -n --arg b "$BODY" '{body: $b}'; }

if [ -n "$existing_id" ]; then
  if payload | gh api -X PATCH "repos/${REPO}/issues/${PR_NUMBER}/comments/${existing_id}" --input - >/dev/null 2>&1; then
    log "updated merge-queue ejection comment ${existing_id} on ${REPO} PR #${PR_NUMBER}"
  else
    log "could not update the ejection comment (id ${existing_id}) — best-effort; enforcement is unaffected"
  fi
else
  if payload | gh api -X POST "repos/${REPO}/issues/${PR_NUMBER}/comments" --input - >/dev/null 2>&1; then
    log "posted merge-queue ejection comment on ${REPO} PR #${PR_NUMBER}"
  else
    log "could not post the ejection comment on ${REPO} PR #${PR_NUMBER} — best-effort; enforcement is unaffected"
  fi
fi
exit 0
