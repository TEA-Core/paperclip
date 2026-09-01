#!/usr/bin/env bash
# Property tests for the entrypoint's ambient CAP_KILL + CAP_FOWNER grants and
# the mixed-ownership worktree normalisation.
#
# These run INSIDE containers, because every property under test is about real
# kernel capability sets and a real setuid drop. Nothing here can be asserted
# from the source text.
#
#   scripts/tests/docker-entrypoint-cap-kill.sh
#   IMAGE=tea-core/paperclip:v2026.722.0-tea scripts/tests/docker-entrypoint-cap-kill.sh
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

# A capsh that always fails, to exercise the "binary unusable" branch without
# rebuilding an image without libcap2-bin. Created here so the test owns its
# executable bit.
STUB_DIR="$(mktemp -d)"
VOL_DIR="$(mktemp -d)"
trap 'rm -rf "$STUB_DIR" "$VOL_DIR"' EXIT
printf '#!/bin/sh\necho "capsh: not found" >&2\nexit 127\n' >"$STUB_DIR/capsh"
chmod 0755 "$STUB_DIR/capsh"

# PROBE reports the identity and capability set the server process actually
# lands with. It runs as the container's argv, so it is what the entrypoint
# exec'd into — the same position the node server occupies in production.
# CapAmb/CapEff and the owner (`Uid:` line) are read from the SAME
# /proc/<pid>/status, so the owner assertion cannot false-pass on pid 1
# (/sbin/docker-init, root), whose cmdline embeds the server command.
#
# CROSS_UID_CHMOD exercises the syscall the fix exists for: the agent uid
# writes a file through the setuid shim, then the server-equivalent uid chmods
# it. chmod(2) keys off ownership or CAP_FOWNER and ignores group write, so
# without the grant this is EPERM — sections 2 and 4 assert that negative
# control, which is what makes section 1's positive meaningful.
PROBE='sed -n "s/^CapAmb:[[:space:]]*/CAPAMB=/p;s/^CapEff:[[:space:]]*/CAPEFF=/p;s/^Uid:[[:space:]]*/UIDLINE=/p" /proc/self/status; echo "GROUPS=$(id -Gn)"; /usr/local/sbin/paperclip-spawn-agent sh -c "echo agent-owned >/tmp/fowner-probe-file" && chmod 0640 /tmp/fowner-probe-file && echo "CROSS_UID_CHMOD=OK" || echo "CROSS_UID_CHMOD=FAIL"'

run_entrypoint() { # run_entrypoint <docker-run-args...>
  docker run --rm -v "$EP:/tmp/ep.sh:ro" "$@" --entrypoint /bin/sh "$IMAGE" \
    /tmp/ep.sh sh -c "$PROBE" 2>&1
}

# --- 1. The grant works when the runtime allows it -------------------------
# cap_fowner is bit 3 (0x08), cap_kill is bit 5 (0x20): armed together the
# ambient and effective sets end in 0x28.
OUT="$(run_entrypoint -e PAPERCLIP_AGENT_UID=1001)"; RC=$?
[ "$RC" -eq 0 ] && ok "armed + caps intact: entrypoint starts" || no "armed + caps intact: exit $RC"
grep -q 'CAPAMB=0000000000000028' <<<"$OUT" \
  && ok "armed + caps intact: server holds ambient CAP_KILL+CAP_FOWNER" \
  || no "armed + caps intact: ambient caps missing -- $(grep -o 'CAPAMB=[0-9a-f]*' <<<"$OUT")"
grep -q 'CAPEFF=0000000000000028' <<<"$OUT" \
  && ok "armed + caps intact: server holds effective CAP_KILL+CAP_FOWNER" \
  || no "armed + caps intact: effective caps missing -- $(grep -o 'CAPEFF=[0-9a-f]*' <<<"$OUT")"
grep -q 'UIDLINE=1000' <<<"$OUT" && ok "armed: server process is owned by uid 1000" || no "armed: wrong owner -- $(grep -o 'UIDLINE=.*' <<<"$OUT")"
# gosu did initgroups; capsh must not silently lose the shared `agents` group,
# which is what lets the server chgrp worktrees the agent uid also writes.
grep -q 'GROUPS=.*agents' <<<"$OUT" && ok "armed: supplementary group 'agents' survives the capsh drop" || no "armed: 'agents' group lost -- $(grep -o 'GROUPS=.*' <<<"$OUT")"
# The syscall the fix exists for: the server uid chmods a file the agent uid
# wrote. Group write does not permit chmod, so this passes only under CAP_FOWNER.
grep -q 'CROSS_UID_CHMOD=OK' <<<"$OUT" \
  && ok "armed: uid 1000 chmods an agent-owned file (the pnpm linkBin operation)" \
  || no "armed: cross-uid chmod failed -- $(grep -o 'CROSS_UID_CHMOD=.*' <<<"$OUT")"

