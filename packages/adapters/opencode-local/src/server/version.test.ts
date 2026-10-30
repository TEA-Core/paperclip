import { describe, expect, it } from "vitest";
import { OPENCODE_V2_CLI_VERSION } from "../index.js";
import { buildOpenCodeRunArgs } from "./execute.js";
import {
  isOpenCodeV2CliVersion,
  unsupportedDetectedOpenCodeV2CliVersionMessage,
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

  it("pins the V2 runtime to 2.2.4", () => {
    expect(OPENCODE_V2_CLI_VERSION).toBe("2.2.4");
    expect(isOpenCodeV2CliVersion(OPENCODE_V2_CLI_VERSION)).toBe(true);
  });

  it("words the configured and detected rejections for what the operator can actually do", () => {
    expect(unsupportedOpenCodeV2CliVersionMessage("2.0.26")).toBe(
      "Unsupported OpenCode CLI version: 2.0.26. Use 2.2.4 for V2 opt-in or omit cliVersion for V1.",
    );
    const detected = unsupportedDetectedOpenCodeV2CliVersionMessage("opencode", "2.3.0");
    expect(detected).toBe(
      "Unsupported OpenCode CLI version: 2.3.0 reported by opencode. Install 2.2.4 or point command at a V1 binary.",
    );
    expect(detected).not.toContain("omit cliVersion");
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
