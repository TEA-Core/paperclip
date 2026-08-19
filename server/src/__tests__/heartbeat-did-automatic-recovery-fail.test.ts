import { describe, expect, it } from "vitest";
import {
  didAutomaticRecoveryFail,
  EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON,
} from "../services/heartbeat.ts";

describe("didAutomaticRecoveryFail", () => {
  it("returns true for an interrupted run whose retry reason matches (issue_continuation_needed)", () => {
    expect(
      didAutomaticRecoveryFail(
        { status: "interrupted", contextSnapshot: { retryReason: "issue_continuation_needed" } },
        "issue_continuation_needed",
      ),
    ).toBe(true);
  });

  it("returns true for an interrupted run whose retry reason matches (execution_review_participant_recovery)", () => {
    expect(
      didAutomaticRecoveryFail(
        {
          status: "interrupted",
          contextSnapshot: { retryReason: EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON },
        },
        EXECUTION_REVIEW_PARTICIPANT_RECOVERY_RETRY_REASON,
      ),
    ).toBe(true);
  });

  it("returns false when the snapshot retry reason does not match the expected retry reason", () => {
    expect(
      didAutomaticRecoveryFail(
        { status: "interrupted", contextSnapshot: { retryReason: "assignment_recovery" } },
        "issue_continuation_needed",
      ),
    ).toBe(false);
  });

  it("returns false for a succeeded run with a matching retry reason", () => {
    expect(
      didAutomaticRecoveryFail(
        { status: "succeeded", contextSnapshot: { retryReason: "issue_continuation_needed" } },
        "issue_continuation_needed",
      ),
    ).toBe(false);
  });

  it("returns false for a null latestRun", () => {
    expect(didAutomaticRecoveryFail(null, "issue_continuation_needed")).toBe(false);
  });
});