# --- 2. A runtime that removes a capability must not remove the server -------
# The regression this file exists for. capsh fails at --inh when a granted
# capability is outside the bounding set; the invocation is exec'd, so before
# the probe its exit status WAS the entrypoint's and any cap_drop became a boot
# loop. The combined grant means a drop of either capability takes the same
# fallback: both caps are withheld rather than a half-armed server.
OUT="$(run_entrypoint --cap-drop=KILL -e PAPERCLIP_AGENT_UID=1001)"; RC=$?
[ "$RC" -eq 0 ] && ok "cap_drop=KILL: entrypoint still starts the server" || no "cap_drop=KILL: entrypoint exited $RC -- a hardening flag must not be an outage"
grep -q 'UIDLINE=1000' <<<"$OUT" && ok "cap_drop=KILL: falls back to the gosu path at uid 1000" || no "cap_drop=KILL: wrong owner -- $(grep -o 'UIDLINE=.*' <<<"$OUT")"
grep -q 'CAPAMB=0000000000000000' <<<"$OUT" && ok "cap_drop=KILL: no ambient capability is claimed" || no "cap_drop=KILL: unexpected ambient set -- $(grep -o 'CAPAMB=[0-9a-f]*' <<<"$OUT")"
grep -q 'CROSS_UID_CHMOD=FAIL' <<<"$OUT" && ok "cap_drop=KILL: cross-uid chmod correctly denied without the grant" || no "cap_drop=KILL: cross-uid chmod was not denied -- $(grep -o 'CROSS_UID_CHMOD=.*' <<<"$OUT")"
# A silent degrade is worse than the outage it replaced: nothing else reports
# that timeouts and provision-chmods have stopped working.
grep -q 'CAP_KILL/CAP_FOWNER could not be granted' <<<"$OUT" && ok "cap_drop=KILL: the degrade is announced" || no "cap_drop=KILL: degraded silently"
grep -q 'Operation not permitted' <<<"$OUT" && ok "cap_drop=KILL: the warning carries the kernel's reason" || no "cap_drop=KILL: warning does not say why"

# The FOWNER half of the same runtime-trim branch: dropping FOWNER alone must
# take the same fallback, not boot a half-armed server.
OUT="$(run_entrypoint --cap-drop=FOWNER -e PAPERCLIP_AGENT_UID=1001)"; RC=$?
[ "$RC" -eq 0 ] && ok "cap_drop=FOWNER: entrypoint still starts the server" || no "cap_drop=FOWNER: entrypoint exited $RC -- a hardening flag must not be an outage"
grep -q 'UIDLINE=1000' <<<"$OUT" && ok "cap_drop=FOWNER: falls back to the gosu path at uid 1000" || no "cap_drop=FOWNER: wrong owner -- $(grep -o 'UIDLINE=.*' <<<"$OUT")"
grep -q 'CAPAMB=0000000000000000' <<<"$OUT" && ok "cap_drop=FOWNER: no ambient capability is claimed" || no "cap_drop=FOWNER: unexpected ambient set -- $(grep -o 'CAPAMB=[0-9a-f]*' <<<"$OUT")"
grep -q 'CAP_KILL/CAP_FOWNER could not be granted' <<<"$OUT" && ok "cap_drop=FOWNER: the degrade is announced" || no "cap_drop=FOWNER: degraded silently"

# --- 3. An unusable capsh takes the same branch -----------------------------
OUT="$(run_entrypoint --cap-drop=KILL -v "$STUB_DIR/capsh:/usr/sbin/capsh:ro" -e PAPERCLIP_AGENT_UID=1001)"; RC=$?
[ "$RC" -eq 0 ] && ok "capsh unusable: entrypoint still starts the server" || no "capsh unusable: entrypoint exited $RC"
grep -q 'CAP_KILL/CAP_FOWNER could not be granted' <<<"$OUT" && ok "capsh unusable: the degrade is announced" || no "capsh unusable: degraded silently"

