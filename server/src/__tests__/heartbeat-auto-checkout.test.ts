import { describe, expect, it } from "vitest";
import { conflict, HttpError } from "../errors.js";
import {
  isCheckoutConflictError,
  shouldAutoCheckoutIssueForWake,
} from "../services/heartbeat.ts";

describe("shouldAutoCheckoutIssueForWake", () => {
  it("auto-checks out an assigned todo issue for an actionable wake", () => {
    expect(shouldAutoCheckoutIssueForWake({
      contextSnapshot: { wakeReason: "issue_assigned" },
      issueStatus: "todo",
      issueAssigneeAgentId: "agent-1",
      isDependencyReady: true,
      agentId: "agent-1",
    })).toBe(true);
  });

  it("does not auto-checkout pending execution-review state even if the row status is todo", () => {
    const reviewerAgentId = "11111111-1111-4111-8111-111111111111";
    const coderAgentId = "22222222-2222-4222-8222-222222222222";
    expect(shouldAutoCheckoutIssueForWake({
      contextSnapshot: { wakeReason: "issue_recovery_action_restored" },
      issueStatus: "todo",
      issueAssigneeAgentId: reviewerAgentId,
      issueExecutionState: {
        status: "pending",
        currentStageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: coderAgentId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
      isDependencyReady: true,
      agentId: reviewerAgentId,
    })).toBe(false);
  });
});

describe("isCheckoutConflictError", () => {
  it("treats the generic 409 'Issue checkout conflict' as a conflict", () => {
    const error = conflict("Issue checkout conflict", {
      issueId: "i1",
      status: "in_progress",
      assigneeAgentId: "agent-1",
      checkoutRunId: "run-1",
      executionRunId: "run-1",
    });
    expect(error.status).toBe(409);
    expect(isCheckoutConflictError(error)).toBe(true);
  });

  it("treats a done-card terminal-refusal 409 as a benign conflict", () => {
    const error = conflict("Issue cannot be checked out because it is already closed", {
      code: "checkout_refused_terminal_status",
      issueId: "i1",
      status: "done",
    });
    expect(error.status).toBe(409);
    expect(error.message).not.toBe("Issue checkout conflict");
    expect(isCheckoutConflictError(error)).toBe(true);
  });

  it("treats a cancelled-card terminal-refusal 409 as a benign conflict", () => {
    const error = conflict("Issue cannot be checked out because it is already closed", {
      code: "checkout_refused_terminal_status",
      issueId: "i1",
      status: "cancelled",
    });
    expect(isCheckoutConflictError(error)).toBe(true);
  });

  it("does not treat an unrelated 409 carrying a different code as a conflict", () => {
    const error = conflict("Some other conflict", {
      code: "checkout_something_else",
      status: "done",
    });
    expect(error.status).toBe(409);
    expect(isCheckoutConflictError(error)).toBe(false);
  });

  it("does not treat a 409 without a code in details as a conflict", () => {
    const error = conflict("Checkout rejected", { issueId: "i1", status: "done" });
    expect(error.status).toBe(409);
    expect(isCheckoutConflictError(error)).toBe(false);
  });

  it("does not treat a non-409 HttpError as a conflict", () => {
    expect(isCheckoutConflictError(new HttpError(404, "Issue not found"))).toBe(false);
  });

  it("does not treat a non-HttpError as a conflict", () => {
    expect(isCheckoutConflictError(new Error("Issue checkout conflict"))).toBe(false);
    expect(isCheckoutConflictError(null)).toBe(false);
    expect(isCheckoutConflictError({ status: 409, message: "Issue checkout conflict" })).toBe(
      false,
    );
  });
});
