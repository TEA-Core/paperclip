import { readdirSync, readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";
import { beforeAll, describe, expect, it } from "vitest";
import {
  derivePluginDatabaseNamespace,
  loadPluginSqlParser,
  splitPluginMigrationSql,
  validatePluginMigrationStatement,
  validatePluginRuntimeExecute,
  validatePluginRuntimeQuery,
} from "../services/plugin-database.js";

/**
 * Conformance corpus: every SQL string that an in-repo plugin sends through
 * ctx.db, and every statement of every in-repo plugin migration, must pass the
 * strict plugin SQL validator. The inventory test fails when a plugin adds SQL
 * outside this list, so new plugin SQL cannot skip the corpus.
 */

type CorpusPlugin = {
  packageDir: string;
  pluginKey: string;
  namespaceSlug: string;
  coreReadTables: string[];
  sqlSources: string[];
};

type AstNode = { type: string; start: number; end: number; [key: string]: unknown };

type SqlCall = { location: string; method: "query" | "execute"; sql: string };

type DynamicFragment = {
  /** The fullest form of the fragment: every optional filter switched on. */
  standIn: string;
  /**
   * For each variable that builds the fragment, the exact source of every value
   * assigned or pushed to it inside the calling function, in source order.
   */
  feeds: Record<string, string[]>;
};

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const PLUGINS_ROOT = path.join(REPO_ROOT, "packages", "plugins");

const PLUGINS: CorpusPlugin[] = [
  {
    packageDir: "packages/plugins/plugin-llm-wiki",
    pluginKey: "paperclipai.plugin-llm-wiki",
    namespaceSlug: "llm_wiki",
    coreReadTables: ["companies", "issues", "projects", "agents"],
    sqlSources: ["src/wiki/core.ts"],
  },
  {
    packageDir: "packages/plugins/examples/plugin-orchestration-smoke-example",
    pluginKey: "paperclipai.plugin-orchestration-smoke-example",
    namespaceSlug: "orchestration_smoke",
    coreReadTables: ["issues"],
    sqlSources: ["src/worker.ts"],
  },
];

/**
 * Interpolations that build optional filter fragments at runtime. Each one is
 * replaced by its fullest form, so the validator sees every filter switched on.
 * Placeholder numbers do not matter to the validator. The test also compares the
 * code that builds each fragment with `feeds`, so a changed fragment fails the
 * test until its stand-in is reviewed and updated.
 */
const DYNAMIC_FRAGMENTS: Record<string, DynamicFragment> = {
  pageFilter: {
    standIn: " AND page_type = $4",
    feeds: { pageFilter: ['""', "` AND page_type = $${params.length}`"] },
  },
  filterSql: {
    standIn: " AND op.operation_type = $4 AND op.status = $5",
    feeds: {
      filterSql: ['filters.length ? ` AND ${filters.join(" AND ")}` : ""'],
      filters: ["[]", "`op.operation_type = $${params.length}`", "`op.status = $${params.length}`"],
    },
  },
  limitIndex: { standIn: "5", feeds: { limitIndex: ["params.length"] } },
  "params.length": { standIn: "6", feeds: {} },
};

const DB_CALL_PATTERN = /\bdb\s*\.\s*(?:query|execute)\s*[<(]/;
const SKIPPED_DIRS = new Set(["node_modules", "dist", "tests", "sdk"]);

function walkFiles(dir: string, visit: (file: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      walkFiles(path.join(dir, entry.name), visit);
    } else if (entry.isFile()) {
      visit(path.join(dir, entry.name));
    }
  }
}

function repoRelative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

function isAstNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function forEachNode(node: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) forEachNode(item, visit);
    return;
  }
  if (!isAstNode(node)) return;
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === "loc") continue;
    if (typeof child === "object" && child !== null) forEachNode(child, visit);
  }
}

function memberName(node: unknown): string | null {
  if (!isAstNode(node) || node.type !== "MemberExpression" || node.computed === true) return null;
  const property = node.property;
  return isAstNode(property) && property.type === "Identifier" ? String(property.name) : null;
}

/** Source text of every value assigned or pushed to `name` inside `scope`, in source order. */
function feedsOf(scope: AstNode, name: string, source: string): string[] {
  const feeds: Array<{ start: number; text: string }> = [];
  const add = (value: unknown) => {
    if (isAstNode(value)) feeds.push({ start: value.start, text: source.slice(value.start, value.end) });
  };
  const isName = (value: unknown) => isAstNode(value) && value.type === "Identifier" && value.name === name;
  forEachNode(scope, (node) => {
    if (node.type === "VariableDeclarator" && isName(node.id)) add(node.init);
    if (node.type === "AssignmentExpression" && isName(node.left)) add(node.right);
    if (node.type === "CallExpression" && memberName(node.callee) === "push"
      && isName((node.callee as AstNode).object) && Array.isArray(node.arguments)) {
      for (const argument of node.arguments) add(argument);
    }
  });
  return feeds.sort((a, b) => a.start - b.start).map((feed) => feed.text);
}

