-- A direct serving-role run write must not bypass the issue lock held by a
-- pending-participant restoration. Guard all three issue bindings understood by
-- the restore route, including bindings added to an existing run.
CREATE OR REPLACE FUNCTION paperclip_guard_pending_participant_run()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  top_issue_id text := NEW.context_snapshot ->> 'issueId';
  nested_issue_id text := NEW.context_snapshot -> 'paperclipIssue' ->> 'id';
  issue_ids uuid[];
  bound_issue record;
  uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  IF NEW.native_issue_id IS NULL
     AND NOT coalesce(top_issue_id ~* uuid_pattern, false)
     AND NOT coalesce(nested_issue_id ~* uuid_pattern, false) THEN
    RETURN NEW;
  END IF;
  issue_ids := ARRAY[NEW.native_issue_id];
  IF top_issue_id ~* uuid_pattern THEN
    issue_ids := array_append(issue_ids, top_issue_id::uuid);
  END IF;
  IF nested_issue_id ~* uuid_pattern THEN
    issue_ids := array_append(issue_ids, nested_issue_id::uuid);
  END IF;

  -- The issue lock must remain held through the run write. A stale former
  -- assignee cannot add a live run after a successful restoration commits.
  FOR bound_issue IN
    SELECT assignee_agent_id, execution_state
    FROM issues
    WHERE company_id = NEW.company_id AND id = ANY(issue_ids)
    ORDER BY id FOR UPDATE
  LOOP
    IF bound_issue.execution_state ->> 'status' = 'pending'
       AND bound_issue.execution_state -> 'currentParticipant' ->> 'type' = 'agent'
       AND bound_issue.execution_state -> 'currentParticipant' ->> 'agentId' = bound_issue.assignee_agent_id::text
       AND bound_issue.assignee_agent_id IS DISTINCT FROM NEW.agent_id THEN
      RAISE EXCEPTION 'Live run agent differs from assigned pending participant'
        USING ERRCODE = '23514', CONSTRAINT = 'heartbeat_runs_pending_participant_owner_guard';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER heartbeat_runs_pending_participant_guard
BEFORE INSERT OR UPDATE OF company_id, agent_id, status, native_issue_id, context_snapshot
ON heartbeat_runs
FOR EACH ROW WHEN (NEW.status IN ('queued', 'running', 'scheduled_retry'))
EXECUTE FUNCTION paperclip_guard_pending_participant_run();
