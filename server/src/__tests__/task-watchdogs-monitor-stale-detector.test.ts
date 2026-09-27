import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  detectFiredNeverRearmedMonitor,
  taskWatchdogService,
  type TaskWatchdogMonitorStaleIssue,
} from "../services/task-watchdogs.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres monitor-stale detector tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE_ID = "33333333-3333-4333-8333-333333333333";
const FIRED_AT = new Date("2026-09-27T00:52:45.000Z");

function staleMonitorIssue(overrides: Partial<TaskWatchdogMonitorStaleIssue> = {}): TaskWatchdogMonitorStaleIssue {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    identifier: "WD-1",
    title: "Watched issue",
    status: "in_progress",
    assigneeAgentId: AGENT_ID,
    assigneeUserId: null,
    monitorLastTriggeredAt: FIRED_AT,
    monitorNextCheckAt: null,
    monitorAttemptCount: 1,
    ...overrides,
  };
}

describe("detectFiredNeverRearmedMonitor", () => {
  it("detects a monitor that fired and was never re-armed, identifying the owning issue", () => {
    const detection = detectFiredNeverRearmedMonitor(staleMonitorIssue());
    expect(detection).not.toBeNull();
    expect(detection!.issueId).toBe(ISSUE_ID);
    expect(detection!.identifier).toBe("WD-1");
    expect(detection!.title).toBe("Watched issue");
    expect(detection!.status).toBe("in_progress");
    expect(detection!.assigneeAgentId).toBe(AGENT_ID);
    expect(detection!.monitorLastTriggeredAt).toBe(FIRED_AT.toISOString());
    expect(detection!.monitorLastTriggeredAtMs).toBe(FIRED_AT.getTime());
    expect(detection!.monitorAttemptCount).toBe(1);
    expect(detection!.fingerprint).toMatch(/^task_watchdog_monitor_stale:[0-9a-f]{64}$/);
  });

  it("does not report a monitor that was re-armed after firing", () => {
    const detection = detectFiredNeverRearmedMonitor(
      staleMonitorIssue({ monitorNextCheckAt: new Date("2026-09-27T02:00:00.000Z") }),
    );
    expect(detection).toBeNull();
  });

  it("does not report a monitor that has never fired", () => {
    const detection = detectFiredNeverRearmedMonitor(
      staleMonitorIssue({
        monitorLastTriggeredAt: null,
        monitorNextCheckAt: new Date("2026-09-27T02:00:00.000Z"),
      }),
    );
    expect(detection).toBeNull();
  });

  it("does not report a monitor cleared when the issue left a monitor-armed state", () => {
    expect(detectFiredNeverRearmedMonitor(staleMonitorIssue({ status: "done" }))).toBeNull();
    expect(detectFiredNeverRearmedMonitor(staleMonitorIssue({ status: "cancelled" }))).toBeNull();
    expect(detectFiredNeverRearmedMonitor(staleMonitorIssue({ status: "todo" }))).toBeNull();
    expect(detectFiredNeverRearmedMonitor(staleMonitorIssue({ status: "backlog" }))).toBeNull();
  });

  it("does not report monitors on user-assigned or unassigned issues", () => {
    expect(detectFiredNeverRearmedMonitor(staleMonitorIssue({ assigneeUserId: "user-1" }))).toBeNull();
    expect(detectFiredNeverRearmedMonitor(staleMonitorIssue({ assigneeAgentId: null }))).toBeNull();
  });

  it("emits a stable fingerprint across re-evaluations of the same firing event", () => {
    const first = detectFiredNeverRearmedMonitor(staleMonitorIssue());
    const second = detectFiredNeverRearmedMonitor(staleMonitorIssue());
    expect(first!.fingerprint).toBe(second!.fingerprint);
  });

  it("moves the fingerprint when the monitor fires again", () => {
    const first = detectFiredNeverRearmedMonitor(staleMonitorIssue());
    const second = detectFiredNeverRearmedMonitor(
      staleMonitorIssue({
        monitorLastTriggeredAt: new Date("2026-09-27T05:00:00.000Z"),
        monitorAttemptCount: 2,
      }),
    );
    expect(second!.fingerprint).not.toBe(first!.fingerprint);
    expect(second!.fingerprint).toMatch(/^task_watchdog_monitor_stale:[0-9a-f]{64}$/);
  });
});

