# syntax=docker/dockerfile:1.20
FROM node:lts-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl gh git wget ripgrep python3 \
  # Agents run as an unprivileged user with no sudo, so anything they need at
  # runtime has to be baked in here — they cannot apt-get install it themselves.
  # Process and network inspection: agents manage background dev servers.
  && apt-get install -y --no-install-recommends procps iproute2 lsof dnsutils \
  # Archive, patch, and file inspection.
  && apt-get install -y --no-install-recommends unzip zip xz-utils patch diffutils less file tree bsdextrautils gnupg gettext-base \
  # node-gyp toolchain: worktree provisioning runs pnpm install at runtime and
  # transitive native deps need make/g++/python3 present in the shipped image.
  && apt-get install -y --no-install-recommends make g++ pkg-config \
  # Database clients: sqlite3 for local D1 state, psql for Supabase/Postgres.
  && apt-get install -y --no-install-recommends sqlite3 postgresql-client \
  # Python tooling: python3 alone cannot install anything (PEP 668 on trixie).
  && apt-get install -y --no-install-recommends python3-pip python3-venv \
  && apt-get install -y --no-install-recommends shellcheck \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Modify the existing node user/group to have the specified UID/GID to match host user
RUN usermod -u $USER_UID --non-unique node \
  && groupmod -g $USER_GID --non-unique node \
  && usermod -g $USER_GID -d /paperclip node

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/google-sheets-mcp-server/package.json packages/google-sheets-mcp-server/
COPY packages/kv-demo-mcp-server/package.json packages/kv-demo-mcp-server/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/skills-catalog/package.json packages/skills-catalog/
COPY packages/teams-catalog/package.json packages/teams-catalog/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-cloud/package.json packages/adapters/cursor-cloud/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/grok-local/package.json packages/adapters/grok-local/
COPY packages/adapters/hermes/package.json packages/adapters/hermes/
COPY packages/adapters/hermes-gateway/package.json packages/adapters/hermes-gateway/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY packages/plugins/plugin-llm-wiki/package.json packages/plugins/plugin-llm-wiki/
COPY packages/plugins/plugin-workspace-diff/package.json packages/plugins/plugin-workspace-diff/
COPY patches/ patches/
COPY scripts/link-plugin-dev-sdk.mjs scripts/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)
# Bundled plugins declare their entrypoints as build outputs under a gitignored dist/.
# Without this, every image ships them unbuilt and activation fails on a package that
# never changed. The script builds each one and verifies every declared entrypoint,
# failing the image build rather than the running instance. It runs after the SDK build
# above because each plugin's prebuild depends on the SDK's output.
RUN node scripts/build-bundled-plugins.mjs

# Both packages declare "files": ["dist"], so they must be compiled before
# npm pack or the tarballs ship a package.json with no code behind it.
RUN pnpm --filter @paperclipai/shared build
RUN pnpm --filter @paperclipai/mcp-server build
RUN test -f packages/mcp-server/dist/stdio.js || (echo "ERROR: mcp-server build output missing" && exit 1)

# Pack both MCP workspace packages into tarballs, then apply publishConfig
# by hand (npm pack does NOT apply it — only npm publish does) and pin
# @paperclipai/shared via a file: tarball path so the local build is used
# rather than a stale registry version.
RUN mkdir -p /opt/paperclip-mcp /opt/paperclip-mcp-tarballs \
  && cd packages/shared && npm pack --pack-destination /opt/paperclip-mcp-tarballs && cd /app \
  && cd packages/mcp-server && npm pack --pack-destination /opt/paperclip-mcp-tarballs && cd /app \
  && node -e '\
    const { readFileSync, writeFileSync } = require("fs"); \
    const { execSync } = require("child_process"); \
    const { join } = require("path"); \
    const dir = "/opt/paperclip-mcp-tarballs"; \
    ["shared", "mcp-server"].forEach(name => { \
      const tgz = execSync("ls " + dir + "/paperclipai-" + name + "-*.tgz").toString().trim(); \
      execSync("tar xzf " + tgz + " -C " + dir); \
      const pkg = JSON.parse(readFileSync(dir + "/package/package.json", "utf8")); \
      if (pkg.publishConfig) { \
        for (const k of ["exports","main","types","bin"]) \
          if (pkg.publishConfig[k]) pkg[k] = pkg.publishConfig[k]; \
      } \
      if (name === "mcp-server" && pkg.dependencies && pkg.dependencies["@paperclipai/shared"]) { \
        const sharedTgz = execSync("ls " + dir + "/paperclipai-shared-*.tgz").toString().trim(); \
        pkg.dependencies["@paperclipai/shared"] = "file:" + sharedTgz; \
      } \
      writeFileSync(dir + "/package/package.json", JSON.stringify(pkg, null, 2) + "\n"); \
      execSync("tar czf " + tgz + " -C " + dir + " package"); \
      execSync("rm -rf " + dir + "/package"); \
    }); \
  ' \
  && npm install --global --omit=dev --prefix /opt/paperclip-mcp \
     /opt/paperclip-mcp-tarballs/paperclipai-mcp-server-*.tgz \
  && rm -rf /opt/paperclip-mcp-tarballs

