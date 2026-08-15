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
# server crashed on its first mkdir. The probe is a first-mismatch find
# over the WHOLE tree (uid and gid): a root-owned mount or descendant
# (init containers, backup restores, files written before a remap) is
# found immediately and repaired recursively, a GID-only remap is caught,
# and a fully-correct tree costs one metadata-only walk with no chown.
home_dir="${PAPERCLIP_HOME:-/paperclip}"
if [ -d "$home_dir" ] && [ -n "$(find "$home_dir" \( ! -user node -o ! -group node \) -print -quit 2>/dev/null)" ]; then
    chown -R node:node "$home_dir"
fi

# Pre-create the secrets key directory with paperclip-user ownership.
# The server's local-encrypted provider writes /etc/paperclip/secrets/master.key
# at startup; this directory is outside the agent-visible volume and must exist.
mkdir -p /etc/paperclip/secrets
chown node:node /etc/paperclip/secrets

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
exec gosu node "$@"
