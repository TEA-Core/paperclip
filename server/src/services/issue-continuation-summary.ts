import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents, issueComments, issueDocuments, issues } from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY, type SourceTrustMetadata } from "@paperclipai/shared";
import { documentService } from "./documents.js";

export { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY };
export const ISSUE_CONTINUATION_SUMMARY_TITLE = "Continuation Summary";
export const ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS = 8_000;
const SUMMARY_SECTION_MAX_CHARS = 1_200;
const PATH_CANDIDATE_RE = /(?:^|[\s`"'(])((?:server|ui|packages|doc|scripts|\.github)\/[A-Za-z0-9._/-]+)/g;
const WAITING_FOR_REVIEW_OR_APPROVAL_RE =
  /\bwait(?:ing)? for\b.{0,160}\b(?:review(?:er)?(?: feedback)?|approval|board|human|user|operator)\b/i;

// SUP-16853: a prior run's narration sometimes asserts a comment write it never
// actually made (or that belongs to a sibling run). When that narration is
// re-injected under "Recent Concrete Actions" the next run reads it as an
// achievement and does not re-post. These detectors port the SUP-16848
// measurement's "completed-comment assertion" rule. A clause asserts a
// completed comment write when it matches either pattern below, carries no
// negation/intent marker, and is not source-code-comment narration (see the
// over-suppression guard below).
const COMPLETED_COMMENT_CLAIM_RES = [
  // passive/auxiliary: "comment posted", "comment was posted", "comment posted successfully"
  /\bcomments?\s+(?:was|were|is|are|has been|have been)?\s*(?:successfully\s+)?(?:posted|created|added|left|recorded|filed|written|submitted|landed)\b/i,
  // active: "posted a comment", "added revision comment"
  /\b(?:posted|created|added|left|recorded|filed|wrote|submitted)\s+(?:a|an|the|my|its|\d+-line|[\w-]+-line)?\s*(?:[\w-]+\s+){0,2}comments?\b/i,
];
const CLAUSE_SPLIT_RE = /[.;\n,]/;
const CLAUSE_SPLIT_CAPTURE_RE = /([.;\n,])/;
// SUP-16853 over-suppression guard (support-CR round 1, HIGH): the comment
// patterns above also match ordinary source-code-comment narration
// ("Added explanatory comments to the module", "left inline comments in the
// code", "created a comment explaining the regex"). Those are not issue-comment
// writes, so a clause carrying code/doc context is never treated as a claim.
// Deliberately fail-open: a real issue-comment claim that happens to mention
// code is left verbatim rather than risking the guard eating a real action.
const CODE_COMMENT_CONTEXT_RES = [
  /\bcode\b/,
  /\bcodebase\b/,
  /\binline\b/,
  /\bexplanatory\b/,
  /\bexplanations?\b/,
  /\bjsdoc\b/,
  /\bdocstrings?\b/,
  /\bdoc comments?\b/,
  /\bheader comments?\b/,
  /\bcommented out\b/,
  /\bannotat(?:e|ed|es|ing|ion|ions)\b/,
  /\bregex(?:es)?\b/,
  /\bmodules?\b/,
  /\bfunctions?\b/,
  /\bmethods?\b/,
  /\bclass(?:es)?\b/,
  /\bvariables?\b/,
  /\bparsers?\b/,
  /\bhelpers?\b/,
  /\bfiles?\b/,
  /\bexplaining\b/,
];
const NON_CLAIM_MARKERS = [
  "no ",
  "not ",
  "never",
  "will",
  "would",
  "needs to",
  "going to",
  "must",
  "should",
  "intend",
  "plans to",
  "trying to",
  "attempt to",
  "about to",
  "to post",
  "blocked",
  "denied",
  "could not",
  "unable",
  "fail to",
  "did not",
  "without comment",
  "instead of",
  "prior run",
  "previous run",
  "already posted",
  "had posted",
  "repeatedly posting",
  "kept posting",
];

function clauseIsCompletedCommentClaim(clause: string): boolean {
  const lower = clause.toLowerCase();
  if (NON_CLAIM_MARKERS.some((marker) => lower.includes(marker))) return false;
  if (CODE_COMMENT_CONTEXT_RES.some((re) => re.test(lower))) return false;
  return COMPLETED_COMMENT_CLAIM_RES.some((re) => re.test(clause));
}

export function summaryAssertsCompletedCommentWrite(text: string | null | undefined): boolean {
  if (!text) return false;
  return text
    .split(CLAUSE_SPLIT_RE)
    .some((clause) => clauseIsCompletedCommentClaim(clause));
}

type IssueSummaryInput = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
};

type RunSummaryInput = {
  id: string;
  status: string;
  error: string | null;
  errorCode?: string | null;
  resultJson?: Record<string, unknown> | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  finishedAt?: Date | null;
  /**
   * SUP-16853: the run's own assistant narration, sourced from its transcript
   * when `result_json.summary` is absent (the interrupted/orphaned case — run
   * `50df0b3f` asserted "the comment posted successfully" with `result_json`
   * null). Used only to *detect* an unbacked comment claim; it is never
   * surfaced verbatim, so a non-claiming interrupted run keeps the existing
   * "no result summary" line.
   */
  narrationText?: string | null;
};

type AgentSummaryInput = {
  id: string;
  name: string;
  adapterType: string | null;
};

export type IssueContinuationSummaryDocument = {
  key: typeof ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY;
  title: string | null;
  body: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  sourceTrust: SourceTrustMetadata | null;
  updatedAt: Date;
};

function truncateText(value: string, maxChars: number) {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[truncated]`;
}

function asNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readResultSummary(resultJson: Record<string, unknown> | null | undefined) {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return null;
  return (
    asNonEmptyString(resultJson.summary) ??
    asNonEmptyString(resultJson.result) ??
    asNonEmptyString(resultJson.message) ??
    asNonEmptyString(resultJson.error) ??
    null
  );
}

function extractMarkdownSection(markdown: string | null | undefined, heading: string) {
  if (!markdown) return null;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "im");
  const match = re.exec(markdown);
  const section = match?.[1]?.trim();
  return section ? truncateText(section, SUMMARY_SECTION_MAX_CHARS) : null;
}

