import { describe, expect, it } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginCanReadIssues, pluginEventForRecipient } from "../services/plugin-event-issue-visibility.js";

function event(overrides: Partial<PluginEvent>): PluginEvent {
  return {
    eventId: "event-1",
    eventType: "issue.updated",
    occurredAt: new Date(0).toISOString(),
    actorId: "system",
    actorType: "system",
    entityId: "issue-1",
    entityType: "issue",
    companyId: "company-1",
    payload: {},
    ...overrides,
  };
}

function manifest(capabilities: string[]) {
  return { id: "paperclip.test", capabilities } as unknown as PaperclipPluginManifestV1;
}

describe("plugin issue event visibility", () => {
  it("reads issues only with the capability issues.get requires", () => {
    expect(pluginCanReadIssues(manifest(["events.subscribe", "issues.read"]))).toBe(true);
    expect(pluginCanReadIssues(manifest(["events.subscribe"]))).toBe(false);
    expect(pluginCanReadIssues(undefined)).toBe(false);
  });

  it("strips the current and previous description of an unreadable issue and keeps its title", () => {
    const original = event({
      payload: {
        identifier: "PAP-1",
        title: "New title",
        description: "New body",
        status: "todo",
        _previous: { title: "Old title", description: "Old body", status: "backlog" },
      },
    });
    expect(pluginEventForRecipient(original, false).payload).toEqual({
      identifier: "PAP-1",
      title: "New title",
      status: "todo",
      _previous: { title: "Old title", status: "backlog" },
    });
    expect(pluginEventForRecipient(original, true)).toBe(original);
  });

  it("strips the comment snippet of an unreadable issue's comment event", () => {
    const original = event({
      eventType: "issue.comment.created",
      payload: { commentId: "comment-1", bodySnippet: "Restricted comment body", identifier: "PAP-1" },
    });
    expect(pluginEventForRecipient(original, false).payload).toEqual({
      commentId: "comment-1",
      identifier: "PAP-1",
    });
    expect(pluginEventForRecipient(original, true)).toBe(original);
  });

  it("strips referenced issue titles from an unreadable issue's document event", () => {
    const reference = { id: "issue-2", identifier: "PAP-2", title: "Referenced restricted title" };
    const original = event({
      eventType: "issue.document.updated",
      payload: {
        key: "plan",
        addedReferencedIssues: [reference],
        removedReferencedIssues: [reference],
        currentReferencedIssues: [reference],
      },
    });
    const stripped = { id: "issue-2", identifier: "PAP-2" };
    expect(pluginEventForRecipient(original, false).payload).toEqual({
      key: "plan",
      addedReferencedIssues: [stripped],
      removedReferencedIssues: [stripped],
      currentReferencedIssues: [stripped],
    });
    expect(pluginEventForRecipient(original, true)).toBe(original);
  });

  it("leaves events about other entities unchanged", () => {
    const agentEvent = event({ eventType: "agent.updated", entityType: "agent", payload: { title: "Agent title" } });
    expect(pluginEventForRecipient(agentEvent, false)).toBe(agentEvent);
  });
});
