import { nonIdleSlackIssueCondition } from "./slack-conversation-state.js";
import { and, isNull, type SQL } from "drizzle-orm";
import { issues } from "@paperclipai/db";

export function visibleIssueCondition(): SQL {
  return and(isNull(issues.hiddenAt), isNull(issues.harnessKind))!;
}

/**
 * The issue-list `includeHidden=true` read shows hidden cards but still omits
 * harness cards. Anything that counts "the cards that read returns" must use this
 * same predicate.
 */
export function includeHiddenIssueCondition(): SQL {
  return isNull(issues.harnessKind);
}

export function visibleIssueSql(alias = "issues") {
  return `"${alias}"."hidden_at" IS NULL AND "${alias}"."harness_kind" IS NULL`;
}

/** Work queues and execution totals omit persistent conversation containers. */
export function executionIssueCondition(): SQL {
  return and(visibleIssueCondition(), isNull(issues.conversationAgentId), nonIdleSlackIssueCondition())!;
}
