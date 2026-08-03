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

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
COPY --chown=node:node --from=build /app /app
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai @google/gemini-cli@latest \
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
