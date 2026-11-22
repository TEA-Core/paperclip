import { describe, expect, it } from "vitest";
import { detectEvidence } from "./card-evidence.js";

describe("card evidence parser", () => {
  it.each([
    ["pull request #12", "change-request"],
    ["Opened merge request 4.", "change-request"],
    ["PR #12", "change-request"],
    ["https://sr.ht/~team/records", "forge-domain"],
    ["https://git.sr.ht/~tea/records", "forge-domain"],
    ["https://gerrit.example.org/dashboard", "forge-label"],
    ["https://example.org/c/records/+/12345", "forge-path"],
    ["https://example.org/team/records.git", "forge-path"],
  ])("refuses %s by %s", (text, arm) => {
    expect(detectEvidence(text, "prose")?.arm).toBe(arm);
  });

  it.each([
    "This card does not use gerrit.",
    "No pull request is needed.",
    "https://example.org/policies/retention",
    "[Routine] weekly check",
    "{not json, a plain note",
  ])("allows prose %s", (text) => {
    expect(detectEvidence(text, "prose")).toBeNull();
  });

  it("refuses a truncated workspace key and allows malformed JSON with no citation", () => {
    expect(detectEvidence('{"executionWorkspaceId":"', "machine")?.arm).toBe("key");
    expect(detectEvidence("executionWorkspaceIdExtra", "machine")).toBeNull();
    expect(detectEvidence({ executionWorkspaceIdExtra: "feature/records" }, "machine")?.arm).toBe("key");
    expect(detectEvidence({ executionWorkspaceId: null }, "machine")).toBeNull();
    expect(detectEvidence("{not json", "machine")).toBeNull();
    expect(detectEvidence("a line of stdout\n{\"ok\":true}", "machine")).toBeNull();
  });

  it("does not treat a 16-hex trace id as a machine commit", () => {
    expect(detectEvidence("trace 3f9c1e0a25b8c4d2", "machine")).toBeNull();
    expect(detectEvidence("pushed 3f9c1e0a25b8", "machine")?.arm).toBe("sha");
  });

  it.each(["prose", "machine"] as const)("keeps ordinary numeric values neutral on %s surfaces", (surface) => {
    for (const value of [0, 42, -7, 0.5, [12, 34], { count: 12, total: 34 }]) {
      expect(detectEvidence(value, surface)).toBeNull();
    }
    expect(detectEvidence({ pr: 12 }, "machine")?.arm).toBe("key");
  });

  it("distinguishes staffing report keys from repository keys", () => {
    expect(detectEvidence({ reportTitle: "Weekly staffing totals" }, "machine")).toBeNull();
    expect(detectEvidence("report: weekly staffing totals", "machine")).toBeNull();
    expect(detectEvidence({ summaryTitle: "Weekly staffing totals" }, "machine")).toBeNull();
    for (const key of ["repo", "repoUrl", "source_repo", "repository", "repositoryUrl"]) {
      expect(detectEvidence({ [key]: "records" }, "machine")?.arm, key).toBe("key");
    }
  });

  it("allows a review subdomain policy URL but still detects repository paths there", () => {
    expect(detectEvidence("https://review.example.org/policies/retention", "prose")).toBeNull();
    expect(detectEvidence("https://reviews.example.org/policies/retention", "prose")).toBeNull();
    expect(detectEvidence("https://review.example.org/c/records/+/12345", "prose")?.arm).toBe("forge-path");
  });

  it("scans a typed no-workspace audit proof without mistaking its container for a binding", () => {
    const proof = { proof: "never_had_execution_workspace", executionWorkspaceId: null };
    expect(detectEvidence({ noRepositoryLanding: proof }, "machine")).toBeNull();
    expect(detectEvidence({ noRepositoryLanding: { ...proof, repository: "records" } }, "machine")?.arm).toBe("key");
    expect(detectEvidence({ noRepositoryLanding: { ...proof, note: "PR #12" } }, "machine")?.arm).toBe("change-request");
    expect(detectEvidence({ noRepositoryLanding: "records" }, "machine")?.arm).toBe("key");
  });
});
