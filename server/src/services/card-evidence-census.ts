import { sql, type SQL as Statement } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { detectEvidence, evidenceSurface } from "./card-evidence.js";

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

type Row = Record<string, unknown>;

interface ValueColumn {
  name: string;
  cls: "text" | "json" | "uuid" | "scalar" | "opaque";
  array: boolean;
  card: boolean;
  run: boolean;
  agent: boolean;
  document: boolean;
  structural: boolean;
  soft: boolean;
}

interface EvidenceTable {
  name: string;
  columns: ValueColumn[];
  company: boolean;
  times: string[];
  expressions: string[];
}

const MAX_ROUNDS = 4;
const VALUE_BYTES = 1024 * 1024;
const CARD_BYTES = 32 * VALUE_BYTES;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
let catalogPromise: Promise<EvidenceTable[]> | null = null;

function ident(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error("Unsupported evidence catalog identifier");
  return value;
}

async function loadCatalog(db: Db): Promise<EvidenceTable[]> {
  const rows = await db.execute(sql`
    select c.relname as tbl, a.attname as col, t.typname as typ,
      t.typcategory as category, t.typtype as type_kind,
      et.typname as element_type, et.typcategory as element_category,
      coalesce((
        select string_agg(distinct fc.relname, ',')
        from pg_constraint k
        join pg_class fc on fc.oid = k.confrelid
        where k.contype = 'f' and k.conrelid = c.oid and a.attnum = any(k.conkey)
          and (
            select fa.attname from pg_attribute fa
            where fa.attrelid = k.confrelid
              and fa.attnum = k.confkey[array_position(k.conkey, a.attnum)]
          ) = 'id'
      ), '') as targets
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    join pg_type t on t.oid = a.atttypid
    left join pg_type et on et.oid = t.typelem
    where c.relkind in ('r', 'p')
    order by c.relname, a.attnum
  `) as unknown as Array<{
    tbl: string; col: string; typ: string; category: string; type_kind: string;
    element_type: string | null; element_category: string | null; targets: string;
  }>;
  const tables = new Map<string, EvidenceTable>();
  for (const row of rows) {
    const name = ident(row.tbl);
    const key = ident(row.col);
    let table = tables.get(name);
    if (!table) {
      table = { name, columns: [], company: false, times: [], expressions: [] };
      tables.set(name, table);
    }
    const targets = new Set(row.targets.split(","));
    const array = row.category === "A" || row.typ === "json" || row.typ === "jsonb";
    const uuid = row.typ === "uuid" || row.element_type === "uuid";
    const text = row.category === "S" || row.element_category === "S" || row.type_kind === "e";
    const cls: ValueColumn["cls"] = row.type_kind === "d" ? "opaque"
      : row.typ === "json" || row.typ === "jsonb" ? "json"
        : uuid ? "uuid"
          : text ? "text"
            : ["N", "B", "D", "T"].includes(row.category) ? "scalar" : "opaque";
    const reference = uuid || text || array;
    const peer = PEER_REF_COLUMNS.has(`${name}.${key}`);
    table.columns.push({
      name: key, cls, array,
      card: !peer && (targets.has("issues") || (reference && /(?:^|_)issue_ids?$/.test(key)) || (name === "issues" && key === "id")),
      run: targets.has("heartbeat_runs") || (reference && /(?:^|_)run_ids?$/.test(key)),
      agent: targets.has("agents") || (reference && /(?:^|_)agent_ids?$/.test(key)),
      document: targets.has("documents"),
      structural: ["projects", "project_workspaces", "execution_workspaces"].some((target) => targets.has(target)),
      soft: !peer && row.targets === "" && key !== "id" && (uuid || text) && /_(?:id|key)$/.test(key),
    });
    if (key === "company_id") table.company = true;
    if (row.category === "D" && ["created_at", "updated_at", "occurred_at", "requested_at"].includes(key)) table.times.push(key);
  }
  // PostgreSQL supplies the expression, not application or caller text. This
  // derives indexed JSON selectors, including new keys added by a migration.
  const expressions = await db.execute(sql`
    select c.relname as tbl, pg_get_indexdef(i.indexrelid, p.position, true) as expression
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    cross join lateral generate_series(1, i.indnkeyatts) p(position)
    where i.indexprs is not null and i.indisvalid
      and pg_get_indexdef(i.indexrelid, p.position, true) like '%->>%'
  `) as unknown as Array<{ tbl: string; expression: string }>;
  for (const row of expressions) {
    const table = tables.get(row.tbl);
    if (table && !table.expressions.includes(row.expression)) table.expressions.push(row.expression);
  }
  return [...tables.values()];
}

