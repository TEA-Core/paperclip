import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginCapabilityValidator } from "./plugin-capability-validator.js";

/** Issue content that a plugin otherwise reads only through `issues.get`. */
const ISSUE_BODY_FIELDS = ["title", "description"] as const;

const capabilityValidator = pluginCapabilityValidator();

/**
 * Whether a plugin may read issues: the same capability gate the host applies
 * to the plugin's `issues.get` call. A missing manifest reads nothing.
 */
export function pluginCanReadIssues(manifest: PaperclipPluginManifestV1 | null | undefined): boolean {
  return manifest ? capabilityValidator.checkOperation(manifest, "issues.get").allowed : false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutIssueBody(record: Record<string, unknown>): Record<string, unknown> {
  const next = { ...record };
  for (const field of ISSUE_BODY_FIELDS) delete next[field];
  if (isRecord(next._previous)) next._previous = withoutIssueBody(next._previous);
  return next;
}

/**
 * The domain event as a plugin may receive it. An issue event carries the
 * issue's content in its payload (an `issue.created` event holds the title and
 * description); a plugin that cannot read issues gets the event without that
 * content, keeping the identifiers it needs to react.
 */
export function pluginEventForRecipient(event: PluginEvent, canReadIssues: boolean): PluginEvent {
  if (canReadIssues || event.entityType !== "issue" || !isRecord(event.payload)) return event;
  return { ...event, payload: withoutIssueBody(event.payload) };
}
