import { parseSync } from "libpg-query";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginDatabaseCoreReadTable } from "@paperclipai/shared";
import {
  loadPluginSqlParser,
  splitPluginMigrationSql,
  validatePluginMigrationStatement,
  validatePluginRuntimeExecute,
  validatePluginRuntimeQuery,
} from "../services/plugin-database.js";

beforeAll(async () => {
  await loadPluginSqlParser();
});

type SqlCase = {
  name: string;
  sql: string;
  namespace?: string;
  coreReadTables?: PluginDatabaseCoreReadTable[];
  /** The rule that must reject the statement. Unused for cases that must pass. */
  reason?: RegExp;
};

const RUNTIME_NAMESPACE = "plugin_x";
const RUNTIME_CORE_READ_TABLES: PluginDatabaseCoreReadTable[] = ["agents", "heartbeat_runs", "issues"];
const MIGRATION_NAMESPACE = "plugin_test";
const MIGRATION_CORE_READ_TABLES: PluginDatabaseCoreReadTable[] = ["issues"];
/** A derived-looking namespace with a hash suffix, like the ones derivePluginDatabaseNamespace returns. */
const EXAMPLE_NAMESPACE = "plugin_example_0123456789";

/**
 * A function the deny-list rejects, with arguments the parser accepts. The parser does not
 * check argument types or whether the function exists, so the arguments only need to parse.
 */
type DeniedFunction = { name: string; args: string };

const DENIED_FUNCTIONS: DeniedFunction[] = [
  // SQL text or a table named in a string
  { name: "query_to_xml", args: "'select 1', true, false, ''" },
  { name: "query_to_xml_and_xmlschema", args: "'select 1', true, false, ''" },
  { name: "table_to_xml", args: "'public.company_skills', true, false, ''" },
  { name: "table_to_xmlschema", args: "'public.company_skills', true, false, ''" },
  { name: "table_to_xml_and_xmlschema", args: "'public.company_skills', true, false, ''" },
  { name: "cursor_to_xml", args: "'c', 1, true, false, ''" },
  { name: "cursor_to_xmlschema", args: "'c', true, false, ''" },
  { name: "schema_to_xml", args: "'public', true, false, ''" },
  { name: "schema_to_xmlschema", args: "'public', true, false, ''" },
  { name: "schema_to_xml_and_xmlschema", args: "'public', true, false, ''" },
  { name: "database_to_xml", args: "true, false, ''" },
  { name: "database_to_xmlschema", args: "true, false, ''" },
  { name: "database_to_xml_and_xmlschema", args: "true, false, ''" },
  { name: "ts_stat", args: "'select 1'" },
  { name: "dblink", args: "'dbname=x', 'select 1'" },
  { name: "dblink_exec", args: "'dbname=x', 'select 1'" },
  { name: "dblink_connect", args: "'dbname=x'" },
  // server files and large objects
  { name: "pg_read_file", args: "'postmaster.pid'" },
  { name: "pg_read_binary_file", args: "'postmaster.pid'" },
  { name: "pg_ls_dir", args: "'.'" },
  { name: "pg_ls_logdir", args: "" },
  { name: "pg_ls_waldir", args: "" },
  { name: "pg_stat_file", args: "'postmaster.pid'" },
  { name: "lo_import", args: "'/tmp/x'" },
  { name: "lo_export", args: "1, '/tmp/x'" },
  { name: "lo_get", args: "1234" },
  { name: "lo_put", args: "1234, 0, 'abc'::bytea" },
  // settings and sequence values
  { name: "set_config", args: "'search_path', 'public', false" },
  { name: "setval", args: "'public.some_seq', 1" },
  // backend and server control
  { name: "pg_terminate_backend", args: "1" },
  { name: "pg_cancel_backend", args: "1" },
  { name: "pg_reload_conf", args: "" },
  { name: "pg_rotate_logfile", args: "" },
  { name: "pg_switch_wal", args: "" },
  { name: "pg_promote", args: "" },
  { name: "pg_backup_start", args: "'label'" },
  { name: "pg_backup_stop", args: "" },
  { name: "pg_start_backup", args: "'label'" },
  { name: "pg_stop_backup", args: "" },
  // adminpack server file functions
  { name: "pg_file_write", args: "'a', 'b', false" },
  { name: "pg_file_rename", args: "'a', 'b'" },
  { name: "pg_file_unlink", args: "'a'" },
  { name: "pg_file_sync", args: "'a'" },
  // more large-object functions (lo_* and the loread/lowrite pair)
  { name: "lo_unlink", args: "1234" },
  { name: "lo_create", args: "1234" },
  { name: "lo_creat", args: "-1" },
  { name: "lo_open", args: "1234, 131072" },
  { name: "lo_truncate", args: "1, 0" },
  { name: "lo_from_bytea", args: "0, 'abc'::bytea" },
  { name: "lo_close", args: "1" },
  { name: "lo_lseek", args: "1, 0, 0" },
  { name: "loread", args: "1, 10" },
  { name: "lowrite", args: "1, 'abc'::bytea" },
  // notifications, logical decoding and WAL messages
  { name: "pg_notify", args: "'channel', 'payload'" },
  { name: "pg_logical_emit_message", args: "true, 'prefix', 'message'" },
  { name: "pg_logical_slot_get_changes", args: "'slot', null, null" },
  { name: "pg_logical_slot_peek_changes", args: "'slot', null, null" },
  { name: "pg_logical_slot_get_binary_changes", args: "'slot', null, null" },
  { name: "pg_logical_slot_peek_binary_changes", args: "'slot', null, null" },
  // replication slots
  { name: "pg_create_physical_replication_slot", args: "'slot'" },
  { name: "pg_create_logical_replication_slot", args: "'slot', 'test_decoding'" },
  { name: "pg_drop_replication_slot", args: "'slot'" },
  { name: "pg_replication_slot_advance", args: "'slot', '0/0'::pg_lsn" },
  { name: "pg_copy_physical_replication_slot", args: "'src', 'dst'" },
  { name: "pg_copy_logical_replication_slot", args: "'src', 'dst'" },
];

/**
 * The administrative, server-file, large-object, notification and replication functions. Each is also
 * tried schema-qualified and quoted, because the list matches the last part of the name.
 */
const ADMIN_FUNCTIONS = new Set([
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "lo_get",
  "lo_put",
  "setval",
  "pg_switch_wal",
  "pg_promote",
  "pg_backup_start",
  "pg_backup_stop",
  "pg_start_backup",
  "pg_stop_backup",
  "pg_file_write",
  "pg_file_rename",
  "pg_file_unlink",
  "pg_file_sync",
  "lo_unlink",
  "lo_create",
  "lo_creat",
  "lo_open",
  "lo_truncate",
  "lo_from_bytea",
  "lo_close",
  "lo_lseek",
  "loread",
  "lowrite",
  "pg_notify",
  "pg_logical_emit_message",
  "pg_logical_slot_get_changes",
  "pg_logical_slot_peek_changes",
  "pg_logical_slot_get_binary_changes",
  "pg_logical_slot_peek_binary_changes",
  "pg_create_physical_replication_slot",
  "pg_create_logical_replication_slot",
  "pg_drop_replication_slot",
  "pg_replication_slot_advance",
  "pg_copy_physical_replication_slot",
  "pg_copy_logical_replication_slot",
]);

function deniedFunctionQueryCases(): SqlCase[] {
  return DENIED_FUNCTIONS.flatMap(({ name, args }) => {
    const reason = new RegExp(`cannot call ${name}\\(\\)`);
    const cases: SqlCase[] = [{ name: `a call to ${name}`, sql: `SELECT ${name}(${args})`, reason }];
    if (ADMIN_FUNCTIONS.has(name)) {
      cases.push(
        { name: `a pg_catalog-qualified call to ${name}`, sql: `SELECT pg_catalog.${name}(${args})`, reason },
        { name: `a quoted call to ${name}`, sql: `SELECT "${name}"(${args})`, reason },
        { name: `a quoted, pg_catalog-qualified call to ${name}`, sql: `SELECT pg_catalog."${name}"(${args})`, reason },
      );
    }
    return cases;
  });
}

/** Statements the keyword scan rejects in every validator, before the statement kind is checked. */
const BANNED_STATEMENTS: Array<{ name: string; sql: string }> = [
  { name: "CREATE EXTENSION", sql: "CREATE EXTENSION IF NOT EXISTS dblink" },
  { name: "CREATE TRIGGER", sql: "CREATE TRIGGER t_after AFTER INSERT ON plugin_x.t FOR EACH ROW EXECUTE FUNCTION plugin_x.f()" },
  { name: "CREATE EVENT TRIGGER", sql: "CREATE EVENT TRIGGER e_start ON ddl_command_start EXECUTE FUNCTION plugin_x.f()" },
  { name: "CREATE FUNCTION", sql: "CREATE FUNCTION plugin_x.f() RETURNS int LANGUAGE sql AS 'select 1'" },
  { name: "CREATE OR REPLACE FUNCTION", sql: "CREATE OR REPLACE FUNCTION plugin_x.f() RETURNS int LANGUAGE sql AS 'select 1'" },
  { name: "CREATE LANGUAGE", sql: "CREATE LANGUAGE plpgsql" },
  { name: "GRANT", sql: "GRANT SELECT ON plugin_x.t TO PUBLIC" },
  { name: "REVOKE", sql: "REVOKE SELECT ON plugin_x.t FROM PUBLIC" },
  { name: "ALTER FUNCTION ... SECURITY DEFINER", sql: "ALTER FUNCTION plugin_x.f() SECURITY DEFINER" },
  { name: "COPY", sql: "COPY plugin_x.t TO '/tmp/out'" },
  { name: "CALL", sql: "CALL plugin_x.p()" },
  { name: "a DO block with $$", sql: "DO $$ BEGIN END $$" },
  { name: "a DO block with LANGUAGE", sql: "DO LANGUAGE plpgsql $$ BEGIN END $$" },
];

const BANNED_REASON = /disallowed statement or clause/;
const bannedCases = (): SqlCase[] =>
  BANNED_STATEMENTS.map((b) => ({ name: `${b.name} (keyword scan)`, sql: b.sql, reason: BANNED_REASON }));

/** Text that does not parse as PostgreSQL. These cannot go through the "reject case parses" guard. */
const UNPARSEABLE: SqlCase[] = [
  { name: "a syntax error", sql: "SELEC id FROM plugin_x.t", reason: /Plugin SQL does not parse/ },
  { name: "an empty string", sql: "", reason: /Plugin SQL does not parse/ },
  { name: "an unterminated string literal", sql: "SELECT 'x", reason: /Plugin SQL does not parse/ },
  { name: "an unterminated parenthesis", sql: "CREATE TABLE plugin_test.t (id int", reason: /Plugin SQL does not parse/ },
];

