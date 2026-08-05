import { describe, expect, it } from "vitest";
import { truncateAgentErrorReason } from "../services/heartbeat.ts";

describe("truncateAgentErrorReason", () => {
  it("returns null for null/undefined/empty input", () => {
    expect(truncateAgentErrorReason(null)).toBeNull();
    expect(truncateAgentErrorReason(undefined)).toBeNull();
    expect(truncateAgentErrorReason("")).toBeNull();
  });

  it("strips ANSI color escape sequences", () => {
    const input = "\x1b[31mError: something went wrong\x1b[0m";
    expect(truncateAgentErrorReason(input)).toBe("Error: something went wrong");
  });

  it("strips ANSI escape sequences with multiple codes", () => {
    const input = "\x1b[1;31m\x1b[43mError\x1b[0m: \x1b[33mdetail\x1b[0m";
    expect(truncateAgentErrorReason(input)).toBe("Error: detail");
  });

  it("trims whitespace", () => {
    expect(truncateAgentErrorReason("  some error  ")).toBe("some error");
  });

  it("returns null when only ANSI codes remain", () => {
    expect(truncateAgentErrorReason("\x1b[31m\x1b[0m")).toBeNull();
  });

  it("returns null when only whitespace remains after stripping", () => {
    expect(truncateAgentErrorReason("   \x1b[31m   ")).toBeNull();
  });

  it("truncates to 500 characters with ellipsis", () => {
    const longReason = "a".repeat(600);
    const result = truncateAgentErrorReason(longReason);
    expect(result).toHaveLength(500);
    expect(result?.endsWith("…")).toBe(true);
    expect(result?.slice(0, 499)).toBe("a".repeat(499));
  });

  it("does not truncate at exactly 500 characters", () => {
    const reason = "b".repeat(500);
    const result = truncateAgentErrorReason(reason);
    expect(result).toHaveLength(500);
    expect(result?.endsWith("…")).toBe(false);
  });

  it("does not truncate below 500 characters", () => {
    const reason = "c".repeat(499);
    const result = truncateAgentErrorReason(reason);
    expect(result).toBe("c".repeat(499));
  });

  it("strips ANSI then truncates", () => {
    const prefix = "\x1b[31m";
    const content = "x".repeat(510);
    const suffix = "\x1b[0m";
    const result = truncateAgentErrorReason(`${prefix}${content}${suffix}`);
    expect(result).toHaveLength(500);
    expect(result?.endsWith("…")).toBe(true);
    expect(result?.slice(0, 499)).toBe("x".repeat(499));
  });
});
