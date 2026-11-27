/**
 * Regression test for the guarded `heartbeat_runs.context_snapshot` write (SUP-15284).
 *
 * A driver-level failure on the snapshot UPDATE used to reach `executeRun`'s outer catch and
 * flip the issue-bound run to `setup_failed` before the agent process started (SUP-15254
 * window). The snapshot is diagnostic persistence, so every write site now runs behind
 * `runContextSnapshotWriteGuarded`: the failure is recorded — with the driver error class,
 * reachable only by walking the drizzle/postgres.js `.cause` chain — and the run continues.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildContextSnapshotWriteFailureEvent,
  contextSnapshotWriteErrorClasses,
  runContextSnapshotWriteGuarded,
  runEventErrorText,
} from "../services/heartbeat.ts";

describe("contextSnapshotWriteErrorClasses", () => {
  it("walks the bounded cause chain, reporting each frame's name", () => {
    const cause = new Error("invalid input syntax for type json");
    const driver = new Error("Failed query: update heartbeat_runs ...");
    driver.cause = cause;
    const classes = contextSnapshotWriteErrorClasses(driver);
    expect(classes.map((entry) => entry.name)).toEqual(["Error", "Error"]);
    expect(classes.map((entry) => entry.code)).toEqual([null, null]);
  });

  it("carries the Postgres error name + SQLSTATE from a driver-wrapped failure", () => {
    const postgresError = Object.assign(new Error("invalid input syntax for type json"), {
      name: "PostgresError",
      code: "22P02",
      severity: "ERROR",
    });
    const wrapped = Object.assign(new Error('Failed query: update "heartbeat_runs" ...'), {
      cause: postgresError,
    });
    const classes = contextSnapshotWriteErrorClasses(wrapped);
    expect(classes[0]).toEqual({ name: "Error", code: null });
    expect(classes[1]).toEqual({ name: "PostgresError", code: "22P02" });
  });

  it("stops at the depth bound on a long cause chain", () => {
    let current: Error = new Error("leaf");
    for (let i = 0; i < 8; i += 1) {
      const next = new Error(`frame-${i}`);
      next.cause = current;
      current = next;
    }
    const classes = contextSnapshotWriteErrorClasses(current);
    expect(classes).toHaveLength(4);
  });
});

describe("runContextSnapshotWriteGuarded", () => {
  it("resolves the write result and records nothing on success", async () => {
    const record = vi.fn();
    const result = await runContextSnapshotWriteGuarded({
      writeSite: "executeRun:dispatch-start",
      runId: "run-1",
      write: async (): Promise<number> => 42,
      fallback: -1,
      record,
    });
    expect(result).toBe(42);
    expect(record).not.toHaveBeenCalled();
  });

  it("never throws on a write failure: returns the fallback and records failure with runId/site", async () => {
    const record = vi.fn();
    const failure = new Error("Failed query: update heartbeat_runs ...");
    const result = await runContextSnapshotWriteGuarded({
      writeSite: "executeRun:dispatch-start",
      runId: "run-1",
      write: async (): Promise<number> => {
        throw failure;
      },
      fallback: -1,
      record,
    });
    expect(result).toBe(-1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      error: failure,
      writeSite: "executeRun:dispatch-start",
      runId: "run-1",
    });
  });

  it("survives even when the failure recorder itself throws", async () => {
    const result = await runContextSnapshotWriteGuarded({
      writeSite: "enqueueWakeup:same-scope-coalesce",
      runId: "run-2",
      write: async (): Promise<{ id: string }> => {
        throw new Error("driver failure");
      },
      fallback: { id: "target" },
      record: async () => {
        throw new Error("recorder failure");
      },
    });
    expect(result).toEqual({ id: "target" });
  });

  it("mirrors the incident class end-to-end: a driver 22P02 at the dispatch-start write degrades to the fallback path", async () => {
    const postgresError = Object.assign(new Error("invalid input syntax for type json"), {
      name: "PostgresError",
      code: "22P02",
      severity: "ERROR",
    });
    const wrapped = new Error('Failed query: update "heartbeat_runs" set "context_snapshot" = $1 ...');
    wrapped.cause = postgresError;
    let recordedError: unknown = null;
    const result = await runContextSnapshotWriteGuarded({
      writeSite: "executeRun:dispatch-start",
      runId: "run-3",
      write: async (): Promise<undefined> => {
        throw wrapped;
      },
      fallback: undefined,
      record: (failure) => {
        recordedError = failure.error;
      },
    });
    expect(result).toBeUndefined();
    expect(recordedError).toBe(wrapped);
    const classes = contextSnapshotWriteErrorClasses(recordedError);
    expect(classes.some((entry) => entry.name === "PostgresError" && entry.code === "22P02")).toBe(true);
  });

  it("returns the fallback even when the record callback's run-event append throws (AC3: degrade-not-throw)", async () => {
    // Mirrors the guard's record closure: it loads the run row and appends a
    // heartbeat_run_events row. If that append throws, the failure must be
    // swallowed and the guarded write must still degrade to the fallback — the
    // append can never propagate into the guarded write path.
    let appendAttempts = 0;
    const result = await runContextSnapshotWriteGuarded({
      writeSite: "executeRun:dispatch-start",
      runId: "run-append-throw",
      write: async (): Promise<number> => {
        throw new Error("driver failure");
      },
      fallback: -1,
      record: async () => {
        appendAttempts += 1;
        throw new Error("heartbeat_run_events insert failed");
      },
    });
    expect(result).toBe(-1);
    expect(appendAttempts).toBe(1);
  });

  it("keeps the run alive across a context_snapshot write failure at the coalesce site (AC4: SUP-15254 fix not regressed)", async () => {
    let recordCalls = 0;
    const result = await runContextSnapshotWriteGuarded({
      writeSite: "enqueueWakeup:same-scope-coalesce",
      runId: "run-4",
      write: async (): Promise<{ id: string }> => {
        const postgresError = Object.assign(new Error("could not extend buffer to 512000 bytes"), {
          name: "PostgresError",
          code: "53200",
        });
        const wrapped = new Error('Failed query: update "heartbeat_runs" set "context_snapshot" = $1 ...');
        wrapped.cause = postgresError;
        throw wrapped;
      },
      fallback: { id: "existing-scope-run" },
      record: (failure) => {
        recordCalls += 1;
        expect(failure.writeSite).toBe("enqueueWakeup:same-scope-coalesce");
        expect(failure.runId).toBe("run-4");
      },
    });
    // The run survives: the guarded write degrades to the prior/fallback value.
    expect(result).toEqual({ id: "existing-scope-run" });
    expect(recordCalls).toBe(1);
  });
});

describe("buildContextSnapshotWriteFailureEvent", () => {
  it("emits an error/system/error event with a non-null, verbatim error column (AC1)", () => {
    const postgresError = Object.assign(new Error("invalid input syntax for type json"), {
      name: "PostgresError",
      code: "22P02",
    });
    const wrapped = new Error('Failed query: update "heartbeat_runs" set "context_snapshot" = $1 ...');
    wrapped.cause = postgresError;

    const event = buildContextSnapshotWriteFailureEvent({
      error: wrapped,
      writeSite: "executeRun:dispatch-start",
      runId: "run-1",
    });

    expect(event.eventType).toBe("error");
    expect(event.stream).toBe("system");
    expect(event.level).toBe("error");
    // The whole point: the deepest driver error text is retained in the `error`
    // column so the failure survives where an agent can read it.
    expect(typeof event.error).toBe("string");
    expect(event.error).not.toHaveLength(0);
    expect(event.error).toBe(runEventErrorText(wrapped));
    expect(event.error).toContain("invalid input syntax for type json");
    expect(event.error).toContain("22P02");
  });

  it("records the write site and the error-class chain in the payload (AC2)", () => {
    const postgresError = Object.assign(new Error("invalid input syntax for type json"), {
      name: "PostgresError",
      code: "22P02",
    });
    const wrapped = new Error("Failed query: update heartbeat_runs ...");
    wrapped.cause = postgresError;

    const event = buildContextSnapshotWriteFailureEvent({
      error: wrapped,
      writeSite: "executeRun:dispatch-start",
      runId: "run-1",
    });

    expect(event.payload).toMatchObject({
      writeSite: "executeRun:dispatch-start",
      runId: "run-1",
    });
    expect(event.payload?.errorClasses).toEqual(contextSnapshotWriteErrorClasses(wrapped));
    expect(event.message).toContain("executeRun:dispatch-start");
    expect(event.message).toContain("without persisting this snapshot");
  });

  it("still emits a non-null error for a plain (unwrapped) driver error", () => {
    const event = buildContextSnapshotWriteFailureEvent({
      error: new Error("could not extend buffer to 512000 bytes"),
      writeSite: "executeRun:dispatch-start",
      runId: "run-2",
    });
    expect(event.error).toContain("could not extend buffer to 512000 bytes");
    expect(event.payload?.errorClasses).toEqual([{ name: "Error", code: null }]);
  });
});
