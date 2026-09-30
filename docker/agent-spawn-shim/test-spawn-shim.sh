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

# --- SUP-17664: the shim marks its own oom_score_adj before dropping, so the
#     whole agent tree inherits it. Five assertions that reinforce each other,
#     because a single "it reads 500" would green on an ambient default:
#       BASE      without the shim the value is 0, so 500 is never ambient
#       OOM       through the shim it is the default 500
#       BUILDARG  a build with -DAGENT_OOM_SCORE_ADJ=750 reads 750, so the value
#                 is configurable and not hardcoded
#       OFF       a build with 0 disables the mark, and 0 != the 500 default
#       TREE      a grandchild inherits it, which is the point of doing it here
#
#     BUILDARG and OFF each need their OWN binary, which is why they compile
#     again rather than reuse $SHIM: the value is fixed at compile time
#     deliberately (the shim reads no environment), so a build arg is the only
#     thing there is to vary.
echo "T_OOM_BASE<<:"; as_node                sh -c 'cat /proc/self/oom_score_adj' 2>&1; echo ":>>"
echo "T_OOM<<:";      as_node "$SHIM"        sh -c 'cat /proc/self/oom_score_adj' 2>&1; echo ":>>"
echo "T_OOM_TREE<<:"; as_node "$SHIM" sh -c 'sh -c "cat /proc/self/oom_score_adj"' 2>&1; echo ":>>"

SHIM750=/usr/local/sbin/paperclip-spawn-agent-750
gcc -O2 -Wall -Wextra -Werror -DAGENT_OOM_SCORE_ADJ=750 -o "$SHIM750" /tmp/spawn-agent.c \
  && chown root:root "$SHIM750" && chmod 4755 "$SHIM750"
echo "T_OOM_BUILDARG<<:"; as_node "$SHIM750" sh -c 'cat /proc/self/oom_score_adj' 2>&1; echo ":>>"

SHIM0=/usr/local/sbin/paperclip-spawn-agent-0
gcc -O2 -Wall -Wextra -Werror -DAGENT_OOM_SCORE_ADJ=0 -o "$SHIM0" /tmp/spawn-agent.c \
  && chown root:root "$SHIM0" && chmod 4755 "$SHIM0"
echo "T_OOM_OFF<<:"; as_node "$SHIM0" sh -c 'cat /proc/self/oom_score_adj' 2>&1; echo ":>>"

# A build arg of 0 must leave an INHERITED adjustment alone, not overwrite it with
# 0. The shim still holds euid 0 at that point, so writing 0 would LOWER a nonzero
# inherited value and make the agent tree a less likely victim than the deployment
# asked for. Raising one's own adjustment needs no privilege, so the caller can set
# 300 and exec the shim to observe what survives.
echo "T_OOM_INHERIT_OFF<<:"
as_node sh -c 'echo 300 > /proc/self/oom_score_adj && exec '"$SHIM0"' sh -c "cat /proc/self/oom_score_adj"' 2>&1
echo ":>>"
# ...while an enabled build must still override that inherited value.
echo "T_OOM_INHERIT_ON<<:"
as_node sh -c 'echo 300 > /proc/self/oom_score_adj && exec '"$SHIM"' sh -c "cat /proc/self/oom_score_adj"' 2>&1
echo ":>>"

# --- The shim lowers the agent tree's CPU priority, so a runaway agent workload
#     (a test fleet, a deliberate CPU-load reproduction) cannot starve the server
#     it shares the container with. 2026-09-30: one agent's 128 busy-loop workers
#     at the server's own priority drove the host to load 184. `nice` with no
#     arguments prints the current niceness.
#       BASE      without the shim the caller runs at 0, so 10 is never ambient
#       NICE      through the shim it is the default 10
#       TREE      a grandchild inherits it
#       BUILDARG  -DAGENT_NICE=15 reads 15, so the value is not hardcoded
#       OFF       -DAGENT_NICE=0 leaves the caller's priority alone
#       RELATIVE  a caller already at 5 lands at 15: the step is relative to the
#                 server, so agents always sit below whatever the server runs at
#       CAP       a caller already at 15 lands at 19, the kernel ceiling
#       NEG       a negative build arg is a compile error: agents must never be
#                 able to outrank the server
echo "T_NICE_BASE<<:"; as_node nice 2>&1; echo ":>>"
echo "T_NICE<<:";      as_node "$SHIM" nice 2>&1; echo ":>>"
echo "T_NICE_TREE<<:"; as_node "$SHIM" sh -c 'sh -c nice' 2>&1; echo ":>>"

SHIMN15=/usr/local/sbin/paperclip-spawn-agent-n15
gcc -O2 -Wall -Wextra -Werror -DAGENT_NICE=15 -o "$SHIMN15" /tmp/spawn-agent.c \
  && chown root:root "$SHIMN15" && chmod 4755 "$SHIMN15"
echo "T_NICE_BUILDARG<<:"; as_node "$SHIMN15" nice 2>&1; echo ":>>"

