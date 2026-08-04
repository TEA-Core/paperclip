import fs from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { projects } from "./schema/projects.js";

const COLUMN_NAME = "default_execution_policy";

function projectsColumn(name: string) {
  return getTableConfig(projects).columns.find((column) => column.name === name);
}

async function migrationSql(): Promise<string> {
  const dir = new URL("./migrations/", import.meta.url);
  const files = (await fs.promises.readdir(dir)).filter((file) => file.endsWith(".sql"));
  const contents = await Promise.all(
    files.map((file) => fs.promises.readFile(new URL(file, dir), "utf8")),
  );
  return contents.join("\n");
}

describe("projects.defaultExecutionPolicy", () => {
  it("is a nullable jsonb column", () => {
    const column = projectsColumn(COLUMN_NAME);
    expect(column).toBeDefined();
    expect(column?.getSQLType()).toBe("jsonb");
    expect(column?.notNull).toBe(false);
  });

  it("is created by a migration so issue creation can read it", async () => {
    // The issue-create path selects this column to default a missing execution
    // policy; without a migration every create would fail on a missing column.
    const sql = await migrationSql();
    expect(sql).toContain(COLUMN_NAME);
  });
});
