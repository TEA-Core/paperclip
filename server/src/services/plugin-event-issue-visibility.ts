import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginCapabilityValidator } from "./plugin-capability-validator.js";

/** Issue content a plugin otherwise reads only through `issues.get`. */
const ISSUE_CONTENT_FIELDS = ["description", "bodySnippet"] as const;

/** Lists of referenced-issue summaries whose entries carry the referenced issue's title. */
const REFERENCED_ISSUE_FIELDS = [
  "addedReferencedIssues",
  "removedReferencedIssues",
  "currentReferencedIssues",
] as const;

const capabilityValidator = pluginCapabilityValidator();

/**
 * Whether a plugin may read the issue an event describes: the same check the
 * host applies to the plugin's `issues.get` call for an issue in the event's
 * company. A missing manifest reads nothing.
 */
export function pluginCanReadIssues(manifest: PaperclipPluginManifestV1 | null | undefined): boolean {
  return manifest ? capabilityValidator.checkOperation(manifest, "issues.get").allowed : false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutIssueContent(record: Record<string, unknown>): Record<string, unknown> {
  const next = { ...record };
  for (const field of ISSUE_CONTENT_FIELDS) delete next[field];
  for (const field of REFERENCED_ISSUE_FIELDS) {
    const references = next[field];
    if (!Array.isArray(references)) continue;
    next[field] = references.map((reference) => {
      if (!isRecord(reference)) return reference;
      const { title: _title, ...rest } = reference;
      return rest;
    });
  }
  if (isRecord(next._previous)) next._previous = withoutIssueContent(next._previous);
  return next;
}

/**
 * The domain event as a plugin may receive it. An issue event can carry issue
 * content in its payload (the description of `issue.created`, the comment
 * snippet of `issue.comment.created`, the titles of referenced issues on
 * `issue.document.*`); a plugin that cannot read the issue gets the event
 * without that content, keeping the identifiers it needs to react.
 */
export function pluginEventForRecipient(event: PluginEvent, canReadIssue: boolean): PluginEvent {
  if (canReadIssue || event.entityType !== "issue" || !isRecord(event.payload)) return event;
  return { ...event, payload: withoutIssueContent(event.payload) };
}
