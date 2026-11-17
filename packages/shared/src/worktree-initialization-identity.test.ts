import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeWorktreeSchemaLineage,
  parseWorktreeEnvInstanceId,
  resolveWorktreeSchemaLineage,
} from "./worktree-initialization-identity.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function migrationsFolder(tags: string[], sqlFor: (tag: string) => string = () => randomBytes(16).toString("hex")) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-schema-lineage-"));
  temporaryRoots.push(root);
  const folder = path.join(root, "migrations");
  fs.mkdirSync(path.join(folder, "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(folder, "meta", "_journal.json"),
    JSON.stringify({ version: "7", entries: tags.map((tag, idx) => ({ idx, tag, when: idx, breakpoints: true })) }),
  );
  for (const tag of tags) fs.writeFileSync(path.join(folder, `${tag}.sql`), sqlFor(tag));
  return folder;
}

describe("computeWorktreeSchemaLineage", () => {
  it("chains each revision over every earlier migration", () => {
    const sql = new Map(["0000_a", "0001_b", "0002_c"].map((tag) => [tag, randomBytes(16).toString("hex")]));
    const folder = migrationsFolder([...sql.keys()], (tag) => sql.get(tag)!);
    const lineage = computeWorktreeSchemaLineage(folder);
    expect(lineage.map((revision) => revision.migrationRevision)).toEqual(["0000_a.sql", "0001_b.sql", "0002_c.sql"]);
    expect(new Set(lineage.map((revision) => revision.schemaFingerprint)).size).toBe(3);
    for (const revision of lineage) expect(revision.schemaFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Same chain: same lineage. A changed middle migration keeps the prefix and
    // changes every later fingerprint.
    expect(computeWorktreeSchemaLineage(migrationsFolder([...sql.keys()], (tag) => sql.get(tag)!))).toEqual(lineage);
    const edited = computeWorktreeSchemaLineage(
      migrationsFolder([...sql.keys()], (tag) => (tag === "0001_b" ? `${sql.get(tag)}--edited` : sql.get(tag)!)),
    );
    expect(edited[0]).toEqual(lineage[0]);
    expect(edited[1].schemaFingerprint).not.toBe(lineage[1].schemaFingerprint);
    expect(edited[2].schemaFingerprint).not.toBe(lineage[2].schemaFingerprint);
  });

  it("throws for a missing, malformed or out-of-order journal and for a missing migration file", () => {
    const missingJournal = migrationsFolder(["0000_a"]);
    fs.rmSync(path.join(missingJournal, "meta", "_journal.json"));
    const malformed = migrationsFolder(["0000_a"]);
    fs.writeFileSync(path.join(malformed, "meta", "_journal.json"), "{");
    const empty = migrationsFolder([]);
    const outOfOrder = migrationsFolder(["0000_a", "0001_b"]);
    fs.writeFileSync(
      path.join(outOfOrder, "meta", "_journal.json"),
      JSON.stringify({ entries: [{ idx: 1, tag: "0001_b" }, { idx: 0, tag: "0000_a" }] }),
    );
    // A journal tag cannot name a file outside the migrations folder, even one that exists.
    const traversal = migrationsFolder(["0000_a"]);
    fs.writeFileSync(path.join(traversal, "..", "outside.sql"), "-- outside\n");
    fs.writeFileSync(path.join(traversal, "meta", "_journal.json"), JSON.stringify({ entries: [{ idx: 0, tag: "../outside" }] }));
    const missingSql = migrationsFolder(["0000_a", "0001_b"]);
    fs.rmSync(path.join(missingSql, "0001_b.sql"));

    for (const folder of [missingJournal, malformed, empty, outOfOrder, traversal, missingSql]) {
      expect(() => computeWorktreeSchemaLineage(folder)).toThrow(/Migration journal in .* is missing or invalid/);
      expect(resolveWorktreeSchemaLineage(folder)).toBeNull();
    }
  });

  it("computes the lineage of this repository's migrations", () => {
    const folder = path.resolve(__dirname, "../../db/src/migrations");
    const journal = JSON.parse(fs.readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    const lineage = resolveWorktreeSchemaLineage(folder);
    expect(lineage).toHaveLength(journal.entries.length);
    expect(lineage?.at(-1)?.migrationRevision).toBe(`${journal.entries.at(-1)!.tag}.sql`);
  });
});

describe("parseWorktreeEnvInstanceId", () => {
  const parse = (text: string) => parseWorktreeEnvInstanceId(Buffer.from(text));

  it("reads plain, exported and quoted values, and the last assignment wins", () => {
    expect(parse("PAPERCLIP_HOME=/x\nPAPERCLIP_INSTANCE_ID=wt-one\n")).toBe("wt-one");
    expect(parse("export PAPERCLIP_INSTANCE_ID='wt-two'")).toBe("wt-two");
    expect(parse("PAPERCLIP_INSTANCE_ID=\"wt-three\"\r\n")).toBe("wt-three");
    expect(parse("PAPERCLIP_INSTANCE_ID=wt-old\nPAPERCLIP_INSTANCE_ID=wt-new")).toBe("wt-new");
  });

  it("returns null for an absent, empty, non-id or non-UTF-8 value", () => {
    expect(parse("PAPERCLIP_HOME=/x\n")).toBeNull();
    expect(parse("PAPERCLIP_INSTANCE_ID=")).toBeNull();
    expect(parse("PAPERCLIP_INSTANCE_ID=../parent")).toBeNull();
    expect(parse("PAPERCLIP_INSTANCE_ID=wt one")).toBeNull();
    expect(parse("# PAPERCLIP_INSTANCE_ID=wt-commented")).toBeNull();
    expect(parseWorktreeEnvInstanceId(Buffer.from([0x50, 0xff]))).toBeNull();
  });
});
