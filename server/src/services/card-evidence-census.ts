import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { detectEvidence, evidenceSurface, type EvidenceFinding } from "./card-evidence.js";

/**
 * Rows attributed to a card, derived from the live catalog rather than a
 * hand-written table list. Company-only tables are not attributed. A peer
 * reference (a child card) is not this card's evidence.
 */
const PEER_REF_COLUMNS = new Set(["issues.parent_id"]);
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const ROW_LIMIT = 200;

export interface CensusHit {
  table: string;
  column: string;
  label: string;
}

interface CardRef {
  table: string;
  column: string;
  hasCompanyId: boolean;
}

interface ValueColumn {
  name: string;
  cls: "text" | "json" | "uuid";
}

let catalogPromise: Promise<{ refs: CardRef[]; columns: Map<string, ValueColumn[]> }> | null = null;

function ident(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`refusing catalog identifier ${value}`);
  return value;
}

async function loadCatalog(db: Db) {
  const refRows = await db.execute(sql`
    select c.relname as tbl, a.attname as col,
      exists (
        select 1 from pg_attribute company
        where company.attrelid = c.oid and company.attname = 'company_id' and not company.attisdropped
      ) as has_company
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_attribute a on a.attrelid = c.oid and a.attnum = any(k.conkey) and not a.attisdropped
    join pg_class fc on fc.oid = k.confrelid and fc.relname = 'issues'
    where k.contype = 'f' and c.relkind in ('r', 'p')
      and (
        select fa.attname from pg_attribute fa
        where fa.attrelid = k.confrelid and fa.attnum = k.confkey[array_position(k.conkey, a.attnum)]
      ) = 'id'
    union
    select c.relname, a.attname, exists (
      select 1 from pg_attribute company
      where company.attrelid = c.oid and company.attname = 'company_id' and not company.attisdropped
    )
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    join pg_type t on t.oid = a.atttypid
    where c.relkind in ('r', 'p')
      and t.typname = 'uuid'
      and (a.attname like '%issue_id' or a.attname like '%issue_ids')
  `) as unknown as Array<{ tbl: string; col: string; has_company: boolean }>;
  const columnRows = await db.execute(sql`
    select c.relname as tbl, a.attname as col,
      case
        when t.typname in ('json', 'jsonb') then 'json'
        when t.typname = 'uuid' then 'uuid'
        else 'text'
      end as cls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    join pg_type t on t.oid = a.atttypid
    left join pg_type et on et.oid = t.typelem
    where c.relkind in ('r', 'p')
      and (
        t.typcategory = 'S'
        or t.typname in ('json', 'jsonb', 'uuid')
        or (t.typcategory = 'A' and (et.typcategory = 'S' or et.typname = 'uuid'))
      )
  `) as unknown as Array<{ tbl: string; col: string; cls: ValueColumn["cls"] }>;
  const columns = new Map<string, ValueColumn[]>();
  for (const row of columnRows) {
    if (!IDENTIFIER.test(row.tbl) || !IDENTIFIER.test(row.col)) continue;
    const list = columns.get(row.tbl) ?? [];
    list.push({ name: row.col, cls: row.cls });
    columns.set(row.tbl, list);
  }
  const refs = refRows
    .filter((row) => IDENTIFIER.test(row.tbl) && IDENTIFIER.test(row.col) && !PEER_REF_COLUMNS.has(`${row.tbl}.${row.col}`))
    .map((row) => ({ table: row.tbl, column: row.col, hasCompanyId: row.has_company === true || String(row.has_company) === "t" || String(row.has_company) === "true" }));
  return { refs, columns };
}

function catalog(db: Db) {
  catalogPromise ??= loadCatalog(db);
  return catalogPromise;
}

function scanRecord(table: string, row: Record<string, unknown>, columns: ValueColumn[]): EvidenceFinding | null {
  const known = new Map(columns.map((column) => [column.name, column]));
  for (const [key, value] of Object.entries(row)) {
    if (value == null) continue;
    const column = known.get(key);
    if (!column) continue;
    if (column.cls === "uuid") {
      if (typeof value === "string" && value.length > 0 && key.endsWith("workspace_id")) {
        return { label: "a workspace id", arm: "key" };
      }
      continue;
    }
    const found = detectEvidence(value, evidenceSurface(table, key));
    if (found) return found;
  }
  return null;
}

async function rowsFor(db: Db, statement: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  const result = await db.execute(statement);
  return result as unknown as Array<Record<string, unknown>>;
}