const QUERY_REJECTS: SqlCase[] = [
  { name: "an unqualified relation", sql: "SELECT * FROM heartbeat_run_events WHERE company_id = $1", reason: /ctx\.db\.query relation "heartbeat_run_events" must use a fully qualified schema name/ },
  { name: "an unqualified quoted relation", sql: 'SELECT * FROM "tool_invocations"', reason: /fully qualified/ },
  { name: "a comma join to a non-whitelisted public table", sql: "SELECT a.id FROM public.agents a, public.company_skills s", reason: /not whitelisted/ },
  { name: "a comma join to an unqualified relation", sql: "SELECT a.id FROM public.agents a, tool_connection_installs i", reason: /fully qualified/ },
  { name: "ONLY on a non-whitelisted public table", sql: "SELECT * FROM ONLY public.activity_log", reason: /not whitelisted/ },
  { name: "a parenthesized join", sql: "SELECT * FROM (public.activity_log l JOIN plugin_x.t t ON true)", reason: /not whitelisted/ },
  { name: "a quoted schema with spaces around the dot", sql: 'SELECT * FROM "public" . company_skills', reason: /not whitelisted/ },
  { name: "whitespace around the dot", sql: "SELECT * FROM public . activity_log", reason: /not whitelisted/ },
  { name: "a newline before the dot", sql: "SELECT * FROM public\n.activity_log", reason: /not whitelisted/ },
  { name: "a comment used as a separator", sql: "SELECT * FROM/**/public.activity_log", reason: /not whitelisted/ },
  { name: "an unqualified relation inside a CTE body", sql: "WITH s AS (SELECT * FROM company_skills) SELECT * FROM s", reason: /fully qualified/ },
  { name: "an unqualified relation inside a scalar subquery", sql: "SELECT (SELECT json_agg(t) FROM tool_catalog_entries t) AS x", reason: /fully qualified/ },
  { name: "a CTE body that reads the table its CTE name shadows", sql: "WITH company_skills AS (SELECT * FROM company_skills) SELECT * FROM company_skills", reason: /fully qualified/ },
  { name: "a CTE body that reads a CTE defined after it", sql: "WITH a AS (SELECT * FROM b), b AS (SELECT 1 AS id) SELECT * FROM a", reason: /fully qualified/ },
  { name: "a CTE name used outside the subquery that defines it", sql: "SELECT * FROM (WITH x AS (SELECT 1 AS id) SELECT * FROM x) s, x", reason: /fully qualified/ },
  { name: "a quoted CTE name that differs in case from the relation it is read as", sql: 'WITH "A" AS (SELECT 1 AS id) SELECT * FROM a', reason: /fully qualified/ },
  { name: "a schema-qualified relation that shares its name with a CTE", sql: "WITH company_skills AS (SELECT 1 AS id) SELECT * FROM public.company_skills", reason: /not whitelisted/ },
  { name: "a database-qualified relation", sql: "SELECT * FROM paperclip.public.agents", reason: /database-qualified/ },
  { name: "a database-qualified namespace relation", sql: "SELECT * FROM paperclip.plugin_x.t", reason: /database-qualified relation paperclip\.plugin_x\.t/ },
  { name: "a qualified non-whitelisted public table", sql: "SELECT * FROM public.tool_invocations", reason: /not whitelisted/ },
  { name: "another plugin schema", sql: "SELECT * FROM plugin_other_abc.t", reason: /cannot read schema/ },
  { name: "a quoted mixed-case schema that only looks like the namespace", sql: 'SELECT * FROM "Plugin_X".t', reason: /cannot read schema/ },
  { name: "a quoted upper-case public schema", sql: 'SELECT * FROM "PUBLIC".agents', reason: /cannot read schema "PUBLIC"/ },
  { name: "a unicode-escaped schema name that decodes to public", sql: 'SELECT * FROM U&"pub\\006cic".company_skills', reason: /public\.company_skills, which is not whitelisted/ },
  { name: "a pg_catalog relation", sql: "SELECT * FROM pg_catalog.pg_authid", reason: /cannot read schema "pg_catalog"/ },
  { name: "a temp-schema relation", sql: "SELECT * FROM pg_temp.t", reason: /cannot read schema "pg_temp"/ },
  { name: "SELECT INTO", sql: "SELECT * INTO plugin_x.snap FROM plugin_x.t", reason: /SELECT INTO/ },
  { name: "SELECT INTO a temporary table", sql: "SELECT * INTO TEMP snap FROM plugin_x.t", reason: /SELECT INTO/ },
  { name: "a row lock", sql: "SELECT * FROM public.agents FOR SHARE", reason: /lock rows/ },
  { name: "FOR UPDATE on a namespace table", sql: "SELECT id FROM plugin_x.t FOR UPDATE", reason: /lock rows/ },
  { name: "FOR NO KEY UPDATE on a whitelisted table", sql: "SELECT id FROM public.issues FOR NO KEY UPDATE", reason: /lock rows/ },
  { name: "FOR KEY SHARE on a whitelisted table", sql: "SELECT id FROM public.issues FOR KEY SHARE", reason: /lock rows/ },
  { name: "FOR UPDATE ... SKIP LOCKED on a whitelisted table", sql: "SELECT id FROM public.issues FOR UPDATE OF issues SKIP LOCKED", reason: /lock rows/ },
  { name: "a row lock inside a subquery", sql: "SELECT * FROM (SELECT id FROM public.issues FOR UPDATE) s", reason: /lock rows/ },
  { name: "TABLE on a non-whitelisted public table", sql: "TABLE public.company_skills", reason: /not whitelisted/ },
  { name: "a data-modifying CTE", sql: "WITH d AS (DELETE FROM plugin_x.t RETURNING id) SELECT id FROM d", reason: /mutation/ },
  { name: "a DELETE in a CTE over a whitelisted table", sql: "WITH d AS (DELETE FROM public.agents RETURNING id) SELECT id FROM d", reason: /mutation/ },
  { name: "an UPDATE in a CTE over a whitelisted table", sql: "WITH u AS (UPDATE public.agents SET name = 'x' RETURNING id) SELECT id FROM u", reason: /mutation/ },
  { name: "an INSERT in a CTE over a whitelisted table", sql: "WITH i AS (INSERT INTO public.agents (id) VALUES (1) RETURNING id) SELECT id FROM i", reason: /mutation/ },
  { name: "a MERGE in a CTE over a whitelisted table", sql: "WITH m AS (MERGE INTO public.agents a USING plugin_x.s s ON a.id = s.id WHEN MATCHED THEN DELETE RETURNING a.id) SELECT id FROM m", reason: /mutation/ },
  { name: "a data-modifying CTE inside a subquery", sql: "SELECT * FROM (WITH d AS (DELETE FROM public.agents RETURNING id) SELECT id FROM d) s", reason: /mutation/ },
  { name: "an UPDATE statement", sql: "UPDATE plugin_x.t SET v = 1", reason: /only allows SELECT/ },
  { name: "a DELETE statement", sql: "DELETE FROM plugin_x.t", reason: /only allows SELECT/ },
  { name: "an INSERT statement", sql: "INSERT INTO plugin_x.t (id) VALUES (1)", reason: /only allows SELECT/ },
  { name: "EXPLAIN", sql: "EXPLAIN SELECT 1", reason: /only allows SELECT/ },
  { name: "SET", sql: "SET search_path = public", reason: /only allows SELECT/ },
  { name: "a DO block with a tagged dollar quote", sql: "DO $tag$ BEGIN NULL; END $tag$", reason: /only allows SELECT/ },
  { name: "two statements", sql: "SELECT id FROM plugin_x.t; SELECT 1", reason: /Plugin runtime SQL must contain exactly one statement/ },
  { name: "a comment with no statement", sql: "-- nothing here", reason: /Plugin runtime SQL must contain exactly one statement/ },
  { name: "a function that runs SQL text", sql: "SELECT query_to_xml('select * from public.company_skills', true, false, '')", reason: /cannot call query_to_xml/ },
  { name: "a function that reads a relation named in a string", sql: "SELECT table_to_xml('public.company_skills', true, false, '')", reason: /cannot call table_to_xml/ },
  { name: "a schema-qualified function that reads a server file", sql: "SELECT pg_catalog.pg_read_file('postmaster.pid')", reason: /cannot call pg_read_file/ },
  { name: "a function that changes a setting", sql: "SELECT set_config('search_path', 'public', false)", reason: /cannot call set_config/ },
  { name: "a quoted function name in mixed case", sql: "SELECT \"Set_Config\"('search_path', 'public', false)", reason: /cannot call set_config/ },
  { name: "a denied function in the FROM clause", sql: "SELECT * FROM pg_ls_dir('.')", reason: /cannot call pg_ls_dir/ },
  { name: "a denied function inside ROWS FROM", sql: "SELECT * FROM ROWS FROM (pg_ls_dir('.')) AS x", reason: /cannot call pg_ls_dir/ },
  { name: "a denied function in a lateral join", sql: "SELECT * FROM plugin_x.t, LATERAL pg_read_file(t.p)", reason: /cannot call pg_read_file/ },
  { name: "a denied function in a CTE body", sql: "WITH s AS (SELECT pg_read_file('x') AS c) SELECT c FROM s", reason: /cannot call pg_read_file/ },
  { name: "a denied function in a scalar subquery", sql: "SELECT (SELECT lo_get(1234)) AS x", reason: /cannot call lo_get/ },
  { name: "a denied function in WHERE", sql: "SELECT id FROM plugin_x.t WHERE id = pg_terminate_backend(1)::int", reason: /cannot call pg_terminate_backend/ },
  { name: "a denied function in ORDER BY", sql: "SELECT id FROM plugin_x.t ORDER BY set_config('a', 'b', false)", reason: /cannot call set_config/ },
  { name: "a denied function in a join condition", sql: "SELECT a.id FROM plugin_x.t a JOIN plugin_x.u b ON setval('s', 1) > 0", reason: /cannot call setval/ },
  ...deniedFunctionQueryCases(),
  ...bannedCases(),
];