function extractPathCandidates(...texts: Array<string | null | undefined>) {
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(PATH_CANDIDATE_RE)) {
      const path = match[1]?.replace(/[),.;:]+$/, "");
      if (path) seen.add(path);
      if (seen.size >= 12) break;
    }
    if (seen.size >= 12) break;
  }
  return [...seen];
}

function inferMode(issue: IssueSummaryInput, run: RunSummaryInput) {
  if (issue.status === "done" || issue.status === "in_review") return "review";
  if (run.status === "failed" || run.status === "timed_out" || run.status === "cancelled" || run.status === "interrupted") return "implementation";
  if (issue.status === "backlog" || issue.status === "todo") return "plan";
  return "implementation";
}

function inferNextAction(issue: IssueSummaryInput, run: RunSummaryInput, previousNextAction: string | null) {
  if (issue.status === "done") return "Review the completed issue output and close any remaining follow-up comments.";
  if (issue.status === "in_review") return "Wait for reviewer feedback or approval before continuing executor work.";
  if (run.status === "failed" || run.status === "timed_out") {
    return "Inspect the failed run, fix the cause, and resume from the most recent concrete action above.";
  }
  if (run.status === "cancelled") return "Confirm the cancellation reason before starting another run.";
  return previousNextAction ?? "Resume implementation from the acceptance criteria, latest comments, and this summary.";
}

function bulletList(items: string[], empty: string) {
  if (items.length === 0) return `- ${empty}`;
  return items.map((item) => `- ${item}`).join("\n");
}

function extractPreviousNextAction(previousBody: string | null | undefined) {
  const section = extractMarkdownSection(previousBody, "Next Action");
  if (!section) return null;
  return section
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .find(Boolean) ?? null;
}

export function extractContinuationSummaryNextAction(body: string | null | undefined) {
  return extractPreviousNextAction(body);
}

export function continuationSummaryParksExecutor(body: string | null | undefined) {
  const nextAction = extractContinuationSummaryNextAction(body);
  if (!nextAction) return false;
  return WAITING_FOR_REVIEW_OR_APPROVAL_RE.test(nextAction);
}

function unverifiedCommentClaimCaveat(run: RunSummaryInput): string {
  const endedUnsuccessfully = run.status === "interrupted" || run.status === "failed";
  const lead = endedUnsuccessfully
    ? `Prior run \`${run.id}\` ended \`${run.status}\` and its narration asserted a comment was posted, but`
    : `Prior run \`${run.id}\` narrated a comment write, but`;
  return `[${lead} no comment owned by that run (createdByRunId/derivedCreatedByRunId) was found on this issue — treat that write as unverified.]`;
}

/**
 * SUP-16853 (support-CR round 1, HIGH): reword only the offending clause(s) and
 * keep the rest of the summary. Replacing the whole line used to drop every
 * other concrete action the run narrated and assert a comment claim that was
 * not there.
 */
