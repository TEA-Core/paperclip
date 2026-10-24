-- Governed existing-PR delivery-receipt recovery (SUP-20246, plan SUP-20244).
-- Two new tables only: no existing table, row, or constraint is altered.
CREATE TABLE IF NOT EXISTS "issue_delivery_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pull_request_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"branch_name" text NOT NULL,
	"source_run_id" uuid,
	"source_delivery_record" jsonb,
	"recovery_reason" text NOT NULL,
	"authorized_by_actor_type" text NOT NULL,
	"authorized_by_actor_id" text NOT NULL,
	"authorized_by_run_id" uuid,
	"idempotency_key" text NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"claimed_at" timestamp with time zone,
	"claim_token" uuid,
	"consumed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_delivery_receipts_state_check" CHECK ("issue_delivery_receipts"."state" in ('ready', 'claimed', 'consumed', 'invalidated')),
	CONSTRAINT "issue_delivery_receipts_provider_check" CHECK ("issue_delivery_receipts"."provider" in ('github')),
	CONSTRAINT "issue_delivery_receipts_actor_type_check" CHECK ("issue_delivery_receipts"."authorized_by_actor_type" in ('user', 'board', 'agent')),
	CONSTRAINT "issue_delivery_receipts_pull_request_number_check" CHECK ("issue_delivery_receipts"."pull_request_number" > 0),
	CONSTRAINT "issue_delivery_receipts_head_sha_check" CHECK ("issue_delivery_receipts"."head_sha" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "issue_delivery_receipt_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"external_object_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pull_request_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_delivery_receipt_links_provider_check" CHECK ("issue_delivery_receipt_links"."provider" in ('github')),
	CONSTRAINT "issue_delivery_receipt_links_pull_request_number_check" CHECK ("issue_delivery_receipt_links"."pull_request_number" > 0),
	CONSTRAINT "issue_delivery_receipt_links_head_sha_check" CHECK ("issue_delivery_receipt_links"."head_sha" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "issue_delivery_receipts" ADD CONSTRAINT "issue_delivery_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "issue_delivery_receipts" ADD CONSTRAINT "issue_delivery_receipts_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "issue_delivery_receipts" ADD CONSTRAINT "issue_delivery_receipts_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "issue_delivery_receipts" ADD CONSTRAINT "issue_delivery_receipts_authorized_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("authorized_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "issue_delivery_receipt_links" ADD CONSTRAINT "issue_delivery_receipt_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "issue_delivery_receipt_links" ADD CONSTRAINT "issue_delivery_receipt_links_receipt_id_issue_delivery_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."issue_delivery_receipts"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "issue_delivery_receipt_links" ADD CONSTRAINT "issue_delivery_receipt_links_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "issue_delivery_receipt_links" ADD CONSTRAINT "issue_delivery_receipt_links_external_object_id_external_objects_id_fk" FOREIGN KEY ("external_object_id") REFERENCES "public"."external_objects"("id") ON DELETE restrict ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_delivery_receipts_canonical_uq" ON "issue_delivery_receipts" USING btree ("company_id","source_issue_id","provider","owner","repo","pull_request_number","head_sha");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_delivery_receipts_company_idempotency_uq" ON "issue_delivery_receipts" USING btree ("company_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_delivery_receipt_links_company_receipt_uq" ON "issue_delivery_receipt_links" USING btree ("company_id","receipt_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_delivery_receipt_links_company_source_object_head_uq" ON "issue_delivery_receipt_links" USING btree ("company_id","source_issue_id","external_object_id","head_sha");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_delivery_receipt_links_lookup_idx" ON "issue_delivery_receipt_links" USING btree ("company_id","source_issue_id","provider","owner","repo","pull_request_number","head_sha");