const QUERY_PASSES: SqlCase[] = [
  { name: "a whitelisted public read", sql: "SELECT agent_id, status FROM public.heartbeat_runs WHERE id = $1" },
  { name: "a namespace join to a whitelisted table", sql: "SELECT r.id FROM plugin_x.rows r JOIN public.issues i ON i.id = r.issue_id" },
  { name: "EXTRACT(... FROM an unqualified column)", sql: "SELECT EXTRACT(DOW FROM created_at) AS do_flag FROM plugin_x.rows" },
  { name: "EXTRACT(... FROM a qualified column)", sql: "SELECT EXTRACT(DOW FROM r.created_at) AS dow FROM plugin_x.t r" },
  { name: "a quoted whitelisted table", sql: 'SELECT * FROM "public"."agents"' },
  { name: "an unquoted upper-case namespace", sql: "SELECT * FROM PLUGIN_X.t" },
  { name: "an unquoted upper-case public schema", sql: "SELECT * FROM PUBLIC.agents" },
  { name: "a recursive CTE", sql: "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 3) SELECT * FROM t" },
  { name: "a CTE chain", sql: "WITH a AS (SELECT id FROM plugin_x.t), b AS (SELECT id FROM a) SELECT * FROM b JOIN public.agents g ON g.id = b.id" },
  { name: "a CTE read from a subquery", sql: "WITH a AS (SELECT id FROM plugin_x.t) SELECT * FROM (SELECT id FROM a) s" },
  { name: "a CTE defined inside a subquery and read there", sql: "SELECT * FROM (WITH x AS (SELECT 1 AS id) SELECT id FROM x) s" },
  { name: "a parenthesized set operation with its own WITH", sql: "(WITH x AS (SELECT 1 AS a) SELECT a FROM x) UNION ALL SELECT 2" },
  { name: "a VALUES list", sql: "VALUES (1), (2)" },
  { name: "a trailing semicolon", sql: "SELECT id FROM plugin_x.t;" },
  { name: "ordinary function calls", sql: "SELECT count(*) AS n, coalesce(max(r.created_at), now()) AS latest, lower(r.label) AS label FROM plugin_x.t r GROUP BY lower(r.label)" },
  { name: "a set-returning function in FROM", sql: "SELECT n FROM generate_series(1, 3) AS n" },
  { name: "a function whose name only starts with a denied name", sql: "SELECT plugin_x.set_config_cache(1)" },
  { name: "a function whose name only ends with a denied name", sql: "SELECT plugin_x.reset_set_config(1)" },
  { name: "an outer CTE read from the main body of a subquery that has its own WITH", sql: "WITH a AS (SELECT 1 AS id) SELECT * FROM (WITH x AS (SELECT 2 AS id) SELECT a.id FROM a, x) s" },
  { name: "a CTE read from a nested WITH inside another CTE body", sql: "WITH a AS (SELECT 1 AS id), b AS (WITH c AS (SELECT id FROM a) SELECT id FROM c) SELECT id FROM b" },
  // The deny-list is a fixed list of names, not a function policy. These three stay allowed on purpose;
  // the real fix is a non-superuser runtime role. See DISALLOWED_FUNCTION_PATTERNS.
  { name: "nextval, which the deny-list deliberately leaves out", sql: "SELECT nextval('plugin_x.some_seq')" },
  { name: "pg_advisory_xact_lock, which the deny-list deliberately leaves out", sql: "SELECT pg_advisory_xact_lock(42)" },
  { name: "pg_sleep, which the deny-list deliberately leaves out", sql: "SELECT pg_sleep(0)" },
  { name: "a string literal that mentions a core table", sql: "SELECT 'see from public.company_skills' AS note FROM plugin_x.t" },
  { name: "banned words inside a string literal", sql: "SELECT 'grant copy call revoke' AS w FROM plugin_x.t" },
  { name: "a banned word inside an escaped-quote string literal", sql: "SELECT 'it''s a call' AS w FROM plugin_x.t" },
  { name: "a banned word as a quoted identifier", sql: 'SELECT "copy" FROM plugin_x.t' },
  { name: "a banned word inside a line comment", sql: "SELECT id FROM plugin_x.t -- grant everything\n" },
  { name: "a banned word inside a block comment", sql: "SELECT id /* revoke all */ FROM plugin_x.t" },
  {
    name: "a run-selection query that left-joins a namespace table",
    namespace: EXAMPLE_NAMESPACE,
    coreReadTables: ["heartbeat_runs"],
    sql: `SELECT h.id, h.agent_id, h.status, h.created_at, h.finished_at, h.log_store, h.log_ref, h.log_bytes,
       h.context_snapshot->>'issueId' AS issue_id
FROM public.heartbeat_runs h LEFT JOIN ${EXAMPLE_NAMESPACE}.ex_runs r ON r.run_id = h.id AND r.company_id = h.company_id
WHERE h.company_id = $1 AND h.created_at > now() - interval '36 days' AND h.finished_at IS NOT NULL
  AND (r.run_id IS NULL OR r.row_version < $2)
ORDER BY (r.run_id IS NULL) DESC, h.finished_at LIMIT 200`,
  },
];

const EXECUTE_REJECTS: SqlCase[] = [
  { name: "a public target", sql: "UPDATE public.issues SET title = $1", reason: /target must be inside plugin namespace/ },
  { name: "an unqualified target", sql: "UPDATE issues SET title = $1", reason: /target must be inside plugin namespace/ },
  { name: "a target in another plugin schema", sql: "INSERT INTO plugin_other_abc.t (id) VALUES ($1)", reason: /target must be inside plugin namespace/ },
  { name: "a database-qualified target", sql: "INSERT INTO paperclip.plugin_x.t (id) VALUES ($1)", reason: /target must be inside plugin namespace/ },
  { name: "a quoted mixed-case target schema", sql: 'UPDATE "Plugin_X".t SET v = $1', reason: /target must be inside plugin namespace/ },
  { name: "INSERT ... SELECT from an unqualified relation", sql: "INSERT INTO plugin_x.t (id) SELECT id FROM issues", reason: /ctx\.db\.execute relation "issues" must use a fully qualified schema name/ },
  { name: "DELETE ... USING an unqualified relation", sql: "DELETE FROM plugin_x.t USING issues i WHERE i.id = t.id", reason: /fully qualified/ },
  { name: "INSERT ... SELECT FROM ONLY a public table", sql: "INSERT INTO plugin_x.t (id) SELECT id FROM ONLY public.agents", reason: /non-plugin schemas/ },
  { name: "UPDATE ... FROM a public table", sql: "UPDATE plugin_x.t SET v = 1 FROM public.agents a WHERE a.id = t.id", reason: /non-plugin schemas/ },
  { name: "UPDATE ... SET from a subquery over a public table", sql: "UPDATE plugin_x.t SET v = (SELECT count(*) FROM public.issues)", reason: /non-plugin schemas/ },
  { name: "DELETE ... USING another plugin schema", sql: "DELETE FROM plugin_x.t USING plugin_other_abc.s s WHERE s.id = t.id", reason: /non-plugin schemas/ },
  { name: "a database-qualified relation in a SELECT", sql: "INSERT INTO plugin_x.t (id) SELECT id FROM paperclip.plugin_x.s", reason: /database-qualified relation paperclip\.plugin_x\.s/ },
  { name: "a comma join in UPDATE ... FROM", sql: "UPDATE plugin_x.t SET v = 1 FROM plugin_x.s, issues i WHERE i.id = s.id", reason: /fully qualified/ },
  { name: "a leading WITH", sql: "WITH s AS (SELECT 1 AS id) INSERT INTO plugin_x.t (id) SELECT id FROM s", reason: /only allows INSERT, UPDATE, or DELETE/ },
  { name: "a leading WITH on a DELETE", sql: "WITH s AS (SELECT 1 AS id) DELETE FROM plugin_x.t USING s WHERE s.id = t.id", reason: /only allows INSERT, UPDATE, or DELETE/ },
  { name: "a SELECT statement", sql: "SELECT 1", reason: /only allows INSERT, UPDATE, or DELETE/ },
  { name: "a MERGE statement", sql: "MERGE INTO plugin_x.t USING plugin_x.s ON t.id = s.id WHEN MATCHED THEN DELETE", reason: /only allows INSERT, UPDATE, or DELETE/ },
  { name: "TRUNCATE", sql: "TRUNCATE plugin_x.t", reason: /only allows INSERT, UPDATE, or DELETE/ },
  { name: "a DO block with a tagged dollar quote", sql: "DO $tag$ BEGIN NULL; END $tag$", reason: /only allows INSERT, UPDATE, or DELETE/ },
  { name: "two statements", sql: "INSERT INTO plugin_x.t (id) VALUES (1); INSERT INTO plugin_x.t (id) VALUES (2)", reason: /Plugin runtime SQL must contain exactly one statement/ },
  { name: "a comment with no statement", sql: "/* nothing here */", reason: /Plugin runtime SQL must contain exactly one statement/ },
  { name: "a data-modifying CTE inside an INSERT ... SELECT subquery", sql: "INSERT INTO plugin_x.t (id) SELECT id FROM (WITH d AS (DELETE FROM plugin_x.u RETURNING id) SELECT id FROM d) s", reason: /cannot nest data-modifying statements/ },
  { name: "a nested INSERT inside an INSERT", sql: "INSERT INTO plugin_x.t (id) SELECT id FROM (WITH i AS (INSERT INTO plugin_x.u (id) VALUES (1) RETURNING id) SELECT id FROM i) s", reason: /cannot nest data-modifying statements/ },
  { name: "a data-modifying CTE inside an UPDATE ... FROM subquery", sql: "UPDATE plugin_x.t SET v = 1 FROM (WITH d AS (DELETE FROM plugin_x.u RETURNING id) SELECT id FROM d) s WHERE s.id = t.id", reason: /cannot nest data-modifying statements/ },
  { name: "SELECT INTO inside INSERT ... SELECT", sql: "INSERT INTO plugin_x.t (id) SELECT id INTO plugin_x.z FROM plugin_x.s", reason: /cannot use SELECT INTO or row locks/ },
  { name: "a row lock inside INSERT ... SELECT", sql: "INSERT INTO plugin_x.t (id) SELECT id FROM plugin_x.s FOR UPDATE", reason: /cannot use SELECT INTO or row locks/ },
  { name: "a row lock inside an UPDATE ... FROM subquery", sql: "UPDATE plugin_x.t SET v = 1 FROM (SELECT id FROM plugin_x.s FOR SHARE) s WHERE s.id = t.id", reason: /cannot use SELECT INTO or row locks/ },
  { name: "a value from a function that runs SQL text", sql: "INSERT INTO plugin_x.t (word) SELECT word FROM ts_stat('SELECT to_tsvector(title) FROM public.issues')", reason: /cannot call ts_stat/ },
  { name: "a denied function in UPDATE ... SET", sql: "UPDATE plugin_x.t SET v = lo_get(1234)", reason: /cannot call lo_get/ },
  { name: "a denied function in VALUES", sql: "INSERT INTO plugin_x.t (id) VALUES (pg_terminate_backend(1))", reason: /cannot call pg_terminate_backend/ },
  { name: "a denied function in RETURNING", sql: "INSERT INTO plugin_x.t (id) VALUES (1) RETURNING setval('s', 1)", reason: /cannot call setval/ },
  { name: "a denied function in ON CONFLICT ... DO UPDATE", sql: "INSERT INTO plugin_x.t (id, v) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET v = pg_read_file('x')", reason: /cannot call pg_read_file/ },
  { name: "a denied function in a DELETE condition", sql: "DELETE FROM plugin_x.t WHERE v = set_config('a', 'b', false)", reason: /cannot call set_config/ },
  { name: "a pg_catalog-qualified denied function", sql: "UPDATE plugin_x.t SET v = pg_catalog.pg_reload_conf()", reason: /cannot call pg_reload_conf/ },
  { name: "a quoted denied function", sql: 'UPDATE plugin_x.t SET v = "pg_rotate_logfile"()', reason: /cannot call pg_rotate_logfile/ },
  ...bannedCases(),
];

const EXECUTE_PASSES: SqlCase[] = [
  { name: "a namespace insert", sql: "INSERT INTO plugin_x.t (id) VALUES ($1)" },
  { name: "an insert with RETURNING", sql: "INSERT INTO plugin_x.t (id) VALUES ($1) RETURNING id" },
  { name: "an unquoted upper-case namespace target", sql: "UPDATE PLUGIN_X.t SET v = $1" },
  { name: "INSERT ... SELECT from the namespace", sql: "INSERT INTO plugin_x.t (id) SELECT id FROM plugin_x.s WHERE id = $1" },
  { name: "INSERT ... SELECT from a subquery with its own WITH", sql: "INSERT INTO plugin_x.t (id) SELECT id FROM (WITH s AS (SELECT id FROM plugin_x.u) SELECT id FROM s) x" },
  { name: "an upsert that compares EXCLUDED values", sql: "INSERT INTO plugin_x.t AS t (id, v) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET v = EXCLUDED.v WHERE t.v IS DISTINCT FROM EXCLUDED.v" },
  { name: "UPDATE ... FROM the namespace", sql: "UPDATE plugin_x.t SET v = s.v FROM plugin_x.s s WHERE s.id = t.id" },
  { name: "DELETE ... USING the namespace", sql: "DELETE FROM plugin_x.t USING plugin_x.s s WHERE s.id = t.id RETURNING t.id" },
  { name: "a trailing semicolon", sql: "DELETE FROM plugin_x.t WHERE id = $1;" },
];

