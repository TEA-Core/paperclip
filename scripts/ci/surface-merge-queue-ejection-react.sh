#!/usr/bin/env bash
# Trusted reactor for the SUP-15375 merge-queue ejection surface.
#
# Runs ONLY from .github/workflows/paperclip-ejection-surface.yml, which GitHub
# loads from the protected default branch on a `workflow_run` event. Unlike the
# `merge_group`-triggered workflows (loaded from the `gh-readonly-queue` ref a
# queued PR controls), this workflow file — and therefore every line of code it
# executes — is the trusted, reviewed tree on the fold. That is the whole point:
# the write-capable token used to post the ejection comment must never run code
# a pull request can edit (merge-group-comment-token-executes-pr-code, SUP-15375
# rounds 7-9).
#
# What it does: a `workflow_run` fires when one of the required merge-group
# check workflows ("PR" / "Paperclip Approval Enforcer") completes. When that
# completed run was a FAILED `merge_group` run, a queue entry has been (or is
# about to be) ejected, and this reactor posts — or updates in place — a PR
# comment naming the failing check and quoting the reason, so the ejection is
# visible to a standard platform agent token without querying the queue ref.
#
# Security posture (pwn-request aware): the triggering run is untrusted and its
# tree is PR-controlled. This script therefore never checks out or executes
# anything from that run. It consumes only (a) GitHub's own event metadata
# (run id / head ref / conclusion, re-verified via the API) and (b) the run's
# jobs/logs through the read-only actions API. The comment body is composed
# from that data and posted by the base-pinned posting helper. A queued PR can
# at most make its own run fail; the artefact it can influence is limited to a
# truthful statement about that run on its own PR thread.
#
# Environment (set by the workflow):
#   GH_TOKEN            github.token (actions: read, pull-requests: write)
#   GH_REPO             owner/repo
#   WORKFLOW_RUN_ID     the completed run id (github.event.workflow_run.id)
#   WORKFLOW_NAME       the completed workflow name
#   WORKFLOW_HEAD_BRANCH the completed run's head branch (the queue ref)
# Optional:
#   PR_NUMBER           explicit PR override (testing / future callers)
#   REACT_DRY_RUN       any value: compose and log, never call the poster
#
# Exit codes:
#   0  surfaced (or best-effort skip — a surface must never be enforcement)
#   2  usage / missing-dependency error
set -euo pipefail

command -v jq >/dev/null 2>&1 || { echo "[merge-queue-ejection-react] jq is required but not on PATH" >&2; exit 2; }
command -v gh >/dev/null 2>&1 || { echo "[merge-queue-ejection-react] gh is required but not on PATH" >&2; exit 2; }

log() { echo "[merge-queue-ejection-react] $*"; }

: "${GH_REPO:?merge-queue-ejection-react requires GH_REPO (owner/repo)}"
: "${WORKFLOW_RUN_ID:?merge-queue-ejection-react requires WORKFLOW_RUN_ID}"

RUN_ID="$WORKFLOW_RUN_ID"
HEAD_BRANCH="${WORKFLOW_HEAD_BRANCH:-}"
WORKFLOW_NAME="${WORKFLOW_NAME:-}"

# Same regex the enforcer and the posting helper use, so the three never
# disagree about which PR a queue entry belongs to.
QUEUE_REF_RE='^gh-readonly-queue/.+/pr-([0-9]+)-[0-9a-f]+$'

# --- 1. Re-verify the run (never trust the event payload alone) ---------------
run_json="$(gh api "repos/${GH_REPO}/actions/runs/${RUN_ID}" 2>/dev/null)" || {
  log "could not read run ${RUN_ID} — skipping (best-effort)"
  exit 0
}
if [ "$(jq -r '.event // empty' <<<"$run_json")" != "merge_group" ]; then
  log "run ${RUN_ID} is not a merge_group run — skipping"
  exit 0
fi
if [ "$(jq -r '.conclusion // empty' <<<"$run_json")" != "failure" ]; then
  log "run ${RUN_ID} did not conclude failure — skipping"
  exit 0
fi

# --- 2. Resolve the PR from the queue ref --------------------------------------
pr=""
if [[ "${PR_NUMBER:-}" =~ ^[0-9]+$ ]]; then
  pr="$PR_NUMBER"
else
  actual_branch="$(jq -r '.head_branch // empty' <<<"$run_json")"
  [ -n "$actual_branch" ] || actual_branch="$HEAD_BRANCH"
  if [[ "$actual_branch" =~ $QUEUE_REF_RE ]]; then
    pr="${BASH_REMATCH[1]}"
  fi
fi
if ! [[ "${pr:-}" =~ ^[0-9]+$ ]]; then
  log "could not resolve a PR from run ${RUN_ID} (head branch '${actual_branch:-<none>}') — skipping (best-effort)"
  exit 0
