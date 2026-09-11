import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRecoveryActions, issues, summarySlots } from "@paperclipai/db";
import {
  SUMMARY_SLOT_REFRESH_ACTOR_ID,
  createSummarySlotRefreshSweepService,
} from "../services/summary-slot-refresh-sweep.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const SCOPES = [
  { companyId: COMPANY, scopeKind: "workspaces_overview", slotKey: "header", scopeId: null },
] as const;

const mockGenerate = vi.hoisted(() => vi.fn());
vi.mock("../services/summary-slots.js", () => ({
  summarySlotService: () => ({ generate: mockGenerate }),
}));

const mockGetExperimental = vi.hoisted(
  () => vi.fn().mockResolvedValue({ enableSummaries: true }),
);
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({ getExperimental: mockGetExperimental }),
}));

const mockQueueWakeup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: mockQueueWakeup,
}));

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A canned in-flight-or-minted `generate` response. */
function generateResponse(overrides: {
  alreadyGenerating?: boolean;
  generatingIssueId?: string;
  assigneeAgentId?: string | null;
  status?: string;
} = {}) {
  return {
    slot: { id: "slot-1", companyId: COMPANY, scopeKind: "workspaces_overview", scopeId: null, slotKey: "header", status: "generating" },
    generatingIssue: {
      id: overrides.generatingIssueId ?? "issue-1",
      identifier: "SUP-9999",
      title: "Summarize workspaces overview",
      status: overrides.status ?? "todo",
      assigneeAgentId: overrides.assigneeAgentId === undefined ? "summarizer-agent" : overrides.assigneeAgentId,
    },
    alreadyGenerating: overrides.alreadyGenerating ?? false,
  };
}

/** Builds a fake drizzle db whose discovery `select()` dispatches by table and whose `update()` applies a no-op patch. */
function makeDb(
  slotRows: Array<Record<string, unknown>>,
  opts: {
    issueRows?: Array<Record<string, unknown>>;
    recoveryRows?: Array<Record<string, unknown>>;
  } = {},
) {
  const issueRows = opts.issueRows ?? [];
  const recoveryRows = opts.recoveryRows ?? [];
  return {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: async () => {
          if (table === summarySlots) return slotRows;
          if (table === issues) return issueRows;
          if (table === issueRecoveryActions) return recoveryRows;
          return [];
        },
      }),
    })),
    update: vi.fn(() => ({
      set: () => ({
        where: async () => [],
      }),
    })),
  };
}

/** Wires the sweep service over a fake db. */
function makeService(
  rows: Array<Record<string, unknown>>,
  opts: {
    sweepIntervalMs?: number;
    now?: () => Date;
    wakeup?: () => Promise<unknown>;
    issueRows?: Array<Record<string, unknown>>;
    recoveryRows?: Array<Record<string, unknown>>;
    wedgedMs?: number;
  } = {},
) {
  const db = makeDb(rows, { issueRows: opts.issueRows, recoveryRows: opts.recoveryRows });
  const service = createSummarySlotRefreshSweepService(db as never, {
    now: opts.now ?? (() => new Date("2026-09-10T00:00:00Z")),
    sweepIntervalMs: opts.sweepIntervalMs ?? 0,
    wakeup: opts.wakeup,
    wedgedMs: opts.wedgedMs,
  });
  return { db, service };
}

beforeEach(() => {
  mockGenerate.mockReset();
  mockQueueWakeup.mockReset().mockResolvedValue(undefined);
  mockLogActivity.mockReset().mockResolvedValue({});
  mockGetExperimental.mockReset().mockResolvedValue({ enableSummaries: true });
});

