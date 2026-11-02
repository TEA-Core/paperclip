import { describe, expect, it } from "vitest";

import {
  allowsUnsupportedOpenCodeVersion,
  parseOpenCodeCliVersion,
  unsupportedOpenCodeVersionMessage,
  usesOpenCodeV2Cli,
} from "./version.js";

describe("parseOpenCodeCliVersion", () => {
  it("parses a bare semver with trailing output", () => {
    expect(parseOpenCodeCliVersion("1.18.29\n")).toEqual({
      version: "1.18.29",
      major: 1,
      supported: true,
    });
  });

  it("parses a version embedded in a CLI banner", () => {
    expect(parseOpenCodeCliVersion("opencode v2.2.4 (abc123)\n")).toEqual({
      version: "2.2.4",
      major: 2,
      supported: true,
    });
  });

  it("marks majors outside 1.x and 2.x unsupported", () => {
    expect(parseOpenCodeCliVersion("3.0.0")?.supported).toBe(false);
    expect(parseOpenCodeCliVersion("0.9.1")?.supported).toBe(false);
  });

  it("returns null when no semver is present", () => {
    expect(parseOpenCodeCliVersion("no version here")).toBeNull();
    expect(parseOpenCodeCliVersion("")).toBeNull();
  });
});

describe("usesOpenCodeV2Cli", () => {
  it("is true only for major 2", () => {
    expect(usesOpenCodeV2Cli({ version: "2.2.4", major: 2, supported: true })).toBe(true);
    expect(usesOpenCodeV2Cli({ version: "1.18.29", major: 1, supported: true })).toBe(false);
    expect(usesOpenCodeV2Cli(null)).toBe(false);
  });
});

describe("allowsUnsupportedOpenCodeVersion", () => {
  it("accepts explicit truthy values case-insensitively", () => {
    expect(
      allowsUnsupportedOpenCodeVersion({ PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION: "1" }),
    ).toBe(true);
    expect(
      allowsUnsupportedOpenCodeVersion({ PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION: "TRUE" }),
    ).toBe(true);
    expect(
      allowsUnsupportedOpenCodeVersion({ PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION: " yes " }),
    ).toBe(true);
  });

  it("rejects unset, empty and other values", () => {
    expect(allowsUnsupportedOpenCodeVersion({})).toBe(false);
    expect(
      allowsUnsupportedOpenCodeVersion({ PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION: "" }),
    ).toBe(false);
    expect(
      allowsUnsupportedOpenCodeVersion({ PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION: "0" }),
    ).toBe(false);
  });
});

describe("unsupportedOpenCodeVersionMessage", () => {
  it("names the detected version and the supported majors", () => {
    expect(
      unsupportedOpenCodeVersionMessage({ version: "3.0.0", major: 3, supported: false }),
    ).toBe("OpenCode 3.0.0 is unsupported; Paperclip supports OpenCode 1.x and 2.x.");
  });
});
