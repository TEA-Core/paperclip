#!/usr/bin/env bash
# Property tests for the entrypoint's ambient CAP_KILL grant.
#
# These run INSIDE containers, because every property under test is about real
# kernel capability sets and a real setuid drop. Nothing here can be asserted
# from the source text.
#
#   scripts/test-docker-entrypoint-cap-kill.sh
#   IMAGE=tea-core/paperclip:v2026.722.0-tea scripts/test-docker-entrypoint-cap-kill.sh
#
# The working-tree entrypoint is mounted over the image's, so a change can be
# tested without a rebuild. It is invoked as `sh /tmp/ep.sh ...` because the file
# is tracked 0644 and only becomes executable when the Dockerfile copies it.
#
# Nothing here touches a running deployment.
# SC2015: the `cond && ok ... || no ...` idiom is deliberate, as in
# test-spawn-shim.sh: `ok` is a counter bump plus a printf and cannot fail, so
# the `||` branch is only ever reached when the condition itself is false.
# SC2016: PROBE must stay unexpanded here — it is evaluated by the shell INSIDE
# the container, and expanding it on the host would report the host's identity.
# shellcheck disable=SC2015,SC2016
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EP="$HERE/docker-entrypoint.sh"
IMAGE="${IMAGE:-tea-core/paperclip:v2026.722.0-tea}"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf 'ok   - %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf 'FAIL - %s\n' "$1"; }

docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "image not present: $IMAGE (set IMAGE= to override)" >&2
  exit 1
}

# A capsh that always fails, to exercise the "binary unusable" branch without
# rebuilding an image without libcap2-bin. Created here so the test owns its
# executable bit.
STUB_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR"' EXIT
printf '#!/bin/sh\necho "capsh: not found" >&2\nexit 127\n' >"$STUB_DIR/capsh"
chmod 0755 "$STUB_DIR/capsh"

# PROBE reports the identity and capability set the server process actually
# lands with. It runs as the container's argv, so it is what the entrypoint
# exec'd into — the same position the node server occupies in production.
PROBE='echo "UID=$(id -u)"; echo "GROUPS=$(id -Gn)"; sed -n "s/^CapAmb:[[:space:]]*/CAPAMB=/p" /proc/self/status'

run_entrypoint() { # run_entrypoint <docker-run-args...>
  docker run --rm -v "$EP:/tmp/ep.sh:ro" "$@" --entrypoint /bin/sh "$IMAGE" \
    /tmp/ep.sh sh -c "$PROBE" 2>&1
}

# --- 1. The grant works when the runtime allows it -------------------------
# cap_kill is bit 5, so an ambient set carrying it ends in 0x20.
OUT="$(run_entrypoint -e PAPERCLIP_AGENT_UID=1001)"; RC=$?
[ "$RC" -eq 0 ] && ok "armed + caps intact: entrypoint starts" || no "armed + caps intact: exit $RC"
grep -q 'CAPAMB=0000000000000020' <<<"$OUT" \
  && ok "armed + caps intact: server holds ambient CAP_KILL" \
  || no "armed + caps intact: ambient CAP_KILL missing -- $(grep -o 'CAPAMB=[0-9a-f]*' <<<"$OUT")"
grep -q 'UID=1000' <<<"$OUT" && ok "armed: server still drops to uid 1000" || no "armed: wrong uid -- $(grep -o 'UID=[0-9]*' <<<"$OUT")"
# gosu did initgroups; capsh must not silently lose the shared `agents` group,
# which is what lets the server chgrp worktrees the agent uid also writes.
grep -q 'GROUPS=.*agents' <<<"$OUT" && ok "armed: supplementary group 'agents' survives the capsh drop" || no "armed: 'agents' group lost -- $(grep -o 'GROUPS=.*' <<<"$OUT")"

