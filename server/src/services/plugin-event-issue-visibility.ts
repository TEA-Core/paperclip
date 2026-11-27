import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { isRecord, withoutUnreadableIssueContent } from "./issue-event-content.js";
import { pluginCapabilityValidator } from "./plugin-capability-validator.js";

const capabilityValidator = pluginCapabilityValidator();

/**
 * Whether a plugin may read the issue an event describes: the same check the
 * host applies to the plugin's `issues.get` call for an issue in the event's
 * company. A missing manifest reads nothing.
 */
export function pluginCanReadIssues(manifest: PaperclipPluginManifestV1 | null | undefined): boolean {
  return manifest ? capabilityValidator.checkOperation(manifest, "issues.get").allowed : false;
}

/** A plugin's `issues.get` reads every issue of the company or none of them. */
const UNREADABLE = { ownIssue: false, summarizedIssue: () => false };

/**
 * The domain event as a plugin may receive it. An issue event can carry issue
 * content in its payload (the description of `issue.created`, the comment
 * snippet of `issue.comment.created`, the titles of referenced and blocking
 * issues); a plugin that cannot read the issue gets the event without that
 * content, keeping the identifiers it needs to react.
 */
export function pluginEventForRecipient(event: PluginEvent, canReadIssue: boolean): PluginEvent {
  if (canReadIssue || event.entityType !== "issue" || !isRecord(event.payload)) return event;
  return { ...event, payload: withoutUnreadableIssueContent(event.payload, UNREADABLE) };
}
