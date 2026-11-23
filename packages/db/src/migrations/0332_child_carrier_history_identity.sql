-- Backfill the wider identity directly from every stored row. No attribution,
-- approval, provenance, timestamp, or repository spelling is rewritten.
-- The old key is a strict subset, so existing rows cannot collide in this index.
-- Build before dropping the old key; the migration runner commits the swap atomically.
CREATE UNIQUE INDEX "issue_child_carrier_attributions_history_uq" ON "issue_child_carrier_attributions" USING btree ("company_id","child_issue_id","provider",lower("owner"),lower("repo"),"ancestor_issue_id","pull_request_number","head_sha");
--> statement-breakpoint
DROP INDEX "issue_child_carrier_attributions_child_pr_head_uq";