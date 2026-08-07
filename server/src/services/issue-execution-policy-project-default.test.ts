import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizeIssueExecutionPolicy,
  resolveProjectDefaultIssueExecutionPolicy,
} from "./issue-execution-policy.js";

function reviewStagePolicy(reviewerAgentId: string) {
  return {
    mode: "normal",
    stages: [
      {
        type: "review",
        participants: [{ type: "agent", agentId: reviewerAgentId }],
      },
    ],
  };
}

describe("resolveProjectDefaultIssueExecutionPolicy", () => {
  it("returns null when the project has no stored default", () => {
    expect(resolveProjectDefaultIssueExecutionPolicy(null)).toBeNull();
    expect(resolveProjectDefaultIssueExecutionPolicy(undefined)).toBeNull();
  });

  it("normalizes a stored default into a usable policy with stage ids", () => {
    const reviewerAgentId = randomUUID();
    const policy = resolveProjectDefaultIssueExecutionPolicy(reviewStagePolicy(reviewerAgentId));

    expect(policy).not.toBeNull();
    expect(policy?.mode).toBe("normal");
    expect(policy?.commentRequired).toBe(true);
    expect(policy?.stages).toHaveLength(1);
    expect(policy?.stages[0]?.type).toBe("review");
    expect(policy?.stages[0]?.id).toBeTruthy();
    expect(policy?.stages[0]?.participants).toEqual([
      { id: expect.any(String), type: "agent", agentId: reviewerAgentId, userId: null },
    ]);
  });

  it("returns null for an empty policy so issues keep a null policy", () => {
    expect(resolveProjectDefaultIssueExecutionPolicy({ mode: "normal", stages: [] })).toBeNull();
  });

  it("returns null instead of throwing when the stored default is malformed", () => {
    // A bad project row must not turn every issue create in that project into a
    // 422; `normalizeIssueExecutionPolicy` throws for the same input.
    const malformed = { mode: "normal", stages: [{ type: "not_a_stage_type", participants: [] }] };

    expect(() => normalizeIssueExecutionPolicy(malformed)).toThrow();
    expect(resolveProjectDefaultIssueExecutionPolicy(malformed)).toBeNull();
    expect(resolveProjectDefaultIssueExecutionPolicy("nonsense")).toBeNull();
  });
});
