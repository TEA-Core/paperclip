// Pure catalog builder for the opencode router plugin. Kept outside plugin/ on
// purpose: opencode calls every function a plugin module exports as a plugin.

// Headroom opencode leaves below a model's window before it compacts. Same
// margin the hand-maintained config used (256000 - 76800 = 179200).
export const CONTEXT_MARGIN = 76800;
// Assumed window for a rung or model that declares none (a spark's 262144).
export const DEFAULT_CONTEXT = 262144;
const OUTPUT = { default: 32768, cheap: 16384 };
const MODELS_OUTPUT = 32768;

// Header -> env var carrying the router's conversation identity. opencode
// interpolates "{env:VAR}" only while it loads the static config file, so a
// plugin that returns the template gets it passed through to the provider
// verbatim. The router then reads "{env:PAPERCLIP_RUN_ID}" as a run id, which
// is the same string for every request from a role: one immortal conversation
// per role, whose pin ratchet holds the whole role on the escalation rung.
// Expand here instead.
const IDENTITY_HEADERS = {
  "X-Paperclip-Run": "PAPERCLIP_WORKSPACE_CWD",
  "X-Paperclip-Run-Id": "PAPERCLIP_RUN_ID",
  // The Paperclip issue this turn belongs to, recorded verbatim into
  // decisions.issue_key. The router has accepted this header since 25d4d4c and
  // infers nothing from the run path, so the column stays empty until something
  // sends it. Paperclip #838 injects the var into the opencode server's env;
  // this is the other half. Left unset rather than
  // empty when a run has no issue (an idle heartbeat poll legitimately has
  // none), so absent reads as absent rather than as a blank key.
  "X-Paperclip-Issue": "PAPERCLIP_ISSUE_IDENTIFIER",
};

// An unset or empty var omits its header. Absent is the safe failure: the
// router falls back to prefix-hash keying, which it knows is not identifying.
// A placeholder would instead mint a key it trusts as one conversation.
function identityHeaders(env) {
  const headers = {};
  for (const [header, name] of Object.entries(IDENTITY_HEADERS)) {
    const value = env?.[name];
    if (value) headers[header] = value;
  }
  return headers;
}

const SEAT_KEY = /^(.+)-(default|cheap)$/;

function contextLimit(window) {
  const ctx = window > 0 ? window : DEFAULT_CONTEXT;
  return Math.max(ctx - CONTEXT_MARGIN, Math.floor(ctx / 2));
}

function openaiCompatible(name, baseURL, headers) {
  return { npm: "@ai-sdk/openai-compatible", name, options: { baseURL, headers: { ...headers } }, models: {} };
}

// Smallest window any rung declares. Disabled targets and paused pools count:
// either can come back without opencode restarting, and a turn sized for a
// bigger rung then overflows it. Same bound as opencode-model-limits-audit.sh,
// so the generated config cannot trip OVERDECL.
function smallestRungWindow(targets) {
  const windows = targets.map((t) => t.maxContextTokens ?? 0).filter((w) => w > 0);
  return windows.length ? Math.min(...windows) : 0;
}

export function buildCatalog({ rules, models, base, env = process.env }) {
  const provider = {};
  const headers = identityHeaders(env);

  for (const [key, role] of Object.entries(rules?.roles ?? {})) {
    const m = SEAT_KEY.exec(key);
    if (!m) continue;
    const [, seat, tier] = m;
    const targets = role?.targets ?? [];
    if (!targets.some((t) => !t.disabled)) continue;
    const id = `router-${seat}`;
    provider[id] ??= openaiCompatible(`Router ${seat}`, `${base}/${seat}/v1`, headers);
    provider[id].models[key] = {
      name: `${key} (router)`,
      limit: { context: contextLimit(smallestRungWindow(targets)), output: OUTPUT[tier] },
    };
  }

  const served = models?.data ?? [];
  if (served.length) {
    const r = openaiCompatible("Router models", `${base}/v1`, headers);
    for (const model of served) {
      r.models[model.id] = {
        name: `${model.id} (router)`,
        limit: { context: contextLimit(model.context_length ?? 0), output: MODELS_OUTPUT },
      };
    }
    provider.router = r;
  }

  return { provider, enabled_providers: Object.keys(provider) };
}

// Mutates opencode's merged config in place: router providers only. A stub a
// caller registered for its configured model (Paperclip does this) is merged
// under the generated entry rather than discarded.
export function applyCatalog(cfg, catalog) {
  const existing = cfg.provider ?? {};
  const next = {};
  for (const [id, generated] of Object.entries(catalog.provider)) {
    const prior = existing[id] ?? {};
    const models = {};
    for (const [mid, def] of Object.entries(generated.models)) {
      models[mid] = { ...(prior.models?.[mid] ?? {}), ...def };
    }
    next[id] = { ...generated, models };
  }
  cfg.provider = next;
  cfg.enabled_providers = [...catalog.enabled_providers];
  return cfg;
}
