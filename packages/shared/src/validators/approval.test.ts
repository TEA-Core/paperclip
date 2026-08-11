import { describe, expect, it } from "vitest";
import {
  createApprovalSchema,
  addApprovalCommentSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
} from "./approval.js";

describe("approval validators", () => {
  it("passes real line breaks through unchanged", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\n\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\n\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
  });

  it("accepts null and omitted optional decision notes", () => {
    expect(resolveApprovalSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(resolveApprovalSchema.parse({}).decisionNote).toBeUndefined();
    expect(requestApprovalRevisionSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(requestApprovalRevisionSchema.parse({}).decisionNote).toBeUndefined();
  });

  it("normalizes escaped line breaks in approval comments and decision notes", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\\n\\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\\n\\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
    expect(requestApprovalRevisionSchema.parse({ decisionNote: "Decision\\r\\nRevise." }).decisionNote)
      .toBe("Decision\nRevise.");
  });
});

describe("createApprovalSchema issue-gating validation", () => {
  it("requires non-empty issueIds for request_board_approval", () => {
    expect(() =>
      createApprovalSchema.parse({
        type: "request_board_approval",
        payload: { title: "Approve" },
      }),
    ).toThrow();
  });

  it("rejects empty issueIds array for request_board_approval", () => {
    expect(() =>
      createApprovalSchema.parse({
        type: "request_board_approval",
        payload: { title: "Approve" },
        issueIds: [],
      }),
    ).toThrow();
  });

  it("accepts non-empty issueIds for request_board_approval", () => {
    const parsed = createApprovalSchema.parse({
      type: "request_board_approval",
      payload: { title: "Approve" },
      issueIds: ["00000000-0000-0000-0000-000000000001"],
    });
    expect(parsed.issueIds).toEqual(["00000000-0000-0000-0000-000000000001"]);
  });

  it("allows missing issueIds for hire_agent", () => {
    const parsed = createApprovalSchema.parse({
      type: "hire_agent",
      payload: { agentId: "agent-1" },
    });
    expect(parsed.issueIds).toBeUndefined();
  });

  it("requires non-empty issueIds for budget_override_required", () => {
    expect(() =>
      createApprovalSchema.parse({
        type: "budget_override_required",
        payload: { title: "Override" },
      }),
    ).toThrow();
  });

  it("rejects empty issueIds array for budget_override_required", () => {
    expect(() =>
      createApprovalSchema.parse({
        type: "budget_override_required",
        payload: { title: "Override" },
        issueIds: [],
      }),
    ).toThrow();
  });

  it("accepts non-empty issueIds for budget_override_required", () => {
    const parsed = createApprovalSchema.parse({
      type: "budget_override_required",
      payload: { title: "Override" },
      issueIds: ["00000000-0000-0000-0000-000000000001"],
    });
    expect(parsed.issueIds).toEqual(["00000000-0000-0000-0000-000000000001"]);
  });

  it("allows missing issueIds for approve_ceo_strategy", () => {
    const parsed = createApprovalSchema.parse({
      type: "approve_ceo_strategy",
      payload: { title: "Strategy" },
    });
    expect(parsed.issueIds).toBeUndefined();
  });
});
