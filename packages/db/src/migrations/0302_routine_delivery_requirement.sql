-- SUP-22127: per-routine delivery requirement carried onto spawned execution issues.
-- Routines had no delivery requirement setting, so every spawned issue inherited
-- the issue create default (repository_delivery). NULL keeps that behaviour.
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "delivery_requirement" text;
--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_delivery_requirement_check" CHECK ("routines"."delivery_requirement" in ('repository_delivery', 'record_only'));