const MIGRATION_REJECTS: SqlCase[] = [
  { name: "an unqualified CREATE TABLE", sql: "CREATE TABLE rows (id uuid PRIMARY KEY, issue_id uuid REFERENCES public.issues(id))", reason: /fully qualified/ },
  { name: "a backfill into a public table", sql: "WITH source_rows AS (SELECT id FROM plugin_test.rows) INSERT INTO public.issues (id) SELECT id FROM source_rows", reason: /public/ },
  { name: "an UPDATE of a public table", sql: "UPDATE public.issues SET title = 'bad'", reason: /public/ },
  { name: "CREATE TABLE in public", sql: "CREATE TABLE public.rows (id uuid PRIMARY KEY)", reason: /public/ },
  { name: "a DO block", sql: "DO $$ BEGIN END $$", reason: /disallowed/ },
  { name: "a DO block with a tagged dollar quote", sql: "DO $tag$ BEGIN NULL; END $tag$", reason: /DDL or namespace-scoped backfill/ },
  { name: "COMMENT ON a core table", sql: "COMMENT ON TABLE public.issues IS 'x'", reason: /COMMENT target/ },
  { name: "COMMENT ON a core column", sql: "COMMENT ON COLUMN public.issues.title IS 'x'", reason: /COMMENT target/ },
  { name: "COMMENT ON another plugin schema", sql: "COMMENT ON SCHEMA plugin_other IS 'x'", reason: /COMMENT target/ },
  { name: "COMMENT ON a table named like the namespace", sql: "COMMENT ON TABLE plugin_test IS 'x'", reason: /COMMENT target/ },
  { name: "COMMENT ON a role named like the namespace", sql: "COMMENT ON ROLE plugin_test IS 'x'", reason: /COMMENT target/ },
  { name: "COMMENT ON a function", sql: "COMMENT ON FUNCTION plugin_test.f() IS 'x'", reason: /COMMENT target/ },
  { name: "INHERITS from a core table", sql: "CREATE TABLE plugin_test.t (id uuid) INHERITS (public.issues)", reason: /inherit/ },
  { name: "INHERITS from an unqualified table", sql: "CREATE TABLE plugin_test.t (id uuid) INHERITS (parent_rows)", reason: /cannot inherit from or partition/ },
  { name: "INHERITS from another plugin's table", sql: "CREATE TABLE plugin_test.t (id uuid) INHERITS (plugin_other.p)", reason: /cannot inherit from or partition/ },
  { name: "INHERITS from a database-qualified table", sql: "CREATE TABLE plugin_test.t (id uuid) INHERITS (paperclip.plugin_test.p)", reason: /cannot inherit from or partition/ },
  { name: "PARTITION OF a core table", sql: "CREATE TABLE plugin_test.p PARTITION OF public.issues FOR VALUES IN ('x')", reason: /inherit/ },
  { name: "ALTER TABLE ... INHERIT a core table", sql: "ALTER TABLE plugin_test.t INHERIT public.issues", reason: /AT_AddInherit/ },
  { name: "ALTER TABLE ... ATTACH PARTITION a core table", sql: "ALTER TABLE plugin_test.t ATTACH PARTITION public.issues FOR VALUES IN ('x')", reason: /AT_AttachPartition/ },
  { name: "ALTER TABLE ... OWNER TO", sql: "ALTER TABLE plugin_test.t OWNER TO someone", reason: /AT_ChangeOwner/ },
  { name: "ALTER TABLE ... ENABLE ROW LEVEL SECURITY", sql: "ALTER TABLE plugin_test.t ENABLE ROW LEVEL SECURITY", reason: /AT_EnableRowSecurity/ },
  { name: "moving a table to another schema", sql: "ALTER TABLE plugin_test.t SET SCHEMA public", reason: /DDL or namespace-scoped backfill/ },
  { name: "renaming a core table", sql: "ALTER TABLE public.issues RENAME TO issues_old", reason: /cannot mutate or define objects in public\.issues/ },
  { name: "renaming a schema", sql: "ALTER SCHEMA plugin_test RENAME TO plugin_other", reason: /fully qualified schema names/ },
  { name: "CREATE INDEX on a core table", sql: "CREATE INDEX rows_idx ON public.issues (id)", reason: /cannot mutate or define objects in public\.issues/ },
  { name: "CREATE INDEX on an unqualified table", sql: "CREATE INDEX rows_idx ON rows (id)", reason: /fully qualified schema names/ },
  { name: "an INSERT into another plugin's schema", sql: "INSERT INTO plugin_other.t (id) SELECT id FROM plugin_test.rows", reason: /outside namespace "plugin_test"/ },
  { name: "a database-qualified target", sql: "CREATE TABLE paperclip.plugin_test.t (id int)", reason: /database-qualified relation paperclip\.plugin_test\.t/ },
  { name: "a backfill that reads a database-qualified relation", sql: "INSERT INTO plugin_test.t (id) SELECT id FROM paperclip.public.issues", reason: /database-qualified relation paperclip\.public\.issues/ },
  { name: "a backfill that reads an unqualified relation", sql: "INSERT INTO plugin_test.t (id) SELECT id FROM agents", reason: /Plugin migration relation "agents" must use a fully qualified schema name/ },
  { name: "a backfill with a comma join to a non-whitelisted table", sql: "UPDATE plugin_test.t SET v = 1 FROM plugin_test.s, public.agents a WHERE a.id = s.id", reason: /not whitelisted/ },
  { name: "a backfill that reads another plugin's schema", sql: "INSERT INTO plugin_test.t (id) SELECT id FROM plugin_other.s", reason: /outside namespace "plugin_test"/ },
  { name: "a foreign key to a non-whitelisted core table", sql: "CREATE TABLE plugin_test.rows (id uuid PRIMARY KEY, agent_id uuid REFERENCES public.agents(id))", reason: /public\.agents, which is not whitelisted/ },
  { name: "CREATE TABLE AS from an unqualified relation", sql: "CREATE TABLE plugin_test.c AS SELECT * FROM agents", reason: /fully qualified/ },
  { name: "CREATE TABLE AS into a core schema", sql: "CREATE TABLE public.c AS SELECT id FROM plugin_test.rows", reason: /cannot mutate or define objects in public\.c/ },
  { name: "a materialized view over namespace tables", sql: "CREATE MATERIALIZED VIEW plugin_test.mv AS SELECT id FROM plugin_test.rows", reason: /DDL or namespace-scoped backfill/ },
  { name: "a materialized view over a whitelisted core table", sql: "CREATE MATERIALIZED VIEW plugin_test.mv AS SELECT id FROM public.issues", reason: /DDL or namespace-scoped backfill/ },
  { name: "REFRESH MATERIALIZED VIEW", sql: "REFRESH MATERIALIZED VIEW plugin_test.mv", reason: /DDL or namespace-scoped backfill/ },
  { name: "CREATE TABLE AS EXECUTE", sql: "CREATE TABLE plugin_test.c AS EXECUTE prepared_name", reason: /cannot create a table from EXECUTE/ },
  { name: "CREATE TABLE AS EXECUTE with parameters", sql: "CREATE TABLE plugin_test.c AS EXECUTE prepared_name(1, 'a')", reason: /cannot create a table from EXECUTE/ },
  { name: "CREATE TABLE AS EXECUTE WITH NO DATA", sql: "CREATE TABLE plugin_test.c AS EXECUTE prepared_name WITH NO DATA", reason: /cannot create a table from EXECUTE/ },
  { name: "CREATE TABLE IF NOT EXISTS AS EXECUTE", sql: "CREATE TABLE IF NOT EXISTS plugin_test.c AS EXECUTE prepared_name", reason: /cannot create a table from EXECUTE/ },
  { name: "SELECT INTO at the top level", sql: "SELECT * INTO plugin_test.snap FROM plugin_test.rows", reason: /DDL or namespace-scoped backfill/ },
  { name: "DELETE", sql: "DELETE FROM plugin_test.t", reason: /cannot delete data/ },
  { name: "DROP TABLE", sql: "DROP TABLE plugin_test.t", reason: /Destructive/ },
  { name: "TRUNCATE", sql: "TRUNCATE plugin_test.t", reason: /Destructive/ },
  { name: "MERGE", sql: "MERGE INTO plugin_test.t USING plugin_test.s ON t.id = s.id WHEN MATCHED THEN DELETE", reason: /DDL or namespace-scoped backfill/ },
  { name: "two statements", sql: "CREATE TABLE plugin_test.a (id int); CREATE TABLE plugin_test.b (id int)", reason: /Plugin migration statement must contain exactly one statement/ },
  { name: "a comment with no statement", sql: "-- nothing here", reason: /Plugin migration statement must contain exactly one statement/ },
  { name: "a DELETE in a CTE over a whitelisted table", sql: "WITH d AS (DELETE FROM public.issues RETURNING id) INSERT INTO plugin_test.t (id) SELECT id FROM d", reason: /cannot nest data-modifying statements/ },
  { name: "an UPDATE in a CTE over a whitelisted table", sql: "WITH u AS (UPDATE public.issues SET title = 'x' RETURNING id) UPDATE plugin_test.t SET v = 1 FROM u WHERE u.id = t.id", reason: /cannot nest data-modifying statements/ },
  { name: "an INSERT in a CTE over a whitelisted table", sql: "WITH i AS (INSERT INTO public.issues (id) VALUES (1) RETURNING id) INSERT INTO plugin_test.t (id) SELECT id FROM i", reason: /cannot nest data-modifying statements/ },
  { name: "a MERGE in a CTE over a whitelisted table", sql: "WITH m AS (MERGE INTO public.issues i USING plugin_test.s s ON i.id = s.id WHEN MATCHED THEN DELETE RETURNING i.id) INSERT INTO plugin_test.t (id) SELECT id FROM m", reason: /cannot nest data-modifying statements/ },
  { name: "a data-modifying CTE inside a subquery of a backfill", sql: "INSERT INTO plugin_test.t (id) SELECT id FROM (WITH d AS (DELETE FROM public.issues RETURNING id) SELECT id FROM d) s", reason: /cannot nest data-modifying statements/ },
  { name: "SELECT INTO inside a backfill", sql: "INSERT INTO plugin_test.t (id) SELECT id INTO plugin_test.z FROM plugin_test.s", reason: /cannot use SELECT INTO or row locks/ },
  { name: "SELECT INTO inside CREATE TABLE AS", sql: "CREATE TABLE plugin_test.c AS SELECT id INTO plugin_test.z FROM plugin_test.s", reason: /cannot use SELECT INTO or row locks/ },
  { name: "a row lock on a whitelisted table inside a backfill", sql: "INSERT INTO plugin_test.t (id) SELECT id FROM public.issues FOR UPDATE", reason: /cannot use SELECT INTO or row locks/ },
  { name: "a row lock on a whitelisted table inside an UPDATE ... FROM subquery", sql: "UPDATE plugin_test.t SET v = 1 FROM (SELECT id FROM public.issues FOR SHARE) s WHERE s.id = t.id", reason: /cannot use SELECT INTO or row locks/ },
  { name: "a row lock inside CREATE TABLE AS", sql: "CREATE TABLE plugin_test.c AS SELECT id FROM public.issues FOR NO KEY UPDATE", reason: /cannot use SELECT INTO or row locks/ },
  { name: "a namespace view over a whitelisted table", sql: "CREATE VIEW plugin_test.v AS SELECT r.id FROM plugin_test.rows r JOIN public.issues i ON i.id = r.issue_id", reason: /Plugin views cannot read public\.issues/ },
  { name: "CREATE OR REPLACE VIEW over a whitelisted table", sql: "CREATE OR REPLACE VIEW plugin_test.v AS SELECT id FROM public.issues", reason: /Plugin views cannot read public\.issues/ },
  { name: "a view over a whitelisted table through a CTE", sql: "CREATE VIEW plugin_test.v AS WITH a AS (SELECT id FROM public.issues) SELECT id FROM a", reason: /Plugin views cannot read public\.issues/ },
  { name: "a view in a core schema", sql: "CREATE VIEW public.v AS SELECT id FROM plugin_test.rows", reason: /cannot mutate or define objects in public\.v/ },
  { name: "a view with an unqualified name", sql: "CREATE VIEW v AS SELECT id FROM plugin_test.rows", reason: /fully qualified schema names/ },
  { name: "a view over a catalog relation", sql: "CREATE VIEW plugin_test.v AS SELECT * FROM pg_catalog.pg_authid", reason: /outside namespace "plugin_test"/ },
  { name: "a view whose body runs SQL text", sql: "CREATE VIEW plugin_test.v AS SELECT query_to_xml('select * from public.company_skills', true, false, '') AS x", reason: /cannot call query_to_xml/ },
  { name: "a denied function in a column default", sql: "CREATE TABLE plugin_test.t (n bigint DEFAULT setval('public.some_seq', 1))", reason: /cannot call setval/ },
  { name: "a denied function in an index expression", sql: "CREATE INDEX t_idx ON plugin_test.t ((set_config('a', 'b', false)))", reason: /cannot call set_config/ },
  { name: "a denied function in a CHECK constraint", sql: "ALTER TABLE plugin_test.t ADD CONSTRAINT t_chk CHECK (pg_reload_conf())", reason: /cannot call pg_reload_conf/ },
  { name: "a denied function in a column type conversion", sql: "ALTER TABLE plugin_test.t ALTER COLUMN v TYPE text USING pg_read_file(v)", reason: /cannot call pg_read_file/ },
  { name: "a denied function in a backfill UPDATE", sql: "UPDATE plugin_test.t SET v = lo_get(1234)", reason: /cannot call lo_get/ },
  { name: "a denied function in a backfill INSERT", sql: "INSERT INTO plugin_test.t (v) VALUES (pg_terminate_backend(1))", reason: /cannot call pg_terminate_backend/ },
  { name: "a denied function in CREATE TABLE AS", sql: "CREATE TABLE plugin_test.c AS SELECT lo_put(1234, 0, 'abc'::bytea) AS r", reason: /cannot call lo_put/ },
  { name: "a pg_catalog-qualified denied function in a view", sql: "CREATE VIEW plugin_test.v AS SELECT pg_catalog.pg_cancel_backend(1) AS r", reason: /cannot call pg_cancel_backend/ },
  { name: "a quoted denied function in a view", sql: 'CREATE VIEW plugin_test.v AS SELECT "pg_rotate_logfile"() AS r', reason: /cannot call pg_rotate_logfile/ },
  { name: "a namespace name with a space", sql: "CREATE TABLE plugin_test.t (id int)", namespace: "plugin test", reason: /Unsafe SQL namespace: plugin test/ },
  { name: "a namespace name that ends a statement", sql: "CREATE TABLE plugin_test.t (id int)", namespace: "plugin_test; DROP SCHEMA public", reason: /Unsafe SQL namespace/ },
  { name: "a namespace name that starts with a digit", sql: "CREATE TABLE plugin_test.t (id int)", namespace: "1plugin", reason: /Unsafe SQL namespace/ },
  { name: "a namespace name with a hyphen", sql: "CREATE TABLE plugin_test.t (id int)", namespace: "plugin-test", reason: /Unsafe SQL namespace/ },
  { name: "an empty namespace name", sql: "CREATE TABLE plugin_test.t (id int)", namespace: "", reason: /Unsafe SQL namespace/ },
  { name: "a namespace name with a double quote", sql: "CREATE TABLE plugin_test.t (id int)", namespace: 'plugin_test"', reason: /Unsafe SQL namespace/ },
  ...bannedCases(),
];

