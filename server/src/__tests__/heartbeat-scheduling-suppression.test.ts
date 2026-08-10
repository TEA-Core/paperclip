import { describe, expect, it } from "vitest";
import {
  resolveHeartbeatSchedulingSuppression,
  type HeartbeatSchedulingSuppression,
} from "../services/heartbeat.js";

// SUP-9857 / SUP-12143. The `dispatch_quiesced` branch was lost when PR #146
// rewrote heartbeat.ts against a stale base. These cases pin the restored
// branch and its ordering against the two env-driven reasons so a future
// rewrite cannot silently drop it again.
describe("resolveHeartbeatSchedulingSuppression", () => {
  it("does not suppress when nothing is set", () => {
    expect(resolveHeartbeatSchedulingSuppression({}, {})).toEqual({
      suppressed: false,
      reason: null,
    } satisfies HeartbeatSchedulingSuppression);
  });

  it("suppresses worktree instances unless run execution is allowed", () => {
    expect(resolveHeartbeatSchedulingSuppression({ PAPERCLIP_IN_WORKTREE: "true" }, {})).toEqual({
      suppressed: true,
      reason: "worktree_instance",
    });

    expect(resolveHeartbeatSchedulingSuppression(
      { PAPERCLIP_IN_WORKTREE: "true" },
      { allowWorktreeRunExecution: true },
    )).toEqual({ suppressed: false, reason: null });
  });

  it("suppresses while a database restore is in progress", () => {
    expect(resolveHeartbeatSchedulingSuppression(
      { PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "1" },
      {},
    )).toEqual({ suppressed: true, reason: "database_restore_in_progress" });

    expect(resolveHeartbeatSchedulingSuppression({ PAPERCLIP_RESTORE_IN_PROGRESS: "yes" }, {}))
      .toEqual({ suppressed: true, reason: "database_restore_in_progress" });
  });

  it("suppresses dispatch while the runtime quiesce is engaged", () => {
    expect(resolveHeartbeatSchedulingSuppression({}, { dispatchQuiesced: true })).toEqual({
      suppressed: true,
      reason: "dispatch_quiesced",
    });
  });

  it("does not suppress when the quiesce is released", () => {
    expect(resolveHeartbeatSchedulingSuppression({}, { dispatchQuiesced: false })).toEqual({
      suppressed: false,
      reason: null,
    });
  });

  it("reports the env reasons ahead of the quiesce when both apply", () => {
    expect(resolveHeartbeatSchedulingSuppression(
      { PAPERCLIP_IN_WORKTREE: "true" },
      { dispatchQuiesced: true },
    )).toEqual({ suppressed: true, reason: "worktree_instance" });

    expect(resolveHeartbeatSchedulingSuppression(
      { PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS: "true" },
      { dispatchQuiesced: true },
    )).toEqual({ suppressed: true, reason: "database_restore_in_progress" });
  });
});
