#!/usr/bin/env bash
# Property tests for the entrypoint's CodeRabbit credential seeding.
#
# These run INSIDE containers, because every property under test is about real
# uid/gid access to a real file. The one that matters — can the AGENT uid read
# the credential the SERVER uid wrote — cannot be asserted from the source text.
#
#   scripts/tests/docker-entrypoint-coderabbit.sh
#   IMAGE=tea-core/paperclip:v2026.722.0-tea scripts/tests/docker-entrypoint-coderabbit.sh
#
# The working-tree entrypoint is mounted over the image's, so a change can be
# tested without a rebuild. It is invoked as `sh /tmp/ep.sh ...` because the file
# is tracked 0644 and only becomes executable when the Dockerfile copies it.
#
# No CodeRabbit account or network access is needed: the seeded credential is a
# fabricated auth.json. What is under test is the file plumbing, not the token.
#
# Nothing here touches a running deployment.
# SC2015: the `cond && ok ... || no ...` idiom is deliberate, as in
# docker-entrypoint-cap-kill.sh: `ok` is a counter bump plus a printf and cannot
# fail, so the `||` branch is only ever reached when the condition is false.
# shellcheck disable=SC2015
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EP="$(cd "$HERE/.." && pwd)/docker-entrypoint.sh"
IMAGE="${IMAGE:-tea-core/paperclip:v2026.722.0-tea}"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf 'ok   - %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf 'FAIL - %s\n' "$1"; }

docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "image not present: $IMAGE (set IMAGE= to override)" >&2
  exit 1
}

# A structurally valid credential with a worthless token. The entrypoint gates
# on `accessToken` being present, which is exactly what this exercises; no
# request is ever made with it.
FAKE_AUTH='{"accessToken":"test-token-not-a-real-credential","expiresAt":"never","provider":"github","region":"us"}'
GOOD_B64="$(printf '%s' "$FAKE_AUTH" | base64 -w0)"

# A real home directory on the host, so state survives between container runs
# and the "an existing credential is not destroyed" properties are testable.
HOME_DIR="$(mktemp -d)"
chmod 0777 "$HOME_DIR"
trap 'sudo rm -rf "$HOME_DIR" 2>/dev/null || rm -rf "$HOME_DIR"' EXIT

run_entrypoint() { # run_entrypoint <docker-run-args...> -- <shell command>
  local args=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do args+=("$1"); shift; done
  shift
  docker run --rm -v "$EP:/tmp/ep.sh:ro" -v "$HOME_DIR:/paperclip" \
    -e PAPERCLIP_HOME=/paperclip "${args[@]}" \
    --entrypoint /bin/sh "$IMAGE" /tmp/ep.sh sh -c "$1" 2>&1
}

# --- 1. A valid credential is seeded where the CLI looks for it -------------
# The CLI reads ONLY $HOME/.coderabbit/auth.json. It ignores CODERABBIT_API_KEY
# at review time, and unauthenticated it does not review at all: it falls
# through to browser OAuth and, with no browser reachable, exits 1 in ~5s with
# {"status":"environment_unsupported"}. Measured on the wonton host against the
# deployed image, 2026-08-26.
OUT="$(run_entrypoint -e CODERABBIT_AUTH_JSON_B64="$GOOD_B64" -- 'stat -c "%n %U:%G %a" /paperclip/.coderabbit /paperclip/.coderabbit/auth.json')"; RC=$?
[ "$RC" -eq 0 ] && ok "seed: entrypoint starts" || no "seed: exit $RC"
grep -q 'seeded CodeRabbit CLI credentials' <<<"$OUT" && ok "seed: the seeding is announced" || no "seed: seeded silently"
grep -q '/paperclip/.coderabbit/auth.json node:agents 660' <<<"$OUT" \
  && ok "seed: credential is node:agents 0660" \
  || no "seed: wrong owner/mode -- $(grep -o '/paperclip/.coderabbit/auth.json .*' <<<"$OUT")"
