import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";
import { isTruthyEnvFlag } from "./models.js";

const execFileAsync = promisify(execFile);

// M1, SUP-12532: agent runtimes run at uid 1001 while the server stays at 1000.
//
// `fs.mkdtemp` always creates its directory 0700 owned by the CALLER — the
// server — regardless of umask. There is no umask or mount option that changes
// that. So the moment PAPERCLIP_AGENT_UID is armed, the agent principal cannot
// even traverse the runtime config dir the server just made for it, and every
// OpenCode run dies at its first write inside it:
//
//   EACCES: permission denied, mkdir '/tmp/paperclip-opencode-config-vn4oaN/opencode'
//
// Observed fleet-wide on 2026-08-19 within minutes of arming the gate; runs
// failed in ~34s and surfaced as agent faults rather than as a deploy fault,
// which is exactly the shape SUP-12532 warned prereq 3 was supposed to prevent.
//
// The prereq-3 sweep cannot cover this. That sweep walks static trees, and this
// directory does not exist until a run starts — there is nothing to pre-chmod.
// The fix has to be here, at the point of creation.
//
// Hand the directory to the shared `agents` group (which holds both 1000 and
// 1001) and set the setgid bit, so anything the agent creates inside inherits
// the group rather than reintroducing the same denial one level down.
//
// Mirrors ensureSharedGroupOwnership() in
// server/src/services/shared-group-ownership.ts, inlined because adapters must
// not import from the server package.
async function grantAgentGroupAccess(dirPath: string): Promise<void> {
  // Gate closed: server and agents share a uid, 0700 is already correct, and
  // widening it would hand access to nobody who does not already have it.
  if (!process.env.PAPERCLIP_AGENT_UID) return;
  try {
    const { stdout } = await execFileAsync("getent", ["group", "agents"], {
      timeout: 5000,
      maxBuffer: 4096,
    });
    const gid = Number.parseInt(stdout.trim().split(":")[2] ?? "", 10);
    if (Number.isNaN(gid)) return;
    const stat = await fs.stat(dirPath);
    await fs.chown(dirPath, stat.uid, gid);
    await fs.chmod(dirPath, (stat.mode & 0o7777) | 0o2070);
  } catch {
    // Deliberately non-fatal. If the group is missing or chgrp is refused, the
    // run still starts and fails loudly at its first write — a legible error
    // beats a silently half-configured runtime, and beats taking the whole
    // fleet down because one lookup failed.
  }
}

type PreparedOpenCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  /**
   * Absolute path of the temporary XDG_CONFIG_HOME this call materialised.
   *
   * Callers that ship the config to a remote execution target key off this: it
   * is the directory to upload, and its presence is the precondition for
   * repointing XDG_CONFIG_HOME at the uploaded copy. They previously inferred
   * the same thing from `notes.length > 0`, which silently stops holding once a
   * config is written on a path that emits no notes — and getting that wrong on
   * a remote target means leaving a host-only path in the remote env.
   */
  runtimeConfigHome: string;
  cleanup: () => Promise<void>;
};

function resolveXdgConfigHome(env: Record<string, string>): string {
  return (
    (typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()) ||
    (typeof process.env.XDG_CONFIG_HOME === "string" && process.env.XDG_CONFIG_HOME.trim()) ||
    path.join(os.homedir(), ".config")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Recursively replace {env:VAR} placeholders with the resolved value. Used to bake
// gateway provider secrets (e.g. the LLM-gateway virtual key) into opencode.json
// SERVER-SIDE, where the value is reliably present. OpenCode's own {env:...}
// resolution happens inside the (possibly sandboxed) run process, whose env
// plumbing is not guaranteed to carry the key to OpenCode's spawned server -- so
// we resolve it here. Unresolvable placeholders are left intact for OpenCode to try.
function expandEnvPlaceholders<T>(value: T, resolve: (name: string) => string | undefined): T {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
      const resolved = resolve(name);
      return resolved !== undefined && resolved.length > 0 ? resolved : match;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandEnvPlaceholders(entry, resolve)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = expandEnvPlaceholders(entry, resolve);
    }
    return out as unknown as T;
  }
  return value;
}

