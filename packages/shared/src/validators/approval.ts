import { z } from "zod";
import { APPROVAL_TYPES, ISSUE_GATING_APPROVAL_TYPES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

/**
 * Plain object form of the create-approval body. Consumers that need a
 * `ZodObject` (e.g. `.merge()` for MCP tool schemas) must use this; use
 * `createApprovalSchema` for parsing so the issue-gating rule is applied.
 */
export const createApprovalObjectSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().guid().optional().nullable(),
  payload: z.record(z.string(), z.unknown()),
  issueIds: z.array(z.string().guid()).optional(),
});

/** Issue-gating approval types must be created with at least one linked issue. */
export function refineIssueGatingApprovalIssueIds(
  data: { type: string; issueIds?: string[] | undefined },
  ctx: z.RefinementCtx,
): void {
  if (
    ISSUE_GATING_APPROVAL_TYPES.includes(data.type as (typeof ISSUE_GATING_APPROVAL_TYPES)[number]) &&
    (!data.issueIds || data.issueIds.length === 0)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "issueIds must be non-empty for issue-gating approval types",
      path: ["issueIds"],
    });
  }
}

export const createApprovalSchema = createApprovalObjectSchema.superRefine(refineIssueGatingApprovalIssueIds);

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;
