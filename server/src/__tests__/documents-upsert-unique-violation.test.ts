import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { issueDocuments } from "@paperclipai/db";
import { documentService } from "../services/documents.js";
import { HttpError } from "../errors.js";

// Regression for SUP-14887: a concurrent ensureForWorkProduct races the
// issue_documents insert and the loser hits the
// issue_documents_company_issue_key_uq constraint. Postgres reports that as a
// 23505, but Drizzle wraps the driver error: the thrown value is a
// DrizzleQueryError whose own `.code` is undefined and the 23505 only lives on
// `.cause.code`. `upsertIssueDocument` must recognize that wrapped 23505 and
// convert it to the 409 conflict that ensureForWorkProduct's retry loop re-reads,
// otherwise the raw error escapes and the race fails instead of converging.
//
// This is a pure unit test (no embedded Postgres, no race timing), so it runs
// deterministically on every CI shard and pins the exact catch path that the
// pre-fix, top-level-only `isUniqueViolation` check missed.

function makeDrizzleWrappedUniqueViolation(): Error {
  const driverError = new Error(
    'duplicate key value violates unique constraint "issue_documents_company_issue_key_uq"',
  );
  driverError.code = "23505";
  driverError.constraint_name = "issue_documents_company_issue_key_uq";

  // Mirrors Drizzle's Failed-query wrapper: no top-level `.code`, the 23505 is
  // only reachable through `.cause`.
  const wrapped = new Error('Failed query: insert into "issue_documents"');
  wrapped.cause = driverError;
  return wrapped;
}

// A `db` handle whose upsert insert path reaches the issue_documents insert and
// fails it with `rejectError`. Everything before that insert resolves so the
// transaction walks the real create-then-insert flow down to the point of failure.
function mockDbThatFailsIssueDocumentInsert(rejectError: unknown): Db {
  const issueRow = { id: "issue-a", companyId: "company-a" };

  const tx = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
    }),
    insert: (table: unknown) => {
      if (table === issueDocuments) {
        return { values: () => Promise.reject(rejectError) };
      }
      return {
        values: () => ({
          returning: () => Promise.resolve([{ id: "row-1" }]),
        }),
      };
    },
    update: () => ({
      set: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
  };

  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([issueRow]),
      }),
    }),
    transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as Db;
}

describe("upsertIssueDocument unique-violation handling (SUP-14887)", () => {
  it("converts a Drizzle-wrapped 23505 on the issue_documents insert into a 409 conflict", async () => {
    const wrapped = makeDrizzleWrappedUniqueViolation();
    // Document the shape the pre-fix local helper could not see: no top-level
    // code, the 23505 lives one cause frame down.
    expect((wrapped as { code?: string }).code).toBeUndefined();
    expect((wrapped as { cause?: { code?: string } }).cause?.code).toBe("23505");

    const svc = documentService(mockDbThatFailsIssueDocumentInsert(wrapped));

    await expect(
      svc.upsertIssueDocument({
        issueId: "issue-a",
        key: "plan",
        format: "markdown",
        body: "# Plan",
        lockedDocumentStrategy: "conflict",
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof HttpError &&
        error.status === 409 &&
        error.message === "Document key already exists on this issue",
    );
  });

  it("re-throws a non-unique insert error unchanged", async () => {
    const boom = new Error('Failed query: insert into "issue_documents"');
    const svc = documentService(mockDbThatFailsIssueDocumentInsert(boom));

    await expect(
      svc.upsertIssueDocument({
        issueId: "issue-a",
        key: "plan",
        format: "markdown",
        body: "# Plan",
        lockedDocumentStrategy: "conflict",
      }),
    ).rejects.toBe(boom);
  });
});