const MIGRATION_PASSES: SqlCase[] = [
  { name: "CREATE TABLE with a whitelisted public foreign key", sql: "CREATE TABLE plugin_test.rows (id uuid PRIMARY KEY, issue_id uuid REFERENCES public.issues(id))" },
  { name: "CREATE TABLE ... INHERITS a namespace table", sql: "CREATE TABLE plugin_test.child (id uuid) INHERITS (plugin_test.parent)" },
  { name: "CREATE TABLE ... PARTITION OF a namespace table", sql: "CREATE TABLE plugin_test.p1 PARTITION OF plugin_test.p FOR VALUES IN ('x')" },
  { name: "CREATE INDEX", sql: "CREATE INDEX IF NOT EXISTS rows_issue_idx ON plugin_test.rows (issue_id)" },
  { name: "a WITH ... INSERT backfill", sql: "WITH source_rows AS (SELECT id FROM plugin_test.rows) INSERT INTO plugin_test.row_copies (id) SELECT id FROM source_rows ON CONFLICT (id) DO NOTHING" },
  { name: "an INSERT backfill that reads a whitelisted core table", sql: "INSERT INTO plugin_test.rows (id) SELECT id FROM public.issues" },
  { name: "an UPDATE ... FROM backfill", sql: "UPDATE plugin_test.rows r SET copied_from_id = s.id FROM plugin_test.source_rows s WHERE s.id = r.id" },
  { name: "COMMENT ON a namespace table", sql: "COMMENT ON TABLE plugin_test.rows IS 'rows'" },
  { name: "COMMENT ON a namespace column", sql: "COMMENT ON COLUMN plugin_test.rows.issue_id IS 'fk'" },
  { name: "COMMENT ON the namespace schema", sql: "COMMENT ON SCHEMA plugin_test IS 'plugin schema'" },
  { name: "CREATE TABLE AS from the namespace", sql: "CREATE TABLE plugin_test.c AS SELECT id FROM plugin_test.rows" },
  { name: "RENAME COLUMN inside the namespace", sql: "ALTER TABLE plugin_test.rows RENAME COLUMN label TO title" },
  { name: "RENAME TO inside the namespace", sql: "ALTER TABLE plugin_test.rows RENAME TO rows_old" },
  { name: "ALTER TABLE ... ADD COLUMN", sql: "ALTER TABLE plugin_test.rows ADD COLUMN note text" },
  { name: "ALTER TABLE ... SET DEFAULT", sql: "ALTER TABLE plugin_test.rows ALTER COLUMN note SET DEFAULT 'x'" },
  { name: "ALTER TABLE ... SET NOT NULL", sql: "ALTER TABLE plugin_test.rows ALTER COLUMN note SET NOT NULL" },
  { name: "ALTER TABLE ... DROP NOT NULL", sql: "ALTER TABLE plugin_test.rows ALTER COLUMN note DROP NOT NULL" },
  { name: "ALTER TABLE ... ALTER COLUMN TYPE", sql: "ALTER TABLE plugin_test.rows ALTER COLUMN note TYPE varchar(20)" },
  { name: "ALTER TABLE ... ADD CONSTRAINT with a whitelisted foreign key", sql: "ALTER TABLE plugin_test.rows ADD CONSTRAINT rows_issue_fk FOREIGN KEY (issue_id) REFERENCES public.issues(id)" },
  { name: "ALTER TABLE ... DROP CONSTRAINT", sql: "ALTER TABLE plugin_test.rows DROP CONSTRAINT rows_issue_fk" },
  { name: "ALTER TABLE ... VALIDATE CONSTRAINT", sql: "ALTER TABLE plugin_test.rows VALIDATE CONSTRAINT rows_issue_fk" },
  { name: "DROP COLUMN inside the namespace", sql: "ALTER TABLE plugin_test.rows DROP COLUMN label" },
  { name: "a trailing semicolon", sql: "CREATE TABLE plugin_test.rows (id uuid PRIMARY KEY);" },
  { name: "a namespace view over namespace tables", sql: "CREATE VIEW plugin_test.v AS SELECT r.id FROM plugin_test.rows r JOIN plugin_test.source_rows s ON s.id = r.id" },
  { name: "a namespace view with its own CTE", sql: "CREATE VIEW plugin_test.v AS WITH a AS (SELECT id FROM plugin_test.rows) SELECT id FROM a" },
  { name: "a column default that calls nextval", sql: "CREATE TABLE plugin_test.t (n bigint DEFAULT nextval('plugin_test.t_seq'))" },
  { name: "banned words inside a string literal", sql: "COMMENT ON TABLE plugin_test.rows IS 'grant copy call'" },
];

function runQuery(c: SqlCase): void {
  validatePluginRuntimeQuery(c.sql, c.namespace ?? RUNTIME_NAMESPACE, c.coreReadTables ?? RUNTIME_CORE_READ_TABLES);
}

function runExecute(c: SqlCase): void {
  validatePluginRuntimeExecute(c.sql, c.namespace ?? RUNTIME_NAMESPACE);
}

function runMigration(c: SqlCase): void {
  validatePluginMigrationStatement(c.sql, c.namespace ?? MIGRATION_NAMESPACE, c.coreReadTables ?? MIGRATION_CORE_READ_TABLES);
}

describe("plugin SQL validator: ctx.db.query", () => {
  it.each(QUERY_REJECTS)("rejects $name", (c) => {
    expect(() => runQuery(c)).toThrow(c.reason);
  });
  it.each(QUERY_PASSES)("allows $name", (c) => {
    expect(() => runQuery(c)).not.toThrow();
  });
  it.each(UNPARSEABLE)("rejects text that does not parse: $name", (c) => {
    expect(() => runQuery(c)).toThrow(c.reason);
  });
});

describe("plugin SQL validator: ctx.db.execute", () => {
  it.each(EXECUTE_REJECTS)("rejects $name", (c) => {
    expect(() => runExecute(c)).toThrow(c.reason);
  });
  it.each(EXECUTE_PASSES)("allows $name", (c) => {
    expect(() => runExecute(c)).not.toThrow();
  });
  it.each(UNPARSEABLE)("rejects text that does not parse: $name", (c) => {
    expect(() => runExecute(c)).toThrow(c.reason);
  });
});

describe("plugin SQL validator: migrations", () => {
  it.each(MIGRATION_REJECTS)("rejects $name", (c) => {
    expect(() => runMigration(c)).toThrow(c.reason);
  });
  it.each(MIGRATION_PASSES)("allows $name", (c) => {
    expect(() => runMigration(c)).not.toThrow();
  });
  it.each(UNPARSEABLE)("rejects text that does not parse: $name", (c) => {
    expect(() => runMigration(c)).toThrow(c.reason);
  });
});

