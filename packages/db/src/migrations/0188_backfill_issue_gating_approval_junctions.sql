-- Backfill issue_approvals junction rows for issue-gating approval types
-- (request_board_approval, budget_override_required) that have an issueId
-- in their payload but no junction row.
-- Specimen: approval 827866af (SUP-11953) had issueId e4ccdb3a in payload
-- but zero junction rows, so GET /api/approvals/{id}/issues returned [].

INSERT INTO "issue_approvals" (
  "company_id",
  "issue_id",
  "approval_id",
  "linked_by_agent_id",
  "linked_by_user_id",
  "created_at"
)
SELECT
  approvals."company_id",
  (approvals.payload ->> 'issueId')::uuid AS "issue_id",
  approvals."id" AS "approval_id",
  NULL AS "linked_by_agent_id",
  NULL AS "linked_by_user_id",
  NOW() AS "created_at"
FROM "approvals"
WHERE approvals."type" IN ('request_board_approval', 'budget_override_required')
  AND approvals.payload ->> 'issueId' IS NOT NULL
  AND approvals.payload ->> 'issueId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND EXISTS (
    SELECT 1 FROM "issues"
    WHERE "issues"."id" = (approvals.payload ->> 'issueId')::uuid
      AND "issues"."company_id" = approvals."company_id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "issue_approvals"
    WHERE "issue_approvals"."approval_id" = approvals."id"
      AND "issue_approvals"."issue_id" = (approvals.payload ->> 'issueId')::uuid
  );
