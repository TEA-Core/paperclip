/**
 * Plugin SQL validator.
 *
 * Parses plugin SQL with PostgreSQL's own grammar (libpg-query, PG17) and checks
 * every relation reference against the plugin namespace and the manifest's core
 * read whitelist. The parser sees whitespace, comments, quoting and case folding
 * exactly as the database does.
 *
 * This module is pure. It imports only `libpg-query`, so a plugin repository can
 * copy it byte for byte to run the same checks in its own tests.
 *
 * Call `loadPluginSqlParser()` once before any validator. The validators are
 * synchronous and reject every statement while the parser is not loaded.
 */

type PgQueryParser = Pick<typeof import("libpg-query"), "loadModule" | "parseSync">;
type AstNode = { [key: string]: unknown };
type RawStatement = { stmt?: AstNode; stmt_location?: number; stmt_len?: number };
type ParsedStatement = { kind: string; node: AstNode };
type RelationRef = { catalog: string | null; schema: string | null; name: string; cte: boolean };
type StatementFacts = {
  relations: RelationRef[];
  functions: string[];
  nestedDml: string[];
  selectInto: boolean;
  locking: boolean;
};
type RelationMode = "query" | "execute" | "migration";

const NAMESPACE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DML_KINDS = new Set(["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"]);
const MIGRATION_KINDS = new Set([
  "CreateStmt",
  "CreateTableAsStmt",
  "IndexStmt",
  "AlterTableStmt",
  "RenameStmt",
  "CommentStmt",
  "ViewStmt",
  "InsertStmt",
  "UpdateStmt",
]);
const MIGRATION_ALTER_SUBTYPES = new Set([
  "AT_AddColumn",
  "AT_ColumnDefault",
  "AT_SetNotNull",
  "AT_DropNotNull",
  "AT_AlterColumnType",
  "AT_AddConstraint",
  "AT_DropConstraint",
  "AT_ValidateConstraint",
  "AT_AddIndex",
  "AT_DropColumn",
]);
/**
 * Function names that plugin SQL cannot call, in any position of any statement.
 * A name matches when the last part of the (possibly schema-qualified, possibly
 * quoted) function name equals one of these patterns, so `pg_catalog.pg_read_file`
 * and `"pg_read_file"` are caught as well as `pg_read_file`.
 *
 * This is a fixed deny-list of names, not a complete function policy. It covers:
 * - functions that run SQL text or read a table named in a string:
 *   query_to_xml*, table_to_xml*, cursor_to_xml*, schema_to_xml*, database_to_xml*,
 *   ts_stat, dblink*
 * - server file access: pg_read_file, pg_read_binary_file, pg_ls_*, pg_stat_file,
 *   pg_file_* (the adminpack functions pg_file_write, pg_file_rename, pg_file_unlink,
 *   pg_file_sync)
 * - large objects: every lo_* function (lo_import, lo_export, lo_get, lo_put, lo_open,
 *   lo_create, lo_creat, lo_unlink, lo_truncate, lo_from_bytea and the rest), loread, lowrite
 * - settings and sequence values: set_config, setval
 * - backend and server control: pg_terminate_backend, pg_cancel_backend, pg_reload_conf,
 *   pg_rotate_logfile, pg_switch_wal, pg_promote, pg_backup_start, pg_backup_stop,
 *   pg_start_backup, pg_stop_backup
 * - notifications and logical decoding: pg_notify, every pg_logical_* function
 *   (pg_logical_emit_message, pg_logical_slot_get_changes and the other slot get and peek functions)
 * - replication slots: pg_create_physical_replication_slot, pg_create_logical_replication_slot,
 *   pg_copy_physical_replication_slot, pg_copy_logical_replication_slot,
 *   pg_drop_replication_slot, pg_replication_slot_advance
 *
 * It does not cover every function that reads a relation by name or has a side effect.
 * nextval, pg_advisory_*lock* and pg_sleep* are deliberately allowed, and so is every
 * other function that is not listed here (for example pg_replication_origin_*,
 * pg_create_restore_point, pg_stat_reset* and pg_export_snapshot). The real fix for those
 * is to run plugin SQL under a non-superuser runtime role, not a longer list.
 */
