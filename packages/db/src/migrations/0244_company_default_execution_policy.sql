-- SUP-15222: add companies.default_execution_policy jsonb column.
-- Project-less issues (e.g. routine dispatch with projectId=null) had no
-- execution-policy fallback. This column provides a company-wide default
-- that the issue service resolves when the project-level default is absent.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS default_execution_policy jsonb;
