import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for SUP-17957.
 *
 * The `Create or update pull request` step in refresh-lockfile.yml carries a
 * PR-body heredoc (`PR_BODY=$(cat <<EOF ... EOF)`) inside its `run: |` block.
 * The heredoc body was once pasted at column 1; a YAML block scalar ends at
 * the first non-empty line indented less than the block, so the scalar
 * terminated early and GitHub failed to parse the workflow at startup (zero
 * jobs, zero-duration failure on every fold/** trigger). The server test
 * dependencies have no YAML parser, so the parse-relevant invariants are
 * asserted structurally: the run block never drops below its indent, and the
 * heredoc opener, body, and terminator all stay inside the block.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "refresh-lockfile.yml"), "utf8");
const lines = workflow.split("\n");

/**
 * Return the `run: |` script lines of the named step: everything after the
 * step's `run: |` line up to the first line indented below the 10-space
 * block content (the next step or a top-level key).
 */
function stepRunBlock(stepName: string): string[] {
  const stepIdx = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  expect(stepIdx, `workflow must declare step '${stepName}'`).toBeGreaterThanOrEqual(0);
  const runIdx = lines
    .slice(stepIdx + 1)
    .findIndex((l) => l === "        run: |");
  expect(runIdx, `step '${stepName}' must carry a run: | block`).toBeGreaterThanOrEqual(0);
  const start = stepIdx + 1 + runIdx + 1;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^ {0,9}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end);
}

describe("refresh-lockfile workflow structure (SUP-17957)", () => {
  it("keeps every column-1 line of the file a top-level key or comment", () => {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\S/.test(line)) {
        expect(
          /^[a-z-]+:|^#/.test(line),
          `line ${i + 1} is a non-key line at column 1 and would break YAML parsing: ${JSON.stringify(line)}`,
        ).toBe(true);
      }
    }
  });

  it("keeps the upsert-pr run block out of column 1", () => {
    const block = stepRunBlock("Create or update pull request");
    for (let i = 0; i < block.length; i++) {
      const line = block[i];
      if (line.length > 0) {
        expect(
          /^ {10}/.test(line),
          `run block line ${i + 1} is indented below the 10-space block content and would end the block scalar: ${JSON.stringify(line)}`,
        ).toBe(true);
      }
    }
  });

  it("keeps the PR-body heredoc fully inside the upsert-pr run block", () => {
    const block = stepRunBlock("Create or update pull request");
    const text = block.join("\n");
    expect(text, "heredoc opener must sit inside the run block").toContain("PR_BODY=$(cat <<EOF");
    expect(block.some((l) => l === "          EOF"), "heredoc terminator must stay inside the run block").toBe(true);
    expect(text, "heredoc body must stay inside the run block").toContain("## Thinking Path");
    expect(text, "post-heredoc push logic must stay inside the run block").toContain('push --force origin "$BRANCH"');
    expect(text, "post-heredoc PR create must stay inside the run block").toContain("--body \"$PR_BODY\"");
  });
});
