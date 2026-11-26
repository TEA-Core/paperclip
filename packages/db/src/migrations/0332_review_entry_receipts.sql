CREATE TABLE "issue_review_entry_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"before_status_version" integer NOT NULL,
	"after_status_version" integer NOT NULL,
	"ruling_revision_id" uuid NOT NULL,
	"artifact_revision_id" uuid NOT NULL,
	"evidence" jsonb NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_review_entry_receipts" ADD CONSTRAINT "issue_review_entry_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_review_entry_receipts" ADD CONSTRAINT "issue_review_entry_receipts_ruling_revision_id_document_revisions_id_fk" FOREIGN KEY ("ruling_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_review_entry_receipts" ADD CONSTRAINT "issue_review_entry_receipts_artifact_revision_id_document_revisions_id_fk" FOREIGN KEY ("artifact_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_review_entry_receipts" ADD CONSTRAINT "issue_review_entry_receipts_company_issue_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_review_entry_receipts_first_entry_uq" ON "issue_review_entry_receipts" USING btree ("company_id","issue_id");
--> statement-breakpoint
CREATE FUNCTION "issue_review_entry_receipts_reject_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'issue_review_entry_receipts is append-only: % is not allowed', TG_OP USING ERRCODE = '55000';
END $$;
--> statement-breakpoint
CREATE TRIGGER "issue_review_entry_receipts_append_only" BEFORE UPDATE OR DELETE ON "issue_review_entry_receipts"
FOR EACH ROW EXECUTE FUNCTION "issue_review_entry_receipts_reject_mutation"();
--> statement-breakpoint
CREATE FUNCTION "review_entry_retain_revision"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.company_id, NEW.document_id, NEW.revision_number, NEW.title, NEW.format, NEW.body,
      NEW.change_summary, NEW.created_by_user_id, NEW.created_at)
      IS NOT DISTINCT FROM (OLD.id, OLD.company_id, OLD.document_id, OLD.revision_number, OLD.title, OLD.format,
      OLD.body, OLD.change_summary, OLD.created_by_user_id, OLD.created_at)
    AND (NEW.created_by_agent_id IS NOT DISTINCT FROM OLD.created_by_agent_id OR NEW.created_by_agent_id IS NULL)
    AND (NEW.created_by_run_id IS NOT DISTINCT FROM OLD.created_by_run_id OR NEW.created_by_run_id IS NULL) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM issue_review_entry_receipts
    WHERE ruling_revision_id = OLD.id OR artifact_revision_id = OLD.id) THEN
    RAISE EXCEPTION 'review-entry document revision is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "review_entry_retain_revision" BEFORE UPDATE ON "document_revisions"
FOR EACH ROW EXECUTE FUNCTION "review_entry_retain_revision"();
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "issue_review_entry_receipts" FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_serving') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "issue_review_entry_receipts" FROM "paperclip_serving";
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION "review_entry_lock_key"(name text) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtextextended('paperclip.review-entry:' || name, 0)
$$;
--> statement-breakpoint
CREATE FUNCTION "review_entry_normalize_path"(candidate text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN left(candidate, 1) = '/'
    THEN '/' || array_to_string(array_remove(string_to_array(candidate, '/'), ''), '/') END
$$;
--> statement-breakpoint
CREATE FUNCTION "review_entry_run_paths"(context jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT array_remove(ARRAY[
    context->>'cwd', context->>'workspaceCwd',
    context->'paperclipWorkspace'->>'cwd', context->'paperclipWorkspace'->>'worktreePath'
  ] || COALESCE((
    SELECT array_agg(hint.path) FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(context->'paperclipWorkspaces') = 'array' THEN context->'paperclipWorkspaces' ELSE '[]'::jsonb END
    ) AS workspace(value), LATERAL (VALUES (workspace.value->>'cwd'), (workspace.value->>'worktreePath')) AS hint(path)
  ), '{}'::text[]), NULL)
$$;
--> statement-breakpoint
CREATE FUNCTION "review_entry_fence_writer"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  claim jsonb := to_jsonb(NEW);
  context jsonb := CASE WHEN jsonb_typeof(to_jsonb(NEW)->'context_snapshot') = 'object' THEN to_jsonb(NEW)->'context_snapshot' ELSE '{}'::jsonb END;
  candidate text;
  part text;
  prefix text;
BEGIN
  FOREACH candidate IN ARRAY array_remove(ARRAY[claim->>'native_issue_id', context->>'issueId', context->>'taskId'], NULL) LOOP
    PERFORM pg_advisory_xact_lock_shared(review_entry_lock_key('issue:' || candidate));
  END LOOP;
  FOREACH candidate IN ARRAY array_remove(ARRAY[claim->>'execution_workspace_id', context->>'executionWorkspaceId'], NULL) LOOP
    PERFORM pg_advisory_xact_lock_shared(review_entry_lock_key('workspace:' || candidate));
  END LOOP;
  FOREACH candidate IN ARRAY array_remove(ARRAY[claim->>'cwd', claim->>'provider_ref'], NULL) || review_entry_run_paths(context) LOOP
    IF review_entry_normalize_path(candidate) IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock_shared(review_entry_lock_key('path-exact:' || review_entry_normalize_path(candidate)));
      prefix := '';
      FOREACH part IN ARRAY array_remove(string_to_array(candidate, '/'), '') LOOP
        prefix := prefix || '/' || part;
        PERFORM pg_advisory_xact_lock_shared(review_entry_lock_key('path:' || prefix));
      END LOOP;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "review_entry_fence_writer" BEFORE INSERT OR UPDATE OF "cwd", "provider_ref" ON "execution_workspaces"
FOR EACH ROW EXECUTE FUNCTION "review_entry_fence_writer"();
--> statement-breakpoint
CREATE TRIGGER "review_entry_fence_writer" BEFORE INSERT OR UPDATE OF "cwd" ON "project_workspaces"
FOR EACH ROW EXECUTE FUNCTION "review_entry_fence_writer"();
--> statement-breakpoint
CREATE TRIGGER "review_entry_fence_writer" BEFORE INSERT OR UPDATE OF "cwd", "execution_workspace_id", "stopped_at" ON "workspace_runtime_services"
FOR EACH ROW WHEN (NEW.stopped_at IS NULL) EXECUTE FUNCTION "review_entry_fence_writer"();
--> statement-breakpoint
CREATE TRIGGER "review_entry_fence_writer" BEFORE INSERT OR UPDATE OF "cwd", "execution_workspace_id", "finished_at" ON "workspace_operations"
FOR EACH ROW WHEN (NEW.finished_at IS NULL) EXECUTE FUNCTION "review_entry_fence_writer"();
--> statement-breakpoint
CREATE TRIGGER "review_entry_fence_writer" BEFORE INSERT OR UPDATE OF "status", "context_snapshot", "native_issue_id" ON "heartbeat_runs"
FOR EACH ROW WHEN (NEW.status IN ('queued', 'running')) EXECUTE FUNCTION "review_entry_fence_writer"();
