-- SUP-12398: Add merge_arming_enabled flag to companies table for per-company
-- opt-in to automatic merge-arming at the final-approval transition.
-- Defaults to false so existing companies are unaffected until explicitly enabled.

ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "merge_arming_enabled" boolean NOT NULL DEFAULT false;
