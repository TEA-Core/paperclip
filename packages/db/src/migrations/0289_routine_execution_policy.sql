-- SUP-17050: add routines.execution_policy jsonb column.
-- Routines could not carry an execution policy, so every laddered parent
-- routine materialised issues with the default policy instead of the intended
-- ladder shape. This column stores the routine's execution policy verbatim so
-- dispatch applies it to the materialised issue.
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "execution_policy" jsonb;
