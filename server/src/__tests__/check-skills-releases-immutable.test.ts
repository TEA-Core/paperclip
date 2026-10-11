import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { checkReleaseDiff, parseNameStatusDiff } = require(
  "../../../scripts/check-skills-releases-immutable.mjs",
) as typeof import("../../../scripts/check-skills-releases-immutable.mjs");

const baseManifest = [
  { id: "v0", dir: "v0", releaseName: "V0" },
  { id: "v7-roster", dir: "v7-roster", releaseName: "V7" },
];

const basePinned = {
  v0: { "SKILL.md": "a".repeat(64) },
  "v7-roster": { "SKILL.md": "b".repeat(64) },
};

const changed = (diff: string) => parseNameStatusDiff(diff);

const modification = (filePath: string) => changed(`M\t${filePath}\0`);

describe("check-skills-releases-immutable", () => {
  it("rejects an existing release edit even when its pin is changed", () => {
    const findings = checkReleaseDiff({
      baseManifest,
      headManifest: baseManifest,
      basePinned,
      headPinned: { ...basePinned, v0: { "SKILL.md": "c".repeat(64) } },
      changedFiles: modification("skills-releases/paperclip/v0/SKILL.md"),
    });

    expect(findings).toHaveLength(2);
    expect(findings.join("\n")).toContain("Existing release contents are immutable");
    expect(findings.join("\n")).toContain("Existing release pin changed");
  });

  it("allows a new release directory, registry entry, and pin block", () => {
    const headManifest = [...baseManifest, { id: "v8-example", dir: "v8-example", releaseName: "V8" }];
    const headPinned = {
      ...basePinned,
      "v8-example": { "SKILL.md": "c".repeat(64) },
    };

    expect(
      checkReleaseDiff({
        baseManifest,
        headManifest,
        basePinned,
        headPinned,
        changedFiles: changed(
          [
            "A\tskills-releases/paperclip/v8-example/SKILL.md",
            "M\tskills-releases/paperclip/releases.json",
            "M\tserver/src/__tests__/bundled-skill-releases-frozen.test.ts",
          ].join("\0") + "\0",
        ),
      }),
    ).toEqual([]);
  });

  it("rejects existing registry identity changes", () => {
    const findings = checkReleaseDiff({
      baseManifest,
      headManifest: [{ id: "v0-renamed", dir: "v0", releaseName: "V0" }, baseManifest[1]],
      basePinned,
      headPinned: basePinned,
      changedFiles: modification("skills-releases/paperclip/releases.json"),
    });

    expect(findings.join("\n")).toContain("Existing release id was removed");
  });

  it("rejects a waiver without a non-empty reason", () => {
    const findings = checkReleaseDiff({
      baseManifest,
      headManifest: baseManifest,
      basePinned,
      headPinned: basePinned,
      changedFiles: modification("skills-releases/paperclip/v0/SKILL.md"),
      addedLines: ["# paperclip:allow-security skills-releases-immutable:"],
    });

    expect(findings).not.toEqual([]);
  });

  it("allows a deliberate operator waiver and requires a reason", () => {
    const findings = checkReleaseDiff({
      baseManifest,
      headManifest: baseManifest,
      basePinned,
      headPinned: { ...basePinned, v0: { "SKILL.md": "c".repeat(64) } },
      changedFiles: modification("skills-releases/paperclip/v0/SKILL.md"),
      addedLines: ["# paperclip:allow-security skills-releases-immutable: deliberate operator re-seed"],
    });

    expect(findings).toEqual([]);
  });

  it("parses newline-delimited name-status output", () => {
    expect(parseNameStatusDiff("M\tskills-releases/paperclip/v0/SKILL.md\n")).toEqual([
      { status: "M", path: "skills-releases/paperclip/v0/SKILL.md" },
    ]);
  });

  it("parses NUL-delimited name-status output with tab-separated records", () => {
    expect(parseNameStatusDiff("M\tskills-releases/paperclip/v0/SKILL.md\0R100\told.md\tnew.md\0")).toEqual([
      { status: "M", path: "skills-releases/paperclip/v0/SKILL.md" },
      { status: "R", oldPath: "old.md", path: "new.md" },
    ]);
  });

  it("rejects the release edits from the #704 diff", () => {
    const findings = checkReleaseDiff({
      baseManifest,
      headManifest: baseManifest,
      basePinned,
      headPinned: basePinned,
      changedFiles: changed(
        "M\tskills-releases/paperclip/v0/SKILL.md\0M\tskills-releases/paperclip/v7-roster/SKILL.md\0",
      ),
    });

    expect(findings.join("\n")).toContain("Existing release contents are immutable");
  });
});
