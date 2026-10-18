import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { externalObjects } from "./external_objects.js";
import { issueDeliveryReceipts } from "./issue_delivery_receipts.js";
import { issues } from "./issues.js";

/**
 * Dedicated link between a governed delivery receipt and the resolved
 * `external_objects` row for the live PR (SUP-20244 plan, SUP-20246).
 *
 * This relation exists so recovery lookup never has to trust prose. Ordinary
 * `external_object_mentions` rows stay citation-only — their source kinds are the
 * existing citation kinds and they are discovered from issue text — so a mention
 * can never satisfy a recovery lookup. Publication and candidate discovery query
 * this table joined to a `ready`/`claimed` receipt instead.
 *
 * The canonical coordinates and the exact head are deliberately repeated from the
 * receipt so a reader can verify tenant, card, external object, and receipt
 * identity from one row without trusting mutable display data; the service rejects
 * any mismatch between the repeated coordinates and the receipt or resolved
 * external object. Deleting the external object is restricted rather than
 * cascaded: the link is provenance and must outlive a display-record cleanup.
 */
export const issueDeliveryReceiptLinks = pgTable(
  "issue_delivery_receipt_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    receiptId: uuid("receipt_id").notNull().references(() => issueDeliveryReceipts.id, { onDelete: "cascade" }),
    sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    externalObjectId: uuid("external_object_id").notNull().references(() => externalObjects.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    pullRequestNumber: integer("pull_request_number").notNull(),
    headSha: text("head_sha").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyReceiptUq: uniqueIndex("issue_delivery_receipt_links_company_receipt_uq").on(
      table.companyId,
      table.receiptId,
    ),
    companySourceObjectHeadUq: uniqueIndex("issue_delivery_receipt_links_company_source_object_head_uq").on(
      table.companyId,
      table.sourceIssueId,
      table.externalObjectId,
      table.headSha,
    ),
    lookupIdx: index("issue_delivery_receipt_links_lookup_idx").on(
      table.companyId,
      table.sourceIssueId,
      table.provider,
      table.owner,
      table.repo,
      table.pullRequestNumber,
      table.headSha,
    ),
    providerCheck: check(
      "issue_delivery_receipt_links_provider_check",
      sql`${table.provider} in ('github')`,
    ),
    pullRequestNumberCheck: check("issue_delivery_receipt_links_pull_request_number_check", sql`${table.pullRequestNumber} > 0`),
    headShaCheck: check(
      "issue_delivery_receipt_links_head_sha_check",
      sql`${table.headSha} ~ '^[0-9a-f]{40,64}$'`,
    ),
  }),
);