const DISALLOWED_FUNCTION_PATTERNS = [
  "(?:query|table|cursor|schema|database)_to_xml\\w*",
  "ts_stat",
  "dblink\\w*",
  "pg_read_(?:binary_)?file",
  "pg_ls_\\w+",
  "pg_stat_file",
  "pg_file_\\w+",
  "lo_\\w+",
  "loread",
  "lowrite",
  "set_config",
  "setval",
  "pg_(?:terminate|cancel)_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_switch_wal",
  "pg_promote",
  "pg_(?:backup_start|backup_stop|start_backup|stop_backup)",
  "pg_notify",
  "pg_logical_\\w+",
  "pg_(?:create|copy)_(?:physical|logical)_replication_slot",
  "pg_drop_replication_slot",
  "pg_replication_slot_advance",
];
const DISALLOWED_FUNCTION_RE = new RegExp(`^(?:${DISALLOWED_FUNCTION_PATTERNS.join("|")})$`);
const RUNTIME_STATEMENT_COUNT_ERROR = "Plugin runtime SQL must contain exactly one statement";
const MIGRATION_STATEMENT_COUNT_ERROR = "Plugin migration statement must contain exactly one statement";

let parser: PgQueryParser | null = null;
let parserLoading: Promise<void> | null = null;

/**
 * Loads the WASM parser once. Safe to call many times and from many callers.
 * The import is dynamic: libpg-query starts its WASM build when it is imported, so
 * a server that never runs plugin SQL never pays for it, and a failed load rejects
 * only this promise.
 */
