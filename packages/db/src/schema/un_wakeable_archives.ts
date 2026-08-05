import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

export const unWakeableArchives = pgTable(
  "un_wakeable_archives",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    policy: text("policy").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyPolicyIdx: index("un_wakeable_archives_company_policy_idx").on(table.companyId, table.policy),
    companyIssueIdx: index("un_wakeable_archives_company_issue_idx").on(table.companyId, table.issueId),
  }),
);
