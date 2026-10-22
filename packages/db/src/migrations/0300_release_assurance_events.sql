-- Release-assurance control-plane ledger, shadow mode (SUP-20771). One new
-- table only: no existing table, row, or constraint is altered. Rows are
-- inserted and never rewritten; `publication_mode` can only be 'shadow'.
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
DO $$ BEGIN ALTER TABLE "release_assurance_events" ADD CONSTRAINT "release_assurance_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "release_assurance_events" ADD CONSTRAINT "release_assurance_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "release_assurance_events" ADD CONSTRAINT "release_assurance_events_ra_agent_id_agents_id_fk" FOREIGN KEY ("ra_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
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
