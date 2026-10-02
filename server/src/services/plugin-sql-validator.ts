/**
 * Plugin SQL validator.
 *
 * Parses plugin SQL with PostgreSQL's own grammar (libpg-query, PG17) and checks
 * every relation reference against the plugin namespace and the manifest's core
 * read whitelist. The parser sees whitespace, comments, quoting and case folding
 * exactly as the database does.
 *
 * This module is pure. It imports only `libpg-query` and Node built-ins, so a plugin
 * repository can copy it byte for byte to run the same checks in its own tests.
 *
 * Call `loadPluginSqlParser()` before any validator. The validators are synchronous
 * and reject every statement while the parser is not loaded. A parser that faults
 * (see `isParserFault`) is dropped, and the next `loadPluginSqlParser()` builds a new one.
 */

import { createRequire } from "node:module";
import { dirname } from "node:path";

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
/**
 * The largest text, in UTF-8 bytes, that the validators and the migration split hand to the parser.
 * The parser's WASM heap stops at 1 GiB, and its parse tree plus JSON output take up to about 220
 * times the input (a column list such as `SELECT a,a,...`, which runs out at about 4.6 MiB). At
 * 1 MiB the worst measured shape uses about 160 MiB of that heap.
 */
const MAX_PLUGIN_SQL_BYTES = 1024 * 1024;
const RUNTIME_STATEMENT_COUNT_ERROR = "Plugin runtime SQL must contain exactly one statement";
const MIGRATION_STATEMENT_COUNT_ERROR = "Plugin migration statement must contain exactly one statement";
const PARSER_NOT_LOADED_ERROR = "Plugin SQL parser is not loaded; call loadPluginSqlParser() first";
const PARSER_UNAVAILABLE_ERROR = "Plugin SQL parser is unavailable (restart required)";
const PARSER_OUT_OF_MEMORY = /out of memory|Aborted|memory access out of bounds|Failed to allocate/i;

let parser: PgQueryParser | null = null;
let parserLoading: Promise<void> | null = null;
/** How many parsers faulted. After the first fault every load builds a new WASM instance. */
let parserFaults = 0;
/** Set when a new parser could not be built after a fault. Every later call then fails at once. */
let parserUnavailable = false;

/**
 * Loads the WASM parser. Safe to call many times and from many callers; concurrent
 * callers share one load. The first import is dynamic: libpg-query starts its WASM
 * build when it is imported, so a server that never runs plugin SQL never pays for
 * it, and a failed first load rejects only this promise (the next call retries).
 * After a parser fault the load builds a new WASM instance instead; if that fails,
 * the parser stays unavailable until the process restarts.
 */
export function loadPluginSqlParser(): Promise<void> {
  if (parserUnavailable) return Promise.reject(new Error(PARSER_UNAVAILABLE_ERROR));
  if (parser) return Promise.resolve();
  if (!parserLoading) {
    const rebuild = parserFaults > 0;
    parserLoading = (rebuild ? requireNewParserInstance() : import("libpg-query"))
      .then(async (lib) => {
        await lib.loadModule();
        parser = lib;
      })
      .catch((error: unknown) => {
        parserLoading = null;
        if (!rebuild) throw error;
        parserUnavailable = true;
        console.error(`${PARSER_UNAVAILABLE_ERROR}: building a new parser after a fault failed: ${describeThrown(error)}`);
        throw new Error(PARSER_UNAVAILABLE_ERROR);
      });
  }
  return parserLoading;
}

/**
 * Evaluates libpg-query's package entry again, which builds a new WASM instance.
 * libpg-query builds its instance once, when its entry is first evaluated, and keeps
 * it for the life of that module. Removing the package's files from the CommonJS
 * module cache makes `require` evaluate them again. The removal also drops the cache's
 * hold on the old instance, so its memory is freed once nothing else refers to it.
 * (The instance from the first, dynamic import stays referenced by the ESM loader.)
 * It is async so that a failed require rejects the load instead of throwing from it.
 */
async function requireNewParserInstance(): Promise<PgQueryParser> {
  const require = createRequire(import.meta.url);
  const packageDir = dirname(require.resolve("libpg-query"));
  for (const cached of Object.keys(require.cache)) {
    if (dirname(cached) === packageDir) delete require.cache[cached];
  }
  return require("libpg-query") as PgQueryParser;
}

function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether an error thrown by the parser means its WASM instance can no longer be trusted.
 * A syntax error comes back as an ordinary error after PostgreSQL has cleaned up. These do not:
 * - a thrown value that is not an Error: a PostgreSQL FATAL ends in Emscripten's exit(),
 *   which throws an ExitStatus object (and sets process.exitCode)
 * - a WebAssembly trap or Emscripten abort (a RuntimeError)
 * - a stack overflow inside the WASM code (a RangeError), which abandons the parse and never
 *   frees its memory; about 50 deeply nested statements of 200 KiB exhaust the heap
 * - an exhausted heap or a failed allocation
 */
