-- SUP-12839: Add scope column to board_api_keys to distinguish read_only
-- keys from all_access keys. Existing keys are backfilled to all_access
-- (preserving their current unscoped, full-creator-membership behavior).
--
-- Idempotent: every statement guards on existence so re-running is a no-op.

ALTER TABLE "board_api_keys" ADD COLUMN IF NOT EXISTS "scope" text NOT NULL DEFAULT 'all_access';--> statement-breakpoint

-- Backfill any rows that somehow have a NULL scope (defensive; the DEFAULT
-- above should have handled all existing rows, but this covers edge cases
-- from partial migrations or concurrent writes).
UPDATE "board_api_keys" SET "scope" = 'all_access' WHERE "scope" IS NULL;--> statement-breakpoint

-- Enforce that scope is one of the allowed values.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'board_api_keys_scope_check'
    AND conrelid = 'board_api_keys'::regclass
  ) THEN
    ALTER TABLE "board_api_keys" ADD CONSTRAINT "board_api_keys_scope_check"
      CHECK ("scope" IN ('read_only', 'all_access'));
  END IF;
END $$;--> statement-breakpoint
