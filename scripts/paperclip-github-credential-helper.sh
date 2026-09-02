#!/usr/bin/env bash
#
# Paperclip GitHub App credential helper (agent-side, "one tier out").
#
# Git invokes this as a credential helper when it needs github.com credentials:
#   paperclip-github-credential-helper.sh get|store|erase|approve|reject
# The credential request arrives on stdin as `key=value` lines. We respond to
# `get` by minting a short-lived GitHub App installation token on demand from
# the Paperclip broker route, and by emitting it to git over stdout only:
#
#     POST $PAPERCLIP_API_URL/api/agents/me/github/installation-tokens
#     Authorization: Bearer $PAPERCLIP_API_KEY
#     body: {"owner":"<o>","repo":"<r>","permissions":{"contents":"<access>"}}
#
# Security discipline (mirrors server/src/services/git-credentials.ts):
#   - The minted token is passed from git via stdin (never on argv) and returned
#     on stdout only. It is never written to disk, never logged, and never placed
#     in a persistent environment variable.
#   - `store`/`erase` are no-ops that drain stdin and succeed, so no helper
#     persists the token to a credential cache.
#   - Minting happens per `get`, so a long-running session that performs a git
#     op late in its life still gets a fresh, un-expired token.
#
# Required in the environment of the invoking git process:
#   PAPERCLIP_API_URL   base URL of the Paperclip API
#   PAPERCLIP_API_KEY   run-bound agent key (Bearer) for the broker route
#
# Owner/repo resolution (git does NOT send the repo path to the helper):
#   1. PAPERCLIP_GIT_REPO=owner/repo            (explicit override)
#   2. the current repo's github.com remote     (origin, else first github remote)
#   3. PAPERCLIP_WORKSPACE_REPO_URL             (workspace fallback)
#
set -u

ACTION="${1:-get}"

# Drain stdin (capture for `get`; ignore for the rest).
REQUEST="$(cat 2>/dev/null || true)"

# Never persist a token. Drain and succeed.
case "$ACTION" in
  store|erase|approve|reject|cache|list)
    exit 0
    ;;
esac

# --- get ----------------------------------------------------------------------

fail() {
  printf 'paperclip-github-credential-helper: %s\n' "$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required but was not found."
[ -n "${PAPERCLIP_API_URL:-}" ] || fail "PAPERCLIP_API_URL is not set; cannot reach the Paperclip broker to mint a GitHub token."
[ -n "${PAPERCLIP_API_KEY:-}" ] || fail "PAPERCLIP_API_KEY is not set; this git process is not running inside a Paperclip agent run."

# Only answer for github.com hosts; re-validate so a mis-scoped config can't
# redirect the helper at an arbitrary host.
HOST="$(printf '%s\n' "$REQUEST" | sed -n 's/^host=//p' | head -n1)"
case "$HOST" in
  github.com|www.github.com) ;;
  *) fail "credential helper is configured for github.com only (requested host: '${HOST:-<unknown>}')." ;;
esac

# Parse a git remote URL (https/ssh) into lowercase `owner/repo`, or empty.
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
      return 0
      ;;
  esac
  [ -n "$rest" ] || return 0
  rest="${rest%.git}"
  case "$rest" in
    */*) printf '%s\n' "$rest" | tr '[:upper:]' '[:lower:]' ;;
    *)   return 0 ;;
  esac
}

OWNER_REPO=""
if [ -n "${PAPERCLIP_GIT_REPO:-}" ]; then
  OWNER_REPO="$(parse_owner_repo "https://github.com/${PAPERCLIP_GIT_REPO}")"
fi

if [ -z "$OWNER_REPO" ]; then
  REMOTE_URLS="$(git -C "$PWD" remote -v 2>/dev/null | awk '{print $2}' || true)"
  for u in $REMOTE_URLS; do
    m="$(parse_owner_repo "$u")"
    if [ -n "$m" ]; then OWNER_REPO="$m"; break; fi
  done
fi

if [ -z "$OWNER_REPO" ] && [ -n "${PAPERCLIP_WORKSPACE_REPO_URL:-}" ]; then
  OWNER_REPO="$(parse_owner_repo "$PAPERCLIP_WORKSPACE_REPO_URL")"
fi

[ -n "$OWNER_REPO" ] || fail "could not determine target owner/repo for github.com; run inside a repo with a github.com remote, or set PAPERCLIP_GIT_REPO=owner/repo."
case "$OWNER_REPO" in
  */*) ;;
  *) fail "resolved owner/repo '$OWNER_REPO' is malformed (expected owner/repo)." ;;
esac
OWNER="${OWNER_REPO%%/*}"
REPO="${OWNER_REPO#*/}"
[ -n "$OWNER" ] && [ -n "$REPO" ] || fail "resolved owner/repo '$OWNER_REPO' is malformed (expected owner/repo)."

# `contents` write covers clone/fetch (read) and push; overridable for read-only use.
ACCESS="${PAPERCLIP_GIT_ACCESS:-write}"
case "$ACCESS" in read|write|admin|none) ;; *) ACCESS="write" ;; esac

BODY="$(printf '{"owner":"%s","repo":"%s","permissions":{"contents":"%s"}}' "$OWNER" "$REPO" "$ACCESS")"
API_BASE="${PAPERCLIP_API_URL%/}"
ENDPOINT="$API_BASE/api/agents/me/github/installation-tokens"

CURL_ERR="$(mktemp 2>/dev/null || echo "/tmp/.gh-helper-curl.err.$$")"
trap 'rm -f "$CURL_ERR" 2>/dev/null' EXIT
RESPONSE="$(curl -sS -m 30 -X POST "$ENDPOINT" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H 'Content-Type: application/json' \
  --data "$BODY" 2>"$CURL_ERR")" || RESPONSE=""

if [ -z "$RESPONSE" ]; then
  err="$(cat "$CURL_ERR" 2>/dev/null | tr '\n' ' ' | tr -d '\0' | sed -E 's/.*(error|timed out|Could not|Connection|refused).*[a-z]"?$/\1/')"
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

# Emit to git's stdout only. The token is consumed by git for this operation.
printf 'username=x-access-token\npassword=%s\n\n' "$TOKEN"
