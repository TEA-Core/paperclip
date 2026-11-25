import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { companies, createDb, issues, type Db } from "@paperclipai/db";
import { scanCardEvidence } from "../services/card-evidence-census.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

interface TestCard {
  id: string;
  companyId: string;
  identifier: string;
  createdAt: Date;
}

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("card evidence census budget boundaries", () => {
  let db: Db;
  let database: EmbeddedPostgresTestDatabase;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-census-boundaries-");
    db = createDb(database.connectionString);
    await db.execute(sql`create table zz_census_budget_evidence (
      id integer generated always as identity primary key,
      company_id uuid not null,
      issue_id uuid references issues(id),
      run_id uuid,
      next_run_id uuid,
      note text not null default ''
    )`);
  }, 60_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  async function seedCard() {
    const companyId = randomUUID();
    const prefix = `B${companyId.slice(0, 7).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Boundary decisions", issuePrefix: prefix });
    const card = {
      id: randomUUID(), companyId, identifier: `${prefix}-1`,
      createdAt: new Date("2020-01-01T00:00:00Z"),
    };
    await db.insert(issues).values({
      ...card, title: "Record the decision", status: "in_progress", deliveryRequirement: "record_only",
    });
    return card;
  }

  async function insertRows(card: TestCard, count: number) {
    return db.execute<{ id: number }>(sql`
      insert into zz_census_budget_evidence (company_id, issue_id)
      select ${card.companyId}::uuid, ${card.id}::uuid from generate_series(1, ${count})
      returning id
    `);
  }

  // SQL measures the complete JSON row, including keys and null fields. Use
  // short neutral words, not a huge token that invokes the opaque-token policy.
  async function sizeRows(companyId: string, bytes: number) {
    await db.execute(sql`
      with sizes as (
        select id, ${bytes} - octet_length(to_jsonb(p)::text) + octet_length(note) as payload_bytes
        from zz_census_budget_evidence p where company_id = ${companyId}::uuid
      )
      update zz_census_budget_evidence p
      set note = repeat('n ', sizes.payload_bytes / 2)
        || case when sizes.payload_bytes % 2 = 1 then 'n' else '' end
      from sizes where p.id = sizes.id
    `);
  }

  async function rowBytes(companyId: string) {
    const [row] = await db.execute<{ bytes: number }>(sql`
      select sum(octet_length(to_jsonb(p)::text))::integer as bytes
      from zz_census_budget_evidence p where company_id = ${companyId}::uuid
    `);
    return row!.bytes;
  }

  async function cardBytes(card: TestCard) {
    const [row] = await db.execute<{ bytes: number }>(sql`
      select octet_length(to_jsonb(i)::text) as bytes from issues i where id = ${card.id}::uuid
    `);
    return row!.bytes + await rowBytes(card.companyId);
  }

  it("allows exactly 200 attributed rows per table and refuses row 201", async () => {
    const card = await seedCard();
    await insertRows(card, 200);
    expect(await scanCardEvidence(db, card)).toBeNull();
    await insertRows(card, 1);
    expect(await scanCardEvidence(db, card)).not.toBeNull();
  });

  it("allows exactly 1 MiB per serialized row and refuses one extra byte", async () => {
    const card = await seedCard();
    await insertRows(card, 1);
    await sizeRows(card.companyId, 1_048_576);
    expect(await rowBytes(card.companyId)).toBe(1_048_576);
    expect(await scanCardEvidence(db, card)).toBeNull();
    await db.execute(sql`update zz_census_budget_evidence set note = note || 'n'
      where company_id = ${card.companyId}::uuid`);
    expect(await rowBytes(card.companyId)).toBe(1_048_577);
    expect(await scanCardEvidence(db, card)).not.toBeNull();
  }, 60_000);

  it("allows exactly 32 MiB per card and refuses one extra byte", async () => {
    const card = await seedCard();
    const rows = await insertRows(card, 34);
    await sizeRows(card.companyId, 1_000_000);
    const excess = await cardBytes(card) - 33_554_432;
    expect(excess).toBeGreaterThan(0);
    expect(excess).toBeLessThan(1_000_000);
    const lastId = rows[rows.length - 1]!.id;
    await db.execute(sql`update zz_census_budget_evidence
      set note = left(note, length(note) - ${excess}) where id = ${lastId}`);
    expect(await cardBytes(card)).toBe(33_554_432);
    expect(await scanCardEvidence(db, card)).toBeNull();
    await db.execute(sql`update zz_census_budget_evidence set note = note || 'n' where id = ${lastId}`);
    expect(await cardBytes(card)).toBe(33_554_433);
    expect(await scanCardEvidence(db, card)).not.toBeNull();
  }, 60_000);

  it("allows convergence in exactly four rounds and refuses a fifth round", async () => {
    const card = await seedCard();
    const runIds = Array.from({ length: 4 }, () => randomUUID());
    await db.execute(sql`insert into zz_census_budget_evidence (company_id, issue_id, run_id, next_run_id)
      values
        (${card.companyId}::uuid, ${card.id}::uuid, ${runIds[0]}::uuid, null),
        (${card.companyId}::uuid, null, ${runIds[0]}::uuid, ${runIds[1]}::uuid),
        (${card.companyId}::uuid, null, ${runIds[1]}::uuid, ${runIds[2]}::uuid),
        (${card.companyId}::uuid, null, ${runIds[2]}::uuid, null)
    `);
    expect(await scanCardEvidence(db, card)).toBeNull();
    await db.execute(sql`update zz_census_budget_evidence set next_run_id = ${runIds[3]}::uuid
      where company_id = ${card.companyId}::uuid and run_id = ${runIds[2]}::uuid`);
    await db.execute(sql`insert into zz_census_budget_evidence (company_id, run_id)
      values (${card.companyId}::uuid, ${runIds[3]}::uuid)`);
    expect(await scanCardEvidence(db, card)).not.toBeNull();
  });
});