# Build-time JSON-RPC handshake: prove the installed binary starts, resolves
# its dependencies, and registers the three WorkSession tools. Fails the image
# build if the dependency tree is broken or a tool is missing.
# readConfigFromEnv() requires both PAPERCLIP_API_URL and PAPERCLIP_API_KEY and
# throws before any tool is registered, so set dummy values here to let the
# binary start during the build-only handshake. This is the build stage; the
# production stage is a separate FROM, so neither value reaches the final image.
ENV PAPERCLIP_API_URL=http://localhost:3100
ENV PAPERCLIP_API_KEY=dummy-for-build-handshake
RUN node -e '\
  const { spawn } = require("child_process"); \
  const proc = spawn("node", ["/opt/paperclip-mcp/bin/paperclip-mcp-server"], { \
    stdio: ["pipe", "pipe", "pipe"] \
  }); \
  let stderr = ""; \
  let stdout = ""; \
  proc.stderr.on("data", d => { stderr += d.toString(); }); \
  proc.stdout.on("data", d => { stdout += d.toString(); }); \
  proc.on("error", err => { console.error("handshake spawn error:", err.message); process.exit(1); }); \
  proc.on("close", code => { \
    if (stderr) { console.error("handshake stderr:", stderr); } \
    if (!stdout.includes("paperclipOpenWorkSession")) { \
      console.error("handshake FAILED: paperclipOpenWorkSession not found in tools/list"); \
      process.exit(1); \
    } \
    if (code !== 0) { console.error("handshake exit code:", code); process.exit(1); } \
    console.log("handshake PASS: paperclipOpenWorkSession present"); \
  }); \
  proc.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"test",version:"1.0.0"}}})); \
  proc.stdin.write("\n"); \
  proc.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized",params:{}})); \
  proc.stdin.write("\n"); \
  proc.stdin.write(JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list",params:{}})); \
  proc.stdin.write("\n"); \
  proc.stdin.end(); \
'

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
COPY --chown=node:node --from=build /app /app
# Self-contained MCP server tree with resolved dependencies (npm pack + install).
COPY --chown=node:node --from=build /opt/paperclip-mcp /opt/paperclip-mcp
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai @google/gemini-cli@latest supabase@latest \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client jq \
  # Chromium shared libraries. Playwright downloads its browsers into
  # $PAPERCLIP_HOME/.cache/ms-playwright, but the binaries fail to dynamically
  # link without these, so `playwright install chromium` succeeds and every
  # launch still fails. Mirrors the `deb.deps` manifest Playwright ships beside
  # its chromium and chrome-headless-shell builds.
  && apt-get install -y --no-install-recommends \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 \
    libdbus-1-3 libexpat1 libgbm1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 \
    libpango-1.0-0 libudev1 libvulkan1 libx11-6 libxcb1 libxcomposite1 \
    libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 xdg-utils \
  # Without fonts, headless screenshots render every glyph as tofu.
  && apt-get install -y --no-install-recommends fonts-liberation fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /paperclip \
  && chown node:node /paperclip

# CodeGraph CLI — agent code-exploration index (doctrine/exploration.md: CodeGraph FIRST)
RUN npm install --global --omit=dev @colbymchenry/codegraph@1.5.0

