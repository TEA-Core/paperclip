import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import { issueService } from "../services/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function generationDescription(generationIssueId: string) {
  return [
    "Generate the workspaces overview summary.",
    "",
    "```json",
    JSON.stringify(
      { scopeKind: "workspaces_overview", scopeId: null, slotKey: "header", generationIssueId },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

describeEmbeddedPostgres("issue update: summary generation tasks cannot be reopened (SUP-20900)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("summary-generation-reopen-guard-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Reopen guard",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(status: "done" | "cancelled" | "in_progress", description: string | null) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Task",
      status,
      description: description ?? undefined,
    });
    return id;
  }

  it.each(["done", "cancelled"] as const)(
    "rejects reopening a %s token-bearing generation task with a 409",
    async (status) => {
      const id = randomUUID();
      await db.insert(issues).values({
        id,
        companyId,
        title: "Generate summary",
        status,
        description: generationDescription(id),
      });

      await expect(issueService(db).update(id, { status: "in_progress" })).rejects.toMatchObject({
        status: 409,
        details: { code: "summary_generation_reopen_forbidden" },
      });
      await expect(issueService(db).update(id, { status: "todo" })).rejects.toMatchObject({ status: 409 });
    },
  );

  it("still lets a token-bearing generation task close", async () => {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Generate summary",
      status: "in_progress",
      description: generationDescription(id),
    });

    const updated = await issueService(db).update(id, { status: "done" });

    expect(updated?.status).toBe("done");
  });

  it("allows reopening an ordinary terminal issue, including one with an unrelated json block", async () => {
    const plain = await seedIssue("done", "Fix the thing.");
    const withJson = await seedIssue("cancelled", "Config:\n\n```json\n{\"a\":1}\n```");

    await expect(issueService(db).update(plain, { status: "todo" })).resolves.toMatchObject({ status: "todo" });
    await expect(issueService(db).update(withJson, { status: "todo" })).resolves.toMatchObject({ status: "todo" });
  });
});
