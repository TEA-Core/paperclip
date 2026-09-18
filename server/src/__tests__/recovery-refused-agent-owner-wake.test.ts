import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

// loadConfig() in recovery/service.ts validates bind mode eagerly.
process.env.PAPERCLIP_BIND = "loopback";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// SUP-16538 follow-up to fold slice 2c / D12: a same-agent owner wake must be
// suppressed whenever the stranded run's errorCode is a non-retryable preflight
// refusal, not only when releaseIssueExecutionAndPromote passes the first-strike
// flag. The stale-action sweep re-fires the wake directly, so the suppression is
// enforced at the shared enqueue choke point.
describeEmbeddedPostgres("refused-agent owner-wake suppression (D12 / SUP-16538)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-refused-owner-wake-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(opts: { coderReportsToManager: boolean }) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const prefix = `RP${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Refused Wake Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "Manager",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
        reportsTo: null,
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: opts.coderReportsToManager ? managerId : null,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return { companyId, managerId, coderId, prefix };
  }

  async function seedIssue(companyId: string, assigneeAgentId: string, prefix: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stranded issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    return row!;
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    errorCode: string;
  }) {
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "manual",
      status: "failed",
      startedAt: new Date("2026-09-18T18:00:00.000Z"),
      contextSnapshot: { issueId: input.issueId },
      errorCode: input.errorCode,
    });
  }

  async function insertStaleRecoveryAction(input: {
    companyId: string;
    sourceIssueId: string;
    ownerAgentId: string;
  }) {
    const [row] = await db
      .insert(issueRecoveryActions)
      .values({
        id: randomUUID(),
        companyId: input.companyId,
        sourceIssueId: input.sourceIssueId,
        recoveryIssueId: null,
        kind: "stranded_assigned_issue",
        status: "active",
        ownerType: "agent",
        ownerAgentId: input.ownerAgentId,
        ownerUserId: null,
        previousOwnerAgentId: null,
        returnOwnerAgentId: null,
        cause: "stranded_assigned_issue",
        fingerprint: `fingerprint:${input.sourceIssueId}`,
        evidence: {},
        nextAction: "Restore a live execution path.",
        wakePolicy: { type: "wake_owner", reason: "source_scoped_recovery_action" },
        monitorPolicy: null,
        attemptCount: 1,
        maxAttempts: null,
        timeoutAt: null,
        lastAttemptAt: new Date(Date.now() - 10 * 60_000),
        outcome: null,
        resolutionNote: null,
        resolvedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    return row;
  }

  function fakeRun(input: { agentId: string; errorCode: string }) {
    return {
      id: randomUUID(),
      agentId: input.agentId,
      status: "failed",
      error: "preflight refused",
      errorCode: input.errorCode,
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
      startedAt: new Date(),
      createdAt: new Date(),
    } as const;
  }

  it("suppresses the same-agent owner wake when the escalation's run is a non-retryable preflight refusal", async () => {
    const { companyId, coderId, prefix } = await seedCompany({
      coderReportsToManager: false,
    });
    const sourceIssue = await seedIssue(companyId, coderId, prefix);

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: fakeRun({ agentId: coderId, errorCode: "spawn_envelope_too_large" }),
      comment: "Automatic continuation recovery failed.",
    });

    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));

    // The recovery action and blocked status still stand; only the re-dispatch wake is skipped.
    expect(action).toBeDefined();
    expect(action.ownerAgentId).toBe(coderId);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("still wakes a different recovery owner when the run is a non-retryable preflight refusal", async () => {
    const { companyId, managerId, coderId, prefix } = await seedCompany({
      coderReportsToManager: true,
    });
    const sourceIssue = await seedIssue(companyId, coderId, prefix);

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: fakeRun({ agentId: coderId, errorCode: "low_trust_boundary_mismatch" }),
      comment: "Automatic continuation recovery failed.",
    });

    const [action] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));

    expect(action).toBeDefined();
    expect(action.ownerAgentId).toBe(managerId);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(
      managerId,
      expect.objectContaining({ reason: "source_scoped_recovery_action" }),
    );
  });

  it("does not re-fire a suppressed owner wake from the stale-action sweep", async () => {
    const { companyId, coderId, prefix } = await seedCompany({
      coderReportsToManager: false,
    });
    const sourceIssue = await seedIssue(companyId, coderId, prefix);
    await seedRun({
      companyId,
      agentId: coderId,
      issueId: sourceIssue.id,
      errorCode: "spawn_envelope_too_large",
    });
    const action = await insertStaleRecoveryAction({
      companyId,
      sourceIssueId: sourceIssue.id,
      ownerAgentId: coderId,
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

    expect(result.checked).toBe(1);
    expect(result.reFired).toBe(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const [updated] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(updated.attemptCount).toBe(2);
  });

  it("still re-fires the sweep wake for a different owner on a non-retryable preflight refusal", async () => {
    const { companyId, managerId, coderId, prefix } = await seedCompany({
      coderReportsToManager: true,
    });
    const sourceIssue = await seedIssue(companyId, coderId, prefix);
    await seedRun({
      companyId,
      agentId: coderId,
      issueId: sourceIssue.id,
      errorCode: "low_trust_boundary_mismatch",
    });
    await insertStaleRecoveryAction({
      companyId,
      sourceIssueId: sourceIssue.id,
      ownerAgentId: managerId,
    });

    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStaleRecoveryActionWakes({ intervalMs: 5 * 60_000 });

    expect(result.checked).toBe(1);
    expect(result.reFired).toBe(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(enqueueWakeup).toHaveBeenCalledWith(
      managerId,
      expect.objectContaining({ reason: "source_scoped_recovery_action" }),
    );
  });
});
