import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, summarySlots } from "@paperclipai/db";
import { createSummarySlotRefreshSweepService } from "../services/summary-slot-refresh-sweep.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockGenerate = vi.hoisted(() => vi.fn());
vi.mock("../services/summary-slots.js", () => ({
  summarySlotService: () => ({ generate: mockGenerate }),
}));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getExperimental: vi.fn().mockResolvedValue({ enableSummaries: true }),
  }),
}));
vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn().mockResolvedValue({}),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const HOUR_MS = 60 * 60 * 1000;

describeEmbeddedPostgres("summary slot refresh sweep: per-class staleness (SUP-20900)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  const now = new Date("2026-10-23T12:00:00Z");

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("summary-slot-stale-class-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Stale class",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIdleSlot(scopeKind: "workspaces_overview" | "project", ageHours: number) {
    await db.insert(summarySlots).values({
      companyId,
      scopeKind,
      scopeId: scopeKind === "project" ? randomUUID() : null,
      slotKey: "header",
      status: "idle",
      lastGeneratedAt: new Date(now.getTime() - ageHours * HOUR_MS),
    });
  }

  it("refreshes a 13h-old overview slot but leaves a 13h-old project slot until 24h", async () => {
    await seedIdleSlot("workspaces_overview", 13);
    await seedIdleSlot("project", 13);
    mockGenerate.mockResolvedValue({
      slot: { status: "generating" },
      generatingIssue: { id: "issue-1", status: "todo", assigneeAgentId: null },
      alreadyGenerating: false,
    });
    const service = createSummarySlotRefreshSweepService(db, { now: () => now, sweepIntervalMs: 0 });

    const result = await service.sweep();

    expect(result.candidates).toBe(1);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(mockGenerate.mock.calls[0]![0]).toMatchObject({ scopeKind: "workspaces_overview" });
  });

  it("still refreshes a project slot older than 24h and skips an overview slot under 12h", async () => {
    await db.delete(summarySlots);
    mockGenerate.mockClear();
    await seedIdleSlot("workspaces_overview", 11);
    await seedIdleSlot("project", 25);
    const service = createSummarySlotRefreshSweepService(db, { now: () => now, sweepIntervalMs: 0 });

    const result = await service.sweep();

    expect(result.candidates).toBe(1);
    expect(mockGenerate.mock.calls[0]![0]).toMatchObject({ scopeKind: "project" });
  });
});
