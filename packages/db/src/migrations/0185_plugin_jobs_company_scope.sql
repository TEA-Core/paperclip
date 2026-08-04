-- SUP-10856 — give plugin_jobs a company scope so scheduled runs can be dispatched
-- with one, which is what lets a job handler call ctx.config.get() / ctx.issues.list().
--
-- company_id is nullable on purpose: existing rows predate the fan-out and have no
-- company to attribute them to. They are paused by the next job sync (which then
-- inserts one properly-scoped row per enabled company) rather than deleted, so their
-- plugin_job_runs history survives.
ALTER TABLE "plugin_jobs"
  ADD COLUMN IF NOT EXISTS "company_id" uuid REFERENCES "companies"("id") ON DELETE CASCADE;
--> statement-breakpoint

-- The old unique key was (plugin_id, job_key), which permits exactly one row per
-- job — the constraint that made fan-out impossible.
DROP INDEX IF EXISTS "plugin_jobs_unique_idx";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "plugin_jobs_unique_idx"
  ON "plugin_jobs" USING btree ("plugin_id", "company_id", "job_key");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "plugin_jobs_company_idx"
  ON "plugin_jobs" USING btree ("company_id");
