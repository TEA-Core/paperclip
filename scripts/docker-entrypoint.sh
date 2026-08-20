#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Without root we can neither remap the node user (usermod/groupmod/chown)
# nor switch users (gosu needs CAP_SETUID/CAP_SETGID), so exec directly.
# This covers Kubernetes restricted PodSecurity (runAsNonRoot + runAsUser)
# as well as platforms that assign arbitrary UIDs (e.g. OpenShift); for the
# latter a UID/GID mismatch is unfixable here, so warn instead of letting
# usermod fail cryptically and keep volume-permission issues diagnosable.
if [ "$(id -u)" -ne 0 ]; then
    if [ "$(id -u)" -ne "$PUID" ] || [ "$(id -g)" -ne "$PGID" ]; then
        echo "docker-entrypoint.sh: running unprivileged as $(id -u):$(id -g); cannot remap to requested ${PUID}:${PGID}" >&2
    fi
    umask 002
    exec "$@"
fi

# Adjust the node user's UID/GID if they differ from the runtime request
if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
fi

# Ensure the app home is owned by the runtime user BEFORE dropping
# privileges -- not only after a UID/GID remap. A freshly mounted volume
# (Docker named volume, Railway volume, Kubernetes PV) arrives root-owned
# and shadows the image's build-time chown, so with the default UID the old
# remap-only condition dropped privileges onto an unwritable home and the
# server crashed on its first mkdir.
#
# FORK DIVERGENCE -- do not re-adopt upstream's whole-tree repair on merge.
# Upstream probes the WHOLE tree for `! -user node -o ! -group node` and then
# runs `chown -R node:node "$home_dir"`. That is right for a plain volume and
# wrong here, because this fork's PAPERCLIP_HOME deliberately contains:
#
#   - read-only bind mounts (vaults, skills-lib). chown returns non-zero on
#     them and, under `set -e`, kills the entrypoint before the server ever
#     listens -- a total outage, not a degraded boot. Measured 2026-08-15:
#     the deploy of fold-de08d947e never reached /api/health and was rolled
#     back at gate 2 for exactly this reason;
#   - directories group-owned by `agents` (see shared-group-ownership.ts).
#     `chown -R node:node` strips that group fork-wide and silently dismantles
#     shared agent access. The probe trips on those directories in ~5s, so this
#     fires on every boot, not in some rare edge case;
#   - a root-owned shared toolchain (/paperclip/toolchain) that agents read but
#     must NOT be able to write. Chowning it to node makes it agent-writable;
#   - a large host-managed workspaces bind, where a recursive walk is costly.
#
# A freshly mounted volume is empty, so repairing the home root alone is
# sufficient: everything beneath it is created by the server as node. That is
# one stat instead of a full-tree walk, and it touches nothing that the fork
# owns deliberately.
home_dir="${PAPERCLIP_HOME:-/paperclip}"
if [ -d "$home_dir" ] && [ "$(stat -c %u "$home_dir")" != "$(id -u node)" ]; then
    echo "docker-entrypoint.sh: repairing ownership of $home_dir root"
    chown node "$home_dir"
fi

# Root-own the secrets directory so agent runs (uid 1000) can neither read nor
# write it. DAC cannot distinguish the server from agents — both run uid 1000 —
# so the key is handed to the server via the environment (exported below) BEFORE
# privileges drop to node.
install -d -m 0700 -o root -g root /etc/paperclip/secrets

# First-boot key bootstrap: when no key file exists and the operator has
# explicitly opted in via PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION=1, generate
# 32 random bytes base64 as root and write master.key with root:root 0600.
# This runs in the root phase so the write succeeds — the directory is
# root-owned 0700, and uid-1000 agent runs (which share the server's UID)
# cannot create or replace the key themselves. The server's own generation
# path (local-encrypted-provider.ts) is unreachable after the gosu drop
# because the directory is unwritable by uid 1000.
#
# Format must match the provider: randomBytes(32).toString("base64"),
# which decodeMasterKey trims + base64-decodes + requires to be 32 bytes.
# `head -c 32 /dev/urandom | base64` produces the same shape.
if [ ! -f /etc/paperclip/secrets/master.key ] && [ "${PAPERCLIP_SECRETS_ALLOW_KEY_GENERATION:-0}" = "1" ] && [ -z "${PAPERCLIP_SECRETS_MASTER_KEY:-}" ]; then
    head -c 32 /dev/urandom | base64 > /etc/paperclip/secrets/master.key
    chown root:root /etc/paperclip/secrets/master.key
    chmod 0600 /etc/paperclip/secrets/master.key
fi

if [ -z "${PAPERCLIP_SECRETS_MASTER_KEY:-}" ] && [ -f /etc/paperclip/secrets/master.key ]; then
    chown root:root /etc/paperclip/secrets/master.key
    chmod 0600 /etc/paperclip/secrets/master.key
    # Hand the master key to the server before the gosu drop. NEVER echo it;
    # this entrypoint must never run under `set -x`.
    PAPERCLIP_SECRETS_MASTER_KEY="$(cat /etc/paperclip/secrets/master.key)"
    export PAPERCLIP_SECRETS_MASTER_KEY
elif [ -n "${PAPERCLIP_SECRETS_MASTER_KEY:-}" ] && [ -f /etc/paperclip/secrets/master.key ]; then
    env_fp="$(printf '%s' "$PAPERCLIP_SECRETS_MASTER_KEY" | sha256sum | cut -c1-12)"
    file_fp="$(printf '%s' "$(cat /etc/paperclip/secrets/master.key)" | sha256sum | cut -c1-12)"
    if [ "$env_fp" != "$file_fp" ]; then
        echo "docker-entrypoint.sh: warning: PAPERCLIP_SECRETS_MASTER_KEY env key differs from master.key file (env=${env_fp} file=${file_fp}); using env key" >&2
    fi
fi

# Populate the npm-global volume with the self-contained MCP server tree.
# The build stage (Dockerfile) ran `npm pack` + `npm install --global --omit=dev
# --prefix /opt/paperclip-mcp`, producing a fully-resolved node_modules tree
# with @modelcontextprotocol/sdk, zod, and @paperclipai/shared. The runtime
# prefix at /paperclip/.npm-global is a mounted volume and therefore empty on
# first start, so we copy the build-time tree into it. The two packages are
# atomic — the mcp-server built at this commit depends on shared symbols that
# only exist in the shared build at this same commit.
MCP_PREFIX=/opt/paperclip-mcp
NPM_GLOBAL=/paperclip/.npm-global

if [ -d "$MCP_PREFIX/lib/node_modules/@paperclipai/mcp-server" ]; then
    echo "docker-entrypoint.sh: refreshing MCP server packages in npm-global prefix..."
    gosu node sh -c '
        mkdir -p "$2"
        cp -a "$1/." "$2/"
        echo "docker-entrypoint.sh: MCP server packages refreshed"
    ' -- "$MCP_PREFIX" "$NPM_GLOBAL"
fi

umask 002

# Give the server CAP_KILL when the agent-uid split is armed.
#
# With PAPERCLIP_AGENT_UID set, agent runtimes are spawned as a DIFFERENT uid
# through the setuid shim (/usr/local/sbin/paperclip-spawn-agent). The server
# runs as plain uid 1000 with an empty capability set, so it can CREATE those
# children but can never SIGNAL them: every kill(2) returns EPERM. That is not
# a cosmetic failure — it defeats the whole run-timeout path. The kill error
# arrives as an `error` event on an already-running child, which reports a
# signalling failure as "Failed to start command", records adapter_failed with
# timeout_fired: false instead of timed_out, and leaves the runtime executing
# unattended with nothing able to reap it.
#
# CAP_KILL is the narrowest fix available. The property the setuid spawn shim
# exists to protect is a FILESYSTEM one — uid 1001 must not read the root-owned
# secrets master key. CAP_KILL grants signalling only and cannot read a file,
# so it is orthogonal to that boundary rather than a weakening of it. The
# alternative, a second setuid-root helper that signals on the server's behalf,
# would need exactly-correct validation of target uid, provenance and signal
# set; CAP_KILL is kernel-enforced with no argument parsing to get wrong and
# needs zero changes to the kill path.
#
# Raised as an AMBIENT capability so it survives the setuid drop to node and is
# held by the server process itself. The privilege does NOT flow back down to
# agents: the kernel clears the ambient set on execve of a setuid binary, so
# every runtime spawned through the shim lands at uid 1001 with CapPrm/CapEff/
# CapAmb all zero (verified in-container). The asymmetry is the point — the
# server can signal agents, agents cannot signal anything.
#
# cap_kill is already in the container's bounding set (CapBnd 00000000a80425fb
# under stock Docker), so no compose `cap_add` is required. Accepted cost: the
# server can now signal any process in the container, pid 1 included.
#
# `sh -c 'exec "$@"' --` re-execs the original argv with no shell left in the
# middle, so the server keeps the same process shape it has under gosu and tini
# still reaps it directly.
#
# PROBE THE GRANT, NOT THE BINARY. `command -v capsh` proves only that the file
# exists. The grant additionally needs cap_kill in the container's BOUNDING set,
# which is a property of the runtime and not of the image: under
# `cap_drop: [KILL]`, a restricted Kubernetes PodSecurity profile, or any
# runtime that trims the default set, `--inh=cap_kill` fails with
#
#   Unable to set inheritable capabilities: Operation not permitted
#
# and capsh exits 1. Because the real invocation is `exec`ed, that exit status
# IS the entrypoint's, so a flag whose only intent was to REMOVE a privilege
# would instead put the server into a boot loop and take the deployment down.
# That is the same failure class as the whole-tree chown above, which never
# reached /api/health on 2026-08-15 and had to be rolled back at gate 2.
#
# So: run the exact same option vector in a subshell first and only exec it if
# it succeeded. One extra fork at boot converts an outage into a documented
# degrade back to the gosu path — the server then behaves exactly as it did
# before CAP_KILL existed, which is survivable, unlike not starting.
#
# A missing capsh takes the same branch (127 from the shell), so one probe
# covers both causes and the captured stderr names which one it was.
if [ -n "${PAPERCLIP_AGENT_UID:-}" ]; then
    if cap_probe_err="$(capsh --keep=1 --user=node --inh=cap_kill --addamb=cap_kill \
        --shell=/bin/sh -- -c 'exit 0' 2>&1)"; then
        exec capsh --keep=1 --user=node --inh=cap_kill --addamb=cap_kill \
            --shell=/bin/sh -- -c 'exec "$@"' -- "$@"
    fi
    echo "docker-entrypoint.sh: warning: PAPERCLIP_AGENT_UID is set but CAP_KILL could not be granted (${cap_probe_err:-capsh unavailable}). Starting without it: the server cannot signal agent processes, so run timeouts will fail with EPERM and leave runtimes orphaned. Restore the KILL capability to fix this." >&2
fi

exec gosu node "$@"