describe("plugin SQL validator: case table integrity", () => {
  const rejectCases = [...QUERY_REJECTS, ...EXECUTE_REJECTS, ...MIGRATION_REJECTS];
  it.each(rejectCases)("reject case parses as PostgreSQL: $name", (c) => {
    expect(() => parseSync(c.sql)).not.toThrow();
    expect(c.reason).toBeInstanceOf(RegExp);
  });
  it.each(UNPARSEABLE)("unparseable case really does not parse: $name", (c) => {
    expect(() => parseSync(c.sql)).toThrow();
  });
  it("lists each denied function once", () => {
    const names = DENIED_FUNCTIONS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("plugin SQL validator: parser loading", () => {
  it("does not load the parser when the server imports the plugin database service", async () => {
    vi.resetModules();
    let parserImported = false;
    vi.doMock("libpg-query", async (importOriginal) => {
      parserImported = true;
      return importOriginal();
    });
    try {
      const fresh = await import("../services/plugin-database.js");
      expect(parserImported).toBe(false);
      await fresh.loadPluginSqlParser();
      expect(parserImported).toBe(true);
    } finally {
      vi.doUnmock("libpg-query");
    }
  });

  it("gives concurrent callers the same in-flight load and resolves once it is loaded", async () => {
    vi.resetModules();
    const fresh = await import("../services/plugin-sql-validator.js");
    const first = fresh.loadPluginSqlParser();
    const second = fresh.loadPluginSqlParser();
    expect(second).toBe(first);
    await first;
    await expect(fresh.loadPluginSqlParser()).resolves.toBeUndefined();
    expect(() => fresh.validatePluginRuntimeQuery("SELECT id FROM plugin_x.t", "plugin_x")).not.toThrow();
  });

  it("fails only the call that needed the parser when the load fails, and retries on the next call", async () => {
    vi.resetModules();
    let loads = 0;
    vi.doMock("libpg-query", async (importOriginal) => {
      const real = await importOriginal<typeof import("libpg-query")>();
      return {
        ...real,
        loadModule: async () => {
          loads += 1;
          if (loads === 1) throw new Error("wasm build failed");
          return real.loadModule();
        },
      };
    });
    try {
      const fresh = await import("../services/plugin-sql-validator.js");
      await expect(fresh.loadPluginSqlParser()).rejects.toThrow(/wasm build failed/);
      expect(() => fresh.validatePluginRuntimeQuery("SELECT id FROM plugin_x.t", "plugin_x")).toThrow(/not loaded/);
      await expect(fresh.loadPluginSqlParser()).resolves.toBeUndefined();
      expect(loads).toBe(2);
      expect(() => fresh.validatePluginRuntimeQuery("SELECT id FROM plugin_x.t", "plugin_x")).not.toThrow();
    } finally {
      vi.doUnmock("libpg-query");
    }
  });

  it("rejects every statement until the parser is loaded", async () => {
    vi.resetModules();
    const fresh = await import("../services/plugin-sql-validator.js");
    expect(() => fresh.validatePluginRuntimeQuery("SELECT id FROM plugin_x.t", "plugin_x")).toThrow(/not loaded/);
    expect(() => fresh.validatePluginRuntimeExecute("INSERT INTO plugin_x.t (id) VALUES (1)", "plugin_x")).toThrow(/not loaded/);
    expect(() => fresh.validatePluginMigrationStatement("CREATE TABLE plugin_x.t (id int)", "plugin_x")).toThrow(/not loaded/);
    await fresh.loadPluginSqlParser();
    expect(() => fresh.validatePluginRuntimeQuery("SELECT id FROM plugin_x.t", "plugin_x")).not.toThrow();
  });
});

describe("plugin SQL validator: migration split", () => {
  it("splits on statement boundaries when comments hold multi-byte text", () => {
    const file = "-- naïve — header\nCREATE TABLE plugin_x.a (id int);\n/* café 🚀 */\nCREATE TABLE plugin_x.b (id int);\n";
    expect(splitPluginMigrationSql(file)).toEqual([
      "-- naïve — header\nCREATE TABLE plugin_x.a (id int)",
      "/* café 🚀 */\nCREATE TABLE plugin_x.b (id int)",
    ]);
  });

  it("keeps a dollar-quoted semicolon inside its statement", () => {
    const file = "COMMENT ON TABLE plugin_x.a IS $$a;b$$;\nCREATE INDEX a_idx ON plugin_x.a (id);";
    expect(splitPluginMigrationSql(file)).toEqual([
      "COMMENT ON TABLE plugin_x.a IS $$a;b$$",
      "CREATE INDEX a_idx ON plugin_x.a (id)",
    ]);
  });

  it("returns no statements for an empty or comment-only file", () => {
    expect(splitPluginMigrationSql("")).toEqual([]);
    expect(splitPluginMigrationSql("  \n")).toEqual([]);
    expect(splitPluginMigrationSql("-- only a comment\n")).toEqual([]);
  });

  it("rejects a file that does not parse", () => {
    expect(() => splitPluginMigrationSql("CREATE TABLE plugin_x.a (")).toThrow(/does not parse/);
  });

  it("splits a file that starts with a byte order mark", () => {
    expect(splitPluginMigrationSql("\uFEFFCREATE TABLE plugin_x.a (id int);\nCREATE TABLE plugin_x.b (id int);")).toEqual([
      "CREATE TABLE plugin_x.a (id int)",
      "CREATE TABLE plugin_x.b (id int)",
    ]);
  });

  describe("a semicolon that is not a statement boundary", () => {
    const NEXT = "CREATE INDEX a_idx ON plugin_x.a (id)";
    const cases: Array<{ name: string; statement: string }> = [
      { name: "an untagged dollar-quoted body", statement: "DO $$ BEGIN PERFORM 1; PERFORM 2; END $$" },
      { name: "a tagged dollar-quoted body", statement: "COMMENT ON TABLE plugin_x.a IS $body$one; two; three$body$" },
      {
        name: "a tagged dollar-quoted body that holds a different dollar quote",
        statement: "COMMENT ON TABLE plugin_x.a IS $outer$ $$ ; $$ $inner$ ; $inner$ $outer$",
      },
      { name: "a line comment", statement: "CREATE TABLE plugin_x.a (id int, -- one; two\n name text)" },
      { name: "a block comment", statement: "CREATE TABLE plugin_x.a (id int /* one; two */, name text)" },
      { name: "a nested block comment", statement: "CREATE TABLE plugin_x.a (id int /* one /* two; */ three; */, name text)" },
      { name: "a string literal", statement: "COMMENT ON TABLE plugin_x.a IS 'one; two'" },
      { name: "a string literal with a doubled quote", statement: "COMMENT ON TABLE plugin_x.a IS 'it''s; here'" },
      { name: "an escape string with a backslash-escaped quote", statement: "COMMENT ON TABLE plugin_x.a IS E'it\\'s; here'" },
      { name: "a quoted identifier", statement: 'CREATE TABLE plugin_x."a;b" (id int)' },
      { name: "a string literal after multi-byte text", statement: "COMMENT ON TABLE plugin_x.a IS '🚀 café; naïve'" },
    ];

    it.each(cases)("does not split on a semicolon inside $name", ({ statement }) => {
      expect(splitPluginMigrationSql(`${statement};\n${NEXT};`)).toEqual([statement, NEXT]);
      expect(splitPluginMigrationSql(`${NEXT};\n${statement}`)).toEqual([NEXT, statement]);
      expect(splitPluginMigrationSql(statement)).toEqual([statement]);
    });

    it("still rejects a disallowed statement whose body holds a semicolon", () => {
      const [fragment] = splitPluginMigrationSql(`DO $$ BEGIN PERFORM 1; END $$;\n${NEXT};`);
      expect(fragment).toBe("DO $$ BEGIN PERFORM 1; END $$");
      expect(() => validatePluginMigrationStatement(fragment!, "plugin_x")).toThrow(/disallowed/i);
    });
  });

  describe("a statement that follows the end of a quoted region", () => {
    // A hand splitter reads the apostrophe inside the dollar quote as the start of a string,
    // so it never sees the statements after it. The parser does.
    const AFTER_DOLLAR_QUOTE = [
      "COMMENT ON TABLE plugin_x.a IS $$ ' $$;",
      "DROP TABLE plugin_x.a;",
      "COMMENT ON TABLE plugin_x.a IS ' $$'",
    ].join("\n");

    it("returns a statement that follows a dollar-quote end as its own statement", () => {
      expect(splitPluginMigrationSql(AFTER_DOLLAR_QUOTE)).toEqual([
        "COMMENT ON TABLE plugin_x.a IS $$ ' $$",
        "DROP TABLE plugin_x.a",
        "COMMENT ON TABLE plugin_x.a IS ' $$'",
      ]);
    });

    it("validates each fragment, so a statement after a dollar-quote end is rejected when it is disallowed", () => {
      const fragments = splitPluginMigrationSql(AFTER_DOLLAR_QUOTE);
      expect(() => validatePluginMigrationStatement(fragments[0]!, "plugin_x")).not.toThrow();
      expect(() => validatePluginMigrationStatement(fragments[1]!, "plugin_x")).toThrow(/Destructive/i);
      expect(() => validatePluginMigrationStatement(fragments[2]!, "plugin_x")).not.toThrow();
    });

    it.each([
      { name: "a table outside the plugin namespace", statement: "CREATE TABLE public.escape (id int)", reason: /public/i },
      { name: "a delete", statement: "DELETE FROM plugin_x.a", reason: /cannot delete/i },
      { name: "a grant", statement: "GRANT ALL ON plugin_x.a TO PUBLIC", reason: /disallowed/i },
      {
        name: "a function that runs SQL text",
        statement: "INSERT INTO plugin_x.a (id) SELECT query_to_xml('select 1', true, false, '')",
        reason: /cannot call query_to_xml/i,
      },
    ])("rejects $name that follows a dollar-quote end", ({ statement, reason }) => {
      const file = `COMMENT ON TABLE plugin_x.a IS $$ ' $$;\n${statement};\nCOMMENT ON TABLE plugin_x.a IS ' $$'`;
      const fragments = splitPluginMigrationSql(file);
      expect(fragments).toHaveLength(3);
      expect(fragments[1]).toBe(statement);
      expect(() => validatePluginMigrationStatement(fragments[1]!, "plugin_x")).toThrow(reason);
    });

    it("returns a statement that follows a comment, a string and a quoted identifier as its own statement", () => {
      const file = [
        "COMMENT ON TABLE plugin_x.a IS 'x'; -- ; DROP TABLE plugin_x.a",
        "/* ; */ DROP TABLE plugin_x.b;",
        'CREATE TABLE plugin_x."c;" (id int);',
      ].join("\n");
      expect(splitPluginMigrationSql(file)).toEqual([
        "COMMENT ON TABLE plugin_x.a IS 'x'",
        "-- ; DROP TABLE plugin_x.a\n/* ; */ DROP TABLE plugin_x.b",
        'CREATE TABLE plugin_x."c;" (id int)',
      ]);
    });
  });

  describe("the validated text is the executed text", () => {
    const files: Array<{ name: string; file: string }> = [
      { name: "plain statements", file: "CREATE TABLE plugin_x.a (id int);\nCREATE TABLE plugin_x.b (id int);\n" },
      { name: "statements with extra separators and blank space", file: ";;\n\n  CREATE TABLE plugin_x.a (id int) ;  ;\n\t\nCREATE TABLE plugin_x.b (id int)\n;\n" },
      {
        name: "dollar quotes, strings and comments",
        file: "COMMENT ON TABLE plugin_x.a IS $$ ' ; $$;\n-- ; note\nCOMMENT ON TABLE plugin_x.b IS 'a;b'; /* ; */ COMMENT ON TABLE plugin_x.c IS E'a\\';b'",
      },
      {
        name: "multi-byte text before every boundary",
        file: "-- ünïcödé\nCOMMENT ON TABLE plugin_x.a IS '🚀;';\n-- 日本語\nCOMMENT ON TABLE plugin_x.b IS $$ñ;$$;\nCOMMENT ON TABLE plugin_x.c IS '€'",
      },
      { name: "a statement after a dollar-quote end that holds an apostrophe", file: "COMMENT ON TABLE plugin_x.a IS $$ ' $$;\nDROP TABLE plugin_x.a;\nCOMMENT ON TABLE plugin_x.a IS ' $$'" },
    ];

    it.each(files)("cuts fragments that are verbatim slices of the file, with only separators between them: $name", ({ file }) => {
      const fragments = splitPluginMigrationSql(file);
      expect(fragments.length).toBeGreaterThan(0);
      let cursor = 0;
      for (const fragment of fragments) {
        const at = file.indexOf(fragment, cursor);
        expect(at).toBeGreaterThanOrEqual(cursor);
        // Nothing but whitespace and statement separators sits between two fragments.
        expect(file.slice(cursor, at)).toMatch(/^[\s;]*$/);
        cursor = at + fragment.length;
      }
      expect(file.slice(cursor)).toMatch(/^[\s;]*$/);
    });

    it.each(files)("cuts fragments that each parse to exactly one statement and split to themselves: $name", ({ file }) => {
      for (const fragment of splitPluginMigrationSql(file)) {
        expect((parseSync(fragment).stmts ?? []).length).toBe(1);
        expect(splitPluginMigrationSql(fragment)).toEqual([fragment]);
        expect(fragment).toBe(fragment.trim());
      }
    });

    it.each(files)("cuts fragments that pass the validator's one-statement check: $name", ({ file }) => {
      // The validator throws a count error for any text that is not exactly one statement. A
      // fragment can still be rejected for another reason, such as a DROP, but never for its count.
      for (const fragment of splitPluginMigrationSql(file)) {
        expect(() => validatePluginMigrationStatement(fragment, "plugin_x", ["issues"])).not.toThrow(
          /exactly one statement/,
        );
      }
    });
  });
});

const NUL = String.fromCharCode(0);
const NBSP = String.fromCharCode(0xa0);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const ZERO_WIDTH_NO_BREAK_SPACE = String.fromCharCode(0xfeff);

describe("plugin SQL validator: NUL bytes", () => {
  // The parser stops reading at the first NUL. Text after one must never be validated as if it were
  // the whole statement, or dropped from a split.
  it("rejects a migration file whose first statement holds a NUL before its semicolon", () => {
    const file = `CREATE TABLE plugin_x.a (id int)${NUL}; ALTER TABLE public.issues ADD COLUMN extra int`;
    expect(() => splitPluginMigrationSql(file)).toThrow(/does not parse/);
  });

  it("rejects a migration file with a NUL after a semicolon, so no later statement is dropped", () => {
    const file = `CREATE TABLE plugin_x.a (id int);${NUL}\nCREATE TABLE plugin_x.b (id int);\nCREATE TABLE plugin_x.c (id int);`;
    expect(() => splitPluginMigrationSql(file)).toThrow(/does not parse/);
  });

  it("rejects a migration file that holds only a NUL", () => {
    expect(() => splitPluginMigrationSql(NUL)).toThrow(/does not parse/);
  });

  it("rejects a NUL inside a string literal", () => {
    expect(() => splitPluginMigrationSql(`COMMENT ON TABLE plugin_x.a IS 'a${NUL}b';`)).toThrow(/does not parse/);
  });

  it("rejects a NUL in a single migration statement", () => {
    expect(() =>
      validatePluginMigrationStatement(`CREATE TABLE plugin_x.a (id int)${NUL}; ALTER TABLE public.issues ADD COLUMN extra int`, "plugin_x"),
    ).toThrow(/does not parse/);
  });

  it("rejects a NUL in a runtime query", () => {
    expect(() =>
      validatePluginRuntimeQuery(`SELECT id FROM plugin_x.t${NUL}; SELECT id FROM public.issues`, "plugin_x"),
    ).toThrow(/does not parse/);
    expect(() => validatePluginRuntimeQuery(`SELECT id FROM plugin_x.t WHERE note = 'a${NUL}b'`, "plugin_x")).toThrow(
      /does not parse/,
    );
  });

  it("rejects a NUL in a runtime execute", () => {
    expect(() =>
      validatePluginRuntimeExecute(`DELETE FROM plugin_x.t${NUL}; DELETE FROM public.issues`, "plugin_x"),
    ).toThrow(/does not parse/);
  });
});

describe("plugin SQL validator: whitespace that is part of a name", () => {
  // PostgreSQL skips only space, tab, newline, carriage return, form feed and vertical tab between
  // tokens. Any other character, including a Unicode space, belongs to the word next to it.
  it.each([
    { name: "a no-break space", character: NBSP },
    { name: "an ideographic space", character: IDEOGRAPHIC_SPACE },
    { name: "a zero-width no-break space", character: ZERO_WIDTH_NO_BREAK_SPACE },
  ])("keeps $name that ends the last word of a statement, so the fragment parses like the file", ({ character }) => {
    const file = `ALTER TABLE plugin_x.a RENAME TO b${character};\nCREATE TABLE plugin_x.c (id int)`;
    const [fragment] = splitPluginMigrationSql(file);
    expect(fragment).toBe(`ALTER TABLE plugin_x.a RENAME TO b${character}`);
    const newName = (statements: ReturnType<typeof parseSync>) =>
      (statements.stmts?.[0]?.stmt as { RenameStmt?: { newname?: string } } | undefined)?.RenameStmt?.newname;
    expect(newName(parseSync(file))).toBe(`b${character}`);
    expect(newName(parseSync(fragment!))).toBe(`b${character}`);
    expect(splitPluginMigrationSql(fragment!)).toEqual([fragment]);
  });

  it.each([
    { name: "a no-break space", character: NBSP },
    { name: "an ideographic space", character: IDEOGRAPHIC_SPACE },
  ])("rejects $name between two statements instead of trimming it", ({ character }) => {
    expect(() =>
      splitPluginMigrationSql(`CREATE TABLE plugin_x.a (id int);\n${character}CREATE TABLE plugin_x.b (id int)`),
    ).toThrow(/does not parse/);
  });

  it("does not treat a file that holds only a Unicode space as empty", () => {
    expect(() => splitPluginMigrationSql(NBSP)).toThrow(/does not parse/);
  });

  it("trims every character PostgreSQL skips between tokens", () => {
    expect(splitPluginMigrationSql(" \t\r\n\f\vCREATE TABLE plugin_x.a (id int) \t\r\n\f\v;\n")).toEqual([
      "CREATE TABLE plugin_x.a (id int)",
    ]);
  });
});

describe("plugin SQL validator: unpaired UTF-16 surrogates", () => {
  // libpg-query sizes its input buffer by counting every surrogate as four bytes, but it writes an
  // unpaired one as three. The buffer comes out short and the end of the text is never parsed, while
  // the driver sends the whole string to the server.
  const HIGH = String.fromCharCode(0xd800);
  const LOW = String.fromCharCode(0xdc00);
  const ROCKET = String.fromCharCode(0xd83d, 0xde80);
  const THREE_BYTE = String.fromCharCode(0x65e5);
  const TAIL = "; DELETE FROM public.issues ";
  const PAD = TAIL.length;

  type Shape = { name: string; build: (padding: string) => { runtime: string; execute: string; migration: string } };
  const inLiteral = (padding: string) => ({
    runtime: `SELECT id FROM plugin_x.t WHERE n = '${padding}'${TAIL}`,
    execute: `INSERT INTO plugin_x.t (n) VALUES ('${padding}')${TAIL}`,
    migration: `COMMENT ON TABLE plugin_x.a IS '${padding}'${TAIL}`,
  });
  const inBlockComment = (padding: string) => ({
    runtime: `SELECT id FROM plugin_x.t /* ${padding} */${TAIL}`,
    execute: `INSERT INTO plugin_x.t (n) VALUES (1) /* ${padding} */${TAIL}`,
    migration: `COMMENT ON TABLE plugin_x.a IS 'x' /* ${padding} */${TAIL}`,
  });
  const inLineComment = (padding: string) => ({
    runtime: `SELECT id FROM plugin_x.t -- ${padding}\n${TAIL}`,
    execute: `INSERT INTO plugin_x.t (n) VALUES (1) -- ${padding}\n${TAIL}`,
    migration: `COMMENT ON TABLE plugin_x.a IS 'x' -- ${padding}\n${TAIL}`,
  });
  const beforeSemicolon = (padding: string) => ({
    runtime: `SELECT id FROM plugin_x.t WHERE n = 'x'${padding}${TAIL}`,
    execute: `INSERT INTO plugin_x.t (n) VALUES (1)${padding}${TAIL}`,
    migration: `COMMENT ON TABLE plugin_x.a IS 'x'${padding}${TAIL}`,
  });
  const shapes: Shape[] = [
    { name: "in a string literal", build: inLiteral },
    { name: "in a block comment", build: inBlockComment },
    { name: "in a line comment", build: inLineComment },
    { name: "directly before the semicolon", build: beforeSemicolon },
  ];
  const paddings = [
    { name: "lone high surrogates", padding: HIGH.repeat(PAD) },
    { name: "lone low surrogates", padding: LOW.repeat(PAD) },
    { name: "high surrogates followed by three-byte characters", padding: (HIGH + THREE_BYTE).repeat(PAD) },
    { name: "low surrogates followed by two-byte characters", padding: (LOW + "é").repeat(PAD) },
    { name: "a single lone high surrogate", padding: HIGH },
    { name: "a single lone low surrogate", padding: LOW },
  ];
  const combos = shapes.flatMap((shape) => paddings.map((p) => ({ shape: shape.name, build: shape.build, padding: p.padding, kind: p.name })));

  it.each(combos)("rejects $kind $shape in a runtime query", ({ build, padding }) => {
    expect(() => validatePluginRuntimeQuery(build(padding).runtime, "plugin_x")).toThrow(/does not parse: it contains an unpaired UTF-16 surrogate/);
  });

  it.each(combos)("rejects $kind $shape in a runtime execute", ({ build, padding }) => {
    expect(() => validatePluginRuntimeExecute(build(padding).execute, "plugin_x")).toThrow(/does not parse: it contains an unpaired UTF-16 surrogate/);
  });

  it.each(combos)("rejects $kind $shape in a migration statement and a migration file", ({ build, padding }) => {
    const { migration } = build(padding);
    expect(() => validatePluginMigrationStatement(migration, "plugin_x")).toThrow(/does not parse: it contains an unpaired UTF-16 surrogate/);
    expect(() => splitPluginMigrationSql(migration)).toThrow(/does not parse: it contains an unpaired UTF-16 surrogate/);
  });

  it("rejects an unpaired surrogate at the very start and the very end of the text", () => {
    expect(() => validatePluginRuntimeQuery(`${LOW}SELECT id FROM plugin_x.t`, "plugin_x")).toThrow(/unpaired UTF-16 surrogate/);
    expect(() => validatePluginRuntimeQuery(`SELECT id FROM plugin_x.t -- ${HIGH}`, "plugin_x")).toThrow(/unpaired UTF-16 surrogate/);
  });

  it("rejects a high surrogate that a low surrogate does not directly follow, and a low surrogate that no high surrogate precedes", () => {
    expect(() => validatePluginRuntimeQuery(`SELECT '${HIGH}${HIGH}${LOW}${LOW}'`, "plugin_x")).toThrow(/unpaired UTF-16 surrogate/);
    expect(() => validatePluginRuntimeQuery(`SELECT '${ROCKET}${LOW}'`, "plugin_x")).toThrow(/unpaired UTF-16 surrogate/);
    expect(() => validatePluginRuntimeQuery(`SELECT '${HIGH}${ROCKET}'`, "plugin_x")).toThrow(/unpaired UTF-16 surrogate/);
  });

  it("still parses well-formed surrogate pairs, and sees the whole text after them", () => {
    const rockets = ROCKET.repeat(PAD);
    expect(() => validatePluginRuntimeQuery(`SELECT id FROM plugin_x.t WHERE n = '${rockets}'`, "plugin_x")).not.toThrow();
    expect(() => validatePluginRuntimeExecute(`INSERT INTO plugin_x.t (n) VALUES ('${rockets}')`, "plugin_x")).not.toThrow();
    expect(() => validatePluginMigrationStatement(`COMMENT ON TABLE plugin_x.a IS '${rockets}'`, "plugin_x")).not.toThrow();
    // Nothing is cut off: the statement after the emoji is read, so the text is two statements.
    expect(() => validatePluginRuntimeQuery(`SELECT id FROM plugin_x.t WHERE n = '${rockets}'${TAIL}`, "plugin_x")).toThrow(
      /exactly one statement/,
    );
    expect(splitPluginMigrationSql(`COMMENT ON TABLE plugin_x.a IS '${rockets}';\nCOMMENT ON TABLE plugin_x.b IS '${rockets}'`)).toEqual([
      `COMMENT ON TABLE plugin_x.a IS '${rockets}'`,
      `COMMENT ON TABLE plugin_x.b IS '${rockets}'`,
    ]);
  });

  it("fails closed when the parser's byte count for the text differs from the real UTF-8 length", () => {
    // Stands in for any future change in how libpg-query encodes its input.
    const text = "SELECT id FROM plugin_x.t WHERE n = 'é日🚀'";
    const realByteLength = Buffer.byteLength.bind(Buffer);
    const spy = vi.spyOn(Buffer, "byteLength").mockImplementation(((value: string, encoding?: BufferEncoding) =>
      realByteLength(value, encoding) + (value === text ? 1 : 0)) as typeof Buffer.byteLength);
    try {
      expect(() => validatePluginRuntimeQuery(text, "plugin_x")).toThrow(/does not parse: encoding mismatch/);
    } finally {
      spy.mockRestore();
    }
    expect(() => validatePluginRuntimeQuery(text, "plugin_x")).not.toThrow();
  });

  describe("fuzz", () => {
    // Deterministic generator, so a failure reproduces.
    function seededRandom(seed: number) {
      let state = seed >>> 0;
      return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const WELL_FORMED_ATOMS = ["a", "b", " ", "x1", "é", THREE_BYTE, ROCKET, "ñ", "€"];
    const UNPAIRED_ATOMS = [HIGH, LOW, HIGH + THREE_BYTE, LOW + "é", HIGH + HIGH, LOW + LOW, HIGH + "a", LOW + ROCKET];
    const TAILS = [TAIL, "; DROP TABLE plugin_x.t", "; DELETE FROM public.agents WHERE true ", ";\nDELETE FROM public.issues"];
    const ITERATIONS = 3000;

    function noise(random: () => number, atoms: string[], length: number) {
      let out = "";
      for (let i = 0; i < length; i += 1) out += atoms[Math.floor(random() * atoms.length)]!;
      return out;
    }

    it("never lets a statement hidden behind unpaired surrogates through any validator", () => {
      const random = seededRandom(0x5eed);
      const accepted: string[] = [];
      let parserSawOneStatement = 0;
      let checked = 0;
      for (let i = 0; i < ITERATIONS; i += 1) {
        const mixed = noise(random, [...WELL_FORMED_ATOMS, ...UNPAIRED_ATOMS, ...UNPAIRED_ATOMS], 1 + Math.floor(random() * 70));
        const tail = TAILS[Math.floor(random() * TAILS.length)]!;
        const shape = [inLiteral, inBlockComment, inLineComment, beforeSemicolon][Math.floor(random() * 4)]!;
        const built = shape(mixed).runtime.replace(TAIL, tail);
        const exec = shape(mixed).execute.replace(TAIL, tail);
        const migration = shape(mixed).migration.replace(TAIL, tail);
        checked += 1;
        // Control: the raw parser, with no guard, reads the whole text as one statement for many of these.
        try {
          if ((parseSync(built).stmts ?? []).length === 1) parserSawOneStatement += 1;
        } catch {
          // The cut can land inside a word; that text does not parse, which is not the fault under test.
        }
        for (const [label, run] of [
          ["query", () => validatePluginRuntimeQuery(built, "plugin_x")],
          ["execute", () => validatePluginRuntimeExecute(exec, "plugin_x")],
          ["migration", () => validatePluginMigrationStatement(migration, "plugin_x")],
          // A file may hold many statements, so the split itself accepts the tail; its validation must not.
          ["file", () => splitPluginMigrationSql(migration).forEach((fragment) => validatePluginMigrationStatement(fragment, "plugin_x"))],
        ] as const) {
          try {
            run();
            accepted.push(`${label}: ${JSON.stringify(label === "query" ? built : label === "execute" ? exec : migration)}`);
          } catch {
            // Rejected, as every one of these must be: each holds a second statement after the noise.
          }
        }
      }
      expect(checked).toBe(ITERATIONS);
      // The generator must hit the fault: without the guard the parser reads many of these as one statement.
      expect(parserSawOneStatement).toBeGreaterThan(100);
      expect(accepted.length).toBe(0);
    });

    it("accepts the same noise when it is well formed and nothing follows it", () => {
      const random = seededRandom(0xfeed);
      for (let i = 0; i < ITERATIONS; i += 1) {
        const clean = noise(random, WELL_FORMED_ATOMS, 1 + Math.floor(random() * 70)).replaceAll("'", "");
        expect(() => validatePluginRuntimeQuery(`SELECT id FROM plugin_x.t WHERE n = '${clean}'`, "plugin_x")).not.toThrow();
        expect(() => validatePluginRuntimeExecute(`INSERT INTO plugin_x.t (n) VALUES ('${clean}')`, "plugin_x")).not.toThrow();
        expect(() => validatePluginMigrationStatement(`COMMENT ON TABLE plugin_x.a IS '${clean}'`, "plugin_x")).not.toThrow();
        expect(splitPluginMigrationSql(`COMMENT ON TABLE plugin_x.a IS '${clean}';\nCOMMENT ON TABLE plugin_x.b IS 'x'`)).toHaveLength(2);
      }
    });
  });
});

describe("plugin SQL validator: input size", () => {
  // libpg-query mallocs a buffer for the whole text without checking the result. A text past about
  // 1 GiB makes that fail, and every later parse in the process then fails too. The validators cap
  // the text well below that, before it reaches the parser.
  const MAX_BYTES = 16 * 1024 * 1024;
  const THREE_BYTE = String.fromCharCode(0x65e5);
  const FOUR_BYTE = String.fromCharCode(0xd83d, 0xde80);

  /** `prefix + filler + suffix` with exactly `totalBytes` bytes of UTF-8. The filler is `unit` repeated, then ASCII. */
  function padded(prefix: string, suffix: string, unit: string, totalBytes: number): string {
    const room = totalBytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    const unitBytes = Buffer.byteLength(unit);
    const text = prefix + unit.repeat(Math.floor(room / unitBytes)) + "a".repeat(room % unitBytes) + suffix;
    expect(Buffer.byteLength(text)).toBe(totalBytes);
    return text;
  }

  const statements = [
    { target: "runtime query", prefix: "SELECT id FROM plugin_x.t WHERE n = '", suffix: "'", run: (text: string) => validatePluginRuntimeQuery(text, "plugin_x") },
    { target: "runtime execute", prefix: "INSERT INTO plugin_x.t (n) VALUES ('", suffix: "')", run: (text: string) => validatePluginRuntimeExecute(text, "plugin_x") },
    { target: "migration statement", prefix: "COMMENT ON TABLE plugin_x.a IS '", suffix: "'", run: (text: string) => validatePluginMigrationStatement(text, "plugin_x") },
  ];
  const units = [
    { name: "ASCII text", unit: "a" },
    { name: "three-byte characters", unit: THREE_BYTE },
    { name: "four-byte characters", unit: FOUR_BYTE },
  ];
  const combos = statements.flatMap((statement) => units.map((unit) => ({ ...statement, ...unit })));

  it.each(combos)("parses a $target of exactly 16 MiB made of $name", ({ prefix, suffix, unit, run }) => {
    expect(() => run(padded(prefix, suffix, unit, MAX_BYTES))).not.toThrow();
  });

  it.each(combos)("rejects a $target one byte over 16 MiB made of $name", ({ prefix, suffix, unit, run }) => {
    expect(() => run(padded(prefix, suffix, unit, MAX_BYTES + 1))).toThrow(/does not parse: input exceeds 16 MiB/);
  });

  it("counts UTF-8 bytes, not characters: a text with fewer characters than the cap is still over it", () => {
    const text = padded("SELECT id FROM plugin_x.t WHERE n = '", "'", THREE_BYTE, MAX_BYTES + 3);
    expect(text.length).toBeLessThan(MAX_BYTES);
    expect(() => validatePluginRuntimeQuery(text, "plugin_x")).toThrow(/input exceeds 16 MiB/);
    const pairs = padded("SELECT id FROM plugin_x.t WHERE n = '", "'", FOUR_BYTE, MAX_BYTES + 4);
    expect(pairs.length).toBeLessThan(MAX_BYTES);
    expect(() => validatePluginRuntimeQuery(pairs, "plugin_x")).toThrow(/input exceeds 16 MiB/);
  });

  it("applies the cap to a whole migration file, however many statements it holds", () => {
    const statement = "CREATE TABLE plugin_x.t (id int);\n";
    const atCap = padded("-- ", "\n" + statement, "a", MAX_BYTES);
    expect(splitPluginMigrationSql(atCap)).toHaveLength(1);
    const overCap = padded("-- ", "\n" + statement, "a", MAX_BYTES + 1);
    expect(() => splitPluginMigrationSql(overCap)).toThrow(/does not parse: input exceeds 16 MiB/);
    const manyStatements = statement.repeat(Math.ceil(MAX_BYTES / statement.length) + 1);
    expect(() => splitPluginMigrationSql(manyStatements)).toThrow(/input exceeds 16 MiB/);
  });

  it("keeps parsing normally after it rejects an over-size text", () => {
    expect(() => validatePluginRuntimeQuery(padded("SELECT id FROM plugin_x.t WHERE n = '", "'", "a", MAX_BYTES + 1), "plugin_x")).toThrow(
      /input exceeds 16 MiB/,
    );
    expect(() => validatePluginRuntimeQuery("SELECT id FROM plugin_x.t", "plugin_x")).not.toThrow();
    expect(splitPluginMigrationSql("CREATE TABLE plugin_x.t (id int);")).toEqual(["CREATE TABLE plugin_x.t (id int)"]);
  });
});