function isParserFault(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  if (error.name === "RuntimeError" || error.name === "RangeError") return true;
  return PARSER_OUT_OF_MEMORY.test(error.message);
}

function dropFaultedParser(faulted: PgQueryParser): void {
  if (parser !== faulted) return;
  parser = null;
  parserLoading = null;
  parserFaults += 1;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** The byte count libpg-query's WASM wrapper allocates for a query string (emscripten lengthBytesUTF8). */
function parserInputByteLength(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) {
      length += 1;
    } else if (code <= 0x7ff) {
      length += 2;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      length += 4;
      i += 1;
    } else {
      length += 3;
    }
  }
  return length;
}

function parseRawStatements(sqlText: string): RawStatement[] {
  if (parserUnavailable) throw new Error(PARSER_UNAVAILABLE_ERROR);
  const active = parser;
  if (!active) throw new Error(PARSER_NOT_LOADED_ERROR);
  // A large text can exhaust the parser's 1 GiB WASM heap (see MAX_PLUGIN_SQL_BYTES), and
  // libpg-query does not check its own malloc for the input copy. Reject before the parser.
  const byteLength = Buffer.byteLength(sqlText, "utf8");
  if (byteLength > MAX_PLUGIN_SQL_BYTES) {
    throw new Error("Plugin SQL does not parse: input exceeds 1 MiB");
  }
  // The parser stops reading at the first NUL, so text after one is neither validated nor split.
  // A NUL never parses.
  if (sqlText.includes("\u0000")) {
    throw new Error("Plugin SQL does not parse: it contains a NUL character");
  }
  // libpg-query sizes its input buffer by counting every UTF-16 surrogate as four bytes and
  // skipping the next unit, but it writes an unpaired surrogate as three bytes. The buffer comes
  // out short and the end of the text is silently never parsed, while the driver sends all of it
  // to the server. Text that is not well-formed UTF-16 never parses.
  if (hasUnpairedSurrogate(sqlText)) {
    throw new Error("Plugin SQL does not parse: it contains an unpaired UTF-16 surrogate");
  }
  // Defense in depth: the byte count the parser's wrapper allocates must equal the real UTF-8
  // length, or part of the text would go unparsed. Fail closed if the two ever differ.
  if (parserInputByteLength(sqlText) !== byteLength) {
    throw new Error("Plugin SQL does not parse: encoding mismatch");
  }
  let tree: { stmts?: RawStatement[] };
  const exitCodeBefore = process.exitCode;
  try {
    tree = active.parseSync(sqlText) as { stmts?: RawStatement[] };
  } catch (error) {
    // Emscripten's exit() sets process.exitCode before it throws. The server did not exit.
    if (process.exitCode !== exitCodeBefore) process.exitCode = exitCodeBefore;
    if (!isParserFault(error)) {
      throw new Error(`Plugin SQL does not parse: ${describeThrown(error)}`);
    }
    dropFaultedParser(active);
    if (!(error instanceof Error) || PARSER_OUT_OF_MEMORY.test(error.message)) {
      throw new Error("Plugin SQL does not parse: parser out of memory");
    }
    throw new Error(`Plugin SQL does not parse: ${error.message}`);
  }
  return tree.stmts ?? [];
}

// The characters PostgreSQL's lexer skips between tokens. String.prototype.trim also strips
// Unicode spaces (U+00A0, U+3000, U+FEFF) that PostgreSQL reads as part of an identifier.
const SQL_WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);