function stringLiteral(node: unknown): string | null {
  return isAstNode(node) && node.type === "Literal" && typeof node.value === "string" ? node.value : null;
}

/**
 * Reads the table-name helpers of a plugin source file:
 * - `function x(ctx) { return tableName(ctx.db.namespace, "t"); }` maps `x()` to `t`;
 * - `function tableName(namespace) { return `${namespace}.t`; }` maps the one-argument `tableName()` to `t`.
 */
function readTableHelpers(program: AstNode): { helpers: Map<string, string>; singleArgTable: string | null } {
  const helpers = new Map<string, string>();
  let singleArgTable: string | null = null;
  forEachNode(program, (node) => {
    if (node.type !== "FunctionDeclaration" || !isAstNode(node.id) || !isAstNode(node.body)) return;
    const statements = node.body.body;
    if (!Array.isArray(statements) || statements.length !== 1) return;
    const returned = isAstNode(statements[0]) && statements[0].type === "ReturnStatement" ? statements[0].argument : null;
    const name = String(node.id.name);
    if (isAstNode(returned) && returned.type === "CallExpression" && isAstNode(returned.callee)
      && returned.callee.type === "Identifier" && returned.callee.name === "tableName" && Array.isArray(returned.arguments)) {
      const table = stringLiteral(returned.arguments[1]);
      if (table) helpers.set(name, table);
    }
    if (name === "tableName" && isAstNode(returned) && returned.type === "TemplateLiteral" && Array.isArray(node.params)
      && node.params.length === 1 && Array.isArray(returned.quasis) && returned.quasis.length === 2) {
      const tail = returned.quasis[1] as { value: { cooked: string } };
      const match = /^\.([a-z_][a-z0-9_]*)$/.exec(tail.value.cooked);
      if (match) singleArgTable = match[1]!;
    }
  });
  return { helpers, singleArgTable };
}

function extractSqlCalls(plugin: CorpusPlugin, sourcePath: string): { calls: SqlCall[]; unresolved: string[]; textualCount: number } {
  const absolute = path.join(REPO_ROOT, plugin.packageDir, sourcePath);
  const stripped = stripTypeScriptTypes(readFileSync(absolute, "utf8"), { mode: "strip" });
  const program = parse(stripped, { ecmaVersion: "latest", sourceType: "module", locations: true }) as unknown as AstNode;
  const namespace = derivePluginDatabaseNamespace(plugin.pluginKey, plugin.namespaceSlug);
  const { helpers, singleArgTable } = readTableHelpers(program);
  const calls: SqlCall[] = [];
  const unresolved: string[] = [];
  const functions: AstNode[] = [];
  forEachNode(program, (node) => {
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
      functions.push(node);
    }
  });
  const enclosingScope = (node: AstNode): AstNode =>
    functions
      .filter((fn) => fn.start <= node.start && fn.end >= node.end)
      .sort((a, b) => b.start - a.start)[0] ?? program;

  const resolveExpression = (expression: AstNode, location: string, scope: AstNode): string => {
    const text = stripped.slice(expression.start, expression.end);
    if (expression.type === "CallExpression" && isAstNode(expression.callee) && expression.callee.type === "Identifier"
      && Array.isArray(expression.arguments)) {
      const callee = String(expression.callee.name);
      if (callee === "tableName") {
        const table = stringLiteral(expression.arguments[1]);
        if (table) return `${namespace}.${table}`;
        if (expression.arguments.length === 1 && singleArgTable) return `${namespace}.${singleArgTable}`;
      }
      const helperTable = helpers.get(callee);
      if (helperTable) return `${namespace}.${helperTable}`;
    }
    const fragment = DYNAMIC_FRAGMENTS[text];
    if (fragment !== undefined) {
      for (const [name, expected] of Object.entries(fragment.feeds)) {
        const actual = feedsOf(scope, name, stripped);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          unresolved.push(`${location}: \${${text}} is built from ${name} = ${JSON.stringify(actual)}; DYNAMIC_FRAGMENTS expects ${JSON.stringify(expected)}`);
        }
      }
      return fragment.standIn;
    }
    unresolved.push(`${location}: \${${text}}`);
    return "";
  };

  forEachNode(program, (node) => {
    if (node.type !== "CallExpression") return;
    const method = memberName(node.callee);
    if (method !== "query" && method !== "execute") return;
    if (memberName((node.callee as AstNode).object) !== "db") return;
    const loc = node.loc as { start: { line: number } };
    const location = `${plugin.packageDir}/${sourcePath}:${loc.start.line}`;
    const scope = enclosingScope(node);
    const first = Array.isArray(node.arguments) ? node.arguments[0] : undefined;
    let sql: string | null = stringLiteral(first);
    if (sql === null && isAstNode(first) && first.type === "TemplateLiteral" && Array.isArray(first.quasis)
      && Array.isArray(first.expressions)) {
      const quasis = first.quasis as Array<{ value: { cooked: string } }>;
      const expressions = first.expressions as AstNode[];
      sql = quasis.map((quasi, index) =>
        quasi.value.cooked + (index < expressions.length ? resolveExpression(expressions[index]!, location, scope) : "")).join("");
    }
    if (sql === null) {
      unresolved.push(`${location}: first argument is not a string or template literal`);
      return;
    }
    calls.push({ location, method, sql });
  });

  return { calls, unresolved, textualCount: stripped.match(new RegExp(DB_CALL_PATTERN.source, "g"))?.length ?? 0 };
}

