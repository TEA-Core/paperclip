import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_ISSUE_REQUEST_DEPTH } from "../index.js";
import {
  addIssueCommentSchema,
  createIssueSchema,
  issueBlockedInboxAttentionSchema,
  issueExecutionMonitorPolicySchema,
  issueExecutionPolicySchema,
  issueExecutionStateSchema,
  resolveIssueRecoveryActionSchema,
  respondIssueThreadInteractionSchema,
  suggestedTaskDraftSchema,
  stripCreateOnlyIssueAttribution,
  updateIssueObjectSchema,
  updateIssueSchema,
  upsertIssueDocumentSchema,
} from "./issue.js";
import { createAgentSchema } from "./agent.js";

describe("issue validators", () => {
  it("passes real line breaks through unchanged", () => {
    const parsed = createIssueSchema.parse({
      title: "Follow up PR",
      description: "Line 1\n\nLine 2",
    });

    expect(parsed.description).toBe("Line 1\n\nLine 2");
  });

  it("accepts null and omitted optional multiline issue fields", () => {
    expect(createIssueSchema.parse({ title: "Follow up PR", description: null }).description)
      .toBeNull();
    expect(createIssueSchema.parse({ title: "Follow up PR" }).description)
      .toBeUndefined();
    expect(updateIssueSchema.parse({ comment: undefined }).comment)
      .toBeUndefined();
  });

  it("normalizes JSON-escaped line breaks in issue descriptions", () => {
    const parsed = createIssueSchema.parse({
      title: "Follow up PR",
      description: "PR: https://example.com/pr/1\\n\\nShip the follow-up.",
    });

    expect(parsed.description).toBe("PR: https://example.com/pr/1\n\nShip the follow-up.");
  });

  it("normalizes escaped line breaks in issue update comments", () => {
    const parsed = updateIssueSchema.parse({
      comment: "Done\\n\\n- Verified the route",
    });

    expect(parsed.comment).toBe("Done\n\n- Verified the route");
  });

  it("validates structured unblock descriptors", () => {
    expect(updateIssueSchema.parse({
      status: "blocked",
      unblockDescriptor: { owner: { agentId: "00000000-0000-4000-8000-000000000001" }, action: "Review the finding" },
    }).unblockDescriptor).toEqual({
      owner: { agentId: "00000000-0000-4000-8000-000000000001" },
      action: "Review the finding",
    });
    expect(updateIssueSchema.safeParse({
      status: "blocked",
      unblockDescriptor: { owner: { agentId: "not-a-uuid" }, action: "Review" },
    }).success).toBe(false);
    expect(updateIssueSchema.safeParse({
      status: "blocked",
      unblockDescriptor: { owner: "board", action: "   " },
    }).success).toBe(false);
    expect(createIssueSchema.safeParse({
      title: "Invalid descriptor status",
      status: "todo",
      unblockDescriptor: { owner: "board", action: "Review" },
    }).success).toBe(false);
  });

  it("rejects invalid task-scoped network egress CIDRs", () => {
    expect(updateIssueSchema.safeParse({
      executionWorkspaceSettings: {
        networkEgress: { allowCidrs: ["203.0.113.0/24"] },
      },
    }).success).toBe(true);
    expect(updateIssueSchema.safeParse({
      executionWorkspaceSettings: {
        networkEgress: { allowCidrs: ["999.0.0.0/8"] },
      },
    }).success).toBe(false);
    expect(updateIssueSchema.safeParse({
      executionWorkspaceSettings: {
        networkEgress: { allowCidrs: ["1.2.3.4/33"] },
      },
    }).success).toBe(false);
    expect(updateIssueSchema.safeParse({
      executionWorkspaceSettings: {
        networkEgress: { allowCidrs: ["10.0.0.0/8"] },
      },
    }).success).toBe(false);
    expect(updateIssueSchema.safeParse({
      executionWorkspaceSettings: {
        networkEgress: { allowCidrs: ["0.0.0.0/0"] },
      },
    }).success).toBe(false);
  });

  it("keeps issue attribution fields create-only", () => {
    const created = createIssueSchema.parse({
      title: "Preserve attribution input for route checks",
      createdByUserId: "spoofed-creator",
      responsibleUserId: "spoofed-responsible",
    });
    const updated = updateIssueSchema.parse({
      title: "Do not update attribution",
      createdByUserId: "spoofed-creator",
      responsibleUserId: "spoofed-responsible",
    });

    expect(created.createdByUserId).toBe("spoofed-creator");
    expect(created.responsibleUserId).toBe("spoofed-responsible");
    expect(updated).not.toHaveProperty("createdByUserId");
    expect(updated).not.toHaveProperty("responsibleUserId");
    // The rest of the payload must still parse — stripping attribution is not a silent no-op.
    expect(updated.title).toBe("Do not update attribution");
  });

  it("still rejects unrecognized update keys while stripping attribution", () => {
    // Accepting a known-but-create-only field must not weaken the typo guard that makes
    // `blockedBy` (for `blockedByIssueIds`) a 400 instead of a silently dropped dependency edge.
    expect(updateIssueSchema.safeParse({ title: "t", blockedBy: ["x"] }).success).toBe(false);
  });

  it("strips attribution through the route's extend composition", () => {
    // Mirrors `updateIssueRouteSchema` in server/src/routes/issues.ts, whose PATCH handler
    // rest-spreads the parsed body into the column update. A surviving key would reach the write.
    const routeSchema = stripCreateOnlyIssueAttribution(updateIssueObjectSchema.extend({
      interrupt: z.boolean().optional(),
      force: z.boolean().optional(),
    }));
    const parsed = routeSchema.parse({
      title: "Echo back a full issue object",
      createdByUserId: "spoofed-creator",
      responsibleUserId: "spoofed-responsible",
      force: true,
    });

    expect(parsed).not.toHaveProperty("createdByUserId");
    expect(parsed).not.toHaveProperty("responsibleUserId");
    expect(Object.keys(parsed)).not.toContain("createdByUserId");
    expect(parsed.title).toBe("Echo back a full issue object");
    expect(parsed.force).toBe(true);
    expect(routeSchema.safeParse({ title: "t", blockedBy: ["x"] }).success).toBe(false);
  });

  it("allows false-positive recovery resolutions to atomically restore the source issue status", () => {
    expect(
      resolveIssueRecoveryActionSchema.parse({
        outcome: "false_positive",
        sourceIssueStatus: "in_review",
      }),
    ).toMatchObject({
      outcome: "false_positive",
      sourceIssueStatus: "in_review",
    });

    expect(
      resolveIssueRecoveryActionSchema.safeParse({
        outcome: "false_positive",
        sourceIssueStatus: "blocked",
      }).success,
    ).toBe(false);

    expect(
      resolveIssueRecoveryActionSchema.safeParse({
        outcome: "false_positive",
      }).success,
    ).toBe(false);
  });

  it("allows restored recovery resolutions to return the source issue to todo", () => {
    expect(
      resolveIssueRecoveryActionSchema.parse({
        outcome: "restored",
        sourceIssueStatus: "todo",
      }),
    ).toMatchObject({
      outcome: "restored",
      sourceIssueStatus: "todo",
    });

    expect(
      resolveIssueRecoveryActionSchema.safeParse({
        outcome: "false_positive",
        sourceIssueStatus: "todo",
      }).success,
    ).toBe(false);
  });

  it("allows cancelled recovery resolutions to atomically restore the source issue status", () => {
    expect(
      resolveIssueRecoveryActionSchema.parse({
        outcome: "cancelled",
        sourceIssueStatus: "in_review",
      }),
    ).toMatchObject({
      outcome: "cancelled",
      sourceIssueStatus: "in_review",
    });

    expect(
      resolveIssueRecoveryActionSchema.safeParse({
        outcome: "cancelled",
        sourceIssueStatus: "blocked",
      }).success,
    ).toBe(false);

    expect(
      resolveIssueRecoveryActionSchema.safeParse({
        outcome: "cancelled",
      }).success,
    ).toBe(false);
  });

  it("rejects recovery outcomes that are not supported by the source-scoped resolution endpoint", () => {
    expect(
      resolveIssueRecoveryActionSchema.safeParse({
        outcome: "delegated",
      }).success,
    ).toBe(false);

    expect(
      resolveIssueRecoveryActionSchema.safeParse({
        outcome: "escalated",
      }).success,
    ).toBe(false);
  });

  it("normalizes escaped line breaks in issue comment bodies", () => {
    const parsed = addIssueCommentSchema.parse({
      body: "Progress update\\r\\n\\r\\nNext action.",
    });

    expect(parsed.body).toBe("Progress update\n\nNext action.");
  });

  it("accepts structured issue comment presentation and metadata", () => {
    const parsed = addIssueCommentSchema.parse({
      body: "Paperclip needs a disposition before this issue can continue.",
      authorType: "system",
      presentation: {
        kind: "system_notice",
        tone: "warning",
        title: "Needs disposition",
        density: "compact",
      },
      metadata: {
        version: 1,
        sourceRunId: "11111111-1111-4111-8111-111111111111",
        sections: [
          {
            title: "Evidence",
            rows: [
              { type: "key_value", label: "Cause", value: "successful_run_missing_state" },
              { type: "issue_link", label: "Source issue", identifier: "PAP-3440" },
              { type: "run_link", label: "Run", runId: "11111111-1111-4111-8111-111111111111" },
            ],
          },
        ],
      },
    });

    expect(parsed.presentation?.detailsDefaultOpen).toBe(false);
    expect(parsed.presentation?.density).toBe("compact");
    expect(parsed.metadata?.sourceRunId).toBe("11111111-1111-4111-8111-111111111111");
    expect(parsed.metadata?.sections[0]?.rows).toHaveLength(3);
  });

  it("rejects unknown issue comment presentation densities", () => {
    expect(addIssueCommentSchema.safeParse({
      body: "Hidden details",
      presentation: {
        kind: "system_notice",
        tone: "warning",
        density: "condensed",
      },
    }).success).toBe(false);
  });

  it("rejects arbitrary issue comment metadata", () => {
    const parsed = addIssueCommentSchema.safeParse({
      body: "Hidden details",
      metadata: {
        version: 1,
        transcript: "raw log dump",
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("normalizes escaped line breaks in generated task drafts", () => {
    const parsed = suggestedTaskDraftSchema.parse({
      clientKey: "task-1",
      title: "Follow up",
      description: "Line 1\\n\\nLine 2",
    });

    expect(parsed.description).toBe("Line 1\n\nLine 2");
  });

  it("normalizes escaped line breaks in thread summaries and documents", () => {
    const response = respondIssueThreadInteractionSchema.parse({
      answers: [],
      summaryMarkdown: "Summary\\n\\nNext action",
    });
    const document = upsertIssueDocumentSchema.parse({
      format: "markdown",
      body: "# Plan\\n\\nShip it",
    });

    expect(response.summaryMarkdown).toBe("Summary\n\nNext action");
    expect(document.body).toBe("# Plan\n\nShip it");
  });

  it("clamps oversized requestDepth values on create", () => {
    const parsed = createIssueSchema.parse({
      title: "Clamp request depth",
      requestDepth: MAX_ISSUE_REQUEST_DEPTH + 500,
    });

    expect(parsed.requestDepth).toBe(MAX_ISSUE_REQUEST_DEPTH);
  });

  it("defaults omitted create status to todo when an assignee is present", () => {
    expect(createIssueSchema.parse({
      title: "Assigned work",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
    }).status).toBe("todo");
    expect(createIssueSchema.parse({ title: "Unassigned work" }).status).toBe("backlog");
    expect(createIssueSchema.parse({
      title: "Deliberately parked",
      assigneeAgentId: "22222222-2222-4222-8222-222222222222",
      status: "backlog",
    }).status).toBe("backlog");
  });

  it("defaults issue work mode to standard and accepts ask, planning, and skill_test", () => {
    expect(createIssueSchema.parse({ title: "Plan first" }).workMode).toBe("standard");
    expect(createIssueSchema.parse({ title: "Ask first", workMode: "ask" }).workMode).toBe("ask");
    expect(createIssueSchema.parse({ title: "Plan first", workMode: "planning" }).workMode).toBe("planning");
    expect(createIssueSchema.parse({
      title: "Harness test",
      workMode: "skill_test",
      harnessKind: "skill_test",
    })).toMatchObject({ workMode: "skill_test", harnessKind: "skill_test" });
    expect(updateIssueSchema.parse({ workMode: "ask" }).workMode).toBe("ask");
    expect(updateIssueSchema.parse({ workMode: "planning" }).workMode).toBe("planning");
    expect(updateIssueSchema.parse({ workMode: "skill_test" }).workMode).toBe("skill_test");
    expect(suggestedTaskDraftSchema.parse({
      clientKey: "ask-child",
      title: "Ask child",
      workMode: "ask",
    }).workMode).toBe("ask");
    expect(suggestedTaskDraftSchema.parse({
      clientKey: "planning-child",
      title: "Plan child",
      workMode: "planning",
    }).workMode).toBe("planning");
    expect(suggestedTaskDraftSchema.parse({
      clientKey: "skill-test-child",
      title: "Test child",
      workMode: "skill_test",
    }).workMode).toBe("skill_test");
  });

  it("validates blocked inbox attention payloads and requires redacted secret fields", () => {
    const parsed = issueBlockedInboxAttentionSchema.parse({
      kind: "blocked",
      state: "needs_attention",
      reason: "blocked_by_unassigned_issue",
      severity: "critical",
      stoppedSinceAt: "2026-05-09T12:00:00.000Z",
      owner: { type: "unknown", agentId: null, userId: null, label: null },
      action: { label: "Assign blocker", detail: "Assign the leaf blocker." },
      sourceIssue: {
        id: "11111111-1111-4111-8111-111111111111",
        identifier: "PAP-1",
        title: "Blocked source",
        status: "blocked",
        priority: "high",
        assigneeAgentId: null,
        assigneeUserId: null,
      },
      leafIssue: {
        id: "22222222-2222-4222-8222-222222222222",
        identifier: "PAP-2",
        title: "Unassigned leaf",
        status: "todo",
        priority: "medium",
        assigneeAgentId: null,
        assigneeUserId: null,
      },
      recoveryIssue: null,
      approvalId: null,
      interactionId: null,
      sampleIssueIdentifier: "PAP-2",
      redaction: {
        externalDetailsRedacted: false,
        secretFieldsOmitted: true,
      },
    });

    expect(parsed.redaction.secretFieldsOmitted).toBe(true);
    expect(issueBlockedInboxAttentionSchema.safeParse({
      ...parsed,
      redaction: { externalDetailsRedacted: false, secretFieldsOmitted: false },
    }).success).toBe(false);
  });

  it("rejects unknown issue work modes", () => {
    expect(createIssueSchema.safeParse({ title: "Plan first", workMode: "normal" }).success).toBe(false);
    expect(suggestedTaskDraftSchema.safeParse({
      clientKey: "bad-child",
      title: "Bad child",
      workMode: "analysis",
    }).success).toBe(false);
  });

  it("clamps oversized requestDepth values on update", () => {
    const parsed = updateIssueSchema.parse({
      requestDepth: MAX_ISSUE_REQUEST_DEPTH + 1,
    });

    expect(parsed.requestDepth).toBe(MAX_ISSUE_REQUEST_DEPTH);
  });

  it("accepts the cheap model profile in issue assignee adapter overrides", () => {
    const parsed = createIssueSchema.parse({
      title: "Run a cheap heartbeat",
      assigneeAdapterOverrides: {
        modelProfile: "cheap",
      },
    });

    expect(parsed.assigneeAdapterOverrides?.modelProfile).toBe("cheap");
  });

  it("rejects unknown issue model profile keys", () => {
    const parsed = updateIssueSchema.safeParse({
      assigneeAdapterOverrides: {
        modelProfile: "fast",
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("validates agent runtime cheap model profile config without rejecting other runtime fields", () => {
    const parsed = createAgentSchema.parse({
      name: "Coder",
      adapterType: "codex_local",
      runtimeConfig: {
        heartbeat: { enabled: true },
        modelProfiles: {
          cheap: {
            enabled: true,
            label: "Cheap Codex",
            adapterConfig: {
              model: "gpt-5.3-codex-spark",
            },
          },
        },
      },
    });

    expect(parsed.runtimeConfig.modelProfiles?.cheap?.adapterConfig).toEqual({
      model: "gpt-5.3-codex-spark",
    });
    expect(parsed.runtimeConfig.heartbeat).toEqual({ enabled: true });
  });

  it("validates cheap model profile env bindings like top-level adapter config", () => {
    const parsed = createAgentSchema.safeParse({
      name: "Coder",
      adapterType: "codex_local",
      runtimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              env: {
                API_TOKEN: 123,
              },
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects unknown agent runtime model profile keys", () => {
    const parsed = createAgentSchema.safeParse({
      name: "Coder",
      adapterType: "codex_local",
      runtimeConfig: {
        modelProfiles: {
          fast: {
            adapterConfig: {
              model: "gpt-5-mini",
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("preserves returnAssigneeAgentId in a create execution policy", () => {
    const agentId = "38ca3dab-cdb5-4d90-84dd-c5f2eb15da5e";
    const parsed = createIssueSchema.parse({
      title: "Persist return assignee",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            type: "review",
            approvalsNeeded: 1,
            participants: [{ type: "agent", agentId }],
          },
        ],
        returnAssigneeAgentId: agentId,
      },
    });

    expect(parsed.executionPolicy?.returnAssigneeAgentId).toBe(agentId);
  });

  it("preserves returnAssigneeAgentId in an update execution policy", () => {
    const agentId = "38ca3dab-cdb5-4d90-84dd-c5f2eb15da5e";
    const parsed = updateIssueSchema.parse({
      executionPolicy: {
        returnAssigneeAgentId: agentId,
      },
    });

    expect(parsed.executionPolicy?.returnAssigneeAgentId).toBe(agentId);
  });

  describe("issueExecutionPolicySchema strictness", () => {
    it("rejects an unrecognized key in executionPolicy with the offending key named", () => {
      const result = createIssueSchema.safeParse({
        title: "Strictness test",
        executionPolicy: {
          stages: [],
          monitorPolicy: { nextCheckAt: "2026-08-15T00:00:00.000Z" },
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) =>
          i.message.includes("monitorPolicy") || i.path?.includes("monitorPolicy"),
        )).toBe(true);
      }
    });

    it("rejects an unrecognized key in executionPolicy update path", () => {
      const result = updateIssueSchema.safeParse({
        executionPolicy: {
          monitorPolicy: { nextCheckAt: "2026-08-15T00:00:00.000Z" },
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) =>
          i.message.includes("monitorPolicy") || i.path?.includes("monitorPolicy"),
        )).toBe(true);
      }
    });

    it("accepts a well-formed executionPolicy.monitor", () => {
      const result = createIssueSchema.safeParse({
        title: "Happy path",
        executionPolicy: {
          stages: [],
          monitor: {
            nextCheckAt: "2026-08-15T00:00:00.000Z",
            maxAttempts: 3,
            notes: "Check something",
          },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.executionPolicy?.monitor).toBeTruthy();
        expect(result.data.executionPolicy?.monitor?.nextCheckAt).toBe("2026-08-15T00:00:00.000Z");
      }
    });

    it("accepts a well-formed executionPolicy.monitor via update path", () => {
      const result = updateIssueSchema.safeParse({
        executionPolicy: {
          monitor: {
            nextCheckAt: "2026-08-15T00:00:00.000Z",
          },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.executionPolicy?.monitor?.nextCheckAt).toBe("2026-08-15T00:00:00.000Z");
      }
    });
  });

  describe("issueExecutionMonitorPolicySchema strictness", () => {
    it("rejects an unrecognized key in monitor policy with the offending key named", () => {
      const result = issueExecutionMonitorPolicySchema.safeParse({
        nextCheckAt: "2026-08-15T00:00:00.000Z",
        misspelledKey: "should reject",
      });
      expect(result.success).toBe(false);
    });

    it("accepts a well-formed monitor policy", () => {
      const result = issueExecutionMonitorPolicySchema.safeParse({
        nextCheckAt: "2026-08-15T00:00:00.000Z",
        maxAttempts: 3,
        notes: "Test monitor",
        scheduledBy: "assignee",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.nextCheckAt).toBe("2026-08-15T00:00:00.000Z");
      }
    });
  });

  const unrecognizedKeysOf = (error: z.ZodError): string[] =>
    error.issues.flatMap((issue) =>
      issue.code === z.ZodIssueCode.unrecognized_keys ? issue.keys : [],
    );

  it("rejects typo'd key at executionPolicy level (e.g. monitorr instead of monitor)", () => {
    const parsed = createIssueSchema.safeParse({
      title: "Silent monitor misspelling",
      executionPolicy: {
        mode: "normal",
        monitorr: {
          nextCheckAt: "2025-01-01T00:00:00Z",
        },
        stages: [
          {
            type: "review",
            participants: [{ type: "agent", agentId: "38ca3dab-cdb5-4d90-84dd-c5f2eb15da5e" }],
          },
        ],
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : unrecognizedKeysOf(parsed.error)).toContain("monitorr");
  });

  it("rejects typo'd key at execution policy stage level (e.g. typee instead of type)", () => {
    const parsed = createIssueSchema.safeParse({
      title: "Silent stage misspelling",
      executionPolicy: {
        mode: "normal",
        stages: [
          {
            typee: "review",
            participants: [{ type: "agent", agentId: "38ca3dab-cdb5-4d90-84dd-c5f2eb15da5e" }],
          },
        ],
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : unrecognizedKeysOf(parsed.error)).toContain("typee");
  });

  it("rejects typo'd key at monitor level (e.g. nextCheckAtt instead of nextCheckAt)", () => {
    const parsed = createIssueSchema.safeParse({
      title: "Silent monitor key misspelling",
      executionPolicy: {
        mode: "normal",
        monitor: {
          nextCheckAtt: "2025-01-01T00:00:00Z",
        },
        stages: [
          {
            type: "review",
            participants: [{ type: "agent", agentId: "38ca3dab-cdb5-4d90-84dd-c5f2eb15da5e" }],
          },
        ],
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : unrecognizedKeysOf(parsed.error)).toContain("nextCheckAtt");
  });

  it("rejects typo'd key at stage participant level (e.g. agentIdd instead of agentId)", () => {
    const parsed = createIssueSchema.safeParse({
      title: "Silent participant misspelling",
      executionPolicy: {
        mode: "normal",
        stages: [
          {
            type: "review",
            participants: [{ type: "agent", agentIdd: "38ca3dab-cdb5-4d90-84dd-c5f2eb15da5e" }],
          },
        ],
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : unrecognizedKeysOf(parsed.error)).toContain("agentIdd");
  });

  it("accepts valid executionPolicy with monitor", () => {
    const parsed = createIssueSchema.parse({
      title: "Valid monitor policy",
      executionPolicy: {
        mode: "normal",
        monitor: {
          nextCheckAt: "2025-01-01T00:00:00Z",
        },
        stages: [
          {
            type: "review",
            participants: [{ type: "agent", agentId: "38ca3dab-cdb5-4d90-84dd-c5f2eb15da5e" }],
          },
        ],
      },
    });

    expect(parsed.executionPolicy?.monitor?.nextCheckAt).toBe("2025-01-01T00:00:00Z");
    expect(parsed.executionPolicy?.monitor?.scheduledBy).toBe("assignee");
    expect(parsed.executionPolicy?.stages).toHaveLength(1);
    expect(parsed.executionPolicy?.stages[0].type).toBe("review");
  });
});

describe("issueExecutionStateSchema principal strictness", () => {
  const unrecognizedKeys = (error: z.ZodError): string[] =>
    error.issues.flatMap((issue) =>
      issue.code === z.ZodIssueCode.unrecognized_keys ? issue.keys : [],
    );
  const stageId = "044300c9-e352-4b38-9a3c-1579a7bb9a96";
  const participantId = "6ac26c92-8a89-4456-b9a1-e66f10387ef8";
  const agentId = "22222222-2222-4222-8222-222222222222";

  const stateWithParticipant = (participant: Record<string, unknown>) => ({
    status: "pending",
    currentStageId: stageId,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: participant,
    returnAssignee: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
  });

  // The writer copies the principal off a policy stage's participant list, so the
  // participant `id` rides along and is already persisted in execution_state.
  // Rejecting it strands the issue: parseIssueExecutionState returns null and the
  // review chain loses its place. See SUP-12029/SUP-12041.
  it("accepts the participant id the writer has always persisted", () => {
    const parsed = issueExecutionStateSchema.safeParse(
      stateWithParticipant({ id: participantId, type: "agent", agentId, userId: null }),
    );

    expect(parsed.success).toBe(true);
  });

  it("still rejects a genuinely unrecognized principal key", () => {
    const parsed = issueExecutionStateSchema.safeParse(
      stateWithParticipant({ type: "agent", agentId, userId: null, agentIdd: agentId }),
    );

    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : unrecognizedKeys(parsed.error)).toContain("agentIdd");
  });
});