# --- 4. Unarmed is byte-for-byte the old behaviour --------------------------
OUT="$(run_entrypoint)"; RC=$?
[ "$RC" -eq 0 ] && ok "unarmed: entrypoint starts" || no "unarmed: exit $RC"
grep -q 'CAPAMB=0000000000000000' <<<"$OUT" && ok "unarmed: no capability is granted" || no "unarmed: capability granted without the uid split -- $(grep -o 'CAPAMB=[0-9a-f]*' <<<"$OUT")"
grep -q 'CAP_KILL' <<<"$OUT" && no "unarmed: warns about a capability it never wanted" || ok "unarmed: silent, as before"
# Negative control for section 1's positive: a plain uid-1000 server cannot
# chmod an agent-owned file. If this starts passing, the grant leaked.
grep -q 'CROSS_UID_CHMOD=FAIL' <<<"$OUT" \
  && ok "unarmed: plain uid 1000 cannot chmod an agent-owned file (baseline holds)" \
  || no "unarmed: cross-uid chmod unexpectedly succeeded -- $(grep -o 'CROSS_UID_CHMOD=.*' <<<"$OUT")"

# --- 5. The grant does not reach the agent uid ------------------------------
# The security property (SUP-14152's narrowing). execve of a setuid binary
# clears the ambient set, so a runtime spawned through the shim must land with
# nothing — CAP_KILL, CAP_FOWNER and everything else. If this ever fails,
# agents can signal the server and pid 1, and can chmod server-owned files.
AGENT_OUT="$(docker run --rm -v "$EP:/tmp/ep.sh:ro" -e PAPERCLIP_AGENT_UID=1001 --entrypoint /bin/sh "$IMAGE" \
  /tmp/ep.sh /usr/local/sbin/paperclip-spawn-agent sh -c \
  'echo "UID=$(id -u)"; sed -n "s/^CapEff:[[:space:]]*/CAPEFF=/p;s/^CapAmb:[[:space:]]*/CAPAMB=/p" /proc/self/status' 2>&1)"
grep -q 'UID=1001' <<<"$AGENT_OUT" && ok "agent lands on the agent uid" || no "agent uid wrong -- $(grep -o 'UID=[0-9]*' <<<"$AGENT_OUT")"
grep -q 'CAPEFF=0000000000000000' <<<"$AGENT_OUT" && grep -q 'CAPAMB=0000000000000000' <<<"$AGENT_OUT" \
  && ok "agent inherits NO capabilities through the setuid shim" \
  || no "capabilities leaked to the agent uid -- $(grep -o 'CAP[EA][FM][FB]=[0-9a-f]*' <<<"$AGENT_OUT" | tr '\n' ' ')"

# --- 6. Mixed-ownership worktree normalisation ------------------------------
# A worktree holding 1001-owned files is the state SUP-13977's EPERM arrives
# in. Running the armed entrypoint over it must chown the whole tree to
# 1000:<agents> while setgid directory modes survive unchanged. The fixture is
# built INSIDE the container (as root) so the test never needs a root host.
# The probe is written to a file so its $() commands run inside the container,
# not on the host.
NORM_FIXTURE='
set -e
WTR=/paperclip/instances/default/projects/p1/w1/paperclip/.paperclip/worktrees/SUP-mixed
mkdir -p "$WTR/sub" "$WTR/node_modules/.bin" "$WTR/agent-sgdir"
printf "agent-owned\n" >"$WTR/node_modules/.bin/some-bin"
chown -R 1001:1002 "$WTR"
chmod 2775 "$WTR" "$WTR/sub"
chown 1000:1002 "$WTR"
chown 1001:1002 "$WTR/agent-sgdir"
chmod 2770 "$WTR/agent-sgdir"
cat >/tmp/norm-probe.sh <<'"'"'PROBE_EOF'"'"'
echo "FILE=$(stat -c %u:%g /paperclip/instances/default/projects/p1/w1/paperclip/.paperclip/worktrees/SUP-mixed/node_modules/.bin/some-bin)"
echo "ROOT=$(stat -c %u:%g /paperclip/instances/default/projects/p1/w1/paperclip/.paperclip/worktrees/SUP-mixed)"
echo "MODE_SUB=$(stat -c %a /paperclip/instances/default/projects/p1/w1/paperclip/.paperclip/worktrees/SUP-mixed/sub)"
echo "MODE_SG=$(stat -c %a /paperclip/instances/default/projects/p1/w1/paperclip/.paperclip/worktrees/SUP-mixed/agent-sgdir)"
echo "MARKER=$(test -f /paperclip/.paperclip-worktree-normalise.done && echo yes || echo no)"
PROBE_EOF
exec /tmp/ep.sh /bin/sh /tmp/norm-probe.sh
'
NORM_OUT="$(docker run --rm -v "$EP:/tmp/ep.sh:ro" -e PAPERCLIP_AGENT_UID=1001 --entrypoint /bin/sh "$IMAGE" -c "$NORM_FIXTURE" 2>&1)"; RC=$?
[ "$RC" -eq 0 ] && ok "normalise: armed entrypoint starts" || no "normalise: exit $RC"
grep -q 'FILE=1000:1002' <<<"$NORM_OUT" \
  && ok "normalise: agent-owned file becomes 1000:1002" \
  || no "normalise: agent-owned file not normalised -- $(grep -o 'FILE=.*' <<<"$NORM_OUT")"
