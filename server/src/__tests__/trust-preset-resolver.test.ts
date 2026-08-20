import { describe, expect, it } from "vitest";
import {
  agentPermissionsSchema,
  type LowTrustBoundary,
  LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
  LOW_TRUST_REVIEW_PRESET,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import {
  assertIssueExecutionPolicySatisfiable,
  isIssueWithinLowTrustBoundary,
  resolveCoreTrustPreset,
} from "../services/trust-preset-resolver.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const projectA = "33333333-3333-4333-8333-333333333333";
const projectB = "44444444-4444-4444-8444-444444444444";
const projectC = "55555555-5555-4555-8555-555555555555";
const rootIssueId = "66666666-6666-4666-8666-666666666666";
const issueA = "77777777-7777-4777-8777-777777777777";
const issueB = "88888888-8888-4888-8888-888888888888";
const issueC = "99999999-9999-4999-8999-999999999999";
const agentA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function lowTrustBoundary(input: Partial<Omit<LowTrustBoundary, "mode">>): LowTrustBoundary {
  return {
    mode: LOW_TRUST_REVIEW_PRESET,
    companyId,
    ...input,
  };
}

function boundaryPolicy(boundary: ReturnType<typeof lowTrustBoundary>) {
  return {
    authorizationPolicy: {
      trustBoundary: boundary,
    },
  };
}

describe("resolveCoreTrustPreset", () => {
  it("defaults to standard with no boundary", () => {
    const result = resolveCoreTrustPreset({
      companyId,
      agent: { companyId, permissions: { canCreateAgents: false } },
    });

    expect(result).toMatchObject({
      kind: "standard",
      preset: "standard",
      boundary: null,
    });
  });

  it("intersects low-trust agent, project, and issue policy boundaries", () => {
    const result = resolveCoreTrustPreset({
      companyId,
      agent: {
        companyId,
        permissions: {
          trustPreset: LOW_TRUST_REVIEW_PRESET,
          authorizationPolicy: {
            managedBy: "core-trust-preset",
            trustBoundary: lowTrustBoundary({
              projectIds: [projectA, projectB],
              rootIssueId,
              issueIds: [issueA, issueB],
              allowedAgentIds: [agentA, agentB],
              allowedToolClasses: ["git.read", "tests.local"],
            }),
          },
        },
      },
      project: {
        companyId,
        executionWorkspacePolicy: boundaryPolicy(lowTrustBoundary({
          projectIds: [projectB, projectC],
          issueIds: [issueB, issueC],
          allowedAgentIds: [agentB],
          allowedToolClasses: ["git.read"],
        })),
      },
      issue: {
        companyId,
        executionPolicy: {
          authorizationPolicy: {
            trustBoundary: lowTrustBoundary({
              issueIds: [issueB],
              allowedToolClasses: ["git.read", "github.pr.read"],
            }),
          },
        },
      },
    });

    expect(result.kind).toBe("low_trust_review");
    if (result.kind !== "low_trust_review") throw new Error("expected low-trust result");
    expect(result.boundary).toMatchObject({
      companyId,
      mode: LOW_TRUST_REVIEW_PRESET,
      rootIssueId,
      projectIds: [projectB],
      issueIds: [issueB],
      allowedAgentIds: [agentB],
      allowedToolClasses: ["git.read"],
    });
    expect(isIssueWithinLowTrustBoundary(result.boundary, { companyId, id: issueB, projectId: projectB })).toBe(true);
    expect(isIssueWithinLowTrustBoundary(result.boundary, { companyId, id: issueC, projectId: projectC })).toBe(false);
  });

  it("fails closed for unknown presets", () => {
    const result = resolveCoreTrustPreset({
      companyId,
      agent: {
        companyId,
        permissions: {
          trustPreset: "trusted_but_weird",
        },
      },
    });

    expect(result).toMatchObject({
      kind: "denied",
      reason: "unsupported_trust_preset",
      source: "agent",
    });
  });

  it("fails closed when low-trust has no concrete project or issue scope", () => {
    const result = resolveCoreTrustPreset({
      companyId,
      agent: {
        companyId,
        permissions: {
          trustPreset: LOW_TRUST_REVIEW_PRESET,
          authorizationPolicy: {
            trustBoundary: lowTrustBoundary({ allowedToolClasses: ["git.read"] }),
          },
        },
      },
    });

    expect(result).toMatchObject({
      kind: "denied",
      reason: "missing_low_trust_boundary_scope",
    });
  });

  it("denies cross-company policy sources and boundaries", () => {
    const sourceMismatch = resolveCoreTrustPreset({
      companyId,
      project: {
        companyId: otherCompanyId,
        executionWorkspacePolicy: boundaryPolicy(lowTrustBoundary({ projectIds: [projectA] })),
      },
    });
    expect(sourceMismatch).toMatchObject({
      kind: "denied",
      reason: "cross_company_boundary",
      source: "project",
    });

    const boundaryMismatch = resolveCoreTrustPreset({
      companyId,
      issue: {
        companyId,
        executionPolicy: {
          authorizationPolicy: {
            trustBoundary: {
              mode: LOW_TRUST_REVIEW_PRESET,
              companyId: otherCompanyId,
              rootIssueId,
            },
          },
        },
      },
    });
    expect(boundaryMismatch).toMatchObject({
      kind: "denied",
      reason: "cross_company_boundary",
      source: "issue",
    });
  });

  it("normalizes and preserves trust policy JSON alongside existing policy data", () => {
    const permissions = agentPermissionsSchema.parse({
      canCreateAgents: false,
      trustPreset: LOW_TRUST_REVIEW_PRESET,
      authorizationPolicy: {
        managedBy: "ee-permissions",
        customEeField: { mode: "visualized" },
        trustBoundary: lowTrustBoundary({ rootIssueId }),
      },
    });
    expect(permissions.authorizationPolicy?.customEeField).toEqual({ mode: "visualized" });

    const executionPolicy = normalizeIssueExecutionPolicy({
      reviewPreset: {
        id: LOW_TRUST_REVIEW_PRESET,
        version: 1,
        rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
      },
      authorizationPolicy: {
        managedBy: "core-trust-preset",
        trustBoundary: lowTrustBoundary({ rootIssueId }),
      },
    });

    expect(executionPolicy).toMatchObject({
      stages: [],
      reviewPreset: {
        id: LOW_TRUST_REVIEW_PRESET,
        rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
      },
      authorizationPolicy: {
        managedBy: "core-trust-preset",
        trustBoundary: { rootIssueId },
      },
    });
  });
});

// A stage whose participants are ALL the policy's own returnAssigneeAgentId can
// never be decided by anyone: the runtime excludes the return assignee from
// participant selection. SUP-10602 papered over that by falling back to the
// excluded principal, which turned an unroutable gate into a self-approved one
// (28 such stages found on 2026-08-19, plus 7 review stages silently
// auto-skipped with no decision row at all). The write paths refuse it now, so
// the deadlock is prevented instead of softened.
describe("assertIssueExecutionPolicySatisfiable — self-gated stages", () => {
  const returnAssigneeAgentId = "88888888-8888-4888-8888-888888888888";
  const reviewerAgentId = "99999999-9999-4999-8999-999999999999";

  const policyWithStages = (stages: unknown[]) => ({
    mode: "normal",
    commentRequired: true,
    returnAssigneeAgentId,
    stages,
  });

  const agentStage = (type: string, ...agentIds: string[]) => ({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    type,
    approvalsNeeded: 1,
    participants: agentIds.map((agentId) => ({ type: "agent", agentId })),
  });

  it("rejects an approval stage gated solely by the return assignee", () => {
    expect(() =>
      assertIssueExecutionPolicySatisfiable({
        companyId,
        executionPolicy: policyWithStages([agentStage("approval", returnAssigneeAgentId)]),
      }),
    ).toThrow(/gated solely by its own return assignee/);
  });

  it("rejects a review stage gated solely by the return assignee", () => {
    expect(() =>
      assertIssueExecutionPolicySatisfiable({
        companyId,
        executionPolicy: policyWithStages([agentStage("review", returnAssigneeAgentId)]),
      }),
    ).toThrow(/gated solely by its own return assignee/);
  });

  it("allows a stage where the return assignee is only one of several participants", () => {
    expect(() =>
      assertIssueExecutionPolicySatisfiable({
        companyId,
        executionPolicy: policyWithStages([
          agentStage("review", returnAssigneeAgentId, reviewerAgentId),
        ]),
      }),
    ).not.toThrow();
  });

  it("allows a stage with no collision", () => {
    expect(() =>
      assertIssueExecutionPolicySatisfiable({
        companyId,
        executionPolicy: policyWithStages([agentStage("review", reviewerAgentId)]),
      }),
    ).not.toThrow();
  });

  it("allows a policy with no declared return assignee and no assignee to check against", () => {
    expect(() =>
      assertIssueExecutionPolicySatisfiable({
        companyId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [agentStage("review", reviewerAgentId)],
        },
      }),
    ).not.toThrow();
  });
});

