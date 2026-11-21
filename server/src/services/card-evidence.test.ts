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
});
