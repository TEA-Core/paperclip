ALTER TABLE "issues" ADD COLUMN "monitor_arm_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE FUNCTION "issues_bump_monitor_arm_generation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.monitor_next_check_at IS NOT NULL AND (
    NEW.monitor_next_check_at IS DISTINCT FROM OLD.monitor_next_check_at
    OR NEW.monitor_scheduled_by IS DISTINCT FROM OLD.monitor_scheduled_by
    OR NEW.execution_policy->'monitor' IS DISTINCT FROM OLD.execution_policy->'monitor'
  ) THEN
    NEW.monitor_arm_generation := OLD.monitor_arm_generation + 1;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "issues_bump_monitor_arm_generation" BEFORE UPDATE ON "issues"
FOR EACH ROW EXECUTE FUNCTION "issues_bump_monitor_arm_generation"();
--> statement-breakpoint
CREATE TABLE "issue_monitor_recovery_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"arm_generation" integer NOT NULL,
	"clear_reason" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"recovery_policy" text NOT NULL,
	"recovery_outcome" text,
	"recovery_issue_id" uuid,
	"recovery_wake_queued" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_monitor_recovery_claims" ADD CONSTRAINT "issue_monitor_recovery_claims_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_monitor_recovery_claims" ADD CONSTRAINT "issue_monitor_recovery_claims_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_monitor_recovery_claims_issue_arm_generation_uq" ON "issue_monitor_recovery_claims" USING btree ("issue_id","arm_generation");--> statement-breakpoint
CREATE INDEX "issue_monitor_recovery_claims_company_issue_idx" ON "issue_monitor_recovery_claims" USING btree ("company_id","issue_id");