function rewriteUnbackedCommentClaims(text: string, run: RunSummaryInput): string {
  const tokens = text.split(CLAUSE_SPLIT_CAPTURE_RE);
  const kept: string[] = [];
  let removed = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (index % 2 === 0 && clauseIsCompletedCommentClaim(token)) {
      removed = true;
      continue;
    }
    kept.push(token);
  }
  if (!removed) return truncateText(text, SUMMARY_SECTION_MAX_CHARS);
  const keptText = kept.join("").replace(/^[.;,\s]+/, "").trim();
  const caveat = unverifiedCommentClaimCaveat(run);
  if (keptText.length === 0) return truncateText(caveat, SUMMARY_SECTION_MAX_CHARS);
  // Reserve room for the caveat so the unverified marker is never the part that
  // gets truncated away on a long summary.
  const room = Math.max(0, SUMMARY_SECTION_MAX_CHARS - caveat.length - 1);
  return `${truncateText(keptText, room)} ${caveat}`;
}

/**
 * SUP-16853: extract the run's own assistant narration from its persisted
 * ndjson log. Only assistant text frames are collected — acpx streams
 * `acpx.text_delta` (channel `output`) and opencode emits `text` items with a
 * `part.text`. Tool-call frames are deliberately ignored so a command that
 * merely mentions "comment posted" is not read as narration. Returns null when
 * the log holds no assistant text (e.g. the run was orphaned before it spoke).
 */
export function extractRunLogAssistantNarration(content: string | null | undefined): string | null {
  if (!content) return null;
  const parts: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const chunk = (entry as { chunk?: unknown } | null)?.chunk;
    if (typeof chunk !== "string") continue;
    let frame: unknown;
    try {
      frame = JSON.parse(chunk);
    } catch {
      continue;
    }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) continue;
    const record = frame as Record<string, unknown>;
    const type = record.type;
    if (type === "acpx.text_delta" && record.channel === "output" && typeof record.text === "string") {
      parts.push(record.text);
      continue;
    }
    const part = record.part;
    if (type === "text" && part && typeof part === "object" && !Array.isArray(part)) {
      const partText = (part as Record<string, unknown>).text;
      if (typeof partText === "string") parts.push(partText);
      continue;
    }
    if (type === "agentMessage" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  const narration = parts.join("").trim();
  return narration.length > 0 ? narration : null;
}

export function buildContinuationSummaryMarkdown(input: {
  issue: IssueSummaryInput;
  run: RunSummaryInput;
  agent: AgentSummaryInput;
  previousSummaryBody?: string | null;
  /**
   * SUP-16853: whether the run owns at least one comment artifact on its target
   * issue (`issue_comments.created_by_run_id` / `derived_created_by_run_id` =
   * `run.id`). When `false` and the summary asserts a completed comment write,
   * the claim is reworded so it does not read as an achievement. Absent/`true`
   * leaves the summary verbatim (never over-suppress a backed claim).
   */
  runOwnedCommentArtifact?: boolean | null;
}) {
  const { issue, run, agent } = input;
  const resultSummary = readResultSummary(run.resultJson);
  // The claim may live in `result_json.summary` (the six misattribution cases)
  // or, when that is null (the interrupted named case), in the run transcript
  // the caller supplies. Detection only — narration is never surfaced verbatim.
  const claimSource = resultSummary ?? run.narrationText ?? null;
  const unbackedCommentClaim =
    claimSource != null &&
    input.runOwnedCommentArtifact === false &&
    summaryAssertsCompletedCommentWrite(claimSource);

  const summaryLine =
    resultSummary != null
      ? unbackedCommentClaim
        ? rewriteUnbackedCommentClaims(resultSummary, run)
        : truncateText(resultSummary, SUMMARY_SECTION_MAX_CHARS)
      : unbackedCommentClaim
        ? unverifiedCommentClaimCaveat(run)
        : "No adapter-provided result summary was captured for this run.";

  const recentActions = [
    `Run \`${run.id}\` finished with status \`${run.status}\`${run.finishedAt ? ` at ${run.finishedAt.toISOString()}` : ""}.`,
    summaryLine,
  ];
  if (run.error) {
    recentActions.push(`Latest run error${run.errorCode ? ` (${run.errorCode})` : ""}: ${truncateText(run.error, 500)}`);
  }

  const paths = extractPathCandidates(resultSummary, run.stdoutExcerpt, run.stderrExcerpt, input.previousSummaryBody);
  const objective = extractMarkdownSection(issue.description, "Objective") ?? issue.description?.trim() ?? "No objective captured.";
  const acceptanceCriteria = extractMarkdownSection(issue.description, "Acceptance Criteria") ?? "No explicit acceptance criteria captured.";
  const mode = inferMode(issue, run);
  const nextAction = inferNextAction(issue, run, extractPreviousNextAction(input.previousSummaryBody));

  const body = [
    "# Continuation Summary",
    "",
    `- Issue: ${issue.identifier ?? issue.id} — ${issue.title}`,
    `- Status: ${issue.status}`,
    `- Priority: ${issue.priority}`,
    `- Current mode: ${mode}`,
    `- Last updated by run: ${run.id}`,
    `- Agent: ${agent.name} (${agent.adapterType ?? "unknown"})`,
    "",
    "## Objective",
    "",
    truncateText(objective, SUMMARY_SECTION_MAX_CHARS),
    "",
    "## Acceptance Criteria",
    "",
    acceptanceCriteria,
    "",
    "## Recent Concrete Actions",
    "",
    bulletList(recentActions, "No recent actions captured."),
    "",
    "## Files / Routes Touched",
    "",
    bulletList(paths.map((path) => `\`${path}\``), "No file or route paths were detected in the captured run summary."),
    "",
    "## Commands Run",
    "",
    bulletList(
      [
        `Heartbeat run \`${run.id}\` invoked adapter \`${agent.adapterType ?? "unknown"}\`.`,
        "Detailed shell/tool commands remain in the run log and transcript.",
      ],
      "No command metadata captured.",
    ),
    "",
    "## Blockers / Decisions",
    "",
    bulletList(
      run.error
        ? [`Latest run ended with \`${run.status}\`; inspect the error before continuing.`]
        : ["No new blocker was recorded by the latest run."],
      "No blockers or decisions captured.",
    ),
    "",
    "## Next Action",
    "",
    `- ${nextAction}`,
  ].join("\n");

  return truncateText(body, ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS);
}

export async function getIssueContinuationSummaryDocument(
  db: Db,
  issueId: string,
): Promise<IssueContinuationSummaryDocument | null> {
  const row = await db
    .select({
      key: issueDocuments.key,
      title: documents.title,
      body: documents.latestBody,
      latestRevisionId: documents.latestRevisionId,
      latestRevisionNumber: documents.latestRevisionNumber,
      sourceTrust: documents.sourceTrust,
      updatedAt: documents.updatedAt,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY)))
    .then((rows) => rows[0] ?? null);

  if (!row) return null;
  return {
    key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    title: row.title,
    body: row.body,
    latestRevisionId: row.latestRevisionId,
    latestRevisionNumber: row.latestRevisionNumber,
    sourceTrust: row.sourceTrust ?? null,
    updatedAt: row.updatedAt,
  };
}

export async function refreshIssueContinuationSummary(input: {
  db: Db;
  issueId: string;
  run: RunSummaryInput;
  agent: AgentSummaryInput;
}) {
  const { db, issueId, run, agent } = input;
  const [issue, existing, runOwnsCommentArtifact] = await Promise.all([
    db
      .select({
        id: issues.id,
        conversationAgentId: issues.conversationAgentId,
        identifier: issues.identifier,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        priority: issues.priority,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null),
    getIssueContinuationSummaryDocument(db, issueId),
    // SUP-16853: does this run own a (non-deleted) comment on the issue? This is
    // the "run-owned artifact" that legitimately backs a claimed comment write.
    db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, issueId),
          isNull(issueComments.deletedAt),
          or(
            eq(issueComments.createdByRunId, run.id),
            eq(issueComments.derivedCreatedByRunId, run.id),
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows.length > 0),
  ]);

  if (!issue || issue.conversationAgentId) return null;
  const body = buildContinuationSummaryMarkdown({
    issue,
    run,
    agent,
    previousSummaryBody: existing?.body ?? null,
    runOwnedCommentArtifact: runOwnsCommentArtifact,
  });
  const result = await documentService(db).upsertIssueDocument({
    issueId,
    key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    title: ISSUE_CONTINUATION_SUMMARY_TITLE,
    format: "markdown",
    body,
    baseRevisionId: existing?.latestRevisionId ?? null,
    changeSummary: `Refresh continuation summary after run ${run.id}`,
    createdByAgentId: agent.id,
    createdByRunId: run.id,
  });
  return result.document;
}