// 33 of the 40 collisions measured on 2026-08-19 declared NO
// returnAssigneeAgentId at all: resolveReturnAssignee() seeds the excluded
// principal from the issue's own assignee, so the collision is IMPLICIT. A
// guard keyed on the declared field alone sees none of them, and the removal of
// allowSelfAsFallback turns every one into a 422 at stage advance instead — the
// SUP-10602 deadlock, back for the majority case. The write path knows the
// assignee (it is in the same create/PATCH body), so it resolves the principal
// the same way the runtime does: returnAssigneeAgentId ?? assigneeAgentId. This
// mirrors _resolve_return_assignee() in fire_issue.py.
describe("assertIssueExecutionPolicySatisfiable — implicit self-gated stages", () => {
  const assigneeAgentId = "77777777-7777-4777-8777-777777777777";
  const declaredReturnAssigneeAgentId = "88888888-8888-4888-8888-888888888888";
  const reviewerAgentId = "99999999-9999-4999-8999-999999999999";

  const agentStage = (type: string, ...agentIds: string[]) => ({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    type,
    approvalsNeeded: 1,
    participants: agentIds.map((agentId) => ({ type: "agent", agentId })),
  });

  const undeclaredPolicy = (stages: unknown[]) => ({
    mode: "normal",
    commentRequired: true,
    stages,
  });

  it("rejects an approval stage gated solely by the issue's own assignee", () => {
    expect(() =>
      assertIssueExecutionPolicySatisfiable({
        companyId,
        assigneeAgentId,
        executionPolicy: undeclaredPolicy([agentStage("approval", assigneeAgentId)]),
      }),
    ).toThrow(/gated solely by its own return assignee/);
  });

  it("rejects a review stage gated solely by the issue's own assignee", () => {
    // The review shape is the dangerous one: it does not 422, it silently
    // auto-skips on the `done` transition and leaves no decision row.
    expect(() =>
      assertIssueExecutionPolicySatisfiable({
        companyId,
        assigneeAgentId,
        executionPolicy: undeclaredPolicy([agentStage("review", assigneeAgentId)]),
      }),
    ).toThrow(/gated solely by its own return assignee/);
  });

  it("names the assignee as the source so the operator knows which field to move", () => {
    try {
      assertIssueExecutionPolicySatisfiable({
        companyId,
        assigneeAgentId,
        executionPolicy: undeclaredPolicy([agentStage("approval", assigneeAgentId)]),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const httpErr = err as HttpError;
      expect(httpErr.status).toBe(422);
      expect(httpErr.message).toMatch(/assigneeAgentId/);
      expect(httpErr.details).toMatchObject({
        stageIndex: 0,
        stageType: "approval",
        returnAssigneeAgentId: assigneeAgentId,
        returnAssigneeSource: "assigneeAgentId",
      });
    }
  });

  it("rejects the ADR-072 close ladder when the parent drifts onto its own approver", () => {
    // SUP-13489 exactly: support-QAE -> coder-LE -> exec-CTO, parent reassigned
    // onto exec-CTO, no returnAssigneeAgentId declared.
    expect(() =>
      assertIssueExecutionPolicySatisfiable({
        companyId,
        assigneeAgentId,
        executionPolicy: undeclaredPolicy([
          agentStage("review", reviewerAgentId),
          agentStage("review", declaredReturnAssigneeAgentId),
          agentStage("approval", assigneeAgentId),
        ]),
      }),
    ).toThrow(/stage 2 \(approval\)/);
  });

  it("prefers the declared return assignee over the assignee when both are present", () => {
    // A stage gated solely by the ASSIGNEE is legitimate once the policy names a
    // different return assignee: the runtime excludes the declared one, so the
    // assignee is still an eligible participant and the gate is real.
    expect(() =>
      assertIssueExecutionPolicySatisfiable({
        companyId,
        assigneeAgentId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          returnAssigneeAgentId: declaredReturnAssigneeAgentId,
          stages: [agentStage("review", assigneeAgentId)],
        },
      }),
    ).not.toThrow();
  });

  it("allows an implicit stage where the assignee is only one of several participants", () => {
    expect(() =>
      assertIssueExecutionPolicySatisfiable({
        companyId,
        assigneeAgentId,
        executionPolicy: undeclaredPolicy([
          agentStage("review", assigneeAgentId, reviewerAgentId),
        ]),
      }),
    ).not.toThrow();
  });

  it("allows an implicit policy with no collision", () => {
    expect(() =>
      assertIssueExecutionPolicySatisfiable({
        companyId,
        assigneeAgentId,
        executionPolicy: undeclaredPolicy([agentStage("review", reviewerAgentId)]),
      }),
    ).not.toThrow();
  });
});
