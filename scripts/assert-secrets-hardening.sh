#!/bin/sh
# CI probe for the /etc/paperclip/secrets hardening (SUP-12989).
#
# Why this is a script and not a set of inline `docker run -u 1000:1000` steps:
# with a non-root uid the entrypoint takes its unprivileged branch and never runs
# the root phase, so /etc/paperclip/secrets does not exist in that container at
# all. `touch` then fails with ENOENT (a pass for the wrong reason) and `rm -f`
# on a missing path exits 0 (a spurious FAIL). The invariant only exists after
# the root phase has run, so the probe has to live inside a single container that
# starts as root, seeds the vulnerable pre-state, hands over to the real
# entrypoint, and probes again after the gosu drop.
#
# Phase 1 (`seed`, the default, root, before the entrypoint): recreate the
# pre-fix state — a node-owned, world-writable secrets directory holding a
# node-owned master.key — then run the entrypoint and assert it repaired
# ownership and modes.
#
# Phase 2 (`probe`, uid 1000 after `exec gosu node`, the uid every agent run
# shares with the server): assert the key is unreadable, the directory
# unwritable and unlistable, master.key unremovable, and that the server still
# received the key value through the environment.
set -e

SECRETS_DIR=/etc/paperclip/secrets
KEY="$SECRETS_DIR/master.key"
: "${EXPECTED_KEY:?EXPECTED_KEY must be set by the caller}"

# Runs a command that must be denied. Output is captured, never the key: on the
# unexpected success path the captured stdout (which would hold key material for
# `cat`) is discarded, and only the failure message is printed.
must_fail() {
    label="$1"
    shift
    if out="$("$@" 2>&1)"; then
        echo "FAIL: $label succeeded as uid $(id -u) — agent runs can still reach the key material"
        exit 1
    fi
    echo "PASS: $label denied as uid $(id -u): $out"
}

if [ "${1:-seed}" = "probe" ]; then
    uid="$(id -u)"
    if [ "$uid" != "1000" ]; then
        echo "FAIL: probe expected uid 1000 after the gosu drop, got $uid"
        exit 1
    fi

    must_fail "read of master.key" cat "$KEY"
    must_fail "listing of $SECRETS_DIR" ls "$SECRETS_DIR"
    must_fail "create in $SECRETS_DIR" touch "$SECRETS_DIR/.probe"
    must_fail "unlink of master.key" rm -f "$KEY"

    if [ "${PAPERCLIP_SECRETS_MASTER_KEY:-}" != "$EXPECTED_KEY" ]; then
        echo "FAIL: the server did not inherit the master key across the gosu drop"
        exit 1
    fi
    echo "PASS: the server inherited PAPERCLIP_SECRETS_MASTER_KEY across the gosu drop"
    exit 0
fi

# Pre-fix state: everything under /etc/paperclip owned by node and writable by
# uid 1000, which is exactly what an agent run could tamper with before this
# change.
mkdir -p "$SECRETS_DIR"
printf '%s' "$EXPECTED_KEY" > "$KEY"
chown -R node:node /etc/paperclip
chmod 0777 "$SECRETS_DIR"
chmod 0666 "$KEY"

# Run (do not exec) the entrypoint so its root phase applies and control returns
# here, still root, with the hardening in place. `true` stands in for the server
# command; the entrypoint runs it under gosu and exits.
docker-entrypoint.sh true

dir_state="$(stat -c '%u %g %a' "$SECRETS_DIR")"
if [ "$dir_state" != "0 0 700" ]; then
    echo "FAIL: $SECRETS_DIR is '$dir_state' (uid gid mode), want '0 0 700'"
    exit 1
fi
key_state="$(stat -c '%u %g %a' "$KEY")"
if [ "$key_state" != "0 0 600" ]; then
    echo "FAIL: $KEY is '$key_state' (uid gid mode), want '0 0 600'"
    exit 1
fi
echo "PASS: entrypoint repaired node-owned secrets to root:root 0700 directory / 0600 key"

# Hand over to the real entrypoint so the probe phase runs as node (uid 1000),
# with the key exported the way the server receives it. `/bin/sh "$0"` keeps this
# working when the script is bind-mounted without an executable bit.
exec docker-entrypoint.sh /bin/sh "$0" probe