grep -q 'ROOT=1000:1002' <<<"$NORM_OUT" && ok "normalise: worktree root stays 1000:1002" || no "normalise: root wrong -- $(grep -o 'ROOT=.*' <<<"$NORM_OUT")"
grep -q 'MODE_SUB=2775' <<<"$NORM_OUT" && ok "normalise: setgid 2775 directory survives unchanged" || no "normalise: setgid 2775 damaged -- $(grep -o 'MODE_SUB=.*' <<<"$NORM_OUT")"
grep -q 'MODE_SG=2770' <<<"$NORM_OUT" && ok "normalise: setgid 2770 agent-owned directory survives unchanged" || no "normalise: setgid 2770 damaged -- $(grep -o 'MODE_SG=.*' <<<"$NORM_OUT")"
grep -q 'MARKER=yes' <<<"$NORM_OUT" \
  && ok "normalise: completion marker is written after a full pass" \
  || no "normalise: completion marker missing -- $(grep -o 'MARKER=.*' <<<"$NORM_OUT")"

# The pass must be gated on the uid split: unarmed, a mixed worktree is left
# exactly as found, so the same-uid deployment is never force-chowned.
NORM_OUT="$(docker run --rm -v "$EP:/tmp/ep.sh:ro" --entrypoint /bin/sh "$IMAGE" -c "$NORM_FIXTURE" 2>&1)"; RC=$?
[ "$RC" -eq 0 ] && ok "normalise (unarmed): entrypoint starts" || no "normalise (unarmed): exit $RC"
grep -q 'FILE=1001:1002' <<<"$NORM_OUT" \
  && ok "normalise (unarmed): mixed worktree is left untouched without the split" \
  || no "normalise (unarmed): worktree was chowned without the split -- $(grep -o 'FILE=.*' <<<"$NORM_OUT")"

# --- 7. The pass is one-time, marker-gated across boots ----------------------
# Two armed boots sharing one $home_dir volume: the first boot normalises and
# writes the marker; the second boot re-mixes the tree and the marker must
# hold — a post-marker mixed file is left for the CAP_FOWNER grant to cover,
# not re-chowned. Exercises the real glob, real chown, and real marker path.
NORM_OUT="$(docker run --rm -v "$VOL_DIR:/paperclip" -v "$EP:/tmp/ep.sh:ro" -e PAPERCLIP_AGENT_UID=1001 --entrypoint /bin/sh "$IMAGE" -c "$NORM_FIXTURE" 2>&1)"; RC=$?
[ "$RC" -eq 0 ] && ok "one-time (first boot): entrypoint starts" || no "one-time (first boot): exit $RC"
grep -q 'FILE=1000:1002' <<<"$NORM_OUT" \
  && ok "one-time (first boot): mixed tree is normalised" \
  || no "one-time (first boot): not normalised -- $(grep -o 'FILE=.*' <<<"$NORM_OUT")"
grep -q 'MARKER=yes' <<<"$NORM_OUT" && ok "one-time (first boot): marker present on the volume" || no "one-time (first boot): marker missing"

NORM_OUT="$(docker run --rm -v "$VOL_DIR:/paperclip" -v "$EP:/tmp/ep.sh:ro" -e PAPERCLIP_AGENT_UID=1001 --entrypoint /bin/sh "$IMAGE" -c "$NORM_FIXTURE" 2>&1)"; RC=$?
[ "$RC" -eq 0 ] && ok "one-time (second boot): entrypoint starts" || no "one-time (second boot): exit $RC"
grep -q 'FILE=1001:1002' <<<"$NORM_OUT" \
  && ok "one-time (second boot): marker gate holds — post-marker mixed files are not re-chowned" \
  || no "one-time (second boot): re-chowned despite marker -- $(grep -o 'FILE=.*' <<<"$NORM_OUT")"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
