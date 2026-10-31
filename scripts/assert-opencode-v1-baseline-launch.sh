#!/bin/sh
# Acceptance probe: baseline V1 agent launch with the V1 router plugin.
#
# Runs INSIDE a container built from the production image (docker-build-assert
# job mounts this script plus the fixture and invokes it). Proves end to end
# that the rebuilt image still:
#   1. resolves /usr/local/bin/opencode to the pinned V1 (1.19.5),
#   2. auto-loads the V1 router plugin from the agent's staged XDG config
#      (sha256-pinned fixture of the V1 router plugin with its router
#      endpoint defaults replaced by placeholders; the probe sets both router
#      URLs, see scripts/__tests__/dockerfile-opencode-pins.test.mjs),
#   3. builds the router providers from a live catalog (stub router served on
#      loopback: rules + models + OpenAI-style completions),
#   4. completes a full agent turn through the router provider as the agent
#      principal (node-agent, uid 1001) using only the image's own binaries.
#
# V1_LAUNCH_GOSU, V1_BIN and V1_FIXTURE_DIR exist only so this script can be
# validated on a harness host that has neither docker, gosu, nor a node-agent
# user; CI runs with all three unset.
set -eu

V1_BIN="${V1_BIN:-/usr/local/bin/opencode}"
V1_LAUNCH_GOSU="${V1_LAUNCH_GOSU-gosu node-agent}"
V1_FIXTURE_DIR="${V1_FIXTURE_DIR:-/v1-plugin-fixture}"
STAGE=/tmp/v1-baseline
ROUTER=http://127.0.0.1:18080

fail() { echo "[v1-baseline] FAIL: $*" >&2; exit 1; }
log() { echo "[v1-baseline] $*"; }

# 1. the unchanged V1 agent path still resolves to the pinned version
test "$(command -v opencode)" = /usr/local/bin/opencode
V1_VERSION="$($V1_BIN --version)"
test "$V1_VERSION" = "1.19.5" || fail "V1 version drifted: $V1_VERSION"
log "V1 pinned version OK: $V1_VERSION"

# 2. stage the adapter-shaped runtime config: XDG_CONFIG_HOME/opencode with
#    the V1 router plugin (auto-discovered from plugin/) and a writable agent
#    home (the adapter stages the same shape at run time).
rm -rf "$STAGE"
mkdir -p "$STAGE/config/opencode/plugin" "$STAGE/config/opencode/router-catalog" "$STAGE/home"
cp "$V1_FIXTURE_DIR/plugin/router-catalog.js" "$STAGE/config/opencode/plugin/"
cp "$V1_FIXTURE_DIR/router-catalog/lib.mjs" "$STAGE/config/opencode/router-catalog/"
cat > "$STAGE/config/opencode/opencode.json" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "permission": { "external_directory": "allow" }
}
JSON
# The agent principal must own everything it writes (opencode creates state
# under HOME and config at startup).
if getent passwd node-agent >/dev/null 2>&1; then
  chown -R node-agent:node-agent "$STAGE"
fi

# 3. loopback stub router: serves exactly the catalog endpoints the V1 router
#    plugin fetches, plus the chat-completions backend for the router provider.
cat > "$STAGE/stub-router.mjs" <<'STUB'
import http from "node:http";
const PORT = Number(process.env.STUB_ROUTER_PORT || 18080);
const RULES = {
  roles: { "coder-default": { targets: [{ provider: "stub-target", maxContextTokens: 262144 }] } },
  pools: {},
};
const MODELS = { data: [{ id: "coder", context_length: 262144, name: "coder (stub)" }] };
function sseBody(id, model, text) {
  const chunks = [
    { id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ];
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}
const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  console.log(`[stub-router] ${req.method} ${url}`);
  if (req.method === "GET" && url === "/api/rules") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(RULES));
    return;
  }
  if (req.method === "GET" && url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(MODELS));
    return;
  }
  if (req.method === "POST" && url.endsWith("/chat/completions")) {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let stream = false;
      let model = "stub";
      try {
        const parsed = JSON.parse(body || "{}");
        stream = parsed.stream === true;
        model = parsed.model || model;
      } catch {}
      if (stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sseBody(`stub-${Date.now()}`, model, "OK"));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: `stub-${Date.now()}`,
            object: "chat.completion",
            created: 0,
            model,
            choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      }
    });
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: `no stub route for ${req.method} ${url}` }));
});
server.listen(PORT, "127.0.0.1", () => console.log(`[stub-router] listening on 127.0.0.1:${PORT}`));
STUB
node "$STAGE/stub-router.mjs" > "$STAGE/stub.log" 2>&1 &
STUB_PID=$!
trap 'kill "$STUB_PID" 2>/dev/null || true' EXIT INT TERM
i=0
until curl -sf "$ROUTER/api/rules" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 50 ]; then cat "$STAGE/stub.log" >&2; fail "stub router never became ready"; fi
  sleep 0.2
done
log "stub router ready"

cd "$STAGE/home"
agent_env="HOME=$STAGE/home XDG_CONFIG_HOME=$STAGE/config XDG_CACHE_HOME=$STAGE/home/.cache PAPERCLIP_ROUTER_URL=$ROUTER PAPERCLIP_ROUTER_CONTROL_URL=$ROUTER OPENCODE_ALLOW_ALL_MODELS=true"

# 4. plugin load + provider registration (the adapter's own probe command)
# shellcheck disable=SC2086 # agent_env is a deliberate NAME=value word list for env(1)
MODELS_OUT="$($V1_LAUNCH_GOSU env $agent_env "$V1_BIN" models)" || fail "opencode models failed"
echo "$MODELS_OUT" | grep -q '^router/coder$' || fail "router/coder missing from models: $MODELS_OUT"
echo "$MODELS_OUT" | grep -q '^router-coder/coder-default$' || fail "role provider missing from models: $MODELS_OUT"
log "V1 router plugin registered: $(echo "$MODELS_OUT" | tr '\n' ' ')"

# 5. full agent turn through the router provider as the agent principal
# shellcheck disable=SC2086 # agent_env is a deliberate NAME=value word list for env(1)
$V1_LAUNCH_GOSU env $agent_env "$V1_BIN" run --format json --model router/coder \
  "Reply with exactly: OK" > "$STAGE/run.out" 2> "$STAGE/run.err" \
  || { tail -20 "$STAGE/run.err" >&2; fail "baseline agent run failed"; }
grep -q '"type":"text"' "$STAGE/run.out" || fail "agent run produced no text part"
grep -q '"text":"OK"' "$STAGE/run.out" || fail "agent run did not return the stub reply"
grep -q '"type":"step_finish"' "$STAGE/run.out" || fail "agent run has no finished step (no model turn)"
log "baseline agent turn OK ($(grep -c '"type":"text"' "$STAGE/run.out") text part)"

# 6. the plugin itself executed: it wrote its catalog cache under the agent home
test -s "$STAGE/home/.cache/paperclip-router-catalog.json" \
  || fail "router plugin did not write its catalog cache"

log "PASS: V1 agent path + V1 router plugin launch on the rebuilt image"