fi
log "run ${RUN_ID} (${WORKFLOW_NAME:-<unknown workflow>}) failed on ${GH_REPO} PR #${pr}"

# --- 3. Find the failing job(s) and derive the check name ----------------------
jobs_json="$(gh api --paginate "repos/${GH_REPO}/actions/runs/${RUN_ID}/jobs" 2>/dev/null)" || {
  log "could not list jobs for run ${RUN_ID} — skipping (best-effort)"
  exit 0
}
# Names of every failed job, in workflow order.
failing_names="$(jq -r '.jobs[] | select(.conclusion == "failure") | .name' <<<"$jobs_json")"
if [ -z "$failing_names" ]; then
  log "run ${RUN_ID} failed but no job concluded failure — nothing to name; skipping"
  exit 0
fi

# The artefact must name the *required merge_group check* that failed, not an
# arbitrary cascade victim. Map the completed workflow + failing jobs to the
# check an agent recognises:
#   - "Paperclip Approval Enforcer" workflow -> paperclip-approved-enforcer
#   - "PR" workflow -> the root required context among the failing jobs,
#     preferring Approval precondition (approval absent) then verify then e2e,
#     falling back to the first failing job.
ENFORCER_WORKFLOW_NAME='Paperclip Approval Enforcer'
check_name=""
if [ "$WORKFLOW_NAME" = "$ENFORCER_WORKFLOW_NAME" ]; then
  check_name='paperclip-approved-enforcer'
else
  for cand in 'Approval precondition' verify e2e; do
    if grep -Fxq "$cand" <<<"$failing_names"; then
      check_name="$cand"
      break
    fi
  done
  if [ -z "$check_name" ]; then
    check_name="$(head -1 <<<"$failing_names")"
  fi
fi

# --- 4. Compose the reason (bounded tails of the genuinely failed jobs) -------
reason="$(mktemp)" || { echo "[merge-queue-ejection-react] could not allocate a temp file" >&2; exit 2; }
trap 'rm -f "$reason"' EXIT
{
  echo "failing job(s) on the merge-group commit:"
  echo "$failing_names" | sed 's/^/  - /'
} > "$reason"

# The reason must be actionable, not status-only (merge-group-surface-reason-is-status-only):
# an aggregate/gate context ('verify'/'e2e'/'Approval precondition') that
# failed because its dependencies failed has a thin log of its own. Prefer the
# first genuinely-failed *lane/shard* job's log (best-effort), and fall back to
# the chosen check's own job when nothing deeper failed.
AGGREGATE_JOBS='["verify", "e2e", "Approval precondition"]'
reason_jid="$(jq -r --argjson agg "$AGGREGATE_JOBS" '.jobs[] | select(.conclusion == "failure") | select((.name | IN($agg[])) | not) | .id' <<<"$jobs_json" | head -1 || true)"
if [ -z "$reason_jid" ]; then
  reason_jid="$(jq -r --arg n "$check_name" '.jobs[] | select(.name == $n) | select(.conclusion == "failure") | .id' <<<"$jobs_json" | head -1 || true)"
fi
reason_name="$(jq -r --arg id "$reason_jid" '.jobs[] | select((.id | tostring) == $id) | .name' <<<"$jobs_json" | head -1 || true)"
tail_one() {
  local name="$1" jid="$2" limit="${3:-1500}"
  [ -n "$jid" ] || return 0
  printf '\n--- %s failing output (bounded tail) ---\n' "$name" >> "$reason"
  gh api "repos/${GH_REPO}/actions/jobs/${jid}/logs" 2>/dev/null | tail -c "$limit" >> "$reason" || true
}
if [ -n "$reason_jid" ]; then
  tail_one "$reason_name" "$reason_jid"
else
  # No failing job id resolved (defensive) — leave the failing-job list as the
  # reason; the helper appends a pointer to the merge_group run.
  :
fi

# --- 5. Post / update the artefact via the trusted posting helper -------------
poster_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
poster="$poster_dir/surface-merge-queue-ejection.sh"
if [ ! -f "$poster" ]; then
  # Same-repo checkout should always carry it; loud-fail rather than inventing
  # an untrusted inline fallback (merge-group-comment-token-executes-pr-code).
  echo "::error::[merge-queue-ejection-react] trusted posting helper ${poster} is missing from the protected tree — refusing to post"
  exit 1
fi
if [ -n "${REACT_DRY_RUN:-}" ]; then
  log "[dry run] would surface check '${check_name}' on ${GH_REPO} PR #${pr} with verdict ${reason}"
  log "[dry run] verdict content:"
  cat "$reason" >&2
  exit 0
fi
PR_NUMBER="$pr" bash "$poster" --check-name "$check_name" --verdict "$reason"
exit 0
