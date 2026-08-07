import { describe, expect, it } from "vitest";
import {
  resolveHeartbeatSchedulingSuppression,
  resolveSkillTestRunCompletionForHeartbeatOutcome,
} from "../services/heartbeat.ts";

describe("heartbeat scheduling suppression", () => {
  it("suppresses heartbeat scheduling for worktree runtimes", () => {
    expect(resolveHeartbeatSchedulingSuppression({
      PAPERCLIP_IN_WORKTREE: "true",
    })).toEqual({
      suppressed: true,
      reason: "worktree_instance",
    });
  });

  it("suppresses heartbeat scheduling while database restore is in progress", () => {
    expect(resolveHeartbeatSchedulingSuppression({
      PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "1",
    })).toEqual({
      suppressed: true,
      reason: "database_restore_in_progress",
    });
  });

  it("leaves normal live-plane runtimes unsuppressed", () => {
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({
      suppressed: false,
      reason: null,
    });
  });

  it("lifts worktree suppression when run execution is explicitly allowed", () => {
    expect(
      resolveHeartbeatSchedulingSuppression(
        { PAPERCLIP_IN_WORKTREE: "true" },
        { allowWorktreeRunExecution: true },
      ),
    ).toEqual({
      suppressed: false,
      reason: null,
    });
  });

  it("still suppresses database restore even when worktree run execution is allowed", () => {
    expect(
      resolveHeartbeatSchedulingSuppression(
        {
          PAPERCLIP_IN_WORKTREE: "true",
          PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "1",
        },
        { allowWorktreeRunExecution: true },
      ),
    ).toEqual({
      suppressed: true,
      reason: "database_restore_in_progress",
    });
  });

  // SUP-9857. A deploy needs to stop new dispatch without cancelling in-flight
  // runs. The suppression path already has exactly those semantics; it was only
  // readable from the environment, which a deploy script cannot change on an
  // already-running server.
  it("suppresses heartbeat scheduling while dispatch is quiesced at runtime", () => {
    expect(
      resolveHeartbeatSchedulingSuppression({}, { dispatchQuiesced: true }),
    ).toEqual({
      suppressed: true,
      reason: "dispatch_quiesced",
    });
  });

  it("reports the more fundamental reason when a restore overlaps a quiesce", () => {
    expect(
      resolveHeartbeatSchedulingSuppression(
        { PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "1" },
        { dispatchQuiesced: true },
      ),
    ).toEqual({
      suppressed: true,
      reason: "database_restore_in_progress",
    });
  });

  it("maps unsuccessful heartbeat outcomes to terminal skill test run outcomes", () => {
    expect(resolveSkillTestRunCompletionForHeartbeatOutcome("succeeded", null)).toBeNull();
    expect(resolveSkillTestRunCompletionForHeartbeatOutcome("cancelled", null)).toEqual({
      outcome: "cancelled",
      error: "Harness run was cancelled",
      heartbeatOutcome: "cancelled",
    });
    expect(resolveSkillTestRunCompletionForHeartbeatOutcome("timed_out", null)).toEqual({
      outcome: "failed",
      error: "Timed out",
      heartbeatOutcome: "timed_out",
    });
    expect(resolveSkillTestRunCompletionForHeartbeatOutcome("failed", "Adapter crashed")).toEqual({
      outcome: "failed",
      error: "Adapter crashed",
      heartbeatOutcome: "failed",
    });
  });
});
