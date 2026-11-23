import { sql } from "drizzle-orm";
import {
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issueExecutionDecisions } from "./issue_execution_decisions.js";
import { issues } from "./issues.js";

/**
 * Governed child-to-carrier attribution. One current row proves that one
 * self-sourced child delivered a complete commit set onto one strict ancestor's
 * carrier pull request. It is not publication authority: the delivery-receipt
 * claimer does not read this table.
 *
 * Only the control plane inserts a row (`written_by_actor_type = system`).
 * An agent delivery claim and a plugin write are not proof.
 */
export const ISSUE_CHILD_CARRIER_ATTRIBUTION_STATES = ["current", "invalidated"] as const;
export type IssueChildCarrierAttributionState = (typeof ISSUE_CHILD_CARRIER_ATTRIBUTION_STATES)[number];

export const issueChildCarrierAttributions = pgTable(
  "issue_child_carrier_attributions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    childIssueId: uuid("child_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    ancestorIssueId: uuid("ancestor_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    pullRequestNumber: integer("pull_request_number").notNull(),
    branchName: text("branch_name").notNull(),
    headSha: text("head_sha").notNull(),
    commitShas: text("commit_shas").array().notNull(),
    state: text("state").$type<IssueChildCarrierAttributionState>().notNull().default("current"),
    childDecisionId: uuid("child_decision_id").references(() => issueExecutionDecisions.id, { onDelete: "set null" }),
    writtenByActorType: text("written_by_actor_type").notNull(),
    writtenByActorId: text("written_by_actor_id").notNull(),
    provenance: jsonb("provenance").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  },
  (table) => ({
    currentChildUq: uniqueIndex("issue_child_carrier_attributions_current_child_uq")
      .on(table.companyId, table.childIssueId)
      .where(sql`${table.state} = 'current'`),
    historicalIdentityUq: uniqueIndex("issue_child_carrier_attributions_history_uq").on(
      table.companyId,
      table.childIssueId,
      table.provider,
      sql`lower(${table.owner})`,
      sql`lower(${table.repo})`,
      table.ancestorIssueId,
      table.pullRequestNumber,
      table.headSha,
    ),
    ancestorLookupIdx: uniqueIndex("issue_child_carrier_attributions_ancestor_current_uq")
      .on(table.companyId, table.ancestorIssueId, table.childIssueId, table.pullRequestNumber)
      .where(sql`${table.state} = 'current'`),
    stateCheck: check(
      "issue_child_carrier_attributions_state_check",
      sql`${table.state} in ('current', 'invalidated')`,
    ),
    providerCheck: check(
      "issue_child_carrier_attributions_provider_check",
      sql`${table.provider} in ('github')`,
    ),
    actorCheck: check(
      "issue_child_carrier_attributions_actor_check",
      sql`${table.writtenByActorType} = 'system'`,
    ),
    distinctIssuesCheck: check(
      "issue_child_carrier_attributions_distinct_issues_check",
      sql`${table.childIssueId} <> ${table.ancestorIssueId}`,
    ),
    pullRequestNumberCheck: check(
      "issue_child_carrier_attributions_pull_request_number_check",
      sql`${table.pullRequestNumber} > 0`,
    ),
    headShaCheck: check(
      "issue_child_carrier_attributions_head_sha_check",
      sql`${table.headSha} ~ '^[0-9a-f]{40,64}$'`,
    ),
    commitShasCheck: check(
      "issue_child_carrier_attributions_commit_shas_check",
      sql`cardinality(${table.commitShas}) > 0`,
    ),
  }),
);
