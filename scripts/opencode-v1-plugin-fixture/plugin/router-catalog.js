// opencode plugin: builds every provider from the live router at startup.
//   roles  -> GET {control}/api/rules  -> provider router-<seat> at /{seat}/v1
//   models -> GET {ingress}/v1/models  -> provider router      at /v1
// Only router providers are enabled. If a fetch fails the last good copy of
// that half is used, so a slow control API does not empty the model list.
// Source of truth: sectoid-stack-admin paperclip-docker/config/opencode-plugin/,
// installed by scripts/seed-opencode-config.sh. See opencode/README.md.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyCatalog, buildCatalog } from "../router-catalog/lib.mjs";

const INGRESS = (process.env.PAPERCLIP_ROUTER_URL || "http://router.invalid").replace(/\/+$/, "");
const CONTROL = (process.env.PAPERCLIP_ROUTER_CONTROL_URL || "http://router-control.invalid").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.PAPERCLIP_ROUTER_CATALOG_TIMEOUT_MS || 4000);
const CACHE = process.env.PAPERCLIP_ROUTER_CATALOG_CACHE ||
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "paperclip-router-catalog.json");

async function getJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// Only what buildCatalog reads; /api/rules also carries prices, caps and notes.
function trimRules(rules) {
  const roles = {};
  for (const [k, r] of Object.entries(rules.roles ?? {})) {
    roles[k] = { targets: (r.targets ?? []).map(({ provider, maxContextTokens, disabled }) => ({ provider, maxContextTokens, disabled })) };
  }
  const pools = {};
  for (const [k, p] of Object.entries(rules.pools ?? {})) pools[k] = { paused: !!p.paused };
  return { roles, pools };
}

async function readCache() {
  try {
    return JSON.parse(await fs.readFile(CACHE, "utf8"));
  } catch {
    return {};
  }
}

async function writeCache(data) {
  try {
    await fs.mkdir(path.dirname(CACHE), { recursive: true });
    const tmp = `${CACHE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, CACHE);
  } catch {
    // Best effort: a read-only home just means no fallback next time.
  }
}

export const RouterCatalog = async () => ({
  config: async (cfg) => {
    const [rules, models] = await Promise.allSettled([getJSON(`${CONTROL}/api/rules`), getJSON(`${INGRESS}/v1/models`)]);
    const fresh = {
      rules: rules.status === "fulfilled" ? trimRules(rules.value) : null,
      models: models.status === "fulfilled" ? { data: models.value.data ?? [] } : null,
    };
    const cached = fresh.rules && fresh.models ? {} : await readCache();
    const input = { rules: fresh.rules ?? cached.rules ?? null, models: fresh.models ?? cached.models ?? null };
    for (const [half, r] of [["roles", rules], ["models", models]]) {
      if (r.status === "rejected") console.error(`[router-catalog] ${half}: ${r.reason?.message ?? r.reason}; using cache`);
    }
    if (!input.rules && !input.models) return;
    if (fresh.rules || fresh.models) await writeCache(input);
    applyCatalog(cfg, buildCatalog({ ...input, base: INGRESS }));
  },
});
