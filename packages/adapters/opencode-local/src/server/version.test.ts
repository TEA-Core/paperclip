import { describe, expect, it } from "vitest";
import { OPENCODE_V2_SUPPORTED_CLI_VERSIONS } from "../index.js";
import { buildOpenCodeRunArgs } from "./execute.js";
import {
  isOpenCodeV2CliVersion,
  isSupportedOpenCodeV2CliVersion,
  unsupportedOpenCodeV2CliVersionMessage,
} from "./version.js";

describe("OpenCode V2 detection", () => {
  it("treats every 2.x version string as V2 and nothing else", () => {
    expect(isOpenCodeV2CliVersion("2.2.4")).toBe(true);
    expect(isOpenCodeV2CliVersion("2.0.26")).toBe(true);
    expect(isOpenCodeV2CliVersion("v2.9.0")).toBe(true);
    expect(isOpenCodeV2CliVersion("1.18.33")).toBe(false);
    expect(isOpenCodeV2CliVersion("")).toBe(false);
    expect(isOpenCodeV2CliVersion(undefined)).toBe(false);
    expect(isOpenCodeV2CliVersion(null)).toBe(false);
  });

  it("accepts only listed versions, so a bump is a list change", () => {
    for (const version of OPENCODE_V2_SUPPORTED_CLI_VERSIONS) {
      expect(isSupportedOpenCodeV2CliVersion(version)).toBe(true);
      expect(isOpenCodeV2CliVersion(version)).toBe(true);
    }
    expect(isSupportedOpenCodeV2CliVersion("2.0.26")).toBe(false);
    expect(isSupportedOpenCodeV2CliVersion("1.18.33")).toBe(false);
    expect(isSupportedOpenCodeV2CliVersion("")).toBe(false);
    expect(unsupportedOpenCodeV2CliVersionMessage("2.0.26")).toContain(OPENCODE_V2_SUPPORTED_CLI_VERSIONS[0]);
  });

  it("builds V2 argv from the same rule for any 2.x version", () => {
    const base = { dir: "/work", model: "p/m", variant: "high", extraArgs: [], printLogs: false, resumeSessionId: null };
    for (const cliVersion of ["2.2.4", "2.9.9"]) {
      const args = buildOpenCodeRunArgs({ ...base, cliVersion });
      expect(args).toEqual(["run", "--standalone", "--format", "json", "--model", "p/m#high"]);
    }
    expect(buildOpenCodeRunArgs({ ...base, cliVersion: "1.18.33" })).toEqual([
      "run", "--format", "json", "--dir", "/work", "--model", "p/m", "--variant", "high",
    ]);
    expect(buildOpenCodeRunArgs({ ...base })).toEqual([
      "run", "--format", "json", "--dir", "/work", "--model", "p/m", "--variant", "high",
    ]);
  });
});
