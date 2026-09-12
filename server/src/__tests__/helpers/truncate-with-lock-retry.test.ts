import { describe, expect, it, vi } from "vitest";
import {
  isLateIssueCommentFkError,
  isRetryableLockError,
  isRetryableTruncateError,
  truncateWithLockRetry,
} from "./truncate-with-lock-retry.js";

const TRUNCATE_SQL = `TRUNCATE TABLE "companies" RESTART IDENTITY CASCADE`;

function postgresError(message: string, code?: string): Error & { code?: string } {
  const error = new Error(message) as Error & { code?: string };
  if (code) error.code = code;
  return error;
}

describe("isRetryableLockError", () => {
  // The regression this guards: fixtures used to retry only on the late
  // issue_comments foreign key, so a 40P01 deadlock — the failure the retry
  // loop exists for — rethrew on the first attempt and left every retry unused.
  it("recognises a 40P01 deadlock raised by the driver", () => {
    expect(isRetryableLockError(postgresError("deadlock detected", "40P01"))).toBe(true);
  });

  it("recognises a deadlock reported only in the message", () => {
    expect(isRetryableLockError(postgresError("deadlock detected"))).toBe(true);
  });

  it("recognises a deadlock wrapped in a cause chain", () => {
    const wrapped = new Error("truncate failed", {
      cause: new Error("query failed", { cause: postgresError("deadlock detected", "40P01") }),
    });
    expect(isRetryableLockError(wrapped)).toBe(true);
  });

  it("recognises lock timeout (55P03) and serialization failure (40001)", () => {
    expect(isRetryableLockError(postgresError("canceling statement due to lock timeout", "55P03"))).toBe(true);
    expect(isRetryableLockError(postgresError("could not serialize access", "40001"))).toBe(true);
  });

  it("does not treat an unrelated failure as retryable", () => {
    expect(isRetryableLockError(postgresError('relation "issues" does not exist', "42P01"))).toBe(false);
    expect(isRetryableLockError(undefined)).toBe(false);
  });

  it("stops walking a self-referencing cause chain", () => {
    const looped = postgresError("boom", "42P01") as Error & { cause?: unknown };
    looped.cause = looped;
    expect(isRetryableLockError(looped)).toBe(false);
  });
});

describe("isRetryableTruncateError", () => {
  it("still covers the late issue_comments foreign key the fixtures retried on", () => {
    const fkError = postgresError(
      'insert or update on table "issue_comments" violates foreign key constraint "issue_comments_issue_id_issues_id_fk"',
      "23503",
    );
    expect(isLateIssueCommentFkError(fkError)).toBe(true);
    expect(isRetryableTruncateError(fkError)).toBe(true);
  });

  it("covers deadlocks the foreign-key predicate alone would miss", () => {
    const deadlock = postgresError("deadlock detected", "40P01");
    expect(isLateIssueCommentFkError(deadlock)).toBe(false);
    expect(isRetryableTruncateError(deadlock)).toBe(true);
  });
});

describe("truncateWithLockRetry", () => {
  it("retries a deadlock and succeeds on a later attempt", async () => {
    const execute = vi
      .fn<(query: unknown) => Promise<unknown>>()
      .mockRejectedValueOnce(postgresError("deadlock detected", "40P01"))
      .mockRejectedValueOnce(postgresError("deadlock detected", "40P01"))
      .mockResolvedValue(undefined);

    await truncateWithLockRetry({ execute }, TRUNCATE_SQL, { baseDelayMs: 0 });

    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("rethrows a non-retryable error without consuming attempts", async () => {
    const execute = vi
      .fn<(query: unknown) => Promise<unknown>>()
      .mockRejectedValue(postgresError('relation "issues" does not exist', "42P01"));

    await expect(
      truncateWithLockRetry({ execute }, TRUNCATE_SQL, { attempts: 10, baseDelayMs: 0 }),
    ).rejects.toThrow('relation "issues" does not exist');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rethrows the last error once the attempts are spent", async () => {
    const execute = vi
      .fn<(query: unknown) => Promise<unknown>>()
      .mockRejectedValue(postgresError("deadlock detected", "40P01"));

    await expect(
      truncateWithLockRetry({ execute }, TRUNCATE_SQL, { attempts: 3, baseDelayMs: 0 }),
    ).rejects.toThrow("deadlock detected");
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
