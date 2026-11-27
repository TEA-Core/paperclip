import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { isIssueDocumentEvent, isRecord, withoutUnreadableIssueContent } from "./issue-event-content.js";
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

/** Output of a run on an issue, which only a reader of that issue may receive. */
const RUN_ISSUE_CONTENT_FIELDS = ["error", "finalText"] as const;

function withoutRunIssueContent(payload: Record<string, unknown>): Record<string, unknown> {
  const present = RUN_ISSUE_CONTENT_FIELDS.filter((field) => payload[field] != null);
  if (typeof payload.issueId !== "string" || payload.issueId.length === 0 || present.length === 0) return payload;
  const next = { ...payload };
  for (const field of present) next[field] = null;
  return next;
}

/**
 * The domain event as a plugin may receive it. An issue event can carry issue
 * content in its payload (the description of `issue.created`, the comment
 * snippet of `issue.comment.created`, the title of an `issue.document.*`
 * document, the titles of referenced and blocking issues); a plugin that
 * cannot read the issue gets the event without that content, keeping the
 * identifiers it needs to react. A run event (`agent.run.*`) about an issue
 * the plugin cannot read arrives with its `error` and `finalText` set to
 * `null`.
 */
export function pluginEventForRecipient(event: PluginEvent, canReadIssue: boolean): PluginEvent {
  if (canReadIssue || !isRecord(event.payload)) return event;
  if (event.entityType === "issue") {
    return {
      ...event,
      payload: withoutUnreadableIssueContent(event.payload, UNREADABLE, isIssueDocumentEvent(event.eventType)),
    };
  }
  if (event.entityType === "heartbeat_run") {
    const payload = withoutRunIssueContent(event.payload);
    return payload === event.payload ? event : { ...event, payload };
  }
  return event;
}
