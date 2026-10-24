-- Release-assurance control-plane ledger, shadow mode (SUP-20771). One new
-- table only: no existing table, row, or constraint is altered. Rows are
-- inserted and never rewritten; `publication_mode` can only be 'shadow'. The
-- company and issue foreign keys have no delete policy, so deleting a parent
-- that still has ledger rows is refused instead of erasing the audit trail. The
-- issue key is composite with the company so the pair must match. The ledger is
-- append-only in the database: UPDATE/DELETE/TRUNCATE are revoked from the
-- serving role and rejected by triggers for every role.
CREATE TABLE IF NOT EXISTS "release_assurance_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"sequence" bigserial NOT NULL,
	"kind" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pull_request_number" integer NOT NULL,
	"head_sha" text,
	"policy_revision" integer DEFAULT 1 NOT NULL,
	"ra_agent_id" uuid,
	"evidence_digest" text,
	"ci_run_ids" jsonb,
	"reason" text NOT NULL,
	"payload_digest" text NOT NULL,
	"recorded_by_actor_type" text NOT NULL,
	"recorded_by_actor_id" text NOT NULL,
	"publication_mode" text DEFAULT 'shadow' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_assurance_events_kind_check" CHECK ("release_assurance_events"."kind" in ('hold', 'go', 'no_go')),
	CONSTRAINT "release_assurance_events_publication_mode_check" CHECK ("release_assurance_events"."publication_mode" in ('shadow')),
	CONSTRAINT "release_assurance_events_pull_request_number_check" CHECK ("release_assurance_events"."pull_request_number" > 0),
	CONSTRAINT "release_assurance_events_head_sha_check" CHECK ("release_assurance_events"."head_sha" is null or "release_assurance_events"."head_sha" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "release_assurance_events_head_binding_check" CHECK (("release_assurance_events"."kind" = 'hold') = ("release_assurance_events"."head_sha" is null)),
	CONSTRAINT "release_assurance_events_go_evidence_check" CHECK ("release_assurance_events"."kind" <> 'go' or ("release_assurance_events"."evidence_digest" is not null and "release_assurance_events"."ci_run_ids" is not null)),
	CONSTRAINT "release_assurance_events_evidence_digest_check" CHECK ("release_assurance_events"."evidence_digest" is null or "release_assurance_events"."evidence_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "release_assurance_events" ADD CONSTRAINT "release_assurance_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "release_assurance_events" ADD CONSTRAINT "release_assurance_events_company_issue_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "release_assurance_events_company_event_uq" ON "release_assurance_events" USING btree ("company_id","event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "release_assurance_events_issue_hold_uq" ON "release_assurance_events" USING btree ("company_id","issue_id") WHERE "release_assurance_events"."kind" = 'hold';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "release_assurance_events_pr_hold_uq" ON "release_assurance_events" USING btree ("company_id","owner","repo","pull_request_number") WHERE "release_assurance_events"."kind" = 'hold';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "release_assurance_events_issue_head_go_uq" ON "release_assurance_events" USING btree ("company_id","issue_id","head_sha") WHERE "release_assurance_events"."kind" = 'go';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "release_assurance_events_issue_sequence_idx" ON "release_assurance_events" USING btree ("company_id","issue_id","sequence");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "release_assurance_events_reject_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'release_assurance_events is append-only: % is not allowed', TG_OP USING ERRCODE = '55000'; END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "release_assurance_events_append_only" ON "release_assurance_events";
--> statement-breakpoint
CREATE TRIGGER "release_assurance_events_append_only" BEFORE UPDATE OR DELETE ON "release_assurance_events" FOR EACH ROW EXECUTE FUNCTION "release_assurance_events_reject_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "release_assurance_events_no_truncate" ON "release_assurance_events";
--> statement-breakpoint
CREATE TRIGGER "release_assurance_events_no_truncate" BEFORE TRUNCATE ON "release_assurance_events" FOR EACH STATEMENT EXECUTE FUNCTION "release_assurance_events_reject_mutation"();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "release_assurance_events" FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_serving') THEN REVOKE UPDATE, DELETE, TRUNCATE ON "release_assurance_events" FROM "paperclip_serving"; END IF; END $$;