function catalog(db: Db) {
  if (!catalogPromise) {
    const loading = loadCatalog(db);
    catalogPromise = loading;
    loading.catch(() => {
      if (catalogPromise === loading) catalogPromise = null;
    });
  }
  return catalogPromise;
}

interface ScanState {
  runs: Set<string>;
  agents: Set<string>;
  documents: Set<string>;
  seen: Set<string>;
  checkedUuids: Set<string>;
  bytes: number;
}

function strings(value: unknown, visit: (value: string) => void): void {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) {
    for (const item of value) strings(item, visit);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Row)) strings(item, visit);
  }
}

function scanRecord(table: EvidenceTable, row: Row, state: ScanState, uuids: Set<string>): CensusHit | null {
  for (const column of table.columns) {
    const value = row[column.name];
    if (value == null) continue;
    if (column.cls === "opaque") return { table: table.name, column: column.name, label: "an unscannable column type" };
    if (column.structural) return { table: table.name, column: column.name, label: "a project or workspace reference" };
    const encoded = typeof value === "string" ? value : JSON.stringify(value);
    const bytes = Buffer.byteLength(encoded);
    state.bytes += bytes;
    if (bytes > VALUE_BYTES || state.bytes > CARD_BYTES) return { table: table.name, column: column.name, label: "evidence exceeds the scan size budget" };
    strings(value, (text) => {
      for (const match of text.matchAll(UUID)) {
        const id = match[0].toLowerCase();
        if (!state.checkedUuids.has(id)) uuids.add(id);
      }
    });
    const surface = evidenceSurface(table.name, column.name);
    const found = detectEvidence(surface === "prose" ? value : { [column.name]: value }, surface);
    if (found) return { table: table.name, column: column.name, label: found.label };
    if (column.run || column.agent || column.document) {
      strings(value, (id) => {
        if (!/^[0-9a-f-]{36}$/i.test(id)) return;
        if (column.run) state.runs.add(id);
        if (column.agent) state.agents.add(id);
        if (column.document) state.documents.add(id);
      });
    }
  }
  if (table.name === "heartbeat_runs" && typeof row.id === "string") state.runs.add(row.id);
  return null;
}

function oneOf(expression: Statement, values: string[]): Statement {
  return sql`${expression} in (${sql.join(values.map((value) => sql`${value}`), sql`, `)})`;
}

function reference(key: Statement, column: ValueColumn, values: string[]): Statement {
  return column.array
    ? sql`(${sql.join(values.map((value) => sql`strpos(to_jsonb(${key})::text, ${value}) > 0`), sql` or `)})`
    : oneOf(sql`${key}::text`, values);
}

function selects(
  table: EvidenceTable,
  card: { id: string; companyId: string; identifier: string; createdAt: Date },
  runs: string[],
  actors: string[],
  documents: string[],
): Statement | null {
  const direct: Statement[] = [];
  const indirect: Statement[] = [];
  const otherCards: Statement[] = [];
  const identities = [card.id, card.identifier];
  for (const column of table.columns) {
    const key = sql.raw(`x.${ident(column.name)}`);
    if (column.card) {
      if (column.array) direct.push(sql`strpos(to_jsonb(${key})::text, ${card.id}) > 0`);
      else {
        direct.push(sql`${key}::text = ${card.id}`);
        // A run can touch several cards. Rows owned by another existing card
        // must not leak that card's repository work into this one's proof.
        otherCards.push(sql`exists (
          select 1 from issues peer where peer.id::text = ${key}::text
            and peer.id <> ${card.id} and peer.company_id = ${card.companyId}
        )`);
      }
    }
    if (column.soft) direct.push(oneOf(sql`${key}::text`, identities));
    if (column.document && documents.length) direct.push(reference(key, column, documents));
    if (column.run && runs.length) indirect.push(reference(key, column, runs));
  }
  if (table.name === "heartbeat_runs" && runs.length) indirect.push(oneOf(sql`x.id::text`, runs));
  if (table.name === "documents" && documents.length) direct.push(oneOf(sql`x.id::text`, documents));
  for (const expression of table.expressions) direct.push(oneOf(sql`(${sql.raw(expression)})::text`, identities));
  if (actors.length) {
    const actorColumns = table.columns.filter((column) => column.agent);
    if (actorColumns.length) {
      const actor = actorColumns.map((column) => reference(sql.raw(`x.${ident(column.name)}`), column, actors));
      const time = table.times.length
        ? sql` and greatest(${sql.join(table.times.map((key) => sql.raw(`x.${ident(key)}`)), sql`, `)}) >= ${card.createdAt.toISOString()}::timestamptz`
        : sql``;
      const token = `(^|[^A-Za-z0-9_-])${card.identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_-]|$)`;
      indirect.push(sql`((${sql.join(actor, sql` or `)})${time}
        and (strpos(to_jsonb(x)::text, ${card.id}) > 0 or to_jsonb(x)::text ~ ${token}))`);
    }
  }
  const predicates = [...direct];
  if (indirect.length) {
    const precedence = otherCards.length ? sql` and not (${sql.join(otherCards, sql` or `)})` : sql``;
    predicates.push(sql`((${sql.join(indirect, sql` or `)})${precedence})`);
  }
  if (!predicates.length) return null;
  const company = table.company ? sql` and x.company_id = ${card.companyId}` : sql``;
  return sql`(${sql.join(predicates, sql` or `)})${company}`;
}

async function workspaceValue(db: Db, companyId: string, ids: Set<string>, state: ScanState): Promise<boolean> {
  if (!ids.size) return false;
  const values = [...ids];
  for (const id of values) state.checkedUuids.add(id);
  const rows = await db.execute(sql`
    select id from projects where company_id = ${companyId} and ${oneOf(sql`id::text`, values)}
    union all select id from project_workspaces where company_id = ${companyId} and ${oneOf(sql`id::text`, values)}
    union all select id from execution_workspaces where company_id = ${companyId} and ${oneOf(sql`id::text`, values)}
    limit 1
  `) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

export async function scanCardEvidence(
  db: Db,
  card: { id: string; companyId: string; identifier: string; createdAt: Date },
  seedRunIds: readonly string[] = [],
): Promise<CensusHit | null> {
  const tables = await catalog(db);
  const byName = new Map(tables.map((table) => [table.name, table]));
  const state: ScanState = { runs: new Set(seedRunIds), agents: new Set(), documents: new Set(), seen: new Set(), checkedUuids: new Set(), bytes: 0 };
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const size = state.runs.size + state.agents.size + state.documents.size;
    const runs = [...state.runs];
    const actors = [...state.agents];
    const documents = [...state.documents];
    const queries: Statement[] = [];
    for (const table of tables) {
      const predicate = selects(table, card, runs, actors, documents);
      if (!predicate) continue;
      queries.push(sql`(select ${table.name}::text as tbl,
        x.tableoid::text || ':' || x.ctid::text as row_key, to_jsonb(x) as row
        from ${sql.raw(ident(table.name))} x where ${predicate} limit ${ROW_LIMIT + 1})`);
    }
    const selected = await db.execute(sql.join(queries, sql` union all `)) as unknown as Array<{ tbl: string; row_key: string; row: Row }>;
    const counts = new Map<string, number>();
    const uuids = new Set<string>();
    for (const selectedRow of selected) {
      const count = (counts.get(selectedRow.tbl) ?? 0) + 1;
      counts.set(selectedRow.tbl, count);
      if (count > ROW_LIMIT) return { table: selectedRow.tbl, column: "", label: "too many attributed rows to scan" };
      const identity = `${selectedRow.tbl}:${selectedRow.row_key}`;
      if (state.seen.has(identity)) continue;
      state.seen.add(identity);
      const table = byName.get(selectedRow.tbl)!;
      const hit = scanRecord(table, selectedRow.row, state, uuids);
      if (hit) return hit;
    }
    if (await workspaceValue(db, card.companyId, uuids, state)) return { table: "attributed evidence", column: "", label: "a project or workspace identity" };
    if (size === state.runs.size + state.agents.size + state.documents.size) return null;
  }
  return { table: "attributed evidence", column: "", label: "attribution exceeds the scan round budget" };
}

export function resetEvidenceCatalogForTests() {
  catalogPromise = null;
}
