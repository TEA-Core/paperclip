import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SQL, is } from "drizzle-orm";
import { PgDialect, PgTable, getTableConfig, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema/index.js";

/**
 * SUP-23998 (mutant B-m1). The folded upstream migrations 0303-0306 are copied in as
 * SQL, and nothing else binds that SQL to the Drizzle schema: a one-word flip such as
 * `setup_pending ... DEFAULT false` -> `DEFAULT true` passed `check:migrations` and the
 * snapshot-drift test and shipped silently to every fresh database. This test reads each
 * `ADD COLUMN` those migrations make and compares nullability and default with the
 * schema column the application actually uses.
 */
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
const FOLDED_MIGRATIONS = ["0303_unique_genesis.sql", "0304_true_boom_boom.sql", "0305_colossal_shocker.sql", "0306_jittery_psynapse.sql"];

interface AddedColumn {
  migration: string;
  table: string;
  column: string;
  notNull: boolean;
  defaultSql: string | null;
}

function describeColumn(migration: string, table: string, column: string, definition: string): AddedColumn {
  const defaultMatch = /\bDEFAULT\s+('(?:[^']|'')*'(?:::\w+)?|[^\s,;]+)/.exec(definition);
  return {
    migration,
    table,
    column,
    notNull: /\bNOT NULL\b|\bPRIMARY KEY\b/.test(definition),
    defaultSql: defaultMatch ? defaultMatch[1]! : null,
  };
}

function addedColumns(): AddedColumn[] {
  const out: AddedColumn[] = [];
  for (const migration of FOLDED_MIGRATIONS) {
    const sql = fs.readFileSync(path.join(migrationsDir, migration), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const add = /ALTER TABLE "(\w+)" ADD COLUMN(?: IF NOT EXISTS)? "(\w+)" ([^;]+)/.exec(statement);
      if (add) out.push(describeColumn(migration, add[1]!, add[2]!, add[3]!));
      const create = /CREATE TABLE(?: IF NOT EXISTS)? "(\w+)" \(([\s\S]*?)\n\);/.exec(statement);
      if (!create) continue;
      for (const line of create[2]!.split("\n")) {
        const column = /^\s*"(\w+)" ([^\n]*?),?\s*$/.exec(line);
        if (column) out.push(describeColumn(migration, create[1]!, column[1]!, column[2]!));
      }
    }
  }
  return out;
}

function sqlDefaultValue(defaultSql: string): unknown {
  if (defaultSql === "true") return true;
  if (defaultSql === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(defaultSql)) return Number(defaultSql);
  const jsonb = /^'(.*)'::jsonb$/s.exec(defaultSql);
  if (jsonb) return JSON.parse(jsonb[1]!.replaceAll("''", "'"));
  if (defaultSql.startsWith("'")) return defaultSql.slice(1, -1).replaceAll("''", "'");
  return defaultSql;
}

/** A schema default as the migration SQL writes it: literals as values, SQL fragments as text. */
function schemaDefaultValue(value: unknown): unknown {
  return is(value, SQL) ? new PgDialect().sqlToQuery(value).sql : value;
}

function schemaColumns() {
  const tables = new Map<string, ReturnType<typeof getTableConfig>>();
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) {
      const config = getTableConfig(value);
      tables.set(config.name, config);
    }
  }
  return tables;
}

describe("folded migrations 0303-0306 agree with the Drizzle schema", () => {
  const columns = addedColumns();
  const tables = schemaColumns();

  it("reads the columns the folded migrations add or create", () => {
    const names = columns.map((column) => `${column.table}.${column.column}`);
    for (const expected of [
      "agents.appearance",
      "chat_endpoints.communication_instructions",
      "routine_triggers.archived",
      "routine_triggers.setup_pending",
      "routine_webhook_test_receipts.received_at",
      "chat_github_configurations.revision",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it.each(addedColumns())("$table $column ($migration) has the schema's nullability and default", (added) => {
    const table = tables.get(added.table);
    expect(table, `${added.table} is not a schema table`).toBeDefined();
    const column = table!.columns.find((candidate) => candidate.name === added.column);
    expect(column, `${added.table}.${added.column} is not a schema column`).toBeDefined();
    expect(column!.notNull, `${added.migration}: NOT NULL differs from the schema`).toBe(added.notNull);
    if (added.defaultSql === null) {
      expect(column!.hasDefault, `${added.migration}: the schema has a default the SQL lacks`).toBe(false);
    } else {
      expect(column!.hasDefault, `${added.migration}: the schema lacks the SQL default`).toBe(true);
      expect(schemaDefaultValue(column!.default), `${added.migration}: DEFAULT differs from the schema`).toEqual(sqlDefaultValue(added.defaultSql));
    }
  });

  // CodeRabbit on PR 1208: a function default must match by expression, not only exist.
  it("tells apart two different function defaults", () => {
    const fixture = getTableConfig(pgTable("fixture", { createdAt: timestamp("created_at").defaultNow(), id: uuid("id").defaultRandom() }));
    const now = fixture.columns.find((column) => column.name === "created_at")!.default;
    const random = fixture.columns.find((column) => column.name === "id")!.default;
    expect(schemaDefaultValue(now)).toEqual(sqlDefaultValue("now()"));
    expect(schemaDefaultValue(random)).toEqual(sqlDefaultValue("gen_random_uuid()"));
    expect(schemaDefaultValue(now)).not.toEqual(sqlDefaultValue("gen_random_uuid()"));
    expect(schemaDefaultValue(random)).not.toEqual(sqlDefaultValue("now()"));
  });
});