# --- 2. A runtime that removes the capability must not remove the server ----
# The regression this file exists for. capsh fails at --inh when cap_kill is
# outside the bounding set; the invocation is exec'd, so before the probe its
# exit status WAS the entrypoint's and any cap_drop became a boot loop.
OUT="$(run_entrypoint --cap-drop=KILL -e PAPERCLIP_AGENT_UID=1001)"; RC=$?
[ "$RC" -eq 0 ] && ok "cap_drop=KILL: entrypoint still starts the server" || no "cap_drop=KILL: entrypoint exited $RC -- a hardening flag must not be an outage"
grep -q 'UID=1000' <<<"$OUT" && ok "cap_drop=KILL: falls back to the gosu path at uid 1000" || no "cap_drop=KILL: wrong uid -- $(grep -o 'UID=[0-9]*' <<<"$OUT")"
grep -q 'CAPAMB=0000000000000000' <<<"$OUT" && ok "cap_drop=KILL: no ambient capability is claimed" || no "cap_drop=KILL: unexpected ambient set -- $(grep -o 'CAPAMB=[0-9a-f]*' <<<"$OUT")"
# A silent degrade is worse than the outage it replaced: nothing else reports
# that timeouts have stopped working.
grep -q 'CAP_KILL could not be granted' <<<"$OUT" && ok "cap_drop=KILL: the degrade is announced" || no "cap_drop=KILL: degraded silently"
grep -q 'Operation not permitted' <<<"$OUT" && ok "cap_drop=KILL: the warning carries the kernel's reason" || no "cap_drop=KILL: warning does not say why"

# --- 3. An unusable capsh takes the same branch -----------------------------
OUT="$(run_entrypoint --cap-drop=KILL -v "$STUB_DIR/capsh:/usr/sbin/capsh:ro" -e PAPERCLIP_AGENT_UID=1001)"; RC=$?
[ "$RC" -eq 0 ] && ok "capsh unusable: entrypoint still starts the server" || no "capsh unusable: entrypoint exited $RC"
grep -q 'CAP_KILL could not be granted' <<<"$OUT" && ok "capsh unusable: the degrade is announced" || no "capsh unusable: degraded silently"

# --- 4. Unarmed is byte-for-byte the old behaviour --------------------------
OUT="$(run_entrypoint)"; RC=$?
[ "$RC" -eq 0 ] && ok "unarmed: entrypoint starts" || no "unarmed: exit $RC"
grep -q 'CAPAMB=0000000000000000' <<<"$OUT" && ok "unarmed: no capability is granted" || no "unarmed: capability granted without the uid split -- $(grep -o 'CAPAMB=[0-9a-f]*' <<<"$OUT")"
grep -q 'CAP_KILL' <<<"$OUT" && no "unarmed: warns about a capability it never wanted" || ok "unarmed: silent, as before"

# --- 5. The grant does not reach the agent uid ------------------------------
# The security property. execve of a setuid binary clears the ambient set, so a
# runtime spawned through the shim must land with nothing. If this ever fails,
# agents can signal the server and pid 1.
AGENT_OUT="$(docker run --rm -v "$EP:/tmp/ep.sh:ro" -e PAPERCLIP_AGENT_UID=1001 --entrypoint /bin/sh "$IMAGE" \
  /tmp/ep.sh /usr/local/sbin/paperclip-spawn-agent sh -c \
  'echo "UID=$(id -u)"; sed -n "s/^CapEff:[[:space:]]*/CAPEFF=/p;s/^CapAmb:[[:space:]]*/CAPAMB=/p" /proc/self/status' 2>&1)"
grep -q 'UID=1001' <<<"$AGENT_OUT" && ok "agent lands on the agent uid" || no "agent uid wrong -- $(grep -o 'UID=[0-9]*' <<<"$AGENT_OUT")"
grep -q 'CAPEFF=0000000000000000' <<<"$AGENT_OUT" && grep -q 'CAPAMB=0000000000000000' <<<"$AGENT_OUT" \
  && ok "agent inherits NO capabilities through the setuid shim" \
  || no "CAP_KILL leaked to the agent uid -- $(grep -o 'CAP[EA][FM][FB]=[0-9a-f]*' <<<"$AGENT_OUT" | tr '\n' ' ')"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
