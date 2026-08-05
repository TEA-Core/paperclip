import { describe, expect, it } from "vitest";
import { truncateAgentErrorReason } from "../services/heartbeat.ts";

describe("truncateAgentErrorReason", () => {
  it("returns null for null/undefined/empty input", () => {
    expect(truncateAgentErrorReason(null)).toBeNull();
    expect(truncateAgentErrorReason(undefined)).toBeNull();
    expect(truncateAgentErrorReason("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(truncateAgentErrorReason("   ")).toBeNull();
    expect(truncateAgentErrorReason("\t\n")).toBeNull();
  });

  it("passes through plain text unchanged", () => {
    expect(truncateAgentErrorReason("agent failed to start")).toBe("agent failed to start");
  });

  it("strips ANSI color escape sequences", () => {
    const input = "\x1b[31merror\x1b[0m: \x1b[1mfailed\x1b[22m";
    expect(truncateAgentErrorReason(input)).toBe("error: failed");
  });

  it("strips stacked ANSI escape sequences with multiple codes", () => {
    const input = "\x1b[1;31m\x1b[43mError\x1b[0m: \x1b[33mdetail\x1b[0m";
    expect(truncateAgentErrorReason(input)).toBe("Error: detail");
  });

  it("returns null when only whitespace remains after stripping", () => {
    expect(truncateAgentErrorReason("   \x1b[31m   ")).toBeNull();
  });

  it("strips ANSI SGR sequences with multiple parameters", () => {
    const input = "\x1b[38;5;196mfailed\x1b[0m";
    expect(truncateAgentErrorReason(input)).toBe("failed");
  });

  it("strips ANSI cursor and erase sequences", () => {
    const input = "\x1b[2K\x1b[1;1Hfailed";
    expect(truncateAgentErrorReason(input)).toBe("failed");
  });

  it("strips OSC (operating system command) sequences", () => {
    const input = "\x1b]0;title\x07failed\x1b\\";
    expect(truncateAgentErrorReason(input)).toBe("failed");
  });

  it("strips OSC sequences terminated with ST (string terminator)", () => {
    const input = "\x1b]2;window title\x07message\x1b]0;another\x07";
    expect(truncateAgentErrorReason(input)).toBe("message");
  });

  it("strips mixed ANSI and OSC sequences", () => {
    const input = "\x1b[31m\x1b]0;title\x07error\x1b[0m";
    expect(truncateAgentErrorReason(input)).toBe("error");
  });

  it("strips ANSI single-char escape sequences", () => {
    const input = "\x1bMfailed";
    expect(truncateAgentErrorReason(input)).toBe("failed");
  });

  it("trims surrounding whitespace after stripping ANSI", () => {
    const input = "\x1b[31m  failed  \x1b[0m";
    expect(truncateAgentErrorReason(input)).toBe("failed");
  });

  it("returns null when only ANSI sequences remain", () => {
    const input = "\x1b[31m\x1b[0m";
    expect(truncateAgentErrorReason(input)).toBeNull();
  });

  it("truncates to 500 characters with ellipsis", () => {
    const long = "x".repeat(600);
    const result = truncateAgentErrorReason(long);
    expect(result).toHaveLength(500);
    expect(result?.endsWith("\u2026")).toBe(true);
    expect(result?.slice(0, 499)).toBe("x".repeat(499));
  });

  it("truncates to exactly 500 characters for input of 501", () => {
    const long = "x".repeat(501);
    const result = truncateAgentErrorReason(long);
    expect(result).toHaveLength(500);
    expect(result?.endsWith("\u2026")).toBe(true);
  });

  it("does not truncate input of exactly 500 characters", () => {
    const input = "x".repeat(500);
    const result = truncateAgentErrorReason(input);
    expect(result).toHaveLength(500);
    expect(result).toBe(input);
  });

  it("does not truncate input of 499 characters", () => {
    const input = "x".repeat(499);
    const result = truncateAgentErrorReason(input);
    expect(result).toBe(input);
  });

  it("strips ANSI before truncating", () => {
    const long = "\x1b[31m" + "x".repeat(600) + "\x1b[0m";
    const result = truncateAgentErrorReason(long);
    expect(result).toHaveLength(500);
    expect(result?.endsWith("\u2026")).toBe(true);
    expect(result?.slice(0, 499)).toBe("x".repeat(499));
  });

  it("handles realistic error message with ANSI codes", () => {
    const input = "\x1b[31mError: \x1b[1mConnection refused\x1b[0m\x1b[0m";
    expect(truncateAgentErrorReason(input)).toBe("Error: Connection refused");
  });

  it("handles empty string after stripping all ANSI", () => {
    const input = "\x1b[0m\x1b[0m";
    expect(truncateAgentErrorReason(input)).toBeNull();
  });

  it("preserves non-ANSI special characters", () => {
    const input = "error: [code 42] path/to/file.ts:10";
    expect(truncateAgentErrorReason(input)).toBe("error: [code 42] path/to/file.ts:10");
  });
});
