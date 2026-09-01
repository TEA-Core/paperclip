-- One-shot backfill (SUP-14590): scope issues.execution_state.completedStageIds
-- and skippedStageIds to the stage ids that actually exist in the issue's current
-- execution_policy. normalizeIssueExecutionPolicy mints fresh stage ids on every
-- re-delivery, so ids carried over from a prior policy revision are orphans and
-- must not survive. Enforces the invariant:
--   completedStageIds ⊆ execution_policy.stages[*].id
--   skippedStageIds   ⊆ execution_policy.stages[*].id
-- Rows already scoped are left untouched (the WHERE only matches when at least
-- one id is dropped).

WITH src AS (
  SELECT
    i.id                                                AS issue_id,
    i.execution_state                                   AS st,
    COALESCE(i.execution_policy -> 'stages', '[]'::jsonb) AS stages
  FROM issues i
  WHERE i.execution_state IS NOT NULL
),
pruned AS (
  SELECT
    s.issue_id,
    s.st,
    s.st -> 'completedStageIds' AS raw_completed,
    s.st -> 'skippedStageIds'   AS raw_skipped,
    (
      SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord), '[]'::jsonb)
      FROM jsonb_array_elements(COALESCE(s.st -> 'completedStageIds', '[]'::jsonb)) WITH ORDINALITY AS e(value, ord)
      WHERE (e.value #>> '{}') IN (
        SELECT p.pid ->> 'id'
        FROM jsonb_array_elements(s.stages) AS p(pid)
        WHERE p.pid ->> 'id' IS NOT NULL
      )
    ) AS kept_completed,
    (
      SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord), '[]'::jsonb)
      FROM jsonb_array_elements(COALESCE(s.st -> 'skippedStageIds', '[]'::jsonb)) WITH ORDINALITY AS e(value, ord)
      WHERE (e.value #>> '{}') IN (
        SELECT p.pid ->> 'id'
        FROM jsonb_array_elements(s.stages) AS p(pid)
        WHERE p.pid ->> 'id' IS NOT NULL
      )
    ) AS kept_skipped
  FROM src s
)
UPDATE issues AS i
SET execution_state = p.st - 'completedStageIds' - 'skippedStageIds'
    || jsonb_build_object(
      'completedStageIds', COALESCE(p.kept_completed, '[]'::jsonb),
      'skippedStageIds',   COALESCE(p.kept_skipped,   '[]'::jsonb)
    )
FROM pruned AS p
WHERE i.id = p.issue_id
  AND (
       COALESCE(p.raw_completed, '[]'::jsonb) <> COALESCE(p.kept_completed, '[]'::jsonb)
    OR COALESCE(p.raw_skipped,   '[]'::jsonb) <> COALESCE(p.kept_skipped,   '[]'::jsonb)
  );