SHIMN0=/usr/local/sbin/paperclip-spawn-agent-n0
gcc -O2 -Wall -Wextra -Werror -DAGENT_NICE=0 -o "$SHIMN0" /tmp/spawn-agent.c \
  && chown root:root "$SHIMN0" && chmod 4755 "$SHIMN0"
echo "T_NICE_OFF<<:"; as_node "$SHIMN0" nice 2>&1; echo ":>>"
echo "T_NICE_RELATIVE<<:"; as_node nice -n 5 "$SHIM" nice 2>&1; echo ":>>"
echo "T_NICE_CAP<<:"; as_node nice -n 15 "$SHIM" nice 2>&1; echo ":>>"
gcc -O2 -Wall -Wextra -Werror -DAGENT_NICE=-5 -o /tmp/shim-neg /tmp/spawn-agent.c >/dev/null 2>&1; RC=$?
echo "T_NICE_NEG<<:"; echo "rc=$RC"; echo ":>>"

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

# SUP-17664. BASE is the fail-control: if the bare uid-1000 child already read
# 500, every assertion below would pass with the shim doing nothing at all.
[ "$(sec OOM_BASE)" = "0" ] \
  && ok "control: an unmarked uid-1000 child reads oom_score_adj 0" \
  || no "control void — unmarked child is not 0, so a 500 below proves nothing: $(sec OOM_BASE)"
[ "$(sec OOM)" = "500" ] \
  && ok "shim marks itself oom_score_adj 500 before dropping" \
  || no "shim did not mark itself: $(sec OOM)"
[ "$(sec OOM_BUILDARG)" = "750" ] \
  && ok "-DAGENT_OOM_SCORE_ADJ=750 is honoured (750, so the value is not hardcoded)" \
  || no "build-arg override ignored: $(sec OOM_BUILDARG)"
[ "$(sec OOM_OFF)" = "0" ] \
  && ok "-DAGENT_OOM_SCORE_ADJ=0 disables the mark (0 != the 500 default)" \
  || no "build-arg 0 did not disable the mark: $(sec OOM_OFF)"
[ "$(sec OOM_INHERIT_OFF)" = "300" ] \
  && ok "a disabled build leaves an inherited 300 untouched, rather than writing 0 over it" \
  || no "disabled build clobbered the inherited adjustment: $(sec OOM_INHERIT_OFF)"
[ "$(sec OOM_INHERIT_ON)" = "500" ] \
  && ok "an enabled build still overrides an inherited 300" \
  || no "enabled build did not override the inherited adjustment: $(sec OOM_INHERIT_ON)"
[ "$(sec OOM_TREE)" = "500" ] \
  && ok "the mark is inherited by a grandchild — the whole agent tree is covered" \
  || no "grandchild did not inherit the mark: $(sec OOM_TREE)"

# BASE is the fail-control: if the bare caller already ran at 10, every
# assertion below would pass with the shim doing nothing.
[ "$(sec NICE_BASE)" = "0" ] \
  && ok "control: an unmarked uid-1000 child runs at nice 0" \
  || no "control void — unmarked child is not at nice 0: $(sec NICE_BASE)"
[ "$(sec NICE)" = "10" ] \
  && ok "shim lowers the agent tree's CPU priority to nice 10" \
  || no "shim did not lower CPU priority: $(sec NICE)"
[ "$(sec NICE_TREE)" = "10" ] \
  && ok "the lowered priority is inherited by a grandchild" \
  || no "grandchild did not inherit the lowered priority: $(sec NICE_TREE)"
[ "$(sec NICE_BUILDARG)" = "15" ] \
  && ok "-DAGENT_NICE=15 is honoured (15, so the value is not hardcoded)" \
  || no "AGENT_NICE build arg ignored: $(sec NICE_BUILDARG)"
[ "$(sec NICE_OFF)" = "0" ] \
  && ok "-DAGENT_NICE=0 leaves the caller's priority alone" \
  || no "AGENT_NICE=0 changed the priority: $(sec NICE_OFF)"
[ "$(sec NICE_RELATIVE)" = "15" ] \
  && ok "the step is relative: a caller at nice 5 lands at 15" \
  || no "priority step is not relative to the caller: $(sec NICE_RELATIVE)"
[ "$(sec NICE_CAP)" = "19" ] \
  && ok "the step caps at the kernel ceiling: a caller at nice 15 lands at 19" \
  || no "priority step did not cap at 19: $(sec NICE_CAP)"
[ "$(sec NICE_NEG)" != "rc=0" ] \
  && ok "a negative AGENT_NICE fails to compile — agents can never outrank the server" \
  || no "a negative AGENT_NICE compiled: $(sec NICE_NEG)"

case "$(sec NOSETUID)" in
  *"not running with euid 0"*) ok "a stripped setuid bit fails loudly, no silent uid-1000 fallback" ;;
  *) no "stripped-setuid path: $(sec NOSETUID)" ;;
esac

[ "$(sec USAGE_RC)"  = "rc=64"  ] && ok "usage exits 64"          || no "usage rc: $(sec USAGE_RC)"
[ "$(sec EXEC_RC)"   = "rc=127" ] && ok "failed exec exits 127"   || no "exec rc: $(sec EXEC_RC)"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
