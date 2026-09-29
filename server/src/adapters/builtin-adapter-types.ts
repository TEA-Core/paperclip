/**
 * Adapter types that ship with Paperclip. An external adapter package MAY
 * declare one of these types to override the built-in implementation: the
 * registry keeps the built-in registered as a fallback and only returns it from
 * `findActiveServerAdapter` while the override is paused or unregistered
 * (see server/src/adapters/registry.ts and docs/adapters/external-adapters.md).
 */
export const BUILTIN_ADAPTER_TYPES = new Set([
  "acpx_local",
  "claude_local",
  "codex_local",
  "paperclip_runner",
  "cursor_cloud",
  "cursor",
  "gemini_local",
  "grok_local",
  "hermes_gateway",
  "hermes_local",
  "kimi_local",
  "openclaw_gateway",
  "opencode_local",
  "pi_local",
  "process",
  "http",
]);

export const PULL_ONLY_ADAPTER_TYPES = new Set(["process"]);

export function isPullOnlyAdapterType(adapterType: string | null | undefined): boolean {
  return !!adapterType && PULL_ONLY_ADAPTER_TYPES.has(adapterType);
}
