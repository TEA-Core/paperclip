-- Additive on image rollback: older writers need not know about queued_at.
-- The runner holds this entire migration in one transaction, including its
-- ALTER TABLE lock. Batches bound query work, not transaction or lock duration.
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "queued_at" timestamp with time zone;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "heartbeat_runs_stamp_queued_at"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'queued' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.queued_at := clock_timestamp();
    ELSIF OLD.status IS DISTINCT FROM 'queued' THEN
      NEW.queued_at := clock_timestamp();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "heartbeat_runs_stamp_queued_at"
BEFORE INSERT OR UPDATE OF "status" ON "heartbeat_runs"
FOR EACH ROW EXECUTE FUNCTION "heartbeat_runs_stamp_queued_at"();
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: The migration runs in one transaction; this temporary partial (created_at,id) index supports only queued/null rows and the 5000-row keyset backfill below.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_queued_at_backfill_idx"
ON "heartbeat_runs" ("created_at", "id")
WHERE "status" = 'queued' AND "queued_at" IS NULL;
--> statement-breakpoint
DO $$
DECLARE
  cursor_created_at timestamp with time zone;
  cursor_id uuid;
BEGIN
  -- Start at the actual first key, including timestamp/UUID boundary values.
  SELECT created_at, id INTO cursor_created_at, cursor_id
  FROM heartbeat_runs
  WHERE status = 'queued' AND queued_at IS NULL
  ORDER BY created_at, id
  LIMIT 1;

  WHILE cursor_id IS NOT NULL LOOP
    WITH batch AS (
      SELECT id
      FROM heartbeat_runs
      WHERE status = 'queued' AND queued_at IS NULL
        AND (created_at, id) >= (cursor_created_at, cursor_id)
      ORDER BY created_at, id
      LIMIT 5000
    ), updated AS (
      UPDATE heartbeat_runs AS runs
      SET queued_at = runs.created_at
      FROM batch
      WHERE runs.id = batch.id
        AND runs.status = 'queued' AND runs.queued_at IS NULL
      RETURNING runs.created_at, runs.id
    )
    SELECT created_at, id INTO cursor_created_at, cursor_id
    FROM updated
    ORDER BY created_at DESC, id DESC
    LIMIT 1;
  END LOOP;

  IF EXISTS (SELECT 1 FROM heartbeat_runs WHERE status = 'queued' AND queued_at IS NULL) THEN
    RAISE EXCEPTION 'heartbeat_runs queued_at backfill left queued/null rows';
  END IF;
END;
$$;
--> statement-breakpoint
-- Install the check only after the zero-null assertion above, then validate.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'heartbeat_runs'::regclass
      AND conname = 'heartbeat_runs_queued_at_required'
  ) THEN
    ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_queued_at_required"
    CHECK ("status" <> 'queued' OR "queued_at" IS NOT NULL) NOT VALID;
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" VALIDATE CONSTRAINT "heartbeat_runs_queued_at_required";
--> statement-breakpoint
DROP INDEX IF EXISTS "heartbeat_runs_queued_at_backfill_idx";