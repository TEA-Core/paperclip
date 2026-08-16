-- SUP-13018: durable, container-replacement-surviving record of unexpected
-- files observed in the control-plane secrets directory. Each row captures the
-- attribution signals actually available in-container (server pid/uid/gid/comm,
-- container start time, observation time, and whether the file predates the
-- container). Only the truncated sha256 fingerprint prefix is stored, never key
-- material or a full hash.

CREATE TABLE IF NOT EXISTS "secrets_directory_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"observed_file_name" text NOT NULL,
	"classification" text NOT NULL,
	"mode" integer,
	"uid" integer,
	"gid" integer,
	"size" bigint,
	"mtime_ms" bigint,
	"sha256_fingerprint_prefix" text,
	"server_pid" integer,
	"server_uid" integer,
	"server_gid" integer,
	"server_comm" text,
	"container_start_time_ms" bigint,
	"observed_at_ms" bigint NOT NULL,
	"file_predates_container_start" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secrets_directory_observations_created_idx" ON "secrets_directory_observations" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secrets_directory_observations_classification_created_idx" ON "secrets_directory_observations" USING btree ("classification", "created_at");
