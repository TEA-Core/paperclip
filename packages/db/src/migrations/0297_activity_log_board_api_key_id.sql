ALTER TABLE "activity_log" ADD COLUMN IF NOT EXISTS "board_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_board_api_key_id_board_api_keys_id_fk" FOREIGN KEY ("board_api_key_id") REFERENCES "public"."board_api_keys"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable because this forward-only index attributes board-API-key writes.
CREATE INDEX IF NOT EXISTS "activity_log_company_board_api_key_created_idx"
  ON "activity_log" USING btree ("company_id","board_api_key_id","created_at");--> statement-breakpoint
