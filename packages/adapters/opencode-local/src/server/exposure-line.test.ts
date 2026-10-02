import { describe, expect, it } from "vitest";
import {
  OPENCODE_EXPOSURE_NAMES_MAX_BYTES,
  escapeOpenCodeExposureName,
  formatOpenCodeSkillExposureLine,
} from "./exposure-line.js";

// Frozen contract for the per-run exposure line (format v2).
// Run-log readers (for example a plugin that parses run logs to learn which
// skills a run could load, or a monitor that compares counts between runs)
// copy these regexes, the reader below and the frozen strings into their own
// golden tests. A change to any of them breaks those readers.
const EXPOSURE_LINE_V2 =
  /^\[paperclip\] skillIsolation=(shared|desired-only): run exposes (\d+) skill\(s\) via (shared skills home|per-run HOME) (.+) names=([^ ]*)(?: \+(\d+) more)?$/;
// Fallback for a line that starts like an exposure line but fails v2 (reader rule R6).
const EXPOSURE_LINE_COUNT_ONLY =
  /^\[paperclip\] skillIsolation=(shared|desired-only): run exposes (\d+) skill\(s\) via (shared skills home|per-run HOME) (\S+)/;

// Reference reader for format v2 (reader rules R1-R5).
function parseExposureLine(line: string) {
  const match = EXPOSURE_LINE_V2.exec(line.endsWith("\n") ? line.slice(0, -1) : line);
  if (!match) return null;
  const [, mode, count, via, location, list, more] = match;
  const items = list ? list.split(",") : [];
  const names: string[] = [];
  let masked = 0;
  for (const item of items) {
    // A raw "*" or "[" can only come from a run-log redaction marker (R3).
    if (/[*[]/.test(item)) {
      masked += 1;
      continue;
    }
    try {
      names.push(decodeURIComponent(item));
    } catch {
      masked += 1;
    }
  }
  const notListed = more === undefined ? 0 : Number(more);
  return {
    mode,
    count: Number(count),
    via,
    location,
    names,
    masked,
    more: notListed,
    approximate: masked > 0 || notListed > 0 || Number(count) !== items.length + notListed,
  };
}

const FROZEN_SHARED_LINE =
  "[paperclip] skillIsolation=shared: run exposes 3 skill(s) via shared skills home /paperclip/.claude/skills names=alpha-skill,beta-skill--0123456789,paperclip\n";
const FROZEN_DESIRED_ONLY_LINE =
  "[paperclip] skillIsolation=desired-only: run exposes 2 skill(s) via per-run HOME /tmp/paperclip-opencode-home-AbC123 names=gamma-skill--a1b2c3d4e5,paperclip\n";
const FROZEN_TRUNCATED_LINE =
  "[paperclip] skillIsolation=shared: run exposes 2 skill(s) via shared skills home /h names= +2 more\n";
// As persisted after the run-log redaction chain masked two secret-shaped names,
// and censorUsernameInLogs masked the home directory and a name equal to the OS user.
const FROZEN_MASKED_LINE =
  "[paperclip] skillIsolation=shared: run exposes 4 skill(s) via shared skills home /p********/.claude/skills names=[REDACTED:secret],***REDACTED***,alpha-skill,n***\n";
// As persisted when the last listed name ends in "-token" and the redactor consumed " +1".
const FROZEN_SUFFIX_MASKED_LINE =
  "[paperclip] skillIsolation=shared: run exposes 2 skill(s) via shared skills home /paperclip/.claude/skills names=a-token [REDACTED:secret] more\n";

describe("formatOpenCodeSkillExposureLine (frozen contract v2)", () => {
  it("emits the frozen shared line", () => {
    const line = formatOpenCodeSkillExposureLine({
      mode: "shared",
      names: ["paperclip", "beta-skill--0123456789", "alpha-skill"],
      location: "/paperclip/.claude/skills",
    });
    expect(line).toBe(FROZEN_SHARED_LINE);
    expect(parseExposureLine(line)).toEqual({
      mode: "shared",
      count: 3,
      via: "shared skills home",
      location: "/paperclip/.claude/skills",
      names: ["alpha-skill", "beta-skill--0123456789", "paperclip"],
      masked: 0,
      more: 0,
      approximate: false,
    });
  });

  it("emits the frozen desired-only line", () => {
    const line = formatOpenCodeSkillExposureLine({
      mode: "desired-only",
      names: ["paperclip", "gamma-skill--a1b2c3d4e5"],
      location: "/tmp/paperclip-opencode-home-AbC123",
    });
    expect(line).toBe(FROZEN_DESIRED_ONLY_LINE);
    expect(parseExposureLine(line)).toMatchObject({
      mode: "desired-only",
      count: 2,
      via: "per-run HOME",
      more: 0,
      approximate: false,
    });
  });

  it("keeps the SUP-17881 prefix, so count-only readers still match", () => {
    expect(EXPOSURE_LINE_COUNT_ONLY.exec(FROZEN_SHARED_LINE)?.slice(1)).toEqual([
      "shared",
      "3",
      "shared skills home",
      "/paperclip/.claude/skills",
    ]);
  });

  it("emits an empty list for an empty or unreadable directory", () => {
    const line = formatOpenCodeSkillExposureLine({ mode: "shared", names: [], location: "/h/.claude/skills" });
    expect(line).toBe(
      "[paperclip] skillIsolation=shared: run exposes 0 skill(s) via shared skills home /h/.claude/skills names=\n",
    );
    expect(parseExposureLine(line)).toMatchObject({ count: 0, names: [], more: 0, approximate: false });
  });

  it("sorts names by UTF-16 code unit, not by locale", () => {
    const line = formatOpenCodeSkillExposureLine({
      mode: "shared",
      names: ["b", "real-dir-skill--0123456789", "B", "a", "real-dir-skill"],
      location: "/h",
    });
    expect(parseExposureLine(line)?.names).toEqual([
      "B",
      "a",
      "b",
      "real-dir-skill",
      "real-dir-skill--0123456789",
    ]);
  });

  it("percent-escapes %, commas, =, :, *, brackets, whitespace and control characters, so every name round-trips", () => {
    const names = [
      "100%",
      "a,b",
      "MY_TOKEN=abc",
      "password:x",
      "star*name",
      "[x]",
      "my skill",
      "tab\tname",
      "line\nbreak",
      "nbsp\u00a0x",
      "ünïcode",
    ];
    expect(names.map((name) => escapeOpenCodeExposureName(name))).toEqual([
      "100%25",
      "a%2Cb",
      "MY_TOKEN%3Dabc",
      "password%3Ax",
      "star%2Aname",
      "%5Bx%5D",
      "my%20skill",
      "tab%09name",
      "line%0Abreak",
      "nbsp%C2%A0x",
      "ünïcode",
    ]);
    const line = formatOpenCodeSkillExposureLine({ mode: "shared", names, location: "/home/with space/.claude/skills" });
    expect(line.split("\n")).toEqual([expect.any(String), ""]);
    const parsed = parseExposureLine(line);
    expect(parsed?.location).toBe("/home/with space/.claude/skills");
    expect(parsed?.names).toEqual([...names].sort());
    expect(parsed).toMatchObject({ count: names.length, masked: 0, approximate: false });
  });

  it.each([
    ["ASCII", "x".repeat(238)],
    ["two-byte UTF-8", "é".repeat(119)],
    ["escaped-comma", `${",".repeat(79)}x`],
  ])("fills names= to exactly 4096 bytes with %s names, then adds +K more", (_label, filler) => {
    // 18 names; each escapes to 240 UTF-8 bytes, so 17 names + 16 commas = 4096 bytes.
    const names = Array.from({ length: 18 }, (_, i) => `${String(i).padStart(2, "0")}${filler}`);
    const line = formatOpenCodeSkillExposureLine({ mode: "shared", names, location: "/h" });
    const list = line.slice(line.indexOf(" names=") + " names=".length, line.lastIndexOf(" +"));
    expect(Buffer.byteLength(list, "utf8")).toBe(OPENCODE_EXPOSURE_NAMES_MAX_BYTES);
    expect(line.endsWith(" +1 more\n")).toBe(true);
    const parsed = parseExposureLine(line);
    expect(parsed).toMatchObject({ count: 18, more: 1, approximate: true });
    expect(parsed?.names).toEqual(names.slice(0, 17));
  });

  it("lists a sorted prefix only: no name follows one that did not fit", () => {
    const line = formatOpenCodeSkillExposureLine({ mode: "shared", names: ["b", "a".repeat(4097)], location: "/h" });
    expect(line).toBe(FROZEN_TRUNCATED_LINE);
    expect(parseExposureLine(line)).toMatchObject({ count: 2, names: [], more: 2, approximate: true });
  });

  it("fits a home of 60 names on one untruncated line", () => {
    const names = Array.from({ length: 60 }, (_, i) => `example-skill-${String(i).padStart(2, "0")}--0123456789`);
    const line = formatOpenCodeSkillExposureLine({ mode: "shared", names, location: "/paperclip/.claude/skills" });
    const parsed = parseExposureLine(line);
    expect(parsed).toMatchObject({ count: 60, more: 0, approximate: false });
    expect(parsed?.names).toEqual(names);
  });

  it("reads items masked by the run log as unknown and marks the result approximate (the `approximate_union` basis) (R3)", () => {
    expect(parseExposureLine(FROZEN_MASKED_LINE)).toEqual({
      mode: "shared",
      count: 4,
      via: "shared skills home",
      location: "/p********/.claude/skills",
      names: ["alpha-skill"],
      masked: 3,
      more: 0,
      approximate: true,
    });
  });

  it("falls back to the count when the redactor rewrote the +K more suffix (R6)", () => {
    expect(parseExposureLine(FROZEN_SUFFIX_MASKED_LINE)).toBeNull();
    expect(EXPOSURE_LINE_COUNT_ONLY.exec(FROZEN_SUFFIX_MASKED_LINE)?.[2]).toBe("2");
  });
});
