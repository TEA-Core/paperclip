import { describe, expect, it } from "vitest";
import {
  ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS,
  buildContinuationSummaryMarkdown,
} from "../services/issue-continuation-summary.js";

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
    expect(body).toContain("- Last updated by run: run-1");
    // Identity-neutral: no prior-agent name/adapter stamp and no "Agent:" self-stamp line
    expect(body).not.toContain("CodexCoder");
    expect(body).not.toContain("codex_local");
    expect(body).not.toContain("- Agent:");
    expect(body).not.toContain("Agent:");
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

  it("neutralizes first-person phrasing in the prior run's result summary", () => {
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
        id: "run-3",
        status: "succeeded",
        error: null,
        resultJson: {
          summary: "I implemented the feature and my tests pass. Mine is ready for review.",
        },
      },
      agent: {
        id: "agent-1",
        name: "CodexCoder",
        adapterType: "codex_local",
      },
    });

    expect(body).toContain("the previous run implemented the feature and the previous run's tests pass");
    expect(body).toContain("The previous run's is ready for review");
    expect(body).not.toContain(" I ");
    expect(body).not.toContain(" my ");
    expect(body).not.toContain(" mine ");
  });

  it("strips a foreign prior-agent identity stamp (SUP-6562 lineage) from the injected summary", () => {
    const body = buildContinuationSummaryMarkdown({
      issue: {
        id: "issue-6562",
        identifier: "SUP-6562",
        title: "NEWS-SENT T6 — Operator Sentiment & Scoring panel",
        description: null,
        status: "in_progress",
        priority: "medium",
      },
      run: {
        id: "run-6562",
        status: "succeeded",
        error: null,
        resultJson: {
          // Exact SUP-6562 lineage shape that captured the Lead Engineer self-stamp.
          summary: "Agent: Lead Engineer (opencode_local)\nI reviewed the CR feedback and my changes are ready.",
        },
      },
      agent: {
        // The reader on this wake is the Frontend Engineer.
        id: "fe-agent",
        name: "Frontend Engineer",
        adapterType: "kimi-for-coding/k2p7",
      },
    });

    // No line the reader (FE) could mistake for its own identity.
    expect(body).not.toContain("Agent: Lead Engineer");
    expect(body).not.toContain("Agent:");
    // The reader's own identity must not be re-stamped into the body either.
    expect(body).not.toContain("Frontend Engineer");
    expect(body).not.toContain("kimi-for-coding/k2p7");
    // First-person prior narration is neutralized.
    expect(body).not.toContain(" I ");
    expect(body).not.toContain(" my ");
    expect(body).toContain("the previous run reviewed the CR feedback");
  });

  it("neutralizes a contaminated previous-summary Next Action carried forward", () => {
    const previousSummaryBody = [
      "# Continuation Summary",
      "",
      "## Next Action",
      "",
      "- I will run my tests next.",
    ].join("\n");

    const body = buildContinuationSummaryMarkdown({
      issue: {
        id: "issue-7",
        identifier: "PAP-7",
        title: "Carry-forward neutralization",
        description: null,
        status: "in_progress",
        priority: "medium",
      },
      run: {
        id: "run-7",
        status: "succeeded",
        error: null,
        resultJson: null,
      },
      agent: {
        id: "agent-1",
        name: "CodexCoder",
        adapterType: "codex_local",
      },
      previousSummaryBody,
    });

    // The carried-forward Next Action must not reach the next agent in first person.
    expect(body).not.toContain("I will run my tests next");
    expect(body).not.toContain(" I ");
    expect(body).not.toContain(" my ");
    expect(body).toContain("the previous run will run the previous run's tests next");
  });
});
