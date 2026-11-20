-- Tighten both head_sha CHECKs from 0298's {40,64} to exactly 40 lowercase hex.
-- Every table is in the public schema, qualified so search_path cannot redirect it.
-- Pre-flight: refuse to run while any row would violate the new check (a NULL
-- head_sha included, because NULL !~ '...' is not true). The
-- message names each table, its count and up to 20 ids, and nothing is written.
DO $$
DECLARE
	target text;
	offending_count bigint;
	offending_ids text;
	report text := '';
BEGIN
	FOREACH target IN ARRAY ARRAY['issue_delivery_receipts', 'issue_delivery_receipt_links'] LOOP
		EXECUTE format('SELECT count(*) FROM "public".%I WHERE "head_sha" IS NULL OR "head_sha" !~ ''^[0-9a-f]{40}$''', target)
			INTO offending_count;
		IF offending_count > 0 THEN
			EXECUTE format(
				'SELECT string_agg("id"::text, '', '' ORDER BY "id") FROM (SELECT "id" FROM "public".%I WHERE "head_sha" IS NULL OR "head_sha" !~ ''^[0-9a-f]{40}$'' ORDER BY "id" LIMIT 20) AS "offending"',
				target
			) INTO offending_ids;
			report := report || format('%s: %s row(s) (first ids: %s); ', target, offending_count, offending_ids);
		END IF;
	END LOOP;
	IF report <> '' THEN
		RAISE EXCEPTION USING
			ERRCODE = 'check_violation',
			MESSAGE = '0329_head_sha_preflight: ' || report
				|| 'head_sha must be exactly 40 lowercase hex characters. Fix or delete these rows, then run the migration again.';
	END IF;
END $$;--> statement-breakpoint
-- Drop every CHECK on head_sha of both tables, whatever its name. Paperclip
-- backups omit CHECK constraints, and a restored or hand-repaired database can
-- carry a loose check under another name.
DO $$
DECLARE
	legacy record;
BEGIN
	FOR legacy IN
		SELECT DISTINCT "t"."relname" AS table_name, "c"."conname" AS constraint_name
		FROM "pg_catalog"."pg_constraint" AS "c"
		JOIN "pg_catalog"."pg_class" AS "t" ON "t"."oid" = "c"."conrelid"
		JOIN "pg_catalog"."pg_attribute" AS "a" ON "a"."attrelid" = "c"."conrelid" AND "a"."attnum" = ANY ("c"."conkey")
		WHERE "c"."contype" = 'c'
			AND "c"."conrelid" IN ('public.issue_delivery_receipts'::regclass, 'public.issue_delivery_receipt_links'::regclass)
			AND "a"."attname" = 'head_sha'
	LOOP
		EXECUTE format('ALTER TABLE "public".%I DROP CONSTRAINT %I', legacy.table_name, legacy.constraint_name);
	END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "public"."issue_delivery_receipt_links" ADD CONSTRAINT "issue_delivery_receipt_links_head_sha_check" CHECK ("issue_delivery_receipt_links"."head_sha" ~ '^[0-9a-f]{40}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "public"."issue_delivery_receipts" ADD CONSTRAINT "issue_delivery_receipts_head_sha_check" CHECK ("issue_delivery_receipts"."head_sha" ~ '^[0-9a-f]{40}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "public"."issue_delivery_receipt_links" VALIDATE CONSTRAINT "issue_delivery_receipt_links_head_sha_check";--> statement-breakpoint
ALTER TABLE "public"."issue_delivery_receipts" VALIDATE CONSTRAINT "issue_delivery_receipts_head_sha_check";
