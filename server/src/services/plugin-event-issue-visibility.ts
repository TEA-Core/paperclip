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
 * Free-form text fields of a run event. A run with no issue can still report
 * issue content in its error or message text, so a plugin without
 * `issues.read` never receives them.
 */
const RUN_FREE_FORM_TEXT_FIELDS = ["error", "message"] as const;

function withoutRunFreeFormText(payload: Record<string, unknown>): Record<string, unknown> {
  if (!RUN_FREE_FORM_TEXT_FIELDS.some((field) => field in payload)) return payload;
  const visible = { ...payload };
  for (const field of RUN_FREE_FORM_TEXT_FIELDS) delete visible[field];
  return visible;
}

/**
 * The payload of an event about a run as a plugin may receive it: unchanged
 * when the plugin can read issues. Otherwise a run on an issue (`issueId` is
 * the run's resolved issue) gives only its metadata, and a run with no issue
 * loses its free-form `error` and `message` text and keeps its own output.
 */
export function pluginRunPayloadForRecipient(
  payload: Record<string, unknown>,
  canReadIssue: boolean,
  issueId: string | null,
): Record<string, unknown> {
  if (canReadIssue) return payload;
  return issueId ? issueEventMetadata(payload, NOTHING_READABLE) : withoutRunFreeFormText(payload);
}

/**
 * An issue, or a comment, document or run summary of an issue, as a plugin
 * without `issues.read` may receive it from a read path: its title and
 * allow-listed metadata only (see `issueEventMetadata`).
 */
export function pluginIssueRecordForRecipient<T extends object>(record: T): T {
  // The reduced record keeps only a subset of the fields the type declares.
  return issueEventMetadata(record as Record<string, unknown>, NOTHING_READABLE) as T;
}

/**
 * The payload of an event or activity entry about an entity as a plugin may
 * receive it. A plugin without `issues.read` receives an entry about any
 * issue, ordinary or restricted, with only its metadata (see
 * `issueEventMetadata`) and the issue's title: the top-level `title` (the
 * document title on a document event) and, on a comment event, `issueTitle`.
 * Descriptions, comment bodies and snippets, document bodies, annotation
 * quotes and every other content field are withheld. An entry about a run on
 * an issue keeps only its metadata, and one about a run with no issue loses
 * its free-form `error` and `message` text. A plugin that can read issues
 * receives the payload unchanged, as it does an entry about any other entity.
 */
export function pluginEntityPayloadForRecipient(
  entityType: string,
  payload: Record<string, unknown>,
  canReadIssue: boolean,
): Record<string, unknown> {
  if (canReadIssue) return payload;
  if (entityType === "issue") {
    const metadata = issueEventMetadata(payload, NOTHING_READABLE);
    const { issueTitle } = payload;
    return typeof issueTitle === "string" ? { ...metadata, issueTitle } : metadata;
  }
  if (entityType === "heartbeat_run") {
    const issueId = typeof payload.issueId === "string" && payload.issueId.length > 0 ? payload.issueId : null;
    return pluginRunPayloadForRecipient(payload, false, issueId);
  }
  return payload;
}

/** The domain event as a plugin may receive it (see `pluginEntityPayloadForRecipient`). */
export function pluginEventForRecipient(event: PluginEvent, canReadIssue: boolean): PluginEvent {
  if (canReadIssue || !isRecord(event.payload)) return event;
  const payload = pluginEntityPayloadForRecipient(event.entityType ?? "", event.payload, false);
  return payload === event.payload ? event : { ...event, payload };
}
