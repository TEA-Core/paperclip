-- SUP-21022: per-routine execution workspace preference.
-- Routines had no workspace setting, so every execution issue followed the
-- project policy (an isolated git worktree per run). NULL keeps that behaviour.
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "execution_workspace_preference" text;
