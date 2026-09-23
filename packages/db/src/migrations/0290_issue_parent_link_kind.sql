ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "parent_link_kind" text NOT NULL DEFAULT 'decomposition';--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issues" ADD CONSTRAINT "issues_parent_link_kind_check" CHECK ("issues"."parent_link_kind" in ('decomposition', 'process'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
