import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { addIssueCommentSchema, updateIssueSchema } from "@paperclipai/shared";
import { validate, validateIssueMutationBody } from "../middleware/validate.js";

// zod's .strict() strips an own `__proto__` key silently, so the request
// validation step looks for it in the raw body before zod parses. JSON.parse
// creates it as an ordinary own key, exactly as the body parser does.

const TIER2 = '"tier":"tier2","probeEvidence":"probe `x` head 3f9c1e0a25b8 post-merge: y"';
const NO_REPOSITORY = '"tier":"tier1","reason":"The deliverable is the recorded entry ruling"';

const DOORS = [
  ["validate(updateIssueSchema)", validate(updateIssueSchema), (doneTier: string) => `{"status":"done","doneTier":${doneTier}}`],
  ["validate(addIssueCommentSchema)", validate(addIssueCommentSchema), (doneTier: string) => `{"body":"closing","doneTier":${doneTier}}`],
  [
    "validateIssueMutationBody(updateIssueSchema)",
    validateIssueMutationBody(updateIssueSchema),
    (doneTier: string) => `{"status":"done","doneTier":${doneTier}}`,
  ],
] as const;

function run(middleware: (req: Request, res: Response, next: NextFunction) => void, raw: string) {
  const req = { body: JSON.parse(raw) } as Request;
  const next = vi.fn();
  let thrown: unknown;
  try {
    middleware(req, {} as Response, next);
  } catch (err) {
    thrown = err;
  }
  return { req, next, thrown };
}

describe.each(DOORS)("%s", (_name, middleware, bodyWith) => {
  it.each([
    ["inside landing", `{${NO_REPOSITORY},"landing":{"mode":"noRepositoryLanding","__proto__":{"polluted":true}}}`],
    ["at the top level", `{${NO_REPOSITORY},"__proto__":{"x":1},"landing":{"mode":"noRepositoryLanding"}}`],
    ["on a Tier 2 declaration", `{${TIER2},"__proto__":{}}`],
    ["nested inside an unrelated key", `{${TIER2},"extra":{"deep":[{"__proto__":{}}]}}`],
  ])("rejects an own __proto__ key %s with a validation error before zod parses it", (_label, doneTier) => {
    const { next, thrown } = run(middleware, bodyWith(doneTier));
    expect(thrown).toBeInstanceOf(ZodError);
    expect((thrown as ZodError).issues).toEqual([
      expect.objectContaining({ path: ["doneTier"], message: "doneTier must not carry a __proto__ key" }),
    ]);
    expect(next).not.toHaveBeenCalled();
  });

  it("still passes the same declaration without the key, through zod", () => {
    const { req, next, thrown } = run(
      middleware,
      bodyWith(`{${NO_REPOSITORY},"landing":{"mode":"noRepositoryLanding"}}`),
    );
    expect(thrown).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(req.body.doneTier).toEqual({
      tier: "tier1",
      reason: "The deliverable is the recorded entry ruling",
      landing: { mode: "noRepositoryLanding" },
    });
  });

  it("leaves an own constructor or prototype key to the strict schema", () => {
    const { thrown } = run(middleware, bodyWith(`{${TIER2},"constructor":{},"prototype":{}}`));
    expect(thrown).toBeInstanceOf(ZodError);
    expect((thrown as ZodError).issues[0]?.message).not.toContain("__proto__");
  });
});

describe("a body without doneTier", () => {
  it("is not affected, including when other keys are named like prototype members", () => {
    const { thrown, next } = run(validate(addIssueCommentSchema), '{"body":"hello"}');
    expect(thrown).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });
});