export async function scanCardEvidence(
  db: Db,
  card: { id: string; companyId: string; identifier: string; createdAt: Date },
): Promise<CensusHit | null> {
  const { refs, columns } = await catalog(db);
  const coveredByDedicatedScan = new Set(["issue_comments", "issue_work_products", "external_object_mentions", "documents", "document_revisions", "issue_documents", "activity_log", "heartbeat_runs", "heartbeat_run_events", "issues"]);
  for (const ref of refs) {
    if (coveredByDedicatedScan.has(ref.table)) continue;
    const table = ident(ref.table);
    const column = ident(ref.column);
    const company = ref.hasCompanyId ? sql` and company_id = ${card.companyId}` : sql``;
    const selected = await rowsFor(db, sql`
      select to_jsonb(x) as row
      from ${sql.raw(table)} x
      where ${sql.raw(column)} = ${card.id}
      ${company}
      limit ${ROW_LIMIT + 1}
    `);
    if (selected.length > ROW_LIMIT) {
      return { table, column, label: "too many attributed rows to scan" };
    }
    for (const selectedRow of selected) {
      const row = selectedRow.row;
      if (row === null || typeof row !== "object") continue;
      const found = scanRecord(table, row as Record<string, unknown>, columns.get(table) ?? []);
      if (found) return { table, column: found.arm, label: found.label };
    }
  }
  const issueRows = await rowsFor(db, sql`select to_jsonb(x) as row from issues x where x.id = ${card.id}`);
  for (const issueRow of issueRows) {
    const issueRecord = issueRow.row;
    if (issueRecord === null || typeof issueRecord !== "object" || Array.isArray(issueRecord)) continue;
    const issueFinding = scanRecord("issues", Object.fromEntries(Object.entries(issueRecord)), columns.get("issues") ?? []);
    if (issueFinding) return { table: "issues", column: issueFinding.arm, label: issueFinding.label };
  }


  const createdAt = card.createdAt.toISOString();
  const softQueries = [
    sql`select to_jsonb(x) as row from agent_task_sessions x where x.company_id = ${card.companyId} and (x.task_key = ${card.id} or x.task_key = ${card.identifier})`,
    sql`select to_jsonb(x) as row from agent_wakeup_requests x where x.company_id = ${card.companyId} and (x.payload ->> 'issueId' = ${card.id} or x.payload ->> 'issueId' = ${card.identifier})`,
    sql`select to_jsonb(x) as row from heartbeat_runs x where x.company_id = ${card.companyId} and x.created_at >= ${createdAt}::timestamptz and (x.native_issue_id = ${card.id} or x.context_snapshot ->> 'issueId' = ${card.id} or x.context_snapshot ->> 'issueId' = ${card.identifier} or strpos(coalesce(x.log_ref, ''), ${card.id}) > 0 or strpos(x.context_snapshot::text, ${card.id}) > 0)`,
  ];
  const softTables = ["agent_task_sessions", "agent_wakeup_requests", "heartbeat_runs"];
  const soft: Array<Record<string, unknown>> = [];
  for (let index = 0; index < softQueries.length; index += 1) {
    const selected = await rowsFor(db, softQueries[index]!);
    for (const selectedRow of selected) soft.push({ tbl: softTables[index], row: selectedRow.row });
  }
  for (const selectedRow of soft) {
    const table = String(selectedRow.tbl);
    const row = selectedRow.row;
    if (row === null || typeof row !== "object") continue;
    const found = scanRecord(table, row as Record<string, unknown>, columns.get(table) ?? []);
    if (found) return { table, column: found.arm, label: found.label };
  }

  const runIds = soft
    .filter((selectedRow) => selectedRow.tbl === "heartbeat_runs" && selectedRow.row && typeof selectedRow.row === "object")
    .map((selectedRow) => (selectedRow.row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string");
  if (runIds.length > 0) {
    const events = await rowsFor(db, sql`
      select to_jsonb(x) as row
      from heartbeat_run_events x
      where x.run_id in (${sql.join(runIds.map((id) => sql`${id}`), sql`, `)})
      limit ${ROW_LIMIT + 1}
    `);
    if (events.length > ROW_LIMIT) {
      return { table: "heartbeat_run_events", column: "run_id", label: "too many attributed rows to scan" };
    }
    for (const selectedRow of events) {
      const row = selectedRow.row;
      if (row === null || typeof row !== "object") continue;
      const found = scanRecord("heartbeat_run_events", row as Record<string, unknown>, columns.get("heartbeat_run_events") ?? []);
      if (found) return { table: "heartbeat_run_events", column: found.arm, label: found.label };
    }
  }
  return null;
}

export function resetEvidenceCatalogForTests() {
  catalogPromise = null;
}
