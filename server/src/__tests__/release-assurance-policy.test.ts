import { describe, expect, it } from "vitest";
import {
  buildReleaseAssurancePolicy,
  evaluateReleaseAssuranceHead,
  publishReleaseAssuranceStatus,
} from "../services/release-assurance.js";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";

const AGENT = "11111111-1111-4111-8111-111111111111";
const HEAD = "d".repeat(40);

describe("release-assurance execution policy (SUP-20771, shadow)", () => {
  it("refuses the release_assurance authority on every default normalize path", () => {
    expect(() => normalizeIssueExecutionPolicy(buildReleaseAssurancePolicy(AGENT))).toThrow(/board enrollment/);
  });

  it("preserves the one-stage RA policy only for a trusted caller", () => {
    const policy = normalizeIssueExecutionPolicy(buildReleaseAssurancePolicy(AGENT), { allowReleaseAssuranceAuthority: true });
    expect(policy).toMatchObject({
      mode: "normal", commentRequired: true, approvalAuthority: "release_assurance",
      stages: [{ type: "approval", approvalsNeeded: 1, participants: [{ type: "agent", agentId: AGENT }] }],
    });
    expect(policy?.stages).toHaveLength(1);
  });

  it.each([
    ["a review stage", [{ type: "review", participants: [{ type: "agent", agentId: AGENT }] }]],
    ["two stages", [
      { type: "approval", participants: [{ type: "agent", agentId: AGENT }] },
      { type: "approval", participants: [{ type: "agent", agentId: AGENT }] },
    ]],
    ["an approval stage plus a review stage", [
      { type: "review", participants: [{ type: "agent", agentId: AGENT }] },
      { type: "approval", participants: [{ type: "agent", agentId: AGENT }] },
    ]],
    ["two participants", [{ type: "approval", participants: [
      { type: "agent", agentId: AGENT },
      { type: "agent", agentId: "22222222-2222-4222-8222-222222222222" },
    ] }]],
    ["a user participant", [{ type: "approval", participants: [{ type: "user", userId: "board-user" }] }]],
    ["no stages", []],
  ])("rejects a release_assurance policy with %s even for a trusted caller", (_label, stages) => {
    expect(() =>
      normalizeIssueExecutionPolicy({ approvalAuthority: "release_assurance", stages }, { allowReleaseAssuranceAuthority: true }),
    ).toThrow(/exactly one approval stage/);
  });

  it("leaves a normal policy byte-identical: an explicit paperclip authority is dropped, nothing is added", () => {
    const stages = [{ type: "review", participants: [{ type: "agent", agentId: AGENT }] }];
    const plain = normalizeIssueExecutionPolicy({ stages });
    const explicit = normalizeIssueExecutionPolicy({ stages, approvalAuthority: "paperclip" });
    expect(plain).not.toHaveProperty("approvalAuthority");
    expect(JSON.stringify({ ...explicit, stages: explicit?.stages.map(({ id, participants, ...rest }) => rest) }))
      .toBe(JSON.stringify({ ...plain, stages: plain?.stages.map(({ id, participants, ...rest }) => rest) }));
  });

  it("evaluates the durable veto from ledger rows", () => {
    const hold = { kind: "hold" as const, headSha: null };
    const go = { kind: "go" as const, headSha: HEAD };
    const noGo = { kind: "no_go" as const, headSha: HEAD };
    expect(evaluateReleaseAssuranceHead([go], HEAD)).toBe("not_enrolled");
    expect(evaluateReleaseAssuranceHead([hold], HEAD)).toBe("held");
    expect(evaluateReleaseAssuranceHead([hold, go], HEAD)).toBe("go");
    expect(evaluateReleaseAssuranceHead([hold, go], "e".repeat(40))).toBe("held");
    expect(evaluateReleaseAssuranceHead([hold, noGo, go], HEAD)).toBe("no_go");
    expect(evaluateReleaseAssuranceHead([hold, go, noGo], HEAD)).toBe("no_go");
  });

  it("plans a status for an enrolled PR and nothing for a non-enrolled one, with no I/O", () => {
    expect(publishReleaseAssuranceStatus({ issueId: "i", headSha: HEAD, verdict: "not_enrolled" })).toEqual({ kind: "shadow", planned: null });
    expect(publishReleaseAssuranceStatus({ issueId: "i", headSha: HEAD, verdict: "held" }).planned?.state).toBe("pending");
    expect(publishReleaseAssuranceStatus({ issueId: "i", headSha: HEAD, verdict: "no_go" }).planned?.state).toBe("failure");
    expect(publishReleaseAssuranceStatus({ issueId: "i", headSha: HEAD, verdict: "go" }).planned?.state).toBe("success");
  });
});
