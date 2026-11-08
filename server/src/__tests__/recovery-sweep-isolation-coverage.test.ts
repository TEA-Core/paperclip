import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issueRelations,
  issues,
  issueWatchdogs,
  pluginManagedResources,
  plugins,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { RECOVERY_SWEEP_NAMES, type RecoverySweepName } from "../lib/recovery-sweep-isolation.js";
import { logger } from "../middleware/logger.js";
import { recoveryService } from "../services/recovery/service.js";
import { sweepHostRestartStrandedIssues } from "../services/recovery/host-restart-strand-sweep.js";
import { taskWatchdogService } from "../services/task-watchdogs.js";

const REFUSE_TITLE = "REFUSE_WRITE";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type Seed = { companyId: string; agentId: string; prefix: string };

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping recovery sweep isolation coverage on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery sweep isolation table", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-sweep-isolation-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql.raw(`
      create or replace function fm_refuse_recovery_write() returns trigger as $$
      begin
        if tg_table_name = 'issues' then
          if new.title = 'REFUSE_WRITE' then
            raise exception 'injected non-connection recovery write failure';
          end if;
        elsif tg_table_name = 'issue_comments' then
          if exists (select 1 from issues where id = new.issue_id and title = 'REFUSE_WRITE') then
            raise exception 'injected non-connection recovery write failure';
          end if;
        elsif tg_table_name = 'issue_recovery_actions' then
          if exists (select 1 from issues where id = new.source_issue_id and title = 'REFUSE_WRITE') then
            raise exception 'injected non-connection recovery write failure';
          end if;
        elsif tg_table_name = 'issue_watchdogs' then
          if exists (select 1 from issues where id = new.issue_id and title = 'REFUSE_WRITE') then
            raise exception 'injected non-connection recovery write failure';
          end if;
        elsif tg_table_name = 'agent_wakeup_requests' then
          if exists (
            select 1 from issues
            where title = 'REFUSE_WRITE'
              and new.payload::text like '%' || id::text || '%'
          ) then
            raise exception 'injected non-connection recovery write failure';
          end if;
        end if;
        return new;
      end
      $$ language plpgsql
    `));
    await db.execute(sql`drop trigger if exists fm_refuse_issues on issues`);
    await db.execute(sql`create trigger fm_refuse_issues before update on issues for each row execute function fm_refuse_recovery_write()`);
    await db.execute(sql`drop trigger if exists fm_refuse_comments on issue_comments`);
    await db.execute(sql`create trigger fm_refuse_comments before insert on issue_comments for each row execute function fm_refuse_recovery_write()`);
    await db.execute(sql`drop trigger if exists fm_refuse_actions on issue_recovery_actions`);
    await db.execute(sql`create trigger fm_refuse_actions before insert or update on issue_recovery_actions for each row execute function fm_refuse_recovery_write()`);
    await db.execute(sql`drop trigger if exists fm_refuse_watchdogs on issue_watchdogs`);
    await db.execute(sql`create trigger fm_refuse_watchdogs before update on issue_watchdogs for each row execute function fm_refuse_recovery_write()`);
    await db.execute(sql`drop trigger if exists fm_refuse_wakeups on agent_wakeup_requests`);
    await db.execute(sql`create trigger fm_refuse_wakeups before insert on agent_wakeup_requests for each row execute function fm_refuse_recovery_write()`);
    await db.execute(sql`drop trigger if exists fm_refuse_activity on activity_log`);
    await db.execute(sql`create trigger fm_refuse_activity before insert on activity_log for each row execute function fm_refuse_recovery_write()`);
  }, 30_000);

  afterAll(async () => {
    if (db) {
      await db.execute(sql`drop trigger if exists fm_refuse_issues on issues`);
      await db.execute(sql`drop trigger if exists fm_refuse_comments on issue_comments`);
      await db.execute(sql`drop trigger if exists fm_refuse_actions on issue_recovery_actions`);
      await db.execute(sql`drop trigger if exists fm_refuse_watchdogs on issue_watchdogs`);
      await db.execute(sql`drop trigger if exists fm_refuse_wakeups on agent_wakeup_requests`);
      await db.execute(sql`drop trigger if exists fm_refuse_activity on activity_log`);
      await db.execute(sql`drop function if exists fm_refuse_recovery_write()`);
    }
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.execute(sql`alter table issues disable trigger fm_refuse_issues`);
    await db.execute(sql`alter table issue_comments disable trigger fm_refuse_comments`);
    await db.execute(sql`alter table issue_recovery_actions disable trigger fm_refuse_actions`);
    await db.execute(sql`alter table issue_watchdogs disable trigger fm_refuse_watchdogs`);
    await db.execute(sql`alter table agent_wakeup_requests disable trigger fm_refuse_wakeups`);
    await db.execute(sql`alter table activity_log disable trigger fm_refuse_activity`);
    await db.delete(issueWatchdogs);
    await db.delete(issueRecoveryActions);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(pluginManagedResources);
    await db.delete(agents);
    await db.delete(plugins);
    await db.delete(companies);
    await db.execute(sql`alter table issues enable trigger fm_refuse_issues`);
    await db.execute(sql`alter table issue_comments enable trigger fm_refuse_comments`);
    await db.execute(sql`alter table issue_recovery_actions enable trigger fm_refuse_actions`);
    await db.execute(sql`alter table issue_watchdogs enable trigger fm_refuse_watchdogs`);
    await db.execute(sql`alter table agent_wakeup_requests enable trigger fm_refuse_wakeups`);
    await db.execute(sql`alter table activity_log enable trigger fm_refuse_activity`);
  });

  async function seedCompany(): Promise<Seed> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const prefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId, prefix };
  }

  async function insertIssue(input: {
    companyId: string;
    agentId?: string | null;
    title: string;
    status: string;
    issueNumber: number;
    prefix: string;
    extra?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      title: input.title,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.agentId === undefined ? null : input.agentId,
      issueNumber: input.issueNumber,
      identifier: `${input.prefix}-${input.issueNumber}`,
      ...(input.extra ?? {}),
    });
    return id;
  }

  function recovery(enqueue?: (issueId: string) => Promise<unknown>) {
    return recoveryService(db, {
      enqueueWakeup: vi.fn(async (_agentId: string, wakeup?: { payload?: Record<string, unknown> | null }) => {
        const issueId = typeof wakeup?.payload?.issueId === "string" ? wakeup.payload.issueId : undefined;
        if (issueId && enqueue) return enqueue(issueId);
        if (issueId) {
          const row = await db.select({ title: issues.title }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
          if (row?.title === REFUSE_TITLE) {
            throw new Error("injected non-connection recovery write failure");
          }
        }
        return { id: randomUUID() };
      }) as never,
    });
  }

  async function assertSkipped(sweep: RecoverySweepName, failingIssueId: string, run: () => Promise<unknown>) {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    try {
      const result = await run();
      expect(result).toBeDefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.objectContaining({ issueId: failingIssueId, sweep }),
        expect.stringContaining("skipped a card"),
      );
      return result;
    } finally {
      errorSpy.mockRestore();
    }
  }

  async function sweepEffectApplied(sweep: RecoverySweepName, issueId: string, seeded: Seed): Promise<boolean> {
    const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
    switch (sweep) {
      case "recovery.reconcile_stranded_assigned_issues":
      case "recovery.reconcile_stillborn_assigned_backlog":
      case "recovery.reconcile_dispatch_suppression_parks":
      case "recovery.reconcile_todo_stranded_cards":
      case "recovery.host_restart_strand_sweep":
        return issue?.status === "blocked";
      case "recovery.reconcile_unassigned_blocking_issue":
        return issue?.assigneeAgentId === seeded.agentId;
      case "recovery.sweep_stale_issue_locks":
        return issue?.checkoutRunId === null;
      case "recovery.reconcile_exhausted_recovery_drain":
        return issue?.monitorNextCheckAt != null;
      case "recovery.reconcile_blocked_without_blockers":
        return (
          await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))
        ).length > 0;
      case "recovery.reconcile_stale_recovery_action_wakes":
        return (
          await db.select({ attemptCount: issueRecoveryActions.attemptCount }).from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))
        ).some((row) => row.attemptCount > 0);
      case "task_watchdogs.reconcile_task_watchdogs":
        return (
          await db.select({ triggerCount: issueWatchdogs.triggerCount }).from(issueWatchdogs).where(eq(issueWatchdogs.issueId, issueId))
        ).some((row) => row.triggerCount > 0);
      default: {
        const unmapped: never = sweep;
        throw new Error(`no effect check for ${String(unmapped)}`);
      }
    }
  }

  const SWEEP_CASES = RECOVERY_SWEEP_NAMES.flatMap((sweep) => [
    [sweep, true] as const,
    [sweep, false] as const,
  ]);

  it.each(SWEEP_CASES)("skips one injected write failure in %s (failing card first: %s) and still processes the ordinary card", async (sweep, failingFirst) => {
    const seeded = await seedCompany();
    const first = await drive(sweep, seeded, failingFirst ? "Failing card" : "Ordinary card", 1);
    const second = await drive(sweep, seeded, failingFirst ? "Ordinary card" : "Failing card", 2);
    const failing = failingFirst ? first : second;
    const ordinary = failingFirst ? second : first;
    const before = await db.select({ updatedAt: issues.updatedAt }).from(issues).where(eq(issues.id, failing)).then((rows) => rows[0]);
    await db.execute(sql`alter table issues disable trigger fm_refuse_issues`);
    await db.update(issues).set({ title: REFUSE_TITLE, updatedAt: before?.updatedAt ?? new Date(Date.now() - 3 * 60 * 60 * 1000) }).where(eq(issues.id, failing));
    await db.execute(sql`alter table issues enable trigger fm_refuse_issues`);
    const result = await assertSkipped(sweep, failing, () => runSweep(sweep, seeded));
    expect(await sweepEffectApplied(sweep, failing, seeded)).toBe(false);
    expect(await sweepEffectApplied(sweep, ordinary, seeded)).toBe(true);
    if (sweep === "task_watchdogs.reconcile_task_watchdogs") {
      expect(result).toMatchObject({ checked: 2, triggered: 1, skipped: 1 });
    }
  });

  async function drive(sweep: RecoverySweepName, seeded: Seed, title: string, issueNumber: number): Promise<string> {
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const veryOld = new Date(Date.now() - 48 * 60 * 60 * 1000);
    if (sweep === "recovery.reconcile_stranded_assigned_issues") {
      const id = await insertIssue({ ...seeded, agentId: seeded.agentId, title, status: "in_progress", issueNumber });
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        invocationSource: "manual",
        status: "failed",
        error: "model_not_found",
        errorCode: "adapter_failed",
        startedAt: old,
        finishedAt: old,
        contextSnapshot: { issueId: id },
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      });
      return id;
    }
    if (sweep === "recovery.reconcile_unassigned_blocking_issue") {
      const downstreamId = await insertIssue({ ...seeded, title: `down-${issueNumber}`, status: "blocked", issueNumber: 100 + issueNumber });
      const id = await insertIssue({ ...seeded, agentId: null, title, status: "todo", issueNumber, extra: { createdByAgentId: seeded.agentId } });
      await db.insert(issueRelations).values({
        companyId: seeded.companyId,
        issueId: id,
        relatedIssueId: downstreamId,
        type: "blocks",
      });
      return id;
    }
    if (sweep === "recovery.reconcile_stillborn_assigned_backlog") {
      return insertIssue({
        ...seeded,
        agentId: seeded.agentId,
        title,
        status: "backlog",
        issueNumber,
        extra: { createdAt: new Date(Date.now() - 120_000) },
      });
    }
    if (sweep === "recovery.sweep_stale_issue_locks") {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        invocationSource: "manual",
        status: "failed",
        startedAt: old,
        finishedAt: old,
      });
      return insertIssue({
        ...seeded,
        agentId: seeded.agentId,
        title,
        status: "in_progress",
        issueNumber,
        extra: { checkoutRunId: runId },
      });
    }
    if (sweep === "recovery.reconcile_exhausted_recovery_drain") {
      const id = await insertIssue({ ...seeded, agentId: seeded.agentId, title, status: "in_review", issueNumber });
      await db.insert(issueRecoveryActions).values({
        id: randomUUID(),
        companyId: seeded.companyId,
        sourceIssueId: id,
        kind: "workspace_validation",
        status: "escalated",
        ownerType: "board",
        previousOwnerAgentId: seeded.agentId,
        cause: "workspace_validation_failed",
        fingerprint: `workspace:provision:failure:${id}`,
        attemptCount: 5,
        maxAttempts: 5,
        nextAction: "Repair the worktree provisioning failure.",
        outcome: "exhausted",
        evidence: { identifier: null },
        lastAttemptAt: old,
      });
      return id;
    }
    if (sweep === "recovery.reconcile_blocked_without_blockers") {
      return insertIssue({
        ...seeded,
        agentId: seeded.agentId,
        title,
        status: "blocked",
        issueNumber,
        extra: { updatedAt: old, blockedTransitionAt: old },
      });
    }
    if (sweep === "recovery.reconcile_todo_stranded_cards") {
      return insertIssue({
        ...seeded,
        agentId: seeded.agentId,
        title,
        status: "todo",
        issueNumber,
        extra: { updatedAt: old },
      });
    }
    if (sweep === "recovery.reconcile_dispatch_suppression_parks") {
      const id = await insertIssue({
        ...seeded,
        agentId: seeded.agentId,
        title,
        status: "in_progress",
        issueNumber,
        extra: { updatedAt: old },
      });
      await db.insert(activityLog).values({
        companyId: seeded.companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.timer_dispatch_suppressed",
        entityType: "issue",
        entityId: id,
        details: { disjuncts: { activeRun: false } },
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      });
      return id;
    }
    if (sweep === "recovery.host_restart_strand_sweep") {
      const id = await insertIssue({
        ...seeded,
        agentId: seeded.agentId,
        title,
        status: "in_progress",
        issueNumber,
        extra: {
          monitorNextCheckAt: null,
          monitorAttemptCount: 1,
          executionPolicy: { mode: "normal", commentRequired: true, stages: [] },
          executionState: {
            currentStageType: null,
            monitor: { status: "triggered", attemptCount: 1, maxAttempts: 5, scheduledBy: "assignee" },
          },
        },
      });
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId: seeded.companyId,
        agentId: seeded.agentId,
        invocationSource: "manual",
        status: "failed",
        startedAt: old,
        finishedAt: old,
        contextSnapshot: { issueId: id },
        resultJson: {
          hostRestart: { detected: true, runBootId: "boot-old", currentBootId: "boot-new", detectedAt: old.toISOString() },
        },
      });
      return id;
    }
    if (sweep === "recovery.reconcile_stale_recovery_action_wakes") {
      const id = await insertIssue({ ...seeded, agentId: seeded.agentId, title, status: "in_progress", issueNumber });
      await db.insert(issueRecoveryActions).values({
        id: randomUUID(),
        companyId: seeded.companyId,
        sourceIssueId: id,
        kind: "issue_graph_liveness",
        status: "active",
        ownerType: "agent",
        ownerAgentId: seeded.agentId,
        cause: "stranded_assigned",
        fingerprint: `stale-wake:${id}`,
        nextAction: "wake the assignee",
        evidence: {},
        lastAttemptAt: veryOld,
        attemptCount: 0,
        maxAttempts: 5,
      });
      return id;
    }
    if (sweep === "task_watchdogs.reconcile_task_watchdogs") {
      const watchdogIssueId = await insertIssue({ ...seeded, agentId: seeded.agentId, title: `watchdog-issue-${issueNumber}`, status: "todo", issueNumber: 500 + issueNumber });
      const id = await insertIssue({
        ...seeded,
        agentId: seeded.agentId,
        title,
        status: "in_progress",
        issueNumber,
        extra: { createdAt: veryOld, updatedAt: veryOld },
      });

      await db.insert(issueWatchdogs).values({
        companyId: seeded.companyId,
        issueId: id,
        watchdogAgentId: seeded.agentId,
        watchdogIssueId,
        status: "active",
      });
      return id;
    }
    throw new Error(`no driver for ${sweep}`);
  }

  async function runSweep(sweep: RecoverySweepName, seeded: Seed) {
    const svc = recovery();
    const now = new Date();
    if (sweep === "recovery.reconcile_stranded_assigned_issues" || sweep === "recovery.reconcile_unassigned_blocking_issue") {
      return svc.reconcileStrandedAssignedIssues();
    }
    if (sweep === "recovery.reconcile_stillborn_assigned_backlog") return svc.reconcileStillbornAssignedBacklog();
    if (sweep === "recovery.sweep_stale_issue_locks") return svc.sweepStaleIssueLocks();
    if (sweep === "recovery.reconcile_exhausted_recovery_drain") return svc.reconcileExhaustedRecoveryDrain();
    if (sweep === "recovery.reconcile_blocked_without_blockers") return svc.reconcileBlockedWithoutBlockers({ now, companyId: seeded.companyId });
    if (sweep === "recovery.reconcile_todo_stranded_cards") return svc.reconcileTodoStrandedCards({ now, companyId: seeded.companyId });
    if (sweep === "recovery.reconcile_dispatch_suppression_parks") {
      return svc.reconcileDispatchSuppressionParks({ now, companyId: seeded.companyId });
    }
    if (sweep === "recovery.reconcile_stale_recovery_action_wakes") return svc.reconcileStaleRecoveryActionWakes({ intervalMs: 0 });
    if (sweep === "recovery.host_restart_strand_sweep") {
      return sweepHostRestartStrandedIssues({ db, now, resolveBootId: async () => "boot-new", companyId: seeded.companyId });
    }
    if (sweep === "task_watchdogs.reconcile_task_watchdogs") {
      return taskWatchdogService(db).reconcileTaskWatchdogs({ companyId: seeded.companyId });
    }
    throw new Error(`no runner for ${sweep}`);
  }
});