describeEmbeddedPostgres("detectStaleIssueMonitors", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-task-watchdogs-monitor-stale-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Watchdog Co",
      issuePrefix: `WD${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      issueCounter: 0,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: "Watchdog Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedIssue(companyId: string, overrides: Partial<typeof issues.$inferInsert> = {}) {
    const id = overrides.id ?? randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: overrides.title ?? "Watched issue",
      status: overrides.status ?? "in_progress",
      priority: overrides.priority ?? "medium",
      identifier: overrides.identifier ?? `WDOG-${Math.floor(Math.random() * 10_000)}`,
      issueNumber: overrides.issueNumber ?? Math.floor(Math.random() * 10_000),
      parentId: overrides.parentId,
      assigneeAgentId: overrides.assigneeAgentId,
      monitorLastTriggeredAt: overrides.monitorLastTriggeredAt,
      monitorNextCheckAt: overrides.monitorNextCheckAt,
      monitorAttemptCount: overrides.monitorAttemptCount,
      createdAt: overrides.createdAt ?? new Date(Date.now() - 60 * 60 * 1000),
    });
    return id;
  }

  it("reports a fired monitor that was never re-armed and identifies the owning issue", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedIssue(companyId, {
      status: "in_progress",
      assigneeAgentId: agentId,
      monitorLastTriggeredAt: FIRED_AT,
      monitorAttemptCount: 1,
    });

    const service = taskWatchdogService(db);
    const result = await service.detectStaleIssueMonitors({ companyId });

    expect(result.checked).toBe(1);
    expect(result.detected).toBe(1);
    expect(result.reported).toBe(1);
    expect(result.detections).toHaveLength(1);
    const detection = result.detections[0];
    expect(detection.issueId).toBe(issueId);
    expect(detection.assigneeAgentId).toBe(agentId);
    expect(detection.fingerprint).toMatch(/^task_watchdog_monitor_stale:[0-9a-f]{64}$/);

    const [activity] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(activity).toBeDefined();
    expect(activity.action).toBe("issue.task_watchdog_monitor_stale_detected");
    expect(activity.entityType).toBe("issue");
    expect((activity.details as Record<string, unknown>).fingerprint).toBe(detection.fingerprint);
    expect((activity.details as Record<string, unknown>).issueIdentifier).toBe(
      (await db.select().from(issues).where(eq(issues.id, issueId)))[0].identifier,
    );
  });

  it("does not accumulate repeated reports for the same stale monitor", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await seedIssue(companyId, {
      status: "in_progress",
      assigneeAgentId: agentId,
      monitorLastTriggeredAt: FIRED_AT,
      monitorAttemptCount: 1,
    });

    const service = taskWatchdogService(db);
    const first = await service.detectStaleIssueMonitors({ companyId });
    expect(first.reported).toBe(1);

    const second = await service.detectStaleIssueMonitors({ companyId });
    expect(second.checked).toBe(1);
    expect(second.detected).toBe(1);
    expect(second.reported).toBe(0);
  });

  it("does not report a monitor that was re-armed after firing", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await seedIssue(companyId, {
      status: "in_progress",
      assigneeAgentId: agentId,
      monitorLastTriggeredAt: FIRED_AT,
      monitorNextCheckAt: new Date("2026-09-27T02:00:00.000Z"),
      monitorAttemptCount: 1,
    });

    const service = taskWatchdogService(db);
    const result = await service.detectStaleIssueMonitors({ companyId });
    // The SQL prefilter (flat next-check time) excludes re-armed monitors
    // before the detector even sees them.
    expect(result.checked).toBe(0);
    expect(result.detected).toBe(0);
    expect(result.reported).toBe(0);
  });

  it("does not report a monitor cleared when the issue completed", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    await seedIssue(companyId, {
      status: "done",
      assigneeAgentId: agentId,
      monitorLastTriggeredAt: FIRED_AT,
      monitorAttemptCount: 1,
    });

    const service = taskWatchdogService(db);
    const result = await service.detectStaleIssueMonitors({ companyId });
    expect(result.checked).toBe(0);
    expect(result.detected).toBe(0);
    expect(result.reported).toBe(0);
  });

  it("skips issues created before the worktree execution cutoff", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const oldIssueId = await seedIssue(companyId, {
      status: "in_progress",
      assigneeAgentId: agentId,
      monitorLastTriggeredAt: FIRED_AT,
      monitorAttemptCount: 1,
      createdAt: new Date("2026-09-20T00:00:00.000Z"),
    });
    await seedIssue(companyId, {
      status: "in_progress",
      assigneeAgentId: agentId,
      monitorLastTriggeredAt: FIRED_AT,
      monitorAttemptCount: 1,
      createdAt: new Date("2026-09-26T00:00:00.000Z"),
    });

    const service = taskWatchdogService(db);
    const result = await service.detectStaleIssueMonitors({
      companyId,
      issueCreatedAtGte: new Date("2026-09-25T00:00:00.000Z"),
    });

    expect(result.checked).toBe(1);
    expect(result.detected).toBe(1);
    expect(result.reported).toBe(1);
    expect(result.detections[0].issueId).not.toBe(oldIssueId);
  });
});
