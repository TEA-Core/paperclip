import { describe, expect, it } from "vitest";
import {
  LOW_TRUST_REVIEW_PRESET,
  LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import {
  assertIssueExecutionPolicySatisfiable,
} from "../services/trust-preset-resolver.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const rootIssueId = "66666666-6666-4666-8666-666666666666";
const projectId = "33333333-3333-4333-8333-333333333333";

describe("assertIssueExecutionPolicySatisfiable", () => {
  it("rejects an unsatisfiable low-trust authorizationPolicy with no boundary scope", () => {
    const unsatisfiablePolicy = {
      mode: "normal",
      stages: [],
      commentRequired: true,
      authorizationPolicy: {
        mode: "low_trust_review",
        reviewPreset: {
          id: "low_trust_review",
          version: 1,
          rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
        },
      },
    };

    expect(() =>
      assertIssueExecutionPolicySatisfiable({
        companyId,
        executionPolicy: unsatisfiablePolicy,
      }),
    ).toThrowError(HttpError);
    try {
      assertIssueExecutionPolicySatisfiable({
        companyId,
        executionPolicy: unsatisfiablePolicy,
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      const httpErr = err as HttpError;
      expect(httpErr.status).toBe(422);
      expect(httpErr.message).toMatch(/Unsatisfiable low-trust authorization policy at write/);
      expect(httpErr.details).toMatchObject({
        reason: "missing_low_trust_boundary_scope",
      });
    }
  });

  it("accepts a satisfiable low-trust policy carrying a rootIssueId boundary", () => {
    const satisfiablePolicy = {
      mode: "normal",
      stages: [],
      commentRequired: true,
      authorizationPolicy: {
        mode: "low_trust_review",
        reviewPreset: {
          id: "low_trust_review",
          version: 1,
          rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
        },
        trustBoundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          companyId,
          rootIssueId,
        },
      },
    };

    expect(() =>
      assertIssueExecutionPolicySatisfiable({
        companyId,
        executionPolicy: satisfiablePolicy,
      }),
    ).not.toThrow();
  });

  it("accepts a satisfiable low-trust policy carrying a projectIds boundary", () => {
    const satisfiablePolicy = {
      mode: "normal",
      stages: [],
      commentRequired: true,
      authorizationPolicy: {
        mode: "low_trust_review",
        reviewPreset: {
          id: "low_trust_review",
          version: 1,
          rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
        },
        trustBoundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          companyId,
          projectIds: [projectId],
        },
      },
    };

    expect(() =>
      assertIssueExecutionPolicySatisfiable({
        companyId,
        executionPolicy: satisfiablePolicy,
      }),
    ).not.toThrow();
  });

  it("is a no-op for standard (non-low-trust) policies", () => {
    const standardPolicy = {
      mode: "normal",
      stages: [],
      commentRequired: true,
    };

    expect(() =>
      assertIssueExecutionPolicySatisfiable({
        companyId,
        executionPolicy: standardPolicy,
      }),
    ).not.toThrow();
  });

  it("is a no-op for null execution policy", () => {
    expect(() =>
      assertIssueExecutionPolicySatisfiable({
        companyId,
        executionPolicy: null,
      }),
    ).not.toThrow();
  });
});
