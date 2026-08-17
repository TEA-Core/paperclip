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

# Absent-key arm: when no master.key exists and the operator has opted in via
# PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION=1, the entrypoint's root phase must
# generate one as root:root 0600 — not leave it absent, and not create it as
# node. This is the first-boot bootstrap that SUP-12904's root-ownership
# change removed from the server's reach.
#
# We remove the existing key, run the entrypoint with the flag, and verify
# generation. Then we remove the key again and run without the flag to verify
# no generation occurs. Finally we restore the expected key for the probe
# phase below.
rm -f "$KEY"
PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION=1 \
    docker-entrypoint.sh true 2>/dev/null || true

if [ ! -f "$KEY" ]; then
    echo "FAIL: entrypoint did not generate master.key with ALLOW_KEY_GENERATION=1"
    exit 1
fi
absent_key_state="$(stat -c '%u %g %a' "$KEY")"
if [ "$absent_key_state" != "0 0 600" ]; then
    echo "FAIL: generated $KEY is '$absent_key_state' (uid gid mode), want '0 0 600'"
    exit 1
fi
echo "PASS: entrypoint generated master.key as root:root 0600 on first boot with ALLOW_KEY_GENERATION=1"

# Flag-unset case: no key file, no generation. The entrypoint must leave the
# directory keyless and not export anything.
rm -f "$KEY"
docker-entrypoint.sh true 2>/dev/null || true
if [ -f "$KEY" ]; then
    echo "FAIL: entrypoint generated master.key without ALLOW_KEY_GENERATION=1"
    exit 1
fi
echo "PASS: entrypoint did not generate master.key when ALLOW_KEY_GENERATION is unset"

# --- Env-wins matrix (SUP-13129) ---
# Precedence: env key > file key > (opt-in) generated key.
# Each case runs the entrypoint with a probe as "$@" that prints only the
# sha256 digest of the key the server received — never the key material.
ENV_KEY="env-master-key-do-not-mint"
ENV_FP="$(printf '%s' "$ENV_KEY" | sha256sum | cut -c1-12)"

# Case 1: env set + file present, differing — server must receive env key;
#         disagreement warning with two 12-hex fingerprints logged to stderr.
printf '%s' "$EXPECTED_KEY" > "$KEY"
chown root:root "$KEY"
chmod 0600 "$KEY"
case1_err="$(PAPERCLIP_SECRETS_MASTER_KEY="$ENV_KEY" docker-entrypoint.sh sh -c 'printf "%s" "${PAPERCLIP_SECRETS_MASTER_KEY:-}" | sha256sum | cut -c1-12' 2>&1 >/dev/null || true)"
case1_out="$(PAPERCLIP_SECRETS_MASTER_KEY="$ENV_KEY" docker-entrypoint.sh sh -c 'printf "%s" "${PAPERCLIP_SECRETS_MASTER_KEY:-}" | sha256sum | cut -c1-12' 2>/dev/null || true)"
if [ "$case1_out" != "$ENV_FP" ]; then
    echo "FAIL: env-set + file-present — server received digest '$case1_out', want env digest '$ENV_FP'"
    exit 1
fi
if ! printf '%s' "$case1_err" | grep -q "differs from master.key"; then
    echo "FAIL: env-set + file-present — no disagreement warning on stderr"
    exit 1
fi
if ! printf '%s' "$case1_err" | grep -q "$ENV_FP"; then
    echo "FAIL: env-set + file-present — warning missing env fingerprint '$ENV_FP'"
    exit 1
fi
file_fp="$(sha256sum "$KEY" | cut -c1-12)"
if ! printf '%s' "$case1_err" | grep -q "$file_fp"; then
    echo "FAIL: env-set + file-present — warning missing file fingerprint '$file_fp'"
    exit 1
fi
echo "PASS: env-set + file-present — server received env key; disagreement warning with env=${ENV_FP} file=${file_fp}"

# Case 2: env set + no file + ALLOW_KEY_GENERATION=1 — no file created;
#         server receives env key.
rm -f "$KEY"
case2_out="$(PAPERCLIP_SECRETS_MASTER_KEY="$ENV_KEY" PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION=1 \
    docker-entrypoint.sh sh -c 'printf "%s" "${PAPERCLIP_SECRETS_MASTER_KEY:-}" | sha256sum | cut -c1-12' 2>/dev/null || true)"
if [ "$case2_out" != "$ENV_FP" ]; then
    echo "FAIL: env-set + no-file + generation — server received digest '$case2_out', want env digest '$ENV_FP'"
    exit 1
fi
if [ -f "$KEY" ]; then
    echo "FAIL: env-set + no-file + generation — entrypoint created master.key despite env key being set"
    exit 1
fi
echo "PASS: env-set + no-file + generation — no file created; server received env key"

# Case 3: no env + file present — server receives file key (unchanged).
printf '%s' "$EXPECTED_KEY" > "$KEY"
chown root:root "$KEY"
chmod 0600 "$KEY"
case3_out="$(docker-entrypoint.sh sh -c 'printf "%s" "${PAPERCLIP_SECRETS_MASTER_KEY:-}" | sha256sum | cut -c1-12' 2>/dev/null || true)"
file_fp="$(sha256sum "$KEY" | cut -c1-12)"
if [ "$case3_out" != "$file_fp" ]; then
    echo "FAIL: no-env + file-present — server received digest '$case3_out', want file digest '$file_fp'"
    exit 1
fi
echo "PASS: no-env + file-present — server received file key"

# Restore the expected key for the probe phase.
printf '%s' "$EXPECTED_KEY" > "$KEY"
chown root:root "$KEY"
chmod 0600 "$KEY"

# Hand over to the real entrypoint so the probe phase runs as node (uid 1000),
# with the key exported the way the server receives it. `/bin/sh "$0"` keeps this
# working when the script is bind-mounted without an executable bit.
exec docker-entrypoint.sh /bin/sh "$0" probe
