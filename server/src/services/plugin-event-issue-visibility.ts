import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { isRecord, issueEventMetadata } from "./issue-event-content.js";
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
const NOTHING_READABLE = () => false;

/**
 * The payload of an event about a run on an issue as a plugin may receive it:
 * unchanged when the plugin can read issues or the run has no issue (`issueId`
 * is the run's resolved issue), and only its metadata otherwise.
 */
export function pluginRunPayloadForRecipient(
  payload: Record<string, unknown>,
  canReadIssue: boolean,
  issueId: string | null,
): Record<string, unknown> {
  return canReadIssue || !issueId ? payload : issueEventMetadata(payload, NOTHING_READABLE);
}

/**
 * The domain event as a plugin may receive it. A plugin that cannot read the
 * issue an event concerns receives only the event's metadata (see
 * `issueEventMetadata`): an `issue.*` event, and an `agent.run.*` event about
 * a run on an issue. A plugin that can read issues receives the event unchanged.
 */
export function pluginEventForRecipient(event: PluginEvent, canReadIssue: boolean): PluginEvent {
  if (canReadIssue || !isRecord(event.payload)) return event;
  if (event.entityType === "issue") {
    return { ...event, payload: issueEventMetadata(event.payload, NOTHING_READABLE) };
  }
  if (event.entityType === "heartbeat_run") {
    const issueId = typeof event.payload.issueId === "string" && event.payload.issueId.length > 0
      ? event.payload.issueId
      : null;
    const payload = pluginRunPayloadForRecipient(event.payload, false, issueId);
    return payload === event.payload ? event : { ...event, payload };
  }
  return event;
}
