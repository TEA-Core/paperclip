ALTER TABLE "cost_events" ALTER COLUMN "input_tokens" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "cost_events" ALTER COLUMN "cached_input_tokens" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "cost_events" ALTER COLUMN "output_tokens" SET DATA TYPE bigint;