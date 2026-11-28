import { bigint, boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * One claim per exhaustion episode of an issue's external-service monitor. The
 * scheduler inserts it in its own transaction before the recovery effect, so it
 * survives a failed completion transaction. It records the effect that ran, so a
 * retry of the same episode never repeats it. `recovery_issue_id` has no foreign
 * key: deleting the recovery issue never erases the claim. The episode is the
 * monitored issue's `monitor_arm_generation`, which every arm or re-arm of the
 * monitor increments; one arm exhausts at most once, so each later, separate
 * exhaustion gets its own claim.
 *
 * Only the current arm's claim is ever read. The arm trigger (migration 0335) deletes
 * the issue's claims for earlier generations in the same transaction that arms the
 * new generation, so superseded claims do not accumulate.
 *
 * `company_id` keeps the default ON DELETE NO ACTION, like the other issue-keyed
 * bookkeeping tables (`issue_recovery_actions`, `issue_read_states`,
 * `issue_relations`): a claim is removed with its issue (`issue_id` cascades), and
 * company deletion deletes the company's issues before the company row.
 */
export const issueMonitorRecoveryClaims = pgTable(
  "issue_monitor_recovery_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    armGeneration: bigint("arm_generation", { mode: "number" }).notNull(),
    clearReason: text("clear_reason").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    recoveryPolicy: text("recovery_policy").notNull(),
    recoveryOutcome: text("recovery_outcome"),
    recoveryIssueId: uuid("recovery_issue_id"),
    recoveryWakeQueued: boolean("recovery_wake_queued"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueArmGenerationUq: uniqueIndex("issue_monitor_recovery_claims_issue_arm_generation_uq").on(
      table.issueId,
      table.armGeneration,
    ),
    companyIssueIdx: index("issue_monitor_recovery_claims_company_issue_idx").on(table.companyId, table.issueId),
  }),
);