export function loadPluginSqlParser(): Promise<void> {
  if (parser) return Promise.resolve();
  if (!parserLoading) {
    parserLoading = import("libpg-query")
      .then(async (lib) => {
        await lib.loadModule();
        parser = lib;
      })
      .catch((error: unknown) => {
        parserLoading = null;
        throw error;
      });
  }
  return parserLoading;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRawStatements(sqlText: string): RawStatement[] {
  const active = parser;
  if (!active) {
    throw new Error("Plugin SQL parser is not loaded; call loadPluginSqlParser() first");
  }
  let tree: { stmts?: RawStatement[] };
  try {
    tree = active.parseSync(sqlText) as { stmts?: RawStatement[] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Plugin SQL does not parse: ${message}`);
  }
  return tree.stmts ?? [];
}

function parseSingleStatement(sqlText: string, countError: string): ParsedStatement {
  const statements = parseRawStatements(sqlText);
  if (statements.length !== 1) throw new Error(countError);
  const stmt = statements[0]!.stmt;
  const kind = stmt ? Object.keys(stmt)[0] : undefined;
  const node = stmt && kind ? stmt[kind] : undefined;
  if (!kind || !isNode(node)) throw new Error(countError);
  return { kind, node };
}

function stripSqlForKeywordScan(input: string): string {
  return input
    .replace(/'([^']|'')*'/g, "''")
    .replace(/"([^"]|"")*"/g, "\"\"")
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function assertNoBannedSql(statement: string): void {
  const normalized = stripSqlForKeywordScan(statement).replace(/\s+/g, " ").trim().toLowerCase();
  const banned = [
    /\bcreate\s+extension\b/,
    /\bcreate\s+(?:event\s+)?trigger\b/,
    /\bcreate\s+(?:or\s+replace\s+)?function\b/,
    /\bcreate\s+language\b/,
    /\bgrant\b/,
    /\brevoke\b/,
    /\bsecurity\s+definer\b/,
    /\bcopy\b/,
    /\bcall\b/,
    /\bdo\s+(?:\$\$|language\b)/,
  ];
  const matched = banned.find((pattern) => pattern.test(normalized));
  if (matched) {
    throw new Error(`Plugin SQL contains a disallowed statement or clause: ${matched.source}`);
  }
}

function functionName(call: AstNode): string {
  const parts = Array.isArray(call.funcname) ? call.funcname : [];
  const last: unknown = parts[parts.length - 1];
  return isNode(last) && isNode(last.String) && typeof last.String.sval === "string"
    ? last.String.sval.toLowerCase()
    : "";
}

function assertNoDisallowedFunctions(functions: readonly string[]): void {
  const blocked = functions.find((name) => DISALLOWED_FUNCTION_RE.test(name));
  if (blocked) {
    throw new Error(`Plugin SQL cannot call ${blocked}()`);
  }
}

function cteNames(withClause: AstNode): string[] {
  const ctes = Array.isArray(withClause.ctes) ? withClause.ctes : [];
  return ctes.flatMap((entry) => {
    const cte = isNode(entry) && isNode(entry.CommonTableExpr) ? entry.CommonTableExpr : entry;
    return isNode(cte) && typeof cte.ctename === "string" ? [cte.ctename] : [];
  });
}

/**
 * Walks the whole statement tree. It records every relation reference (any node
 * with a string `relname`) together with the CTE names visible at that point, and
 * the name of every function call.
 * A non-recursive CTE body sees only the CTEs listed before it; a recursive WITH
 * makes every CTE in the list visible to every body.
 */
function analyseStatement(kind: string, node: AstNode): StatementFacts {
  const facts: StatementFacts = { relations: [], functions: [], nestedDml: [], selectInto: false, locking: false };

  function visitChildren(value: AstNode, scope: ReadonlySet<string>, skipKey: string | null): void {
    for (const [key, child] of Object.entries(value)) {
      if (key === skipKey) continue;
      if (DML_KINDS.has(key)) facts.nestedDml.push(key);
      if (key === "FuncCall" && isNode(child)) facts.functions.push(functionName(child));
      if (key === "intoClause" && child) facts.selectInto = true;
      if (key === "lockingClause" && Array.isArray(child) && child.length > 0) facts.locking = true;
      walk(child, scope);
    }
  }

  function walk(value: unknown, scope: ReadonlySet<string>): void {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, scope);
      return;
    }
    if (!isNode(value)) return;

    if (typeof value.relname === "string") {
      const schema = typeof value.schemaname === "string" ? value.schemaname : null;
      const catalog = typeof value.catalogname === "string" ? value.catalogname : null;
      facts.relations.push({
        catalog,
        schema,
        name: value.relname,
        cte: schema === null && catalog === null && scope.has(value.relname),
      });
      return;
    }

    if (!isNode(value.withClause)) {
      visitChildren(value, scope, null);
      return;
    }
    const withClause = value.withClause;
    const names = cteNames(withClause);
    const ctes = Array.isArray(withClause.ctes) ? withClause.ctes : [];
    ctes.forEach((entry, index) => {
      const cte = isNode(entry) && isNode(entry.CommonTableExpr) ? entry.CommonTableExpr : entry;
      if (!isNode(cte)) return;
      const visible = new Set(scope);
      for (const name of withClause.recursive === true ? names : names.slice(0, index)) visible.add(name);
      walk(cte.ctequery, visible);
    });
    const inner = new Set(scope);
    for (const name of names) inner.add(name);
    visitChildren(value, inner, "withClause");
  }

  walk({ [kind]: node }, new Set());
  const topIndex = facts.nestedDml.indexOf(kind);
  if (topIndex !== -1) facts.nestedDml.splice(topIndex, 1);
  return facts;
}

function assertRelationsAllowed(
  relations: readonly RelationRef[],
  namespace: string,
  coreReadTables: readonly string[],
  mode: RelationMode,
): void {
  const allowedCoreReadTables = new Set(coreReadTables);
  for (const relation of relations) {
    if (relation.cte) continue;
    if (relation.catalog !== null) {
      throw new Error(
        `Plugin SQL cannot use database-qualified relation ${relation.catalog}.${relation.schema ?? ""}.${relation.name}`,
      );
    }
    if (relation.schema === null) {
      const prefix = mode === "query" ? "ctx.db.query" : mode === "execute" ? "ctx.db.execute" : "Plugin migration";
      throw new Error(`${prefix} relation "${relation.name}" must use a fully qualified schema name`);
    }
    if (relation.schema === namespace) continue;
    if (mode === "execute") {
      throw new Error("ctx.db.execute cannot reference public or other non-plugin schemas");
    }
    if (relation.schema === "public") {
      if (allowedCoreReadTables.has(relation.name)) continue;
      throw new Error(`Plugin SQL references public.${relation.name}, which is not whitelisted`);
    }
    if (mode === "query") {
      throw new Error(`ctx.db.query cannot read schema "${relation.schema}"`);
    }
    throw new Error(`Plugin SQL references schema "${relation.schema}" outside namespace "${namespace}"`);
  }
}

function assertMigrationTarget(target: unknown, namespace: string): void {
  if (!isNode(target) || typeof target.relname !== "string" || typeof target.schemaname !== "string") {
    throw new Error("Plugin migration objects must use fully qualified schema names");
  }
  if (typeof target.catalogname === "string") {
    throw new Error(
      `Plugin SQL cannot use database-qualified relation ${target.catalogname}.${target.schemaname}.${target.relname}`,
    );
  }
  if (target.schemaname === namespace) return;
  if (target.schemaname === "public") {
    throw new Error(`Plugin SQL cannot mutate or define objects in public.${target.relname}`);
  }
  throw new Error(`Plugin SQL references schema "${target.schemaname}" outside namespace "${namespace}"`);
}

function commentObjectNames(object: unknown): string[] {
  if (!isNode(object)) return [];
  if (isNode(object.String) && typeof object.String.sval === "string") return [object.String.sval];
  const list = isNode(object.List) ? object.List : null;
  const items = list && Array.isArray(list.items) ? list.items : [];
  return items.flatMap((item) =>
    isNode(item) && isNode(item.String) && typeof item.String.sval === "string" ? [item.String.sval] : [],
  );
}

function migrationTarget(kind: string, node: AstNode): unknown {
  if (kind === "ViewStmt") return node.view;
  if (kind === "CreateTableAsStmt") return isNode(node.into) ? node.into.rel : undefined;
  return node.relation;
}

export function validatePluginMigrationStatement(
  statement: string,
  namespace: string,
  coreReadTables: readonly string[] = [],
): void {
  if (!NAMESPACE_RE.test(namespace)) {
    throw new Error(`Unsafe SQL namespace: ${namespace}`);
  }
  const { kind, node } = parseSingleStatement(statement, MIGRATION_STATEMENT_COUNT_ERROR);
  assertNoBannedSql(statement);

  if (kind === "DropStmt" || kind === "TruncateStmt") {
    throw new Error("Destructive plugin migrations are not allowed in Phase 1");
  }
  if (kind === "DeleteStmt") {
    throw new Error("Plugin migrations cannot delete data");
  }
  if (!MIGRATION_KINDS.has(kind)) {
    throw new Error("Plugin migrations may contain DDL or namespace-scoped backfill statements only");
  }

  if (kind === "CommentStmt") {
    const names = commentObjectNames(node.object);
    const schemaComment = node.objtype === "OBJECT_SCHEMA" && names.length === 1;
    if (names[0] !== namespace || (!schemaComment && names.length < 2)) {
      throw new Error(`COMMENT target must be inside plugin namespace "${namespace}"`);
    }
    return;
  }
  if (kind === "CreateTableAsStmt" && node.objtype !== "OBJECT_TABLE") {
    throw new Error("Plugin migrations may contain DDL or namespace-scoped backfill statements only");
  }
  if (kind === "CreateTableAsStmt" && isNode(node.query) && isNode(node.query.ExecuteStmt)) {
    // EXECUTE runs a prepared statement by name. Its query text is invisible to the relation rule.
    throw new Error("Plugin migrations cannot create a table from EXECUTE");
  }

  assertMigrationTarget(migrationTarget(kind, node), namespace);

  if (kind === "AlterTableStmt") {
    const cmds = Array.isArray(node.cmds) ? node.cmds : [];
    for (const entry of cmds) {
      const cmd = isNode(entry) && isNode(entry.AlterTableCmd) ? entry.AlterTableCmd : entry;
      const subtype = isNode(cmd) && typeof cmd.subtype === "string" ? cmd.subtype : "unknown";
      if (!MIGRATION_ALTER_SUBTYPES.has(subtype)) {
        throw new Error(`ALTER TABLE ${subtype} is not allowed in plugin migrations`);
      }
    }
  }
  if (kind === "CreateStmt") {
    const parents = Array.isArray(node.inhRelations) ? node.inhRelations : [];
    for (const entry of parents) {
      const parent = isNode(entry) && isNode(entry.RangeVar) ? entry.RangeVar : entry;
      if (!isNode(parent) || parent.schemaname !== namespace || typeof parent.catalogname === "string") {
        throw new Error("Plugin tables cannot inherit from or partition outside the plugin namespace");
      }
    }
  }

  const facts = analyseStatement(kind, node);
  if (facts.nestedDml.length > 0) {
    throw new Error("Plugin migrations cannot nest data-modifying statements");
  }
  if (facts.selectInto || facts.locking) {
    throw new Error("Plugin migrations cannot use SELECT INTO or row locks");
  }
  assertNoDisallowedFunctions(facts.functions);
  if (kind === "ViewStmt") {
    // PostgreSQL makes a simple view auto-updatable. A view over a core table would
    // let ctx.db.execute write through it, so a view may read only the namespace.
    const core = facts.relations.find((relation) => relation.schema === "public");
    if (core) {
      throw new Error(`Plugin views cannot read public.${core.name}; a view may read only plugin namespace "${namespace}"`);
    }
  }
  assertRelationsAllowed(facts.relations, namespace, kind === "ViewStmt" ? [] : coreReadTables, "migration");
}

export function validatePluginRuntimeQuery(
  query: string,
  namespace: string,
  coreReadTables: readonly string[] = [],
): void {
  const { kind, node } = parseSingleStatement(query, RUNTIME_STATEMENT_COUNT_ERROR);
  assertNoBannedSql(query);
  if (kind !== "SelectStmt") {
    throw new Error("ctx.db.query only allows SELECT statements");
  }
  const facts = analyseStatement(kind, node);
  if (facts.nestedDml.length > 0) {
    throw new Error("ctx.db.query cannot contain mutation or DDL keywords");
  }
  if (facts.selectInto) {
    throw new Error("ctx.db.query cannot use SELECT INTO");
  }
  if (facts.locking) {
    throw new Error("ctx.db.query cannot lock rows");
  }
  assertNoDisallowedFunctions(facts.functions);
  assertRelationsAllowed(facts.relations, namespace, coreReadTables, "query");
}

export function validatePluginRuntimeExecute(query: string, namespace: string): void {
  const { kind, node } = parseSingleStatement(query, RUNTIME_STATEMENT_COUNT_ERROR);
  assertNoBannedSql(query);
  if ((kind !== "InsertStmt" && kind !== "UpdateStmt" && kind !== "DeleteStmt") || isNode(node.withClause)) {
    throw new Error("ctx.db.execute only allows INSERT, UPDATE, or DELETE");
  }
  const target = node.relation;
  if (
    !isNode(target) ||
    target.schemaname !== namespace ||
    typeof target.catalogname === "string"
  ) {
    throw new Error(`ctx.db.execute target must be inside plugin namespace "${namespace}"`);
  }
  const facts = analyseStatement(kind, node);
  if (facts.nestedDml.length > 0) {
    throw new Error("ctx.db.execute cannot nest data-modifying statements");
  }
  if (facts.selectInto || facts.locking) {
    throw new Error("ctx.db.execute cannot use SELECT INTO or row locks");
  }
  assertNoDisallowedFunctions(facts.functions);
  assertRelationsAllowed(facts.relations, namespace, [], "execute");
}
