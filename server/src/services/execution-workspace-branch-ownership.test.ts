import { describe, expect, it } from "vitest";
import { isValidGitBranchName } from "./execution-workspace-branch-ownership.js";

describe("isValidGitBranchName", () => {
  it.each(["SUP-1-100%", "SUP-1-fix-50%-cpu", "SUP-1-%zz", "SUP-1-50%2", "SUP-1-café-修正", "SUP-1-%41"])(
    "accepts %s, which git accepts",
    (name) => {
      expect(isValidGitBranchName(name)).toBe(true);
    },
  );

  it.each([
    "SUP-1-%2F..",
    "SUP-1-%2e%2e/x",
    "SUP-1-%252e%252e/x",
    "SUP-1-%00",
    "SUP-1-%20x",
    "SUP-1-x%2F",
    "SUP-1-line\nbreak",
    "SUP-1-nul\u0000byte",
    "SUP-1-../x",
    "",
    "@",
  ])("refuses %j", (name) => {
    expect(isValidGitBranchName(name)).toBe(false);
  });
});
