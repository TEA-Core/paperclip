-- Widen issues.monitor_arm_generation to bigint without rewriting issues. An
-- ALTER COLUMN ... TYPE bigint rewrites the whole table and rebuilds every index under
-- ACCESS EXCLUSIVE. Here the new column has a constant default (catalog-only), only
-- rows whose generation is not 0 are copied, and the old column is dropped
-- (catalog-only). This migration runs in one transaction, so no arm can commit in between.
ALTER TABLE "issues" ADD COLUMN "monitor_arm_generation_bigint" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "issues" SET "monitor_arm_generation_bigint" = "monitor_arm_generation" WHERE "monitor_arm_generation" <> 0;--> statement-breakpoint
ALTER TABLE "issues" DROP COLUMN "monitor_arm_generation";--> statement-breakpoint
ALTER TABLE "issues" RENAME COLUMN "monitor_arm_generation_bigint" TO "monitor_arm_generation";--> statement-breakpoint
ALTER TABLE "issue_monitor_recovery_claims" ALTER COLUMN "arm_generation" SET DATA TYPE bigint;--> statement-breakpoint
-- Every arm or re-arm also deletes the issue's claims for earlier generations in the
-- same transaction: only the current arm's claim is ever read. A claim that a recovery
-- tick holds locked is skipped, so the re-arm never waits on it; a later arm deletes it.
CREATE OR REPLACE FUNCTION "issues_bump_monitor_arm_generation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.monitor_next_check_at IS NOT NULL AND (
    NEW.monitor_next_check_at IS DISTINCT FROM OLD.monitor_next_check_at
    OR NEW.monitor_scheduled_by IS DISTINCT FROM OLD.monitor_scheduled_by
    OR NEW.execution_policy->'monitor' IS DISTINCT FROM OLD.execution_policy->'monitor'
  ) THEN
    NEW.monitor_arm_generation := OLD.monitor_arm_generation + 1;
    DELETE FROM "issue_monitor_recovery_claims"
    WHERE "id" IN (
      SELECT "id" FROM "issue_monitor_recovery_claims"
      WHERE "issue_id" = NEW.id AND "arm_generation" < NEW.monitor_arm_generation
      FOR UPDATE SKIP LOCKED
    );
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
-- One-time cleanup of the superseded claims written before this trigger existed.
DELETE FROM "issue_monitor_recovery_claims" AS "claim"
USING "issues"
WHERE "issues"."id" = "claim"."issue_id"
  AND "claim"."arm_generation" < "issues"."monitor_arm_generation";
