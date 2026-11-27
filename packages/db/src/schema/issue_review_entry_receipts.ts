import { foreignKey, integer, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { documentRevisions } from "./document_revisions.js";
import { issues } from "./issues.js";

/** Historical first admission, not a delivery authorization or a close-tier fact.
 * The migration forbids mutation and retains both referenced document revisions.
 * One first entry per issue survives policy edits, reopening and reassignment.
 */
export const issueReviewEntryReceipts = pgTable("issue_review_entry_receipts", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull(),
  beforeStatusVersion: integer("before_status_version").notNull(),
  afterStatusVersion: integer("after_status_version").notNull(),
  rulingRevisionId: uuid("ruling_revision_id").notNull().references(() => documentRevisions.id),
  artifactRevisionId: uuid("artifact_revision_id").notNull().references(() => documentRevisions.id),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  companyIssueFk: foreignKey({
    name: "issue_review_entry_receipts_company_issue_fk",
    columns: [table.companyId, table.issueId], foreignColumns: [issues.companyId, issues.id],
  }),
  firstEntryUq: uniqueIndex("issue_review_entry_receipts_first_entry_uq").on(table.companyId, table.issueId),
}));