describe("createSummarySlotRefreshSweepService", () => {
  it("uses the documented actor id", () => {
    expect(SUMMARY_SLOT_REFRESH_ACTOR_ID).toBe("system:summary-slot-refresh");
  });

  it("claims a fresh generation task for a stale/failed slot and wakes the Summarizer (AC-1, AC-4)", async () => {
    const rows = [
      { ...SCOPES[0], status: "idle", lastGeneratedAt: new Date("2026-08-01T00:00:00Z") },
      { ...SCOPES[0], status: "failed" },
    ];
    mockGenerate.mockResolvedValue(generateResponse());
    const { db, service } = makeService(rows, { wakeup: vi.fn().mockResolvedValue(undefined) });

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      summariesEnabled: true,
      candidates: 2,
      claimed: 2,
      inFlight: 0,
      failed: 0,
    });

    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(mockGenerate.mock.calls[0]![0]).toEqual({
      companyId: COMPANY,
      scopeKind: "workspaces_overview",
      slotKey: "header",
      scopeId: null,
    });
    expect(mockGenerate.mock.calls[0]![1]).toEqual({ agentId: null, userId: null, runId: null });
    // Every fresh claim fires the same assignment wake the HTTP route fires.
    expect(mockQueueWakeup).toHaveBeenCalledTimes(2);
    expect(mockQueueWakeup).toHaveBeenCalledWith(expect.objectContaining({
      reason: "summary_slot_generation_requested",
      mutation: "summary_slot.generate",
      contextSource: "summary-slot-refresh-sweep",
      requestedByActorType: "system",
      rethrowOnError: true,
      issue: expect.objectContaining({ id: "issue-1" }),
    }));
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("is a settings no-op when summaries are disabled (AC-2)", async () => {
    mockGetExperimental.mockResolvedValue({ enableSummaries: false });
    const rows = [{ ...SCOPES[0], status: "idle", lastGeneratedAt: null }];
    const { db, service } = makeService(rows, { wakeup: vi.fn() });

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      summariesEnabled: false,
      candidates: 0,
      claimed: 0,
      inFlight: 0,
      failed: 0,
    });
    // Discovery never runs when the feature flag is off.
    expect(db.select).not.toHaveBeenCalled();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockQueueWakeup).not.toHaveBeenCalled();
  });

  it("does not re-fire generate for an in-flight slot, but re-delivers its assignee wake (AC-3)", async () => {
    const rows = [{ ...SCOPES[0], status: "generating", generatingIssueId: "issue-live" }];
    mockGenerate.mockResolvedValue(generateResponse({ alreadyGenerating: true }));
    const { service } = makeService(rows, { wakeup: vi.fn() });

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      summariesEnabled: true,
      candidates: 1,
      claimed: 0,
      inFlight: 1,
      failed: 0,
    });
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    // The slot already has a live generation issue, so `generate` is not
    // re-fired to mint a second one (AC-3). But the assignee wake IS re-delivered
    // so a wake that was rejected on the minting tick is retried instead of
    // stranding the slot unwoken. No fresh-claim audit entry is recorded for an
    // in-flight slot (the entry was written on the tick that minted the issue).
    expect(mockQueueWakeup).toHaveBeenCalledTimes(1);
    expect(mockQueueWakeup).toHaveBeenCalledWith(
      expect.objectContaining({
        rethrowOnError: true,
        issue: expect.objectContaining({ id: "issue-1" }),
      }),
    );
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("retries a stranded slot: a rejected mint-tick wake is re-delivered on the next sweep instead of stranding it", async () => {
    const rows = [{ ...SCOPES[0], status: "idle", lastGeneratedAt: null }];
    // Sweep 1 mints a fresh issue but its assignee wake is rejected (rethrows),
    // so the claim counts a failure. Sweep 2 sees the slot already generating
    // and re-delivers the wake successfully.
    mockGenerate
      .mockResolvedValueOnce(generateResponse({ alreadyGenerating: false }))
      .mockResolvedValueOnce(generateResponse({ alreadyGenerating: true }));
    mockQueueWakeup
      .mockRejectedValueOnce(new Error("dispatcher unavailable"))
      .mockResolvedValueOnce(undefined);
    const { service } = makeService(rows, { wakeup: vi.fn() });

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      summariesEnabled: true,
      candidates: 1,
      claimed: 0,
      inFlight: 0,
      failed: 1,
    });
    await expect(service.sweep()).resolves.toEqual({
      due: true,
      summariesEnabled: true,
      candidates: 1,
      claimed: 0,
      inFlight: 1,
      failed: 0,
    });
    // `generate` ran on both due sweeps but never minted a second issue; the
    // wake was delivered twice (once per due sweep), so the slot is not left
    // unwoken.
    expect(mockGenerate).toHaveBeenCalledTimes(2);
    expect(mockQueueWakeup).toHaveBeenCalledTimes(2);
  });

  it("counts a rejected in-flight re-wake as failed, not in-flight, so the slot is retried", async () => {
    const rows = [{ ...SCOPES[0], status: "generating", generatingIssueId: "issue-live" }];
    mockGenerate.mockResolvedValue(generateResponse({ alreadyGenerating: true }));
    mockQueueWakeup.mockRejectedValueOnce(new Error("dispatcher unavailable"));
    const { service } = makeService(rows, { wakeup: vi.fn() });

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      summariesEnabled: true,
      candidates: 1,
      claimed: 0,
      inFlight: 0,
      failed: 1,
    });
  });

  it("re-claims a `generating` slot pinned behind a `blocked` issue with an escalated recovery action (AC-4)", async () => {
    const rows = [
      { ...SCOPES[0], status: "generating", generatingIssueId: "issue-wedged", updatedAt: new Date("2026-09-09T23:00:00Z") },
    ];
    // The stale link is cleared first, so `generate` mints a fresh issue
    // instead of short-circuiting to `alreadyGenerating`.
    mockGenerate.mockResolvedValue(generateResponse({ alreadyGenerating: false, generatingIssueId: "issue-fresh" }));
    const { db, service } = makeService(rows, {
      wakeup: vi.fn(),
      issueRows: [{ status: "blocked" }],
      recoveryRows: [{ id: "ra-1", status: "escalated", sourceIssueId: "issue-wedged" }],
      wedgedMs: 6 * 60 * 60 * 1000,
    });

    // Counted in `claimed`, not `inFlight`.
    await expect(service.sweep()).resolves.toEqual({
      due: true,
      summariesEnabled: true,
      candidates: 1,
      claimed: 1,
      inFlight: 0,
      failed: 0,
    });
    // The stale `generating` link was cleared so `generate` re-mints the slot.
    expect(db.update).toHaveBeenCalledTimes(1);
    // The re-claim is logged and flagged as a wedged recovery — no longer log-invisible.
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: "summary_slot.generate_requested",
        details: expect.objectContaining({
          alreadyGenerating: false,
          source: "summary-slot-refresh-sweep",
          wedgedRecovery: true,
          wedgedReason: "blocked_escalated_recovery",
          supersededGenerationIssueId: "issue-wedged",
        }),
      }),
    );
  });

  it("leaves a `generating` slot in-flight behind a recently-updated `in_review` issue (AC-5, no thrash)", async () => {
    const rows = [
      { ...SCOPES[0], status: "generating", generatingIssueId: "issue-live", updatedAt: new Date("2026-09-09T23:30:00Z") },
    ];
    mockGenerate.mockResolvedValue(generateResponse({ alreadyGenerating: true }));
    const { db, service } = makeService(rows, {
      wakeup: vi.fn(),
      issueRows: [{ status: "in_review" }],
      recoveryRows: [],
      wedgedMs: 6 * 60 * 60 * 1000,
    });

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      summariesEnabled: true,
      candidates: 1,
      claimed: 0,
      inFlight: 1,
      failed: 0,
    });
    // Not wedged: no stale-link clear and no re-claim audit entry.
    expect(db.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
    // The assignee wake is still re-delivered for the live in-flight issue.
    expect(mockQueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("re-claims a `generating` slot that has aged past the wedged window even without a blocked/escalated issue (age backstop)", async () => {
    const rows = [
      { ...SCOPES[0], status: "generating", generatingIssueId: "issue-stale", updatedAt: new Date("2026-09-08T00:00:00Z") },
    ];
    mockGenerate.mockResolvedValue(generateResponse({ alreadyGenerating: false, generatingIssueId: "issue-fresh" }));
    const { db, service } = makeService(rows, {
      wakeup: vi.fn(),
      issueRows: [{ status: "in_progress" }],
      recoveryRows: [],
      wedgedMs: 6 * 60 * 60 * 1000,
    });

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      summariesEnabled: true,
      candidates: 1,
      claimed: 1,
      inFlight: 0,
      failed: 0,
    });
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        details: expect.objectContaining({
          wedgedRecovery: true,
          wedgedReason: "generating_age_exceeded",
          supersededGenerationIssueId: "issue-stale",
        }),
      }),
    );
  });

  it("records a route-equivalent summary_slot.generate_requested activity entry on a fresh claim", async () => {
    const rows = [{ ...SCOPES[0], status: "idle", lastGeneratedAt: null }];
    mockGenerate.mockResolvedValue(generateResponse({ alreadyGenerating: false }));
    const { service, db } = makeService(rows, { wakeup: vi.fn() });

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      summariesEnabled: true,
      candidates: 1,
      claimed: 1,
      inFlight: 0,
      failed: 0,
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(db, {
      companyId: COMPANY,
      actorType: "system",
      actorId: SUMMARY_SLOT_REFRESH_ACTOR_ID,
      action: "summary_slot.generate_requested",
      entityType: "summary_slot",
      entityId: "slot-1",
      issueId: "issue-1",
      details: {
        scopeKind: "workspaces_overview",
        scopeId: null,
        slotKey: "header",
        generatingIssueId: "issue-1",
        alreadyGenerating: false,
        source: "summary-slot-refresh-sweep",
      },
    });
  });

  it("counts a failed generate and does not wake (retry next sweep)", async () => {
    const rows = [{ ...SCOPES[0], status: "failed" }];
    mockGenerate.mockRejectedValue(new Error("Summarizer built-in agent is not configured"));
    const { service } = makeService(rows, { wakeup: vi.fn() });

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      summariesEnabled: true,
      candidates: 1,
      claimed: 0,
      inFlight: 0,
      failed: 1,
    });
    expect(mockQueueWakeup).not.toHaveBeenCalled();
  });

  it("counts a rejected wakeup as failed rather than claimed (regression: swallowed-wakeup)", async () => {
    const rows = [{ ...SCOPES[0], status: "idle", lastGeneratedAt: null }];
    mockGenerate.mockResolvedValue(generateResponse());
    // Simulates a heartbeat.wakeup rejection that rethrowOnError: true surfaces
    // out of queueIssueAssignmentWakeup (it would otherwise log-and-resolve).
    mockQueueWakeup.mockRejectedValue(new Error("heartbeat wakeup rejected"));
    const { service } = makeService(rows, { wakeup: vi.fn() });

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      summariesEnabled: true,
      candidates: 1,
      claimed: 0,
      inFlight: 0,
      failed: 1,
    });
    // The wake must be asked to rethrow so a reject is surfaced, mirroring the
    // HTTP route — and the slot is not miscounted as a successful claim.
    expect(mockQueueWakeup).toHaveBeenCalledWith(
      expect.objectContaining({ rethrowOnError: true }),
    );
    expect(mockQueueWakeup).toHaveBeenCalledTimes(1);
  });

  it("skips the wake when no wakeup dispatcher is injected but still claims", async () => {
    const rows = [{ ...SCOPES[0], status: "idle", lastGeneratedAt: null }];
    mockGenerate.mockResolvedValue(generateResponse());
    const { service } = makeService(rows);

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      summariesEnabled: true,
      candidates: 1,
      claimed: 1,
      inFlight: 0,
      failed: 0,
    });
    expect(mockQueueWakeup).not.toHaveBeenCalled();
  });

  it("performs no work when no candidate slot is selected", async () => {
    const { db, service } = makeService([], { wakeup: vi.fn() });

    await expect(service.sweep()).resolves.toEqual({
      due: true,
      summariesEnabled: true,
      candidates: 0,
      claimed: 0,
      inFlight: 0,
      failed: 0,
    });
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockQueueWakeup).not.toHaveBeenCalled();
  });

  it("keeps every non-due tick a no-op behind the min-interval gate (AC-5)", async () => {
    let clock = new Date("2026-09-10T00:00:00Z").getTime();
    const rows = [{ ...SCOPES[0], status: "failed" }];
    mockGenerate.mockResolvedValue(generateResponse());
    const { db, service } = makeService(rows, {
      sweepIntervalMs: 60 * 60 * 1000,
      now: () => new Date(clock),
      wakeup: vi.fn(),
    });

    await expect(service.sweep()).resolves.toMatchObject({ due: true, claimed: 1 });
    const selectsAfterFirst = db.select.mock.calls.length;

    clock += 30 * 1000;
    await expect(service.sweep()).resolves.toEqual({
      due: false,
      summariesEnabled: false,
      candidates: 0,
      claimed: 0,
      inFlight: 0,
      failed: 0,
    });
    expect(db.select.mock.calls.length).toBe(selectsAfterFirst);
    expect(mockGenerate).toHaveBeenCalledTimes(1);

    clock += 61 * 60 * 1000;
    await expect(service.sweep()).resolves.toMatchObject({ due: true, claimed: 1 });
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });
});