# setgid matters beyond the initial write: the CLI creates machine-id, logs and
# per-review state in here at runtime, and without 2770 those land group-node
# and the other uid cannot rewrite them.
grep -q '/paperclip/.coderabbit node:agents 2770' <<<"$OUT" \
  && ok "seed: directory is setgid agents, group-writable" \
  || no "seed: wrong directory owner/mode -- $(grep -o '/paperclip/.coderabbit node.*' <<<"$OUT")"

# --- 2. The agent uid can actually read it ----------------------------------
# The property the whole design turns on. The server (uid 1000) writes the
# credential; agent runtimes spawn on uid 1001 under PAPERCLIP_AGENT_UID and
# share HOME=/paperclip. The CLI's own default of 0700/0600 would lock 1001 out.
#
# This goes through the real setuid shim rather than setpriv, because by the
# time the entrypoint runs its argv it has already dropped to uid 1000 and can
# no longer change uid itself — which is also precisely how agents are spawned
# in production, so the test exercises the production path.
AGENT_OUT="$(docker run --rm -v "$EP:/tmp/ep.sh:ro" -v "$HOME_DIR:/paperclip" \
  -e PAPERCLIP_HOME=/paperclip -e CODERABBIT_AUTH_JSON_B64="$GOOD_B64" -e PAPERCLIP_AGENT_UID=1001 \
  --entrypoint /bin/sh "$IMAGE" /tmp/ep.sh /usr/local/sbin/paperclip-spawn-agent sh -c \
  'echo "UID=$(id -u)"; cat /paperclip/.coderabbit/auth.json' 2>&1)"
grep -q 'UID=1001' <<<"$AGENT_OUT" && ok "agent lands on the agent uid" || no "agent uid wrong -- $(grep -o 'UID=[0-9]*' <<<"$AGENT_OUT")"
grep -q 'test-token-not-a-real-credential' <<<"$AGENT_OUT" \
  && ok "agent uid 1001 can read the seeded credential" \
  || no "agent uid 1001 cannot read the credential -- $AGENT_OUT"

# --- 3. A malformed value must not destroy a working credential -------------
# Rotation goes through this variable, so a fat-fingered value arrives on a
# volume that already holds valid auth. Clobbering it would take agent review
# down at the moment an operator was trying to fix it.
OUT="$(run_entrypoint -e CODERABBIT_AUTH_JSON_B64='not!valid!base64!!' -- 'cat /paperclip/.coderabbit/auth.json')"; RC=$?
[ "$RC" -eq 0 ] && ok "malformed base64: entrypoint still starts" || no "malformed base64: entrypoint exited $RC -- a bad variable must not be an outage"
grep -q 'test-token-not-a-real-credential' <<<"$OUT" \
  && ok "malformed base64: existing credential survives" \
  || no "malformed base64: existing credential was destroyed"
grep -q 'not valid base64-encoded CodeRabbit auth JSON' <<<"$OUT" \
  && ok "malformed base64: the degrade is announced" || no "malformed base64: degraded silently"
# A silent degrade here surfaces later as every agent review exiting 1 on an
# opaque "environment_unsupported", which reads as a broken CLI rather than a
# missing credential.
grep -q 'environment_unsupported' <<<"$OUT" \
  && ok "malformed base64: the warning names the symptom operators will see" \
  || no "malformed base64: warning does not say what breaks"

# --- 4. Valid base64 carrying the wrong JSON takes the same branch ----------
OUT="$(run_entrypoint -e CODERABBIT_AUTH_JSON_B64="$(printf '{"nope":1}' | base64 -w0)" -- 'cat /paperclip/.coderabbit/auth.json')"; RC=$?
[ "$RC" -eq 0 ] && ok "wrong JSON shape: entrypoint still starts" || no "wrong JSON shape: entrypoint exited $RC"
grep -q 'test-token-not-a-real-credential' <<<"$OUT" \
  && ok "wrong JSON shape: existing credential survives" \
  || no "wrong JSON shape: existing credential was destroyed"
