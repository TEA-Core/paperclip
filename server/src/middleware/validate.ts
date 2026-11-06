import type { Request, Response, NextFunction } from "express";
import { ZodError, type ZodIssue, type ZodSchema } from "zod";
import { unprocessable } from "../errors.js";

/**
 * True when `value` carries an own `__proto__` key at any depth. `JSON.parse`
 * creates `__proto__` as an ordinary own key, and zod's `.strict()` strips it
 * silently instead of rejecting it, so it has to be looked for in the raw body.
 * Iterative, so an absurdly nested body cannot exhaust the stack.
 */
function hasOwnProtoKey(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    for (const key of Reflect.ownKeys(current)) {
      if (key === "__proto__") return true;
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
      if (descriptor && "value" in descriptor) pending.push(descriptor.value);
    }
  }
  return false;
}

/**
 * Every door that accepts the structured `doneTier` close declaration goes
 * through `validate` or `validateIssueMutationBody`, so the raw `doneTier` is
 * checked here, before zod parses (and silently strips) it. The refusal is the
 * generic 400 validation error. The schema itself stays a plain discriminated
 * union so tool clients keep seeing the full declaration shape.
 */
function assertNoProtoKeyInDoneTier(body: unknown): void {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return;
  const doneTier = Object.getOwnPropertyDescriptor(body, "doneTier")?.value;
  if (!hasOwnProtoKey(doneTier)) return;
  throw new ZodError([
    { code: "custom", path: ["doneTier"], message: "doneTier must not carry a __proto__ key", input: doneTier },
  ]);
}

export function validate(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    assertNoProtoKeyInDoneTier(req.body);
    req.body = schema.parse(req.body);
    next();
  };
}

// The issue create/update contract requires HTTP 422 (not the generic Zod 400)
// when a request pins an invalid executionWorkspaceSettings.workspaceStrategy
// .existingBranch: bad branch syntax, placement outside isolated_workspace +
// git_worktree, or combination with branchTemplate. All three semantic checks
// report this exact path suffix, including when an issue-creating route nests
// the settings (for example accepted-plan-decomposition children). Requests
// that also fail unrelated validation keep the long-standing 400.
const EXISTING_BRANCH_SETTINGS_PATH = [
  "executionWorkspaceSettings",
  "workspaceStrategy",
  "existingBranch",
] as const;

export function isExistingBranchSemanticsZodIssue(issue: Pick<ZodIssue, "path">): boolean {
  const pathOffset = issue.path.length - EXISTING_BRANCH_SETTINGS_PATH.length;
  return (
    pathOffset >= 0 &&
    EXISTING_BRANCH_SETTINGS_PATH.every((segment, index) => issue.path[pathOffset + index] === segment)
  );
}

export function validateIssueMutationBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      assertNoProtoKeyInDoneTier(req.body);
      req.body = schema.parse(req.body);
    } catch (err) {
      if (
        err instanceof ZodError &&
        err.issues.length > 0 &&
        err.issues.every(isExistingBranchSemanticsZodIssue)
      ) {
        // Same body shape as the generic Zod 400 response, so the
        // field-specific details are preserved verbatim.
        throw unprocessable("Validation error", err.issues);
      }
      throw err;
    }
    next();
  };
}