function parseProviderConfig(
  raw: unknown,
  resolveEnv: (name: string) => string | undefined,
  notes: string[],
): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Surface the misconfiguration instead of silently dropping the provider
    // block; an unparseable value would otherwise be undiagnosable.
    notes.push("PAPERCLIP_OPENCODE_PROVIDERS contains invalid JSON; custom providers ignored.");
    return null;
  }
  if (!isPlainObject(parsed)) {
    notes.push(
      "PAPERCLIP_OPENCODE_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    );
    return null;
  }
  // Only keep provider entries that are themselves objects; surface the ones
  // we drop so a malformed entry is just as diagnosable as malformed JSON.
  const providers: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (isPlainObject(value)) providers[key] = expandEnvPlaceholders(value, resolveEnv);
    else skipped.push(key);
  }
  if (skipped.length > 0) {
    notes.push(
      `PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: ${skipped.join(", ")}.`,
    );
  }
  return Object.keys(providers).length > 0 ? providers : null;
}

function parseConfiguredModelRef(raw: unknown): { provider: string; model: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

async function readJsonObject(filepath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filepath, "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Always materialises a runtime config, on every execution target.
//
// `dangerouslySkipPermissions` opts out of the headless permission grant, not
// out of having a runtime config at all. It used to return early here, which
// took the SUP-10914 snapshot disable with it, so an agent configured with
// `dangerouslySkipPermissions: false` kept leaking a full `tmp_pack_*` per run
// on both local and remote targets (SUP-11164).
//
// Remote targets are handled by building the config on the host and uploading
// it as the `xdgConfig` runtime asset, after which the caller repoints
// XDG_CONFIG_HOME at the uploaded copy — see `prepareAdapterExecutionTargetRuntime`
// in execute.ts. The host path is never what the remote process sees, so this
// function does not need to know whether the target is remote. An earlier
// `targetIsRemote` short-circuit predates that upload path and is gone; callers
// stopped passing it when the upload landed.
export async function prepareOpenCodeRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
}): Promise<PreparedOpenCodeRuntimeConfig> {
  const skipPermissions = asBoolean(input.config.dangerouslySkipPermissions, true);

  const sourceConfigDir = path.join(resolveXdgConfigHome(input.env), "opencode");
  const runtimeConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-config-"));
  await grantAgentGroupAccess(runtimeConfigHome);
  const runtimeConfigDir = path.join(runtimeConfigHome, "opencode");
  const runtimeConfigPath = path.join(runtimeConfigDir, "opencode.json");

  await fs.mkdir(runtimeConfigDir, { recursive: true });
  try {
    await fs.cp(sourceConfigDir, runtimeConfigDir, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      throw err;
    }
  }

  const existingConfig = await readJsonObject(runtimeConfigPath);
  const existingPermission = isPlainObject(existingConfig.permission)
    ? existingConfig.permission
    : {};
  const notes: string[] = [];
  if (skipPermissions) {
    notes.push(
      "Injected runtime OpenCode config with permission.external_directory=allow to avoid headless approval prompts.",
    );
  }

  // Merge gateway/custom provider definitions supplied via PAPERCLIP_OPENCODE_PROVIDERS
  // (a JSON object in OpenCode's `provider` shape). OpenCode resolves a `--model
  // provider/model` only when that model exists in a provider's `models` map, and
  // OPENCODE_ALLOW_ALL_MODELS does NOT bypass its internal getModel(). So routing a
  // gateway model (e.g. an EU LLM gateway exposing OpenAI-compatible /v1) requires a
  // custom provider with an explicit models map. We accept it as config (not
  // hard-coded) so the gateway URL, key env, and model list stay declarative.
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const gatewayProviders = parseProviderConfig(
    input.env.PAPERCLIP_OPENCODE_PROVIDERS ?? process.env.PAPERCLIP_OPENCODE_PROVIDERS,
    resolveEnv,
    notes,
  );
  const existingProvider = isPlainObject(existingConfig.provider) ? existingConfig.provider : {};
  let nextProvider = gatewayProviders
    ? { ...existingProvider, ...gatewayProviders }
    : existingProvider;
  if (gatewayProviders) {
    notes.push(
      `Injected ${Object.keys(gatewayProviders).length} custom OpenCode provider(s) from PAPERCLIP_OPENCODE_PROVIDERS: ${Object.keys(gatewayProviders).join(", ")}.`,
    );
  }

  // Register the configured model on its provider's models map. OpenCode resolves
  // `--model provider/model` only when the model id exists in that map, so ids the
  // models.dev catalog does not carry — OpenRouter routing variants such as
  // `openai/gpt-oss-120b:nitro`, or models newer than the bundled catalog — are
  // otherwise rejected with "Model not found" even though the provider serves them.
  // An empty entry deep-merges with catalog metadata, so this is a no-op for models
  // the catalog already knows, and we never clobber an explicit definition from the
  // user config or PAPERCLIP_OPENCODE_PROVIDERS.
  const configuredModel = parseConfiguredModelRef(input.config.model);
  if (configuredModel) {
    const providerEntry = isPlainObject(nextProvider[configuredModel.provider])
      ? { ...(nextProvider[configuredModel.provider] as Record<string, unknown>) }
      : {};
    const providerModels = isPlainObject(providerEntry.models)
      ? { ...(providerEntry.models as Record<string, unknown>) }
      : {};
    if (!isPlainObject(providerModels[configuredModel.model])) {
      providerModels[configuredModel.model] = {};
      providerEntry.models = providerModels;
      nextProvider = { ...nextProvider, [configuredModel.provider]: providerEntry };
      notes.push(
        `Registered configured model ${configuredModel.provider}/${configuredModel.model} in the runtime OpenCode config.`,
      );
    }
  }

  const nextConfig: Record<string, unknown> = { ...existingConfig };
  if (skipPermissions) {
    nextConfig.permission = {
      ...existingPermission,
      external_directory: "allow",
    };
  }
  if (Object.keys(nextProvider).length > 0) {
    nextConfig.provider = nextProvider;
  }

  // Pin OpenCode's auxiliary "small" model (used for session-title generation and
  // other helper tasks) via PAPERCLIP_OPENCODE_SMALL_MODEL. OpenCode otherwise
  // defaults the small model to a built-in provider default (e.g. a claude-* model
  // for the anthropic provider); when that provider is repointed at a gateway that
  // does not serve that exact model, the title-gen call fails and aborts the run.
  // Setting small_model to a gateway-served model keeps every call on supported models.
  // Turn opencode's snapshot tracking off (SUP-10914). OpenCode fires
  // `git gc --prune=7.days` against its snapshot git store on run start,
  // fire-and-forget, and the CLI tears the child down when the run ends — so on
  // short Paperclip heartbeat runs the gc is killed mid-repack every time. git
  // only sweeps stale `tmp_pack_*` files during a gc that COMPLETES, so each
  // killed attempt leaks a full-size temp pack. One measured store held 21 of
  // them at 2.66 GB each: 56 GB of garbage, 92% of the store, against 3 GB of
  // real content. A completed gc on that same content took 15s and reclaimed
  // 4.4 GB -> 21 MB, so the cost is not the gc itself — it is that it never
  // finishes. Paperclip runs in its own git worktrees and does not use
  // opencode's undo/revert, so the feature is redundant here.
  //
  // Only `snapshot` is written. The v2 schema calls the same flag `snapshots`,
  // but opencode 1.17.9 validates this config strictly and rejects the whole
  // file on an unrecognised key ("Configuration is invalid ... Unrecognized
  // key: snapshots", exit 1) — writing both would break every run. An explicit
  // setting in the operator's own opencode.json wins, and
  // PAPERCLIP_OPENCODE_SNAPSHOTS opts back in wholesale.
  const snapshotsOptedIn = isTruthyEnvFlag(
    input.env.PAPERCLIP_OPENCODE_SNAPSHOTS ?? process.env.PAPERCLIP_OPENCODE_SNAPSHOTS,
  );
  const snapshotAlreadyConfigured =
    "snapshot" in existingConfig || "snapshots" in existingConfig;
  if (!snapshotsOptedIn && !snapshotAlreadyConfigured) {
    nextConfig.snapshot = false;
    notes.push(
      "Disabled OpenCode snapshot tracking; its per-run `git gc` is killed at run exit and leaks a full temp pack each time.",
    );
  }

  const smallModel = (input.env.PAPERCLIP_OPENCODE_SMALL_MODEL ?? process.env.PAPERCLIP_OPENCODE_SMALL_MODEL)?.trim();
  if (smallModel) {
    nextConfig.small_model = smallModel;
    notes.push(`Pinned OpenCode small_model to ${smallModel}.`);
  }
  await fs.writeFile(runtimeConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  return {
    env: {
      ...input.env,
      XDG_CONFIG_HOME: runtimeConfigHome,
    },
    notes,
    runtimeConfigHome,
    cleanup: async () => {
      await fs.rm(runtimeConfigHome, { recursive: true, force: true });
    },
  };
}
