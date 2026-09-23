import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  createBufferedTextFileWriter,
  runDatabaseBackup,
  runDatabaseRestore,
  splitConnectionStringPassword,
} from "./backup-lib.js";
import { ensurePostgresDatabase } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void> | void> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-db-backup-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

async function createSiblingDatabase(connectionString: string, databaseName: string): Promise<string> {
  const adminUrl = new URL(connectionString);
  adminUrl.pathname = "/postgres";
  await ensurePostgresDatabase(adminUrl.toString(), databaseName);
  const targetUrl = new URL(connectionString);
  targetUrl.pathname = `/${databaseName}`;
  return targetUrl.toString();
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres backup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("createBufferedTextFileWriter", () => {
  it("preserves line boundaries across buffered flushes", async () => {
    const tempDir = createTempDir("paperclip-buffered-writer-");
    const outputPath = path.join(tempDir, "backup.sql");
    const writer = createBufferedTextFileWriter(outputPath, 16);
    const lines = [
      "-- header",
      "BEGIN;",
      "",
      "INSERT INTO test VALUES (1);",
      "-- footer",
    ];

    for (const line of lines) {
      writer.emit(line);
    }

    await writer.close();

    expect(fs.readFileSync(outputPath, "utf8")).toBe(lines.join("\n"));
  });
});

describeEmbeddedPostgres("runDatabaseBackup", () => {
  it(
    "backs up and restores large table payloads without materializing one giant string",
    async () => {
      const sourceConnectionString = await createTempDatabase();
      const restoreConnectionString = await createSiblingDatabase(
        sourceConnectionString,
        "paperclip_restore_target",
      );
      const backupDir = createTempDir("paperclip-db-backup-output-");
      const sourceSql = postgres(sourceConnectionString, { max: 1, onnotice: () => {} });
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });

      try {
        await sourceSql.unsafe(`
          CREATE TYPE "public"."backup_test_state" AS ENUM ('pending', 'done');
        `);
        await sourceSql.unsafe(`
          CREATE TABLE "public"."backup_test_records" (
            "id" serial PRIMARY KEY,
            "title" text NOT NULL,
            "payload" text NOT NULL,
            "state" "public"."backup_test_state" NOT NULL,
            "metadata" jsonb,
            "created_at" timestamptz NOT NULL DEFAULT now()
          );
        `);

        const payload = "x".repeat(8192);
        for (let index = 0; index < 160; index += 1) {
          const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index));
          await sourceSql`
            INSERT INTO "public"."backup_test_records" (
              "title",
              "payload",
              "state",
              "metadata",
              "created_at"
            )
            VALUES (
              ${`row-${index}`},
              ${payload},
              ${index % 2 === 0 ? "pending" : "done"}::"public"."backup_test_state",
              ${JSON.stringify({ index, even: index % 2 === 0 })}::jsonb,
              ${createdAt}
            )
          `;
        }

        const result = await runDatabaseBackup({
          connectionString: sourceConnectionString,
          backupDir,
          retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
          filenamePrefix: "paperclip-test",
          backupEngine: "javascript",
        });

        expect(result.backupFile).toMatch(/paperclip-test-.*\.sql\.gz$/);
        expect(result.sizeBytes).toBeGreaterThan(0);
        expect(fs.existsSync(result.backupFile)).toBe(true);

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile: result.backupFile,
        });

        const counts = await restoreSql.unsafe<{ count: number }[]>(`
          SELECT count(*)::int AS count
          FROM "public"."backup_test_records"
        `);
        expect(counts[0]?.count).toBe(160);

        const sampleRows = await restoreSql.unsafe<{
          title: string;
          payload: string;
          state: string;
          metadata: { index: number; even: boolean } | string;
        }[]>(`
          SELECT "title", "payload", "state"::text AS "state", "metadata"
          FROM "public"."backup_test_records"
          WHERE "title" IN ('row-0', 'row-159')
          ORDER BY "title"
        `);
        expect(sampleRows.map((row) => ({
          ...row,
          metadata: typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata,
        }))).toEqual([
          {
            title: "row-0",
            payload,
            state: "pending",
            metadata: { index: 0, even: true },
          },
          {
            title: "row-159",
            payload,
            state: "done",
            metadata: { index: 159, even: false },
          },
        ]);
      } finally {
        await sourceSql.end();
        await restoreSql.end();
      }
    },
    60_000,
  );

  it(
    "restores statements incrementally when backup comments precede the first breakpoint",
    async () => {
      const restoreConnectionString = await createTempDatabase();
      const restoreSql = postgres(restoreConnectionString, { max: 1, onnotice: () => {} });
      const backupDir = createTempDir("paperclip-db-restore-manual-");
      const backupFile = path.join(backupDir, "manual.sql");

      try {
        await fs.promises.writeFile(
          backupFile,
          [
            "-- Paperclip database backup",
            "-- Created: 2026-04-06T00:00:00.000Z",
            "",
            "BEGIN;",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "CREATE TABLE public.restore_stream_test (id integer primary key, payload text not null);",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "INSERT INTO public.restore_stream_test (id, payload)",
            "VALUES (1, 'hello');",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
            "COMMIT;",
            "-- paperclip statement breakpoint 69f6f3f1-42fd-46a6-bf17-d1d85f8f3900",
          ].join("\n"),
          "utf8",
        );

        await runDatabaseRestore({
          connectionString: restoreConnectionString,
          backupFile,
        });

        const rows = await restoreSql.unsafe<{ payload: string }[]>(`
          SELECT payload
          FROM public.restore_stream_test
        `);
        expect(rows).toEqual([{ payload: "hello" }]);
      } finally {
        await restoreSql.end();
      }
    },
    20_000,
  );

  it(
    "never puts the database password in pg_dump argv",
    async () => {
      const connectionString = await createTempDatabase();
      const backupDir = createTempDir("paperclip-db-backup-argv-");
      const harnessDir = createTempDir("paperclip-db-backup-stub-");
      const argvFile = path.join(harnessDir, "argv.txt");
      const pgPasswordFile = path.join(harnessDir, "pgpassword.txt");
      const stub = path.join(harnessDir, "fake-pg-dump.sh");

      // Records exactly what a local user would see in `ps -eo args`, then emits a
      // plausible dump so the gzip pipeline completes.
      fs.writeFileSync(
        stub,
        [
          "#!/bin/sh",
          `: > ${JSON.stringify(argvFile)}`,
          `for arg in "$@"; do printf '%s\\n' "$arg" >> ${JSON.stringify(argvFile)}; done`,
          `printf '%s' "\${PGPASSWORD-}" > ${JSON.stringify(pgPasswordFile)}`,
          'echo "-- stub pg_dump output"',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const sourceUrl = new URL(connectionString);
      const password = decodeURIComponent(sourceUrl.password);
      expect(password).not.toBe("");
      const expectedUrl = new URL(connectionString);
      expectedUrl.password = "";

      const previousPgDumpPath = process.env.PAPERCLIP_PG_DUMP_PATH;
      process.env.PAPERCLIP_PG_DUMP_PATH = stub;
      try {
        await runDatabaseBackup({
          connectionString,
          backupDir,
          retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
          backupEngine: "pg_dump",
        });
      } finally {
        if (previousPgDumpPath === undefined) delete process.env.PAPERCLIP_PG_DUMP_PATH;
        else process.env.PAPERCLIP_PG_DUMP_PATH = previousPgDumpPath;
      }

      const argv = fs.readFileSync(argvFile, "utf8").split("\n").filter((line) => line.length > 0);
      expect(argv).toContain(`--dbname=${expectedUrl.toString()}`);
      for (const arg of argv) {
        expect(arg).not.toContain(`:${password}@`);
        expect(arg).not.toContain(`password=${password}`);
      }
      expect(fs.readFileSync(pgPasswordFile, "utf8")).toBe(password);
    },
    20_000,
  );
});

