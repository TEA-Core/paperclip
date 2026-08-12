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
    exec "$@"
fi

# Adjust the node user's UID/GID if they differ from the runtime request
# and fix volume ownership only when a remap is needed
changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

if [ "$changed" = "1" ]; then
    chown -R node:node /paperclip
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

exec gosu node "$@"
