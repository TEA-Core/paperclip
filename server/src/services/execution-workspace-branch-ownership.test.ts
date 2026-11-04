import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isValidGitBranchName } from "./execution-workspace-branch-ownership.js";

describe("isValidGitBranchName", () => {
  it.each(["SUP-1-100%", "SUP-1-fix-50%-cpu", "SUP-1-%zz", "SUP-1-50%2", "SUP-1-café-修正", "SUP-1-%41", "SUP-1-100%25", "SUP-1-%2541"])(
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
    "SUP-1-%25252541",
  ])("refuses %j", (name) => {
    expect(isValidGitBranchName(name)).toBe(false);
  });

  it("refuses a deeply nested escape string without throwing", () => {
    const nested = `SUP-1-%${"25".repeat(20_000)}`;
    expect(isValidGitBranchName(nested)).toBe(false);
  });

  it.each(["-SUP-14824-1-x", "-SUP-42-x", "-", "HEAD", "SUP-1-\uD800x", "SUP-1-x\uDC00"])(
    "refuses %j, which git check-ref-format --branch refuses",
    (name) => {
      expect(isValidGitBranchName(name)).toBe(false);
    },
  );

  it.each(["a/-b", "head", "Head", "a/HEAD", "SUP-1-\uD83D\uDE00-x"])(
    "accepts %j, which git check-ref-format --branch accepts",
    (name) => {
      expect(isValidGitBranchName(name)).toBe(true);
    },
  );
});

describe("isValidGitBranchName against real git (differential corpus)", () => {
  const gitCache = new Map<string, boolean>();
  // The oracle is git itself. Two principled divergences are NOT literal
  // branch names at all: a lone `@` is git's HEAD alias and `@{...}` is
  // rev-syntax shorthand, which `git check-ref-format --branch` expands
  // instead of validating. The validator refuses both, and the corpus
  // asserts that refusal explicitly rather than comparing against the
  // expansion.
  function gitBranchAccepts(name: string): boolean {
    if (name.includes("\u0000")) return false; // cannot be passed as argv; git refuses NUL bytes
    const cached = gitCache.get(name);
    if (cached !== undefined) return cached;
    const result = spawnSync("git", ["check-ref-format", "--branch", name], { encoding: "utf8" });
    const accepted = result.status === 0;
    gitCache.set(name, accepted);
    return accepted;
  }
  function isShorthandNotLiteralName(name: string): boolean {
    return name === "@" || name.includes("@{");
  }
  function decodeOnce(candidate: string): string {
    return candidate.replace(/%([0-7][0-9a-fA-F])/g, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
  }
  // Expected verdict for a percent-encoded name, expressed only through git:
  // every decode layer (at most three passes, mirroring the documented
  // bounded-decode rule) must itself be a name git accepts, and decoding
  // must terminate.
  function gitAcceptsAfterBoundedDecode(name: string): boolean {
    let candidate = name;
    for (let pass = 0; ; pass += 1) {
      if (isShorthandNotLiteralName(candidate) || !gitBranchAccepts(candidate)) return false;
      const decoded = decodeOnce(candidate);
      if (decoded === candidate) return true;
      if (pass === 3) return false;
      candidate = decoded;
    }
  }

  function generatedCorpus(): string[] {
    const corpus = new Set<string>([""]);
    const printable: string[] = [];
    for (let code = 0x20; code <= 0x7e; code += 1) printable.push(String.fromCharCode(code));
    for (const a of printable) {
      corpus.add(a);
      for (const b of printable) corpus.add(a + b);
    }
    // Leading and trailing dots and dashes, at-signs, .lock suffixes and
    // slashes, in longer shapes than a pair can express.
    for (const name of [
      "-SUP-14824-1-x", "-SUP-42-x", "--x", "-a/b", "a/-b", "a-/b", "a/b-", "HEAD", "head", "Head",
      "a/HEAD", "HEAD/a", "@", "@@", "a@b", "@{-1}", "@{1}", "a@{b}", "@{", "a.lock", "a.LOCK",
      "a/b.lock/c", "x/.lock", "x/a.lock", ".lock", "a./b", "a/.b", "a/b.", ".a/b", "./a", "a/.",
      "a..b", "..", ".", "a//b", "/a", "a/", "a///b", "a/b/c", "feat/x.y", "SUP-1-x", "café",
      "a\u007fb", "a\u0001b", "a\tb",
    ]) corpus.add(name);
    // Control characters embedded in an otherwise ordinary name.
    for (let code = 0x00; code <= 0x1f; code += 1) corpus.add(`a${String.fromCharCode(code)}b`);
    corpus.add("a\u007fb");
    // Percent-encodings: every ASCII escape standalone and embedded, lone
    // and malformed percents, and nested encodings up to the decode bound.
    for (let code = 0x00; code <= 0x7f; code += 1) {
      const hex = code.toString(16).padStart(2, "0");
      corpus.add(`%${hex}`);
      corpus.add(`a%${hex}b`);
      corpus.add(`SUP-1-%${hex.toUpperCase()}x`);
    }
    for (const name of [
      "%", "a%", "%2", "%zz", "%2e%2e/x", "a%2fb", "%252e%252e/x", "%25252541", "%2525252541",
      "SUP-1-100%", "SUP-1-100%25", "SUP-1-%2541", "SUP-1-%25252541", "a%2525252Fb",
    ]) corpus.add(name);
    return [...corpus];
  }

  it("agrees with git check-ref-format --branch over the generated corpus", () => {
    const corpus = generatedCorpus();
    const disagreements: Array<{ name: string; validator: boolean; git: boolean }> = [];
    for (const name of corpus) {
      const validator = isValidGitBranchName(name);
      if (!name.includes("%") && isShorthandNotLiteralName(name)) {
        // Shorthand divergence: the validator must refuse what git expands.
        if (validator !== false) disagreements.push({ name, validator, git: true });
        continue;
      }
      const git = name.includes("%") ? gitAcceptsAfterBoundedDecode(name) : gitBranchAccepts(name);
      if (validator !== git) disagreements.push({ name, validator, git });
    }
    expect(disagreements).toEqual([]);
  }, 600_000);
});
