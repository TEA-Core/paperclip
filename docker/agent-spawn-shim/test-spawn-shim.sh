#!/usr/bin/env bash
# Property tests for paperclip-spawn-agent (SUP-12531, route M1).
#
# These run INSIDE a container, because every property under test needs a real
# uid-1001 process and a real setuid bit. That is deliberate: this whole chain
# has three prior half-landings, all of which greened on an inference or on the
# absence of a path rather than on a measured property.
#
#   docker/agent-spawn-shim/test-spawn-shim.sh            # builds a throwaway image
#   IMAGE=tea-core/paperclip:v2026.722.0-tea docker/agent-spawn-shim/test-spawn-shim.sh
#
# Nothing here touches a running deployment.
# SC2015: the `cond && ok ... || no ...` idiom is deliberate here. `ok` is a
# counter bump plus a printf and cannot fail, so the `||` branch is only ever
# reached when the condition itself is false.
# shellcheck disable=SC2015
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${IMAGE:-node:lts-trixie-slim}"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf 'ok   - %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf 'FAIL - %s\n' "$1"; }

# One container, one compile, all assertions — the properties are about a single
# built artefact, so rebuilding per case would test a different binary each time.
OUT="$(docker run --rm -i -v "$HERE/spawn-agent.c:/tmp/spawn-agent.c:ro" \
  --entrypoint bash "$IMAGE" -s <<'CONTAINER' 2>&1
set -uo pipefail

command -v gcc >/dev/null 2>&1 || apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq gcc >/dev/null 2>&1
groupadd -g 1002 agents        >/dev/null 2>&1
groupadd -g 1001 node-agent    >/dev/null 2>&1
useradd -u 1001 -g 1001 -G agents node-agent >/dev/null 2>&1
usermod -aG agents node        >/dev/null 2>&1

# Run-as-uid-1000 helper. The paperclip image ships gosu; the plain node base
# image does not, so fall back to setpriv (util-linux) and keep the test
# runnable against either.
if command -v gosu >/dev/null 2>&1; then
  as_node() { gosu node "$@"; }
elif command -v setpriv >/dev/null 2>&1; then
  as_node() { setpriv --reuid=1000 --regid=1000 --init-groups -- "$@"; }
else
  echo "NO_DROP_TOOL"; exit 1
fi

SHIM=/usr/local/sbin/paperclip-spawn-agent
gcc -O2 -Wall -Wextra -Werror -o "$SHIM" /tmp/spawn-agent.c || { echo "COMPILE_FAILED"; exit 1; }
chown root:root "$SHIM" && chmod 4755 "$SHIM"
echo "COMPILED_CLEAN"

# --- the property M1 exists for: the child lands on 1001, not the server's uid
echo "T_UID<<:"; as_node "$SHIM" id -u 2>&1; echo ":>>"
echo "T_GID<<:"; as_node "$SHIM" id -g 2>&1; echo ":>>"

# --- supplementary groups are exactly the pinned set, not the caller's
echo "T_GROUPS<<:"; as_node "$SHIM" sh -c 'grep ^Groups: /proc/self/status' 2>&1; echo ":>>"

# --- the caller cannot choose the uid: there is no argument that selects one.
#     Passing "0" just runs a command called "0".
echo "T_NOUID<<:"; as_node "$SHIM" 0 2>&1; echo ":>>"

# --- the child cannot climb back to root
cat > /tmp/climb.c <<'EOF'
#include <stdio.h>
#include <unistd.h>
int main(void) {
  printf("setuid0=%d uid=%d euid=%d\n", setuid(0), (int)getuid(), (int)geteuid());
  return 0;
}
EOF
gcc -o /tmp/climb /tmp/climb.c 2>/dev/null
echo "T_CLIMB<<:"; as_node "$SHIM" /tmp/climb 2>&1; echo ":>>"

# --- THE acceptance test for the whole chain: cross-uid /proc read is denied.
#     Run a long-lived process as uid 1000 and read its environ as uid 1001.
# The victim must genuinely BE uid 1000. Backgrounding the helper function is
# not enough: bash forks a root subshell and $! is that subshell, so the reads
# below would target a root-owned process and the control would fail for a
# reason unrelated to what is being tested. Have the dropped shell report its
# own pid, then exec into sleep so the pid is preserved.
as_node sh -c 'echo $$ > /tmp/victim.pid; exec sleep 300' &
sleep 1
VICTIM="$(cat /tmp/victim.pid 2>/dev/null)"
echo "T_VICTIM<<:"
if [ -r "/proc/$VICTIM/status" ]; then
  # Note: root itself cannot read this environ. Default Docker caps omit
  # CAP_SYS_PTRACE and /proc/<pid>/environ requires PTRACE_MODE_READ, so the
  # read succeeds only for the owning uid. That is the mechanism M1 relies on.
  echo "pid=$VICTIM owner_uid=$(awk '/^Uid:/{print $2}' "/proc/$VICTIM/status") root_read=$(cat "/proc/$VICTIM/environ" >/dev/null 2>&1 && echo ok || echo denied)"
