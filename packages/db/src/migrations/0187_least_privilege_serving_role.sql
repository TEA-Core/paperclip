-- SUP-12126: Create a least-privilege PostgreSQL role for steady-state control-plane
-- serving. The `paperclip` superuser remains the migration-time identity; the
-- `paperclip_serving` role is restricted to DML + the CREATE privilege needed
-- for plugin schema creation. No SUPERUSER, no CREATEDB, no CREATEROLE.
--
-- Idempotent: every statement guards on existence so re-running is a no-op.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'paperclip_serving') THEN
    CREATE ROLE paperclip_serving NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

-- Serving role must not be able to escalate privileges.
ALTER ROLE paperclip_serving NOINHERIT;
--> statement-breakpoint

-- Grant CONNECT + CREATE on the current database (required to open a session
-- and for plugin-database.ts:376 CREATE SCHEMA IF NOT EXISTS).
-- current_database() returns the name as a string; GRANT ON DATABASE needs a
-- literal, so we use EXECUTE to build the statement dynamically.
DO $$
DECLARE
  db_name text := current_database();
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO paperclip_serving', db_name);
  EXECUTE format('GRANT CREATE ON DATABASE %I TO paperclip_serving', db_name);
END
$$;
--> statement-breakpoint

-- USAGE on schema public so the role can see tables.
GRANT USAGE ON SCHEMA public TO paperclip_serving;
--> statement-breakpoint

-- DML on all existing tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO paperclip_serving;
--> statement-breakpoint

-- Sequences: nextval()/setval() require USAGE + SELECT + UPDATE.
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO paperclip_serving;
--> statement-breakpoint

-- Default privileges for future tables/sequences created by the superuser
-- (migrations run as paperclip, so new tables land in public owned by paperclip).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO paperclip_serving;
--> statement-breakpoint

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO paperclip_serving;
--> statement-breakpoint

-- Allow the serving role to be used as a LOGIN role when an operator sets a
-- password. The migration itself does not set a password — that is an operator
-- action via ALTER ROLE ... WITH LOGIN PASSWORD '<from-secret-store>'.
