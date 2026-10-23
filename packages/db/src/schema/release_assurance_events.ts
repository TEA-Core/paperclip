import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * Event vocabulary of the release-assurance ledger. `hold` is the board-authorized
 * enrollment of a card + exact PR (it persists across head changes); `go` and
 * `no_go` are head-bound release decisions. A revocation is a `no_go` on the
 * head being revoked, so the veto is one durable fact rather than a second kind.
 */
export const RELEASE_ASSURANCE_EVENT_KINDS = ["hold", "go", "no_go"] as const;
export type ReleaseAssuranceEventKind = (typeof RELEASE_ASSURANCE_EVENT_KINDS)[number];

/**
 * Publication modes the database can express. Only `shadow` exists in this
 * slice: a decision is recorded and visible, but no `release-assurance/approved`
 * status is ever written. Admitting a second mode is a deliberate migration.
 */
export const RELEASE_ASSURANCE_PUBLICATION_MODES = ["shadow"] as const;
export type ReleaseAssurancePublicationMode = (typeof RELEASE_ASSURANCE_PUBLICATION_MODES)[number];

/**
 * Append-only ledger of release-assurance enrollment and decisions (SUP-20771).
 * Rows are only ever inserted: a decision is never rewritten, so a later head
 * change, comment deletion, or policy edit cannot erase an enrollment or a
 * denial. The company and issue foreign keys carry no delete policy (the
 * `decisions` precedent), so deleting a card or company that still has ledger
 * rows is refused rather than cascading the audit trail away. `(companyId, eventId)` is the idempotency key — a replay of the same
 * canonical payload is a no-op and a conflicting reuse fails — and `sequence`
 * is the server-side ordering, never the caller's clock.
 *
 * `headSha` is an authorization value, stored exact-lowercase. It is null only
 * for `hold`, which binds the card to a PR rather than to one head. No
 * signature, key, or GitHub token is stored here: issuer-signature verification
 * is the later live-provisioning step, so this slice records the authorizing
 * board actor instead.
 */
export const releaseAssuranceEvents = pgTable(
  "release_assurance_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id),
    eventId: uuid("event_id").notNull(),
    sequence: bigserial("sequence", { mode: "number" }).notNull(),
    kind: text("kind").$type<ReleaseAssuranceEventKind>().notNull(),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    pullRequestNumber: integer("pull_request_number").notNull(),
    headSha: text("head_sha"),
    policyRevision: integer("policy_revision").notNull().default(1),
    // Recorded identity, deliberately not a foreign key: the enrolled seat must stay readable
    // in the durable record after the agent row is deleted or its id is reused elsewhere.
    raAgentId: uuid("ra_agent_id"),
    evidenceDigest: text("evidence_digest"),
    ciRunIds: jsonb("ci_run_ids").$type<number[]>(),
    reason: text("reason").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    recordedByActorType: text("recorded_by_actor_type").notNull(),
    recordedByActorId: text("recorded_by_actor_id").notNull(),
    publicationMode: text("publication_mode").$type<ReleaseAssurancePublicationMode>().notNull().default("shadow"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyEventUq: uniqueIndex("release_assurance_events_company_event_uq").on(table.companyId, table.eventId),
    issueHoldUq: uniqueIndex("release_assurance_events_issue_hold_uq")
      .on(table.companyId, table.issueId)
      .where(sql`${table.kind} = 'hold'`),
    prHoldUq: uniqueIndex("release_assurance_events_pr_hold_uq")
      .on(table.companyId, table.owner, table.repo, table.pullRequestNumber)
      .where(sql`${table.kind} = 'hold'`),
    issueHeadGoUq: uniqueIndex("release_assurance_events_issue_head_go_uq")
      .on(table.companyId, table.issueId, table.headSha)
      .where(sql`${table.kind} = 'go'`),
    issueSequenceIdx: index("release_assurance_events_issue_sequence_idx").on(
      table.companyId,
      table.issueId,
      table.sequence,
    ),
    kindCheck: check(
      "release_assurance_events_kind_check",
      sql`${table.kind} in ('hold', 'go', 'no_go')`,
    ),
    publicationModeCheck: check(
      "release_assurance_events_publication_mode_check",
      sql`${table.publicationMode} in ('shadow')`,
    ),
    pullRequestNumberCheck: check(
      "release_assurance_events_pull_request_number_check",
      sql`${table.pullRequestNumber} > 0`,
    ),
    headShaCheck: check(
      "release_assurance_events_head_sha_check",
      sql`${table.headSha} is null or ${table.headSha} ~ '^[0-9a-f]{40}$'`,
    ),
    // Only an enrollment is head-less; every decision is bound to one exact head.
    headBindingCheck: check(
      "release_assurance_events_head_binding_check",
      sql`(${table.kind} = 'hold') = (${table.headSha} is null)`,
    ),
    // A GO must carry the evidence digest and CI run receipts it certifies.
    goEvidenceCheck: check(
      "release_assurance_events_go_evidence_check",
      sql`${table.kind} <> 'go' or (${table.evidenceDigest} is not null and ${table.ciRunIds} is not null)`,
    ),
    evidenceDigestCheck: check(
      "release_assurance_events_evidence_digest_check",
      sql`${table.evidenceDigest} is null or ${table.evidenceDigest} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);
