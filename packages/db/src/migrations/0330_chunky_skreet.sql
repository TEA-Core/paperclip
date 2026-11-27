CREATE TABLE "issue_child_carrier_attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"child_issue_id" uuid NOT NULL,
	"ancestor_issue_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pull_request_number" integer NOT NULL,
	"branch_name" text NOT NULL,
	"head_sha" text NOT NULL,
	"commit_shas" text[] NOT NULL,
	"state" text DEFAULT 'current' NOT NULL,
	"child_decision_id" uuid,
	"written_by_actor_type" text NOT NULL,
	"written_by_actor_id" text NOT NULL,
	"provenance" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	CONSTRAINT "issue_child_carrier_attributions_state_check" CHECK ("issue_child_carrier_attributions"."state" in ('current', 'invalidated')),
	CONSTRAINT "issue_child_carrier_attributions_provider_check" CHECK ("issue_child_carrier_attributions"."provider" in ('github')),
	CONSTRAINT "issue_child_carrier_attributions_actor_check" CHECK ("issue_child_carrier_attributions"."written_by_actor_type" = 'system'),
	CONSTRAINT "issue_child_carrier_attributions_distinct_issues_check" CHECK ("issue_child_carrier_attributions"."child_issue_id" <> "issue_child_carrier_attributions"."ancestor_issue_id"),
	CONSTRAINT "issue_child_carrier_attributions_pull_request_number_check" CHECK ("issue_child_carrier_attributions"."pull_request_number" > 0),
	CONSTRAINT "issue_child_carrier_attributions_head_sha_check" CHECK ("issue_child_carrier_attributions"."head_sha" ~ '^[0-9a-f]{40,64}$'),
	CONSTRAINT "issue_child_carrier_attributions_commit_shas_check" CHECK (cardinality("issue_child_carrier_attributions"."commit_shas") > 0)
);
--> statement-breakpoint
ALTER TABLE "issue_child_carrier_attributions" ADD CONSTRAINT "issue_child_carrier_attributions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_child_carrier_attributions" ADD CONSTRAINT "issue_child_carrier_attributions_child_issue_id_issues_id_fk" FOREIGN KEY ("child_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_child_carrier_attributions" ADD CONSTRAINT "issue_child_carrier_attributions_ancestor_issue_id_issues_id_fk" FOREIGN KEY ("ancestor_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_child_carrier_attributions" ADD CONSTRAINT "issue_child_carrier_attributions_child_decision_id_issue_execution_decisions_id_fk" FOREIGN KEY ("child_decision_id") REFERENCES "public"."issue_execution_decisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_child_carrier_attributions_current_child_uq" ON "issue_child_carrier_attributions" USING btree ("company_id","child_issue_id") WHERE "issue_child_carrier_attributions"."state" = 'current';--> statement-breakpoint
CREATE UNIQUE INDEX "issue_child_carrier_attributions_child_pr_head_uq" ON "issue_child_carrier_attributions" USING btree ("company_id","child_issue_id","pull_request_number","head_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_child_carrier_attributions_ancestor_current_uq" ON "issue_child_carrier_attributions" USING btree ("company_id","ancestor_issue_id","child_issue_id","pull_request_number") WHERE "issue_child_carrier_attributions"."state" = 'current';