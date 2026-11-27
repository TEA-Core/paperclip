import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * One claim per exhaustion episode of an issue's external-service monitor. The
 * scheduler inserts it in its own transaction before the recovery effect, so it
 * survives a failed completion transaction. It records the effect that ran, so a
 * retry of the same episode never repeats it. `recovery_issue_id` has no foreign
 * key: deleting the recovery issue never erases the claim. The episode is the
 * monitored issue's `monitor_exhaustion_count` + 1 at claim time, so a later,
 * separate exhaustion of the same monitor gets its own claim.
 */
export const issueMonitorRecoveryClaims = pgTable(
  "issue_monitor_recovery_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    exhaustionEpisode: integer("exhaustion_episode").notNull(),
    clearReason: text("clear_reason").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    recoveryPolicy: text("recovery_policy").notNull(),
    recoveryOutcome: text("recovery_outcome"),
    recoveryIssueId: uuid("recovery_issue_id"),
    recoveryWakeQueued: boolean("recovery_wake_queued"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    issueEpisodeUq: uniqueIndex("issue_monitor_recovery_claims_issue_episode_uq").on(
      table.issueId,
      table.exhaustionEpisode,
    ),
    companyIssueIdx: index("issue_monitor_recovery_claims_company_issue_idx").on(table.companyId, table.issueId),
  }),
);