describe("splitConnectionStringPassword", () => {
  it("moves a URI password out of the connection string", () => {
    const result = splitConnectionStringPassword("postgres://paperclip:s3cr3t@db:5432/paperclip");
    expect(result.password).toBe("s3cr3t");
    expect(result.connectionString).toBe("postgres://paperclip@db:5432/paperclip");
    expect(result.connectionString).not.toContain("s3cr3t");
  });

  it("percent-decodes the password and preserves query parameters", () => {
    const result = splitConnectionStringPassword(
      "postgresql://paperclip:p%40ss%3Aword@db:5432/paperclip?sslmode=disable",
    );
    expect(result.password).toBe("p@ss:word");
    expect(result.connectionString).toBe("postgresql://paperclip@db:5432/paperclip?sslmode=disable");
  });

  it("strips a password passed as a URI query parameter", () => {
    const result = splitConnectionStringPassword("postgres://paperclip@db:5432/paperclip?password=s3cr3t&sslmode=require");
    expect(result.password).toBe("s3cr3t");
    expect(result.connectionString).not.toContain("s3cr3t");
    expect(result.connectionString).toContain("sslmode=require");
  });

  it("strips a password from the keyword form without disturbing other values", () => {
    const result = splitConnectionStringPassword("host=db port=5432 password='s3 cr3t' dbname=paperclip options='-c a  b'");
    expect(result.password).toBe("s3 cr3t");
    expect(result.connectionString).toBe("host=db port=5432 dbname=paperclip options='-c a  b'");
  });

  it("returns passwordless connection strings unchanged", () => {
    for (const input of ["postgres://paperclip@db:5432/paperclip", "host=db dbname=paperclip"]) {
      const result = splitConnectionStringPassword(input);
      expect(result.password).toBeUndefined();
      expect(result.connectionString).toBe(input);
    }
  });
});