else
  echo "VICTIM_MISSING pid=$VICTIM"
fi
echo ":>>"
echo "T_SAMEUID<<:"; as_node          sh -c "cat /proc/$VICTIM/environ >/dev/null 2>&1 && echo READ_OK || echo DENIED"; echo ":>>"
echo "T_CROSSUID<<:"; as_node "$SHIM" sh -c "cat /proc/$VICTIM/environ >/dev/null 2>&1 && echo READ_OK || echo DENIED"; echo ":>>"
kill "$VICTIM" 2>/dev/null

# --- a stripped setuid bit must fail loudly, never silently run as the caller
cp "$SHIM" /tmp/shim-nosetuid && chmod 0755 /tmp/shim-nosetuid
NOSETUID_OUT="$(as_node /tmp/shim-nosetuid id -u 2>&1)"; NOSETUID_RC=$?
echo "T_NOSETUID<<:"; echo "$NOSETUID_OUT"; echo "rc=$NOSETUID_RC"; echo ":>>"

# --- usage and exec-failure paths carry their own distinct exit codes
as_node "$SHIM" >/dev/null 2>&1; RC=$?
echo "T_USAGE_RC<<:"; echo "rc=$RC"; echo ":>>"
as_node "$SHIM" /nonexistent-cmd >/dev/null 2>&1; RC=$?
echo "T_EXEC_RC<<:"; echo "rc=$RC"; echo ":>>"
CONTAINER
)"

sec() { printf '%s' "$OUT" | sed -n "/^T_$1<<:$/,/^:>>$/p" | sed '1d;$d'; }

printf '%s' "$OUT" | grep -q COMPILED_CLEAN \
  && ok "compiles clean under -Wall -Wextra -Werror" \
  || { no "compile failed"; printf '%s\n' "$OUT" | head -30; }

[ "$(sec UID)" = "1001" ]  && ok "child lands on uid 1001"        || no "uid: got '$(sec UID)'"
[ "$(sec GID)" = "1001" ]  && ok "child lands on gid 1001"        || no "gid: got '$(sec GID)'"

# Exactly the pinned group. 1000 (the server's own group) must NOT ride through.
G="$(sec GROUPS)"
case "$G" in
  *1002*) case "$G" in
            *1000*) no "server group 1000 leaked into the agent principal: $G" ;;
            *)      ok "supplementary groups pinned to agents only ($G)" ;;
          esac ;;
  *) no "agents group missing: $G" ;;
esac

case "$(sec NOUID)" in
  *"exec 0"*|*"No such file"*) ok "no argument selects the uid — '0' is treated as a command" ;;
  *) no "uid-selection probe: $(sec NOUID)" ;;
esac

case "$(sec CLIMB)" in
  *"setuid0=-1"*) ok "child cannot regain uid 0 (saved-set-uid cleared)" ;;
  *) no "privilege climb: $(sec CLIMB)" ;;
esac

# The decisive one. Guarded: a missing victim makes BOTH reads fail, which would
# green the cross-uid assertion for entirely the wrong reason. That is the exact
# shape of the three prior half-landings, so it is an explicit failure here.
case "$(sec VICTIM)" in
  *VICTIM_MISSING*|"") no "victim process never started — decisive test is void: $(sec VICTIM)" ;;
  *owner_uid=1000*)    ok "victim is a live uid-1000 process ($(sec VICTIM))" ;;
  *) no "victim is not uid 1000, so the cross-uid result means nothing: $(sec VICTIM)" ;;
esac
[ "$(sec SAMEUID)"  = "READ_OK" ] && ok "control: same-uid /proc/<pid>/environ IS readable (gap is real)" \
                                  || no "control failed, same-uid read denied: $(sec SAMEUID)"
[ "$(sec CROSSUID)" = "DENIED"  ] && ok "DECISIVE: cross-uid /proc/<pid>/environ is DENIED from uid 1001" \
                                  || no "cross-uid read was NOT denied: $(sec CROSSUID)"

case "$(sec NOSETUID)" in
  *"not running with euid 0"*) ok "a stripped setuid bit fails loudly, no silent uid-1000 fallback" ;;
  *) no "stripped-setuid path: $(sec NOSETUID)" ;;
esac

[ "$(sec USAGE_RC)"  = "rc=64"  ] && ok "usage exits 64"          || no "usage rc: $(sec USAGE_RC)"
[ "$(sec EXEC_RC)"   = "rc=127" ] && ok "failed exec exits 127"   || no "exec rc: $(sec EXEC_RC)"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