grep -q 'not valid base64-encoded CodeRabbit auth JSON' <<<"$OUT" \
  && ok "wrong JSON shape: the degrade is announced" || no "wrong JSON shape: degraded silently"

# --- 4b. A present-but-unusable token is rejected too -----------------------
# `has("accessToken")` is true for null and for "", so a key-present check would
# accept both. Either one replaces a working credential with one the CLI cannot
# use AND, because the file then exists, suppresses the API-key fallback — a
# quiet downgrade from working to broken. Non-object JSON must not pass either.
for shape in '{"accessToken":null}' '{"accessToken":""}' '["accessToken"]'; do
  OUT="$(run_entrypoint -e CODERABBIT_AUTH_JSON_B64="$(printf '%s' "$shape" | base64 -w0)" -- 'cat /paperclip/.coderabbit/auth.json')"; RC=$?
  [ "$RC" -eq 0 ] && ok "unusable token $shape: entrypoint still starts" || no "unusable token $shape: entrypoint exited $RC"
  grep -q 'test-token-not-a-real-credential' <<<"$OUT" \
    && ok "unusable token $shape: existing credential survives" \
    || no "unusable token $shape: existing credential was destroyed"
  grep -q 'not valid base64-encoded CodeRabbit auth JSON' <<<"$OUT" \
    && ok "unusable token $shape: the degrade is announced" || no "unusable token $shape: degraded silently"
done

# --- 5. Unconfigured is byte-for-byte the old behaviour ---------------------
CLEAN_HOME="$(mktemp -d)"; chmod 0777 "$CLEAN_HOME"
OUT="$(docker run --rm -v "$EP:/tmp/ep.sh:ro" -v "$CLEAN_HOME:/paperclip" -e PAPERCLIP_HOME=/paperclip \
  --entrypoint /bin/sh "$IMAGE" /tmp/ep.sh sh -c 'ls -a /paperclip' 2>&1)"; RC=$?
sudo rm -rf "$CLEAN_HOME" 2>/dev/null || rm -rf "$CLEAN_HOME"
[ "$RC" -eq 0 ] && ok "unconfigured: entrypoint starts" || no "unconfigured: exit $RC"
grep -q '\.coderabbit' <<<"$OUT" && no "unconfigured: created a credential directory nobody asked for" || ok "unconfigured: no .coderabbit directory is created"
grep -qi 'coderabbit' <<<"$OUT" && no "unconfigured: mentions CodeRabbit without being configured" || ok "unconfigured: silent, as before"

# --- 6. The CLI itself is present and reachable by both uids ----------------
# Skipped rather than failed on an older IMAGE, so this file stays runnable
# against the image a deployment is currently on.
if docker run --rm --entrypoint sh "$IMAGE" -c 'command -v coderabbit' >/dev/null 2>&1; then
  OUT="$(docker run --rm --entrypoint sh "$IMAGE" -c \
    'coderabbit --version; setpriv --reuid=1001 --regid=1001 --groups=1002 coderabbit --version' 2>&1)"
  [ "$(grep -c '^[0-9]\+\.[0-9]\+\.[0-9]\+$' <<<"$OUT")" -eq 2 ] \
    && ok "CLI runs for both the server uid and the agent uid" \
    || no "CLI does not run for both uids -- $OUT"
  # /etc/profile hard-resets PATH for login shells, discarding the image's ENV
  # PATH; the /usr/local/bin symlink is what survives that, for `cr` too.
  docker run --rm --entrypoint bash "$IMAGE" -lc 'command -v coderabbit && command -v cr' >/dev/null 2>&1 \
    && ok "coderabbit and cr resolve in a login shell" || no "coderabbit/cr missing from login-shell PATH"
else
  printf 'skip - CLI presence: %s predates the CodeRabbit CLI layer\n' "$IMAGE"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
