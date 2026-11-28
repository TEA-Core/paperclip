import { describe, expect, it } from "vitest";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  pluginCanReadIssues,
  pluginEventForRecipient,
  pluginRunPayloadForRecipient,
} from "../services/plugin-event-issue-visibility.js";

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

  it("gives a plugin without issues.read only the title and metadata of an ordinary issue's events", () => {
    const updated = event({
      payload: {
        identifier: "PAP-3",
        title: "Ordinary issue title",
        description: "Ordinary issue description",
        status: "todo",
        _previous: { description: "Earlier ordinary description", status: "backlog" },
      },
    });
    expect(pluginEventForRecipient(updated, false).payload).toEqual({
      identifier: "PAP-3",
      title: "Ordinary issue title",
      status: "todo",
      _previous: { status: "backlog" },
    });
    expect(pluginEventForRecipient(updated, true)).toBe(updated);

    const commented = event({
      eventType: "issue.comment.created",
      payload: {
        commentId: "comment-3",
        bodySnippet: "Ordinary comment body",
        identifier: "PAP-3",
        issueTitle: "Ordinary issue title",
        authorizationReason: "Ordinary authorization text",
      },
    });
    expect(pluginEventForRecipient(commented, false).payload).toEqual({
      commentId: "comment-3",
      identifier: "PAP-3",
      issueTitle: "Ordinary issue title",
    });
    expect(pluginEventForRecipient(commented, true)).toBe(commented);
  });

  it("strips referenced and blocking issue titles from an unreadable issue's event", () => {
    const reference = { id: "issue-2", identifier: "PAP-2", title: "Referenced restricted title" };
    const original = event({
      eventType: "issue.document.updated",
      payload: {
        key: "plan",
        addedReferencedIssues: [reference],
        removedReferencedIssues: [reference],
        currentReferencedIssues: [reference],
        blockedByIssues: [reference],
      },
    });
    const stripped = { id: "issue-2", identifier: "PAP-2" };
    expect(pluginEventForRecipient(original, false).payload).toEqual({
      key: "plan",
      addedReferencedIssues: [stripped],
      removedReferencedIssues: [stripped],
      currentReferencedIssues: [stripped],
      blockedByIssues: [stripped],
    });
    expect(pluginEventForRecipient(original, true)).toBe(original);
  });

  it("keeps the document title of an unreadable issue's document event", () => {
    const original = event({
      eventType: "issue.document.created",
      payload: { key: "plan", documentId: "doc-1", title: "Document title", revisionNumber: 1, body: "Restricted body" },
    });
    expect(pluginEventForRecipient(original, false).payload).toEqual({
      key: "plan",
      documentId: "doc-1",
      title: "Document title",
      revisionNumber: 1,
    });
    expect(pluginEventForRecipient(original, true)).toBe(original);
  });

  it("passes only metadata of an unreadable issue's nested and unknown fields", () => {
    const original = event({
      payload: {
        identifier: "PAP-1",
        status: "in_progress",
        changes: {
          status: { from: "todo", to: "in_progress" },
          description: { from: "Restricted old body", to: "Restricted new body" },
        },
        quote: "Restricted quote",
        notes: "Restricted notes",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(pluginEventForRecipient(original, false).payload).toEqual({
      identifier: "PAP-1",
      status: "in_progress",
      changes: { status: { from: "todo", to: "in_progress" } },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(pluginEventForRecipient(original, true)).toBe(original);
  });

  it("withholds the output of a run on an unreadable issue and keeps its status", () => {
    const original = event({
      eventType: "agent.run.failed",
      entityType: "heartbeat_run",
      entityId: "run-1",
      payload: {
        runId: "run-1",
        agentId: "agent-1",
        status: "failed",
        error: "Restricted run error",
        errorCode: "adapter_failed",
        issueId: "issue-1",
      },
    });
    expect(pluginEventForRecipient(original, false).payload).toEqual({
      runId: "run-1",
      agentId: "agent-1",
      status: "failed",
      errorCode: "adapter_failed",
      issueId: "issue-1",
    });
    expect(pluginEventForRecipient(original, true)).toBe(original);
  });

  it("withholds the error text of a run with no issue from a plugin without issues.read", () => {
    const issueless = event({
      eventType: "agent.run.failed",
      entityType: "heartbeat_run",
      entityId: "run-2",
      payload: { runId: "run-2", status: "failed", error: "Run error naming issue content", errorCode: "adapter_failed", issueId: null },
    });
    expect(pluginEventForRecipient(issueless, false).payload).toEqual({
      runId: "run-2",
      status: "failed",
      errorCode: "adapter_failed",
      issueId: null,
    });
    expect(pluginEventForRecipient(issueless, true)).toBe(issueless);
  });

  it("withholds error and message text of session output with no issue and keeps the output itself", () => {
    const runEvent = { runId: "run-3", seq: 2, eventType: "adapter.message", message: "Free-form message", error: "Free-form error" };
    expect(pluginRunPayloadForRecipient(runEvent, false, null)).toEqual({ runId: "run-3", seq: 2, eventType: "adapter.message" });
    expect(pluginRunPayloadForRecipient(runEvent, true, null)).toBe(runEvent);
    const log = { runId: "run-3", seq: 3, stream: "stdout", chunk: "Session output" };
    expect(pluginRunPayloadForRecipient(log, false, null)).toBe(log);
  });

  it("withholds fields outside the metadata allow-list even when their names look like metadata", () => {
    const original = event({
      payload: {
        identifier: "PAP-1",
        status: "todo",
        assigneeAgentId: "agent-1",
        updatedAt: "2026-01-01T00:00:00.000Z",
        internalNoteKey: "Restricted note",
        reviewerNoteIdentifier: "Restricted reviewer note",
        draftSavedAt: "Restricted draft",
      },
    });
    expect(pluginEventForRecipient(original, false).payload).toEqual({
      identifier: "PAP-1",
      status: "todo",
      assigneeAgentId: "agent-1",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(pluginEventForRecipient(original, true)).toBe(original);
  });

  it("leaves events about other entities unchanged", () => {
    const agentEvent = event({ eventType: "agent.updated", entityType: "agent", payload: { title: "Agent title" } });
    expect(pluginEventForRecipient(agentEvent, false)).toBe(agentEvent);
  });
});
