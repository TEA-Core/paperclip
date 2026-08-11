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

# Refresh the MCP server and its shared dependency in the npm-global prefix.
# The image builds both packages into /app/packages/<pkg>/dist/, but the MCP
# client resolves paperclip-mcp-server from /paperclip/.npm-global/, which is a
# mounted volume and therefore empty on first start. This block copies the
# image's compiled artifacts into the volume so the binary is callable.
# The two packages are atomic — the mcp-server built at this commit depends on
# shared symbols that only exist in the shared build at this same commit.
# Refreshing one without the other leaves the server broken.
MCP_SERVER_DIST=/app/packages/mcp-server/dist
SHARED_DIST=/app/packages/shared/dist
NPM_GLOBAL=/paperclip/.npm-global

if [ -f "$MCP_SERVER_DIST/stdio.js" ] && [ -f "$SHARED_DIST/index.js" ]; then
    echo "docker-entrypoint.sh: refreshing MCP server packages in npm-global prefix..."
    gosu node sh -c '
        MODULES="$1/lib/node_modules"
        mkdir -p "$MODULES/@paperclipai/shared/dist" "$MODULES/@paperclipai/mcp-server/dist" "$1/bin"

        # Copy package manifests so Node module resolution works
        cp /app/packages/shared/package.json "$MODULES/@paperclipai/shared/"
        cp /app/packages/mcp-server/package.json "$MODULES/@paperclipai/mcp-server/"

        # Overwrite the exported entrypoint in the shared package.json so
        # Node resolves "./dist/index.js" instead of "./src/index.ts"
        # (the workspace default points at TypeScript source, not the
        # compiled output that lives beside it in this prefix).
        node -e "
            const p = require(\"$MODULES/@paperclipai/shared/package.json\");
            p.exports = p.publishConfig.exports;
            p.main = void 0;
            p.types = void 0;
            require(\"fs\").writeFileSync(
                \"$MODULES/@paperclipai/shared/package.json\",
                JSON.stringify(p, null, 2) + \"\n\"
            );
        "

        # Overwrite dist/ with the image'\''s compiled artifacts
        cp -rf /app/packages/shared/dist/* "$MODULES/@paperclipai/shared/dist/"
        cp -rf /app/packages/mcp-server/dist/* "$MODULES/@paperclipai/mcp-server/dist/"

        # Symlink the bin entry so "paperclip-mcp-server" resolves
        ln -sf ../lib/node_modules/@paperclipai/mcp-server/dist/stdio.js "$1/bin/paperclip-mcp-server"

        echo "docker-entrypoint.sh: MCP server packages refreshed"
    ' -- "$NPM_GLOBAL"
fi

exec gosu node "$@"