beforeAll(async () => {
  await loadPluginSqlParser();
});

describe("in-repo plugin SQL corpus", () => {
  it("lists every in-repo plugin that has SQL", () => {
    const sqlSources: string[] = [];
    const databaseManifests: string[] = [];
    const migrationFiles: string[] = [];
    walkFiles(PLUGINS_ROOT, (file) => {
      const relative = repoRelative(file);
      if (/\.(ts|tsx)$/.test(file)) {
        const text = readFileSync(file, "utf8");
        if (DB_CALL_PATTERN.test(text)) sqlSources.push(relative);
        if (file.endsWith(`${path.sep}manifest.ts`) && /\bdatabase\s*:\s*\{/.test(text)) databaseManifests.push(relative);
      }
      if (file.endsWith(".sql") && path.basename(path.dirname(file)) === "migrations") migrationFiles.push(relative);
    });

    expect(sqlSources.sort()).toEqual(
      PLUGINS.flatMap((plugin) => plugin.sqlSources.map((source) => `${plugin.packageDir}/${source}`)).sort(),
    );
    expect(databaseManifests.sort()).toEqual(PLUGINS.map((plugin) => `${plugin.packageDir}/src/manifest.ts`).sort());
    for (const file of migrationFiles) {
      expect(PLUGINS.some((plugin) => file.startsWith(`${plugin.packageDir}/migrations/`)), file).toBe(true);
    }
  });

  it.each(PLUGINS)("matches the manifest of $pluginKey", (plugin) => {
    const sourceText = readdirSync(path.join(REPO_ROOT, plugin.packageDir, "src"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(path.join(REPO_ROOT, plugin.packageDir, "src", name), "utf8"))
      .join("\n");
    const manifest = readFileSync(path.join(REPO_ROOT, plugin.packageDir, "src", "manifest.ts"), "utf8");
    expect(sourceText).toContain(`"${plugin.pluginKey}"`);
    expect(manifest).toContain(`namespaceSlug: "${plugin.namespaceSlug}"`);
    expect(manifest).toContain(`coreReadTables: [${plugin.coreReadTables.map((table) => `"${table}"`).join(", ")}]`);
  });

  it.each(PLUGINS)("passes every ctx.db call of $pluginKey", (plugin) => {
    const namespace = derivePluginDatabaseNamespace(plugin.pluginKey, plugin.namespaceSlug);
    const failures: string[] = [];
    for (const source of plugin.sqlSources) {
      const { calls, unresolved, textualCount } = extractSqlCalls(plugin, source);
      expect(unresolved).toEqual([]);
      expect(calls.length).toBe(textualCount);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        try {
          if (call.method === "query") validatePluginRuntimeQuery(call.sql, namespace, plugin.coreReadTables);
          else validatePluginRuntimeExecute(call.sql, namespace);
        } catch (error) {
          failures.push(`${call.location} (${call.method}): ${(error as Error).message}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it.each(PLUGINS)("passes every migration statement of $pluginKey", (plugin) => {
    const namespace = derivePluginDatabaseNamespace(plugin.pluginKey, plugin.namespaceSlug);
    const migrationsDir = path.join(REPO_ROOT, plugin.packageDir, "migrations");
    const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const file of files) {
      const statements = splitPluginMigrationSql(readFileSync(path.join(migrationsDir, file), "utf8"));
      expect(statements.length, file).toBeGreaterThan(0);
      statements.forEach((statement, index) => {
        try {
          validatePluginMigrationStatement(statement, namespace, plugin.coreReadTables);
        } catch (error) {
          failures.push(`${plugin.packageDir}/migrations/${file}#${index + 1}: ${(error as Error).message}`);
        }
      });
    }
    expect(failures).toEqual([]);
  });
});