function trimSqlWhitespace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && SQL_WHITESPACE.has(text[start]!)) start += 1;
  while (end > start && SQL_WHITESPACE.has(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
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

/**
 * Splits a migration file into the exact statements to validate and run. It uses
 * the parser's own statement boundaries, so a semicolon inside a dollar quote, an
 * E'' string or a comment never splits a statement. The parser reports UTF-8 byte
 * offsets, so the slices are cut from the file's bytes.
 *
 * The caller must validate and run each returned string as it is. Each one is a slice
 * of the file, taken after any leading byte order mark, with only SQL whitespace trimmed.
 * The statement validators still re-parse it and reject anything that is not exactly one
 * statement.
 */
export function splitPluginMigrationSql(fileSql: string): string[] {
  // A leading byte order mark is not SQL: the parser reads it as part of the first word.
  const text = fileSql.startsWith("\uFEFF") ? fileSql.slice(1) : fileSql;
  if (trimSqlWhitespace(text) === "") return [];
  const statements = parseRawStatements(text);
  const bytes = Buffer.from(text, "utf8");
  return statements
    .map((entry) => {
      const start = entry.stmt_location ?? 0;
      const end = entry.stmt_len ? start + entry.stmt_len : bytes.length;
      return trimSqlWhitespace(bytes.subarray(start, end).toString("utf8"));
    })
    .filter((statement) => statement.length > 0);
}

/** A character that can start an identifier or a dollar-quote tag: a letter, `_` or any non-ASCII character. */
function isWordStart(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || code === 0x5f || code >= 0x80;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/** The end of quoted text that opened just before `from`, where the quote written twice stands for itself. */
function endOfQuoted(text: string, from: number, quote: string): number {
  let at = from;
  for (;;) {
    const close = text.indexOf(quote, at);
    if (close === -1) return text.length;
    if (text[close + 1] !== quote) return close + 1;
    at = close + 2;
  }
}

/** The end of an E'' string whose text starts at `from`: a backslash escapes the next character. */
function endOfEscapeString(text: string, from: number): number {
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\") {
      at += 1;
    } else if (char === "'") {
      if (text[at + 1] !== "'") return at + 1;
      at += 1;
    }
  }
  return text.length;
}

/** The end of a block comment whose text starts at `from`. Block comments nest. */
function endOfBlockComment(text: string, from: number): number {
  let depth = 1;
  let at = from;
  while (at < text.length) {
    if (text[at] === "/" && text[at + 1] === "*") {
      depth += 1;
      at += 2;
    } else if (text[at] === "*" && text[at + 1] === "/") {
      depth -= 1;
      at += 2;
      if (depth === 0) return at;
    } else {
      at += 1;
    }
  }
  return text.length;
}

/** The end of a line comment: the next newline or carriage return, which is not part of it. */
function endOfLineComment(text: string, from: number): number {
  for (let at = from; at < text.length; at += 1) {
    if (text[at] === "\n" || text[at] === "\r") return at;
  }
  return text.length;
}

/** The dollar-quote delimiter (`$$` or `$tag$`) that starts at `at`, or null if none does. */
function dollarDelimiterAt(text: string, at: number): string | null {
  let end = at + 1;
  if (text[end] !== "$") {
    if (end >= text.length || !isWordStart(text.charCodeAt(end))) return null;
    end += 1;
    while (end < text.length && (isWordStart(text.charCodeAt(end)) || isDigit(text.charCodeAt(end)))) end += 1;
    if (text[end] !== "$") return null;
  }
  return text.slice(at, end + 1);
}

/**
 * Returns the text with comments removed and quoted text emptied, for the keyword scan. It reads
 * the text once, left to right, the way PostgreSQL's lexer does with standard_conforming_strings
 * on, so its time is linear in the length of the text:
 * - `--` to the end of the line is removed (the line break stays);
 * - a block comment is removed, nested comments included;
 * - '…' (also the B, X, N and U& forms) becomes '', with '' inside read as a quote;
 * - E'…' becomes E'', with a backslash escaping the next character;
 * - "…" becomes "", with "" inside read as a quote;
 * - $tag$…$tag$ is kept as written, so its text is scanned as before, but quote and comment
 *   marks inside it start nothing;
 * - everything else is copied. Identifiers and numbers are read whole, so a `$` or `e'` inside
 *   one does not start a dollar quote or an E'' string.
 *
 * Exported for tests.
 */
export function stripSqlForKeywordScan(input: string): string {
  const parts: string[] = [];
  let copiedTo = 0;
  let at = 0;
  const drop = (end: number, replacement: string) => {
    parts.push(input.slice(copiedTo, at), replacement);
    at = end;
    copiedTo = end;
  };
  while (at < input.length) {
    const char = input[at];
    const next = input[at + 1];
    const code = input.charCodeAt(at);
    if (char === "-" && next === "-") {
      drop(endOfLineComment(input, at + 2), "");
    } else if (char === "/" && next === "*") {
      drop(endOfBlockComment(input, at + 2), "");
    } else if (char === "'") {
      drop(endOfQuoted(input, at + 1, "'"), "''");
    } else if (char === "\"") {
      drop(endOfQuoted(input, at + 1, "\""), "\"\"");
    } else if ((char === "e" || char === "E") && next === "'") {
      // Only reached at the start of a token: identifiers are read whole below.
      at += 1;
      drop(endOfEscapeString(input, at + 1), "''");
    } else if (char === "$") {
      const delimiter = dollarDelimiterAt(input, at);
      if (delimiter === null) {
        at += 1;
      } else {
        const close = input.indexOf(delimiter, at + delimiter.length);
        at = close === -1 ? input.length : close + delimiter.length;
      }
    } else if (isWordStart(code)) {
      // An identifier or keyword: letters, digits, `_`, `$` and non-ASCII characters.
      at += 1;
      while (at < input.length) {
        const part = input.charCodeAt(at);
        if (!isWordStart(part) && !isDigit(part) && part !== 0x24) break;
        at += 1;
      }
    } else if (isDigit(code)) {
      // A number. It does not take a `$`, so `1$$…$$` is a number and then a dollar quote.
      at += 1;
      while (at < input.length) {
        const part = input.charCodeAt(at);
        if (!isDigit(part) && !(part < 0x80 && isWordStart(part))) break;
        at += 1;
      }
    } else {
      at += 1;
    }
  }
  parts.push(input.slice(copiedTo));
  return parts.join("");
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
