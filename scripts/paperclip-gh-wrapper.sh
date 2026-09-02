#!/usr/bin/env bash
#
# Paperclip `gh` wrapper (agent-side, "one tier out").
#
# Drop this on PATH in front of the real `gh` (or set PAPERCLIP_GH_REAL to the
# real binary) so that agent runs call the GitHub API with a short-lived GitHub
# App installation token minted on demand from the Paperclip broker, instead of a
# long-lived GH_TOKEN in the environment.
#
#   paperclip-gh-wrapper.sh [gh args...]
#
# Behavior:
#   - Resolves the target owner/repo (--repo flag > GH_REPO > PAPERCLIP_GIT_REPO
#     > current repo's github.com remote > PAPERCLIP_WORKSPACE_REPO_URL).
#   - Mints a token for that repo from
#       POST $PAPERCLIP_API_URL/api/agents/me/github/installation-tokens
#     with Authorization: Bearer $PAPERCLIP_API_KEY.
#   - Runs the real `gh` with GH_TOKEN set for that single invocation only. The
#     token is never written to disk, never logged, and is not left in a
#     persistent environment variable.
#
set -u

fail() {
  printf 'paperclip-gh-wrapper: %s\n' "$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required but was not found."
[ -n "${PAPERCLIP_API_URL:-}" ] || fail "PAPERCLIP_API_URL is not set; cannot reach the Paperclip broker to mint a GitHub token."
[ -n "${PAPERCLIP_API_KEY:-}" ] || fail "PAPERCLIP_API_KEY is not set; this process is not running inside a Paperclip agent run."

# --- resolve owner/repo -------------------------------------------------------

parse_owner_repo() {
  url="$1"
  rest=""
  case "$url" in
    https://github.com/*|https://www.github.com/*)
      rest="${url#*://}"; rest="${rest#github.com/}"; rest="${rest#www.github.com/}" ;;
    ssh://git@github.com/*|ssh://git@www.github.com/*)
      rest="${url#*github.com/}" ;;
    git@github.com:*|git@www.github.com:*)
      rest="${url#*:}" ;;
    *)
      # bare owner/repo
      case "$url" in */*) rest="${url}" ;; *) return 0 ;; esac ;;
  esac
  [ -n "$rest" ] || return 0
  rest="${rest%.git}"
  case "$rest" in
    */*) printf '%s\n' "$rest" | tr '[:upper:]' '[:lower:]' ;;
    *)   return 0 ;;
  esac
}

OWNER_REPO=""
# 1) --repo flag: `gh [--repo owner/repo]` (value in the following arg)
args=("$@")
n=${#args[@]}
for ((idx=0; idx<n; idx++)); do
  if [ "${args[idx]}" = "--repo" ] && [ $((idx+1)) -lt "$n" ]; then
    OWNER_REPO="$(parse_owner_repo "${args[idx+1]}")"; break
  fi
done
# GH_REPO env
if [ -z "$OWNER_REPO" ] && [ -n "${GH_REPO:-}" ]; then OWNER_REPO="$(parse_owner_repo "$GH_REPO")"; fi
# PAPERCLIP_GIT_REPO
if [ -z "$OWNER_REPO" ] && [ -n "${PAPERCLIP_GIT_REPO:-}" ]; then OWNER_REPO="$(parse_owner_repo "https://github.com/${PAPERCLIP_GIT_REPO}")"; fi
# current repo remote
if [ -z "$OWNER_REPO" ]; then
  REMOTE_URLS="$(git -C "$PWD" remote -v 2>/dev/null | awk '{print $2}' || true)"
  for u in $REMOTE_URLS; do
    m="$(parse_owner_repo "$u")"; if [ -n "$m" ]; then OWNER_REPO="$m"; break; fi
  done
fi
# workspace fallback
if [ -z "$OWNER_REPO" ] && [ -n "${PAPERCLIP_WORKSPACE_REPO_URL:-}" ]; then
  OWNER_REPO="$(parse_owner_repo "$PAPERCLIP_WORKSPACE_REPO_URL")"
fi

[ -n "$OWNER_REPO" ] || fail "could not determine target owner/repo; pass --repo owner/repo, set GH_REPO / PAPERCLIP_GIT_REPO, or run inside a repo with a github.com remote."
case "$OWNER_REPO" in */*) ;; *) fail "owner/repo '$OWNER_REPO' is malformed." ;; esac
OWNER="${OWNER_REPO%%/*}"; REPO="${OWNER_REPO#*/}"
[ -n "$OWNER" ] && [ -n "$REPO" ] || fail "owner/repo '$OWNER_REPO' is malformed."