# Blacksmith CLI — `blacksmith testbox` runs agent commands inside a real GitHub
# Actions job environment. Deliberately NOT installed to /usr/local/bin: the CLI
# self-updates on every invocation, which needs a directory writable by the
# unprivileged runtime user, so it gets its own node-owned prefix on PATH.
# BLACKSMITH_INSTALL_DIR is set explicitly because the installer otherwise
# prefers ~/.local/bin, and HOME is /paperclip — a VOLUME, so a build-time write
# there would be masked by the mounted volume at runtime.
RUN mkdir -p /opt/blacksmith/bin \
  && BLACKSMITH_INSTALL_DIR=/opt/blacksmith/bin sh -c "$(curl -fsSL https://get.blacksmith.sh)" \
  && chown -R node:node /opt/blacksmith \
  # /etc/profile hard-resets PATH for login shells, discarding the ENV PATH
  # below, so the node-owned prefix alone is not reachable from every shell.
  # Symlink from /usr/local/bin (present in both login and non-login PATH);
  # self-update rewrites the target in place, so the link keeps resolving.
  && ln -sf /opt/blacksmith/bin/blacksmith /usr/local/bin/blacksmith \
  && /opt/blacksmith/bin/blacksmith --version

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Route M1 (SUP-12472 / SUP-12531): agent runtimes must land on a uid distinct
# from the server's, so an agent cannot read PAPERCLIP_SECRETS_MASTER_KEY out of
# /proc/<server-pid>/environ. The server runs at CapEff=0 and cannot change uid
# itself, so the privilege has to be here.
#
# NOTE: this only creates the principal and the shim. Nothing spawns as
# ${AGENT_UID} until SUP-12531 lands, and nothing chgrps to `agents` until
# SUP-12530 lands, so shipping this alone is a no-op at runtime.
#
# Do NOT replace the shim with `chmod 4755` on gosu: gosu self-aborts when its
# setuid bit is set (for root too), which would break `exec gosu node` in the
# entrypoint and stop the container from starting. Do NOT use
# `setcap cap_setuid+ep` on node either — that lets an agent setuid(0).
ARG AGENT_UID=1001
ARG AGENT_GID=1001
ARG AGENTS_GID=1002
# buildx injects these automatically. They let the exec probes below run only on
# a native build: under binfmt/qemu emulation (BUILDPLATFORM != TARGETPLATFORM)
# the kernel never honours the setuid bit, so the probes can never pass there.
ARG BUILDPLATFORM
ARG TARGETPLATFORM
COPY docker/agent-spawn-shim/spawn-agent.c /tmp/spawn-agent.c
RUN groupadd -g ${AGENTS_GID} agents \
  && groupadd -g ${AGENT_GID} node-agent \
  && useradd -u ${AGENT_UID} -g ${AGENT_GID} -G agents -M -d /paperclip -s /usr/sbin/nologin node-agent \
  # Both principals share `agents` so they can write the same worktrees; the
  # server needs it to chgrp new checkouts (SUP-12530).
  && usermod -aG agents node \
  && gcc -O2 -Wall -Wextra -Werror \
       -DAGENT_UID=${AGENT_UID} -DAGENT_GID=${AGENT_GID} -DAGENTS_GID=${AGENTS_GID} \
       -o /usr/local/sbin/paperclip-spawn-agent /tmp/spawn-agent.c \
  && rm -f /tmp/spawn-agent.c \
  && chown root:root /usr/local/sbin/paperclip-spawn-agent \
  && chmod 4755 /usr/local/sbin/paperclip-spawn-agent \
  # Prove the drop works in the built image rather than at first agent run.
  # A broken shim must fail the build, not present later as an agent fault.
  # These probes can only pass on a native build: under binfmt/qemu emulation
  # the setuid bit is never honoured (the non-setuid emulator is what execs),
  # so the shim's euid!=0 refusal fires and the probe would fail forever. Gate
  # them on BUILDPLATFORM == TARGETPLATFORM, and make a skipped probe
  # unmistakable — it must never read as a passed one.
  && if [ "${BUILDPLATFORM}" = "${TARGETPLATFORM}" ]; then \
       [ "$(gosu node /usr/local/sbin/paperclip-spawn-agent id -u)" = "${AGENT_UID}" ] \
       && gosu node /usr/local/sbin/paperclip-spawn-agent sh -c \
            'cat /proc/1/environ >/dev/null 2>&1 && exit 1 || exit 0'; \
     else \
       echo "SKIP paperclip-spawn-agent exec probes: BUILDPLATFORM=${BUILDPLATFORM} != TARGETPLATFORM=${TARGETPLATFORM} (setuid bit is not honoured under binfmt emulation)"; \
     fi

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  OPENCODE_ALLOW_ALL_MODELS=true \
  GEMINI_SANDBOX=false \
  PATH=/opt/blacksmith/bin:${PATH}

EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
