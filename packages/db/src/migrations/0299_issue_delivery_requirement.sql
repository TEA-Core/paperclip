ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "delivery_requirement" text DEFAULT 'repository_delivery' NOT NULL;
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_delivery_requirement_check" CHECK ("issues"."delivery_requirement" in ('repository_delivery', 'record_only'));
