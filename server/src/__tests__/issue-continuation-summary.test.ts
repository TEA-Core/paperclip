import { describe, expect, it } from "vitest";
import {
  ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS,
  buildContinuationSummaryMarkdown,
  continuationSummaryParksExecutor,
  extractContinuationSummaryNextAction,
  summaryAssertsCompletedCommentWrite,
} from "../services/issue-continuation-summary.js";

function baseIssue() {
  return {
    id: "issue-1",
    identifier: "PAP-1579",
    title: "Add continuation summaries",
    description: null,
    status: "in_progress",
    priority: "medium",
  };
}

function baseAgent() {
  return {
    id: "agent-1",
    name: "CodexCoder",
    adapterType: "codex_local",
  };
}

describe("issue continuation summaries", () => {
  it("builds bounded issue-local handoff context with required sections", () => {
    const body = buildContinuationSummaryMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-1579",
        title: "Add continuation summaries",
        description: [
          "## Objective",
          "",
          "Keep work resumable after adapter session reset.",
          "",
          "## Acceptance Criteria",
          "",
          "- Summary is issue-local",
          "- Wake context includes the summary",
        ].join("\n"),
        status: "in_progress",
        priority: "medium",
      },
      run: {
        id: "run-1",
        status: "succeeded",
        error: null,
        resultJson: {
          summary: "Updated server/src/services/heartbeat.ts and packages/adapter-utils/src/server-utils.ts.",
        },
        stdoutExcerpt: null,
        stderrExcerpt: null,
        finishedAt: new Date("2026-04-18T12:00:00.000Z"),
      },
      agent: {
        id: "agent-1",
        name: "CodexCoder",
        adapterType: "codex_local",
      },
    });

    expect(body).toContain("# Continuation Summary");
    expect(body).toContain("## Objective");
    expect(body).toContain("Keep work resumable after adapter session reset.");
    expect(body).toContain("## Acceptance Criteria");
    expect(body).toContain("- Summary is issue-local");
    expect(body).toContain("## Recent Concrete Actions");
    expect(body).toContain("Run `run-1` finished with status `succeeded`");
    expect(body).toContain("`server/src/services/heartbeat.ts`");
    expect(body).toContain("## Commands Run");
    expect(body).toContain("## Blockers / Decisions");
    expect(body).toContain("## Next Action");
    expect(body.length).toBeLessThanOrEqual(ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS);
  });

  it("uses failure state to point the next run at the error", () => {
    const body = buildContinuationSummaryMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-1579",
        title: "Add continuation summaries",
        description: null,
        status: "in_progress",
        priority: "medium",
      },
      run: {
        id: "run-2",
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        resultJson: null,
      },
      agent: {
        id: "agent-1",
        name: "CodexCoder",
        adapterType: "codex_local",
      },
    });

    expect(body).toContain("Latest run error (adapter_failed): adapter failed");
    expect(body).toContain("Inspect the failed run, fix the cause");
  });

  it("detects continuation summaries that explicitly park executor work for review", () => {
    const body = [
      "# Continuation Summary",
      "",
      "## Next Action",
      "",
      "- Wait for reviewer feedback or approval before continuing executor work.",
    ].join("\n");

    expect(extractContinuationSummaryNextAction(body)).toBe(
      "Wait for reviewer feedback or approval before continuing executor work.",
    );
    expect(continuationSummaryParksExecutor(body)).toBe(true);
  });

  it("does not park executor work when the next action is still runnable", () => {
    const body = [
      "# Continuation Summary",
      "",
      "## Next Action",
      "",
      "- Re-check run `25145432006`, then move the issue to `in_review` if the final step is green.",
    ].join("\n");

    expect(continuationSummaryParksExecutor(body)).toBe(false);
  });

  describe("SUM-16853 comment-write narration guard", () => {
    it("rewords an unbacked completed-comment claim so it does not read as an achievement", () => {
      const body = buildContinuationSummaryMarkdown({
        issue: baseIssue(),
        run: {
          id: "run-phantom",
          status: "succeeded",
          error: null,
          resultJson: {
            summary:
              "The comment was posted successfully to the issue. Also updated server/src/services/foo.ts.",
          },
        },
        agent: baseAgent(),
        runOwnedCommentArtifact: false,
      });

      // The raw assertion must not surface as an achievement...
      expect(body).not.toContain("The comment was posted successfully");
      // ...it is reworded to flag the write as unverified...
      expect(body).toContain("no comment owned by that run");
      expect(body).toContain("Treat that write as unverified");
      // ...while the non-claim content (the file path) is still captured.
      expect(body).toContain("`server/src/services/foo.ts`");
    });

    it("keeps a completed-comment claim verbatim when a run-owned artifact backs it (no over-suppression)", () => {
      const summary = "The comment was posted successfully. Also updated server/src/services/foo.ts.";
      const body = buildContinuationSummaryMarkdown({
        issue: baseIssue(),
        run: {
          id: "run-backed",
          status: "succeeded",
          error: null,
          resultJson: { summary },
        },
        agent: baseAgent(),
        runOwnedCommentArtifact: true,
      });

      // Backed claim surfaces unchanged — the guard must not eat a real action.
      expect(body).toContain(summary);
      expect(body).not.toContain("Treat that write as unverified");
    });

    it("suppresses completed-action narration for an interrupted run with no run-owned artifact", () => {
      const body = buildContinuationSummaryMarkdown({
        issue: baseIssue(),
        run: {
          id: "run-interrupted",
          status: "interrupted",
          error: "orphaned",
          errorCode: "orphaned_running_run",
          resultJson: { summary: "the comment posted successfully" },
        },
        agent: baseAgent(),
        runOwnedCommentArtifact: false,
      });

      expect(body).toContain("ended `interrupted`");
      expect(body).toContain("Treat that write as unverified");
      expect(body).not.toContain("the comment posted successfully");
    });

    it("leaves a summary that merely denies a comment write untouched even when unbacked", () => {
      const summary = "Did not post a comment; blocked on auth and will retry next run.";
      const body = buildContinuationSummaryMarkdown({
        issue: baseIssue(),
        run: {
          id: "run-negated",
          status: "succeeded",
          error: null,
          resultJson: { summary },
        },
        agent: baseAgent(),
        runOwnedCommentArtifact: false,
      });

      // Negation/intent markers mean it is not a completed-write claim -> keep verbatim.
      expect(body).toContain(summary);
      expect(body).not.toContain("Treat that write as unverified");
    });

    it("leaves the summary line untouched when the artifact flag is not supplied", () => {
      const summary = "The comment was posted successfully.";
      const body = buildContinuationSummaryMarkdown({
        issue: baseIssue(),
        run: {
          id: "run-no-flag",
          status: "succeeded",
          error: null,
          resultJson: { summary },
        },
        agent: baseAgent(),
      });

      expect(body).toContain(summary);
    });
  });

  describe("summaryAssertsCompletedCommentWrite (SUM-16853 detector port)", () => {
    it.each([
      "the comment posted successfully", // 50df0b3f (named case)
      "Recovery summary comment posted (comment ID: 0a141eb6)", // 5294f4d4
      "Recovery from successful_run_missing_state, comment posted", // 6c564f2f
      "Added revision comment to SUP-15506 issue", // bf3a34ae
      "a recovery comment posted", // 273b8df7
      "posted a 12-line comment",
    ] as const)("detects the completed-comment assertion: %s", (text) => {
      expect(summaryAssertsCompletedCommentWrite(text)).toBe(true);
    });

    it.each([
      "did not post a comment",
      "no comment was posted yet",
      "will post the comment next run",
      "blocked from posting a comment",
      "the comment has not been created",
      "left the summary; no comment written",
    ] as const)("ignores negated or intent phrases: %s", (text) => {
      expect(summaryAssertsCompletedCommentWrite(text)).toBe(false);
    });

    it("returns false for empty or comment-free summaries", () => {
      expect(summaryAssertsCompletedCommentWrite(null)).toBe(false);
      expect(summaryAssertsCompletedCommentWrite("")).toBe(false);
      expect(summaryAssertsCompletedCommentWrite("Updated server/src/services/heartbeat.ts")).toBe(false);
    });
  });
});