# --- permissions --------------------------------------------------------------
# Default is an empty permissions object (the broker/App grants the token the
# repo's baseline access). Override with PAPERCLIP_GH_PERMISSIONS (JSON object),
# e.g. PAPERCLIP_GH_PERMISSIONS='{"contents":"read","pull_requests":"read"}'.
PERMS="${PAPERCLIP_GH_PERMISSIONS:-}"
if [ -n "$PERMS" ]; then
  BODY="{\"owner\":\"$OWNER\",\"repo\":\"$REPO\",\"permissions\":$PERMS}"
else
  BODY="{\"owner\":\"$OWNER\",\"repo\":\"$REPO\"}"
fi
API_BASE="${PAPERCLIP_API_URL%/}"
ENDPOINT="$API_BASE/api/agents/me/github/installation-tokens"

CURL_ERR="$(mktemp 2>/dev/null || echo "/tmp/.gh-wrapper-curl.err.$$")"
trap 'rm -f "$CURL_ERR" 2>/dev/null' EXIT
RESPONSE="$(curl -sS -m 30 -X POST "$ENDPOINT" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H 'Content-Type: application/json' \
  --data "$BODY" 2>"$CURL_ERR")" || RESPONSE=""

if [ -z "$RESPONSE" ]; then
  err="$(cat "$CURL_ERR" 2>/dev/null | tr '\n' ' ')"
  fail "could not reach the Paperclip broker at $ENDPOINT${err:+ ($err)}."
fi

TOKEN=""
ERR_MSG=""
if command -v jq >/dev/null 2>&1; then
  TOKEN="$(printf '%s' "$RESPONSE" | jq -r '.token // empty' 2>/dev/null || true)"
  ERR_MSG="$(printf '%s' "$RESPONSE" | jq -r '.error // .message // .code // empty' 2>/dev/null || true)"
else
  TOKEN="$(printf '%s' "$RESPONSE" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  ERR_MSG="$(printf '%s' "$RESPONSE" | sed -n 's/.*"error"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
fi
[ -n "$TOKEN" ] || fail "GitHub token mint failed${ERR_MSG:+: $ERR_MSG} (owner/repo: $OWNER_REPO)."

# --- locate the real gh and exec it with GH_TOKEN set for this call only ------
SELF="$(command -v "$0" 2>/dev/null || printf '%s' "$0")"
SELF="$(readlink -f "$SELF" 2>/dev/null || printf '%s' "$SELF")"
REAL_GH=""
if [ -n "${PAPERCLIP_GH_REAL:-}" ]; then
  [ -x "${PAPERCLIP_GH_REAL}" ] || fail "PAPERCLIP_GH_REAL='${PAPERCLIP_GH_REAL}' is not an executable."
  REAL_GH="${PAPERCLIP_GH_REAL}"
else
  OLD_IFS="$IFS"; IFS=":"
  for dir in $PATH; do
    cand="$dir/gh"
    [ -x "$cand" ] || continue
    cand_real="$(readlink -f "$cand" 2>/dev/null || printf '%s' "$cand")"
    if [ "$cand_real" != "$SELF" ]; then REAL_GH="$cand_real"; break; fi
  done
  IFS="$OLD_IFS"
fi
[ -n "$REAL_GH" ] || fail "could not locate the real gh binary (set PAPERCLIP_GH_REAL to its path)."

# GH_TOKEN applies only to the single gh invocation; the token is not persisted.
exec env GH_TOKEN="$TOKEN" "$REAL_GH" "$@"
