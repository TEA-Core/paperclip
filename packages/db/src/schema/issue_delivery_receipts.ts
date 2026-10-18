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
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/**
 * Closed state set for a governed delivery receipt. A receipt is created `ready`
 * by the board-authorized recovery endpoint, `claimed` by exactly one publication
 * attempt, then `consumed` only after a successful status write, or `invalidated`
 * when the PR head moved. No other state is expressible in the database.
 */
export const ISSUE_DELIVERY_RECEIPT_STATES = ["ready", "claimed", "consumed", "invalidated"] as const;
export type IssueDeliveryReceiptState = (typeof ISSUE_DELIVERY_RECEIPT_STATES)[number];

/** Providers a recovery receipt can bind. Deliberately narrower than GitHub reads elsewhere. */
export const ISSUE_DELIVERY_RECEIPT_PROVIDERS = ["github"] as const;
export type IssueDeliveryReceiptProvider = (typeof ISSUE_DELIVERY_RECEIPT_PROVIDERS)[number];

/** Actor vocabulary for the authorizing board actor, matching the control-plane actor types. */
export const ISSUE_DELIVERY_RECEIPT_ACTOR_TYPES = ["user", "board", "agent"] as const;
export type IssueDeliveryReceiptActorType = (typeof ISSUE_DELIVERY_RECEIPT_ACTOR_TYPES)[number];

/**
 * Persistence for the approved existing-PR delivery-receipt recovery (SUP-20244
 * plan, SUP-20246). One row is the single-use authority that binds a card to an
 * already-live PR head so a normal review-stage approval may publish
 * `paperclip/approved` at exactly that head.
 *
 * The canonical tuple is the receipt identity: company, card, provider, repo
 * coordinates, PR number, and the exact head. `headSha` is an authorization
 * value, not display metadata, so it is stored exact-lowercase and is covered by
 * the canonical unique index — a second receipt for the same card/PR/head cannot
 * exist, and a `(companyId, idempotencyKey)` unique index makes a retry either
 * replay the same canonical payload or fail on conflict rather than fork it.
 *
 * Claim/consume timestamps plus a claim token are what make the receipt
 * single-use across concurrent publishers; `sourceDeliveryRecord` and the
 * authorized-by columns carry the provenance the audit trail needs. No secret or
 * GitHub token is stored anywhere in this table.
 */
export const issueDeliveryReceipts = pgTable(
  "issue_delivery_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    provider: text("provider").$type<IssueDeliveryReceiptProvider>().notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    pullRequestNumber: integer("pull_request_number").notNull(),
    headSha: text("head_sha").notNull(),
    branchName: text("branch_name").notNull(),
    sourceRunId: uuid("source_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    sourceDeliveryRecord: jsonb("source_delivery_record").$type<Record<string, unknown>>(),
    recoveryReason: text("recovery_reason").notNull(),
    authorizedByActorType: text("authorized_by_actor_type").$type<IssueDeliveryReceiptActorType>().notNull(),
    authorizedByActorId: text("authorized_by_actor_id").notNull(),
    authorizedByRunId: uuid("authorized_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state").$type<IssueDeliveryReceiptState>().notNull().default("ready"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimToken: uuid("claim_token"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    canonicalUq: uniqueIndex("issue_delivery_receipts_canonical_uq").on(
      table.companyId,
      table.sourceIssueId,
      table.provider,
      table.owner,
      table.repo,
      table.pullRequestNumber,
      table.headSha,
    ),
    companyIdempotencyUq: uniqueIndex("issue_delivery_receipts_company_idempotency_uq").on(
      table.companyId,
      table.idempotencyKey,
    ),
    stateCheck: check(
      "issue_delivery_receipts_state_check",
      sql`${table.state} in ('ready', 'claimed', 'consumed', 'invalidated')`,
    ),
    providerCheck: check(
      "issue_delivery_receipts_provider_check",
      sql`${table.provider} in ('github')`,
    ),
    actorTypeCheck: check(
      "issue_delivery_receipts_actor_type_check",
      sql`${table.authorizedByActorType} in ('user', 'board', 'agent')`,
    ),
    pullRequestNumberCheck: check("issue_delivery_receipts_pull_request_number_check", sql`${table.pullRequestNumber} > 0`),
    headShaCheck: check(
      "issue_delivery_receipts_head_sha_check",
      sql`${table.headSha} ~ '^[0-9a-f]{40,64}$'`,
    ),
  }),
);
