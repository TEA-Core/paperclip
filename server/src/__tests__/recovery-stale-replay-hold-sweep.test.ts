import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { clearStaleRecoveryReplayHolds } from "../services/recovery/service.js";

// loadConfig() in recovery/service.ts validates bind mode eagerly.
process.env.PAPERCLIP_BIND = "loopback";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale-replay-hold sweep tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const BLOCKED_CAUSE = "uncertain_provider_action";

describeEmbeddedPostgres("clearStaleRecoveryReplayHolds", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-replay-hold-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const prefix = `RH${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Replay Hold Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId, prefix };
  }

  async function seedIssue(input: {
    companyId: string;
    agentId: string;
    prefix: string;
    number: number;
    status: "todo" | "in_review";
    executionState?: Record<string, unknown>;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      title: `Replay hold fixture ${input.number}`,
      status: input.status,
      priority: "medium",
      assigneeAgentId: input.agentId,
      issueNumber: input.number,
      identifier: `${input.prefix}-${input.number}`,
      ...(input.executionState ? { executionState: input.executionState } : {}),
    });
    return id;
  }

  async function seedRecoveryAction(input: {
    companyId: string;
    sourceIssueId: string;
    status: "active" | "escalated" | "resolved" | "cancelled";
    evidence: Record<string, unknown>;
    updatedAt?: Date;
  }) {
    const id = randomUUID();
    await db.insert(issueRecoveryActions).values({
      id,
      companyId: input.companyId,
      sourceIssueId: input.sourceIssueId,
      recoveryIssueId: null,
      kind: "stranded_assigned_issue",
      status: input.status,
      ownerType: "agent",
      ownerAgentId: null,
      ownerUserId: null,
      previousOwnerAgentId: null,
      returnOwnerAgentId: null,
      cause: BLOCKED_CAUSE,
      fingerprint: `fingerprint:${input.sourceIssueId}`,
      evidence: input.evidence,
      nextAction: "Restore a live execution path.",
      wakePolicy: null,
      monitorPolicy: null,
      attemptCount: 0,
      maxAttempts: null,
      timeoutAt: null,
      lastAttemptAt: null,
      outcome: input.status === "resolved" ? "blocked" : null,
      resolutionNote: null,
      resolvedAt: input.status === "resolved" ? new Date() : null,
      createdAt: new Date(),
      updatedAt: input.updatedAt ?? new Date(),
    });
    return id;
  }

  function blockedEvidence(extra: Record<string, unknown> = {}) {
    return {
      automaticRecovery: { replay: "blocked", reason: "automatic recovery stopped" },
      runId: randomUUID(),
      ...extra,
    };
  }

  async function readEvidence(actionId: string) {
    const [row] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId));
    return row!.evidence as Record<string, unknown>;
  }

  it("clears the hold on a resolved in_review card with an armed stage and unblocks its wake", async () => {
    const { companyId, agentId, prefix } = await seedCompany();
    // SUP-16430 shape: in_review with a pending review stage armed.
    const issueId = await seedIssue({
      companyId,
      agentId,
      prefix,
      number: 1,
      status: "in_review",
      executionState: {
        status: "pending",
        currentStageType: "review",
        currentStageId: randomUUID(),
        currentParticipant: { type: "agent", agentId, userId: null },
        lastDecisionId: null,
      },
    });
    const actionId = await seedRecoveryAction({
      companyId,
      sourceIssueId: issueId,
      status: "resolved",
      evidence: blockedEvidence(),
    });

    // The durable hold is effective even though the action resolved.
    await expect(getExecutionBlocker(db, companyId, issueId)).resolves.toMatchObject({
      cause: BLOCKED_CAUSE,
      recoveryActionId: actionId,
    });

    const result = await clearStaleRecoveryReplayHolds(db);
    expect(result.cleared).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const evidence = await readEvidence(actionId);
    expect(evidence.automaticRecovery).toMatchObject({ replay: "restored" });
    // Other automatic-recovery bookkeeping is preserved, not dropped.
    expect((evidence.automaticRecovery as Record<string, unknown>).reason).toBe(
      "automatic recovery stopped",
    );

    await expect(getExecutionBlocker(db, companyId, issueId)).resolves.toBeNull();
  });

  it("clears the hold on a todo card with an assignment wake (the shape stalled-review detectors cannot see)", async () => {
    const { companyId, agentId, prefix } = await seedCompany();
    // SUP-16668 shape: todo, assigned to an idle agent, no review stage anywhere.
    const issueId = await seedIssue({
      companyId,
      agentId,
      prefix,
      number: 2,
      status: "todo",
    });
    const actionId = await seedRecoveryAction({
      companyId,
      sourceIssueId: issueId,
      status: "resolved",
      evidence: blockedEvidence(),
    });

    await expect(getExecutionBlocker(db, companyId, issueId)).resolves.not.toBeNull();

    const result = await clearStaleRecoveryReplayHolds(db);
    expect(result.cleared).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
    expect((await readEvidence(actionId)).automaticRecovery).toMatchObject({
      replay: "restored",
    });
    await expect(getExecutionBlocker(db, companyId, issueId)).resolves.toBeNull();
  });

  it("never touches active or escalated actions", async () => {
    const { companyId, agentId, prefix } = await seedCompany();
    const activeIssueId = await seedIssue({
      companyId,
      agentId,
      prefix,
      number: 3,
      status: "todo",
    });
    const escalatedIssueId = await seedIssue({
      companyId,
      agentId,
      prefix,
      number: 4,
      status: "todo",
    });
    const activeActionId = await seedRecoveryAction({
      companyId,
      sourceIssueId: activeIssueId,
      status: "active",
      evidence: blockedEvidence(),
    });
    const escalatedActionId = await seedRecoveryAction({
      companyId,
      sourceIssueId: escalatedIssueId,
      status: "escalated",
      evidence: blockedEvidence(),
    });

    const result = await clearStaleRecoveryReplayHolds(db);
    expect(result.scanned).toBe(0);
    expect(result.cleared).toBe(0);

    expect((await readEvidence(activeActionId)).automaticRecovery).toMatchObject({
      replay: "blocked",
    });
    expect((await readEvidence(escalatedActionId)).automaticRecovery).toMatchObject({
      replay: "blocked",
    });
    await expect(getExecutionBlocker(db, companyId, activeIssueId)).resolves.not.toBeNull();
    await expect(getExecutionBlocker(db, companyId, escalatedIssueId)).resolves.not.toBeNull();
  });

  it("is idempotent: a second pass matches nothing and writes nothing", async () => {
    const { companyId, agentId, prefix } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      prefix,
      number: 5,
      status: "todo",
    });
    const actionId = await seedRecoveryAction({
      companyId,
      sourceIssueId: issueId,
      status: "resolved",
      evidence: blockedEvidence(),
    });

    const first = await clearStaleRecoveryReplayHolds(db);
    expect(first.cleared).toBe(1);
    const [afterFirst] = await db
      .select({ updatedAt: issueRecoveryActions.updatedAt })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId));

    const second = await clearStaleRecoveryReplayHolds(db);
    expect(second.scanned).toBe(0);
    expect(second.cleared).toBe(0);

    const [afterSecond] = await db
      .select({ updatedAt: issueRecoveryActions.updatedAt })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actionId));
    expect(afterSecond!.updatedAt).toEqual(afterFirst!.updatedAt);
  });

  it("leaves resolved actions without a blocked replay hold untouched", async () => {
    const { companyId, agentId, prefix } = await seedCompany();
    const issueId = await seedIssue({
      companyId,
      agentId,
      prefix,
      number: 6,
      status: "todo",
    });
    const actionId = await seedRecoveryAction({
      companyId,
      sourceIssueId: issueId,
      status: "resolved",
      evidence: { automaticRecovery: { replay: "restored" } },
    });

    const result = await clearStaleRecoveryReplayHolds(db);
    expect(result.scanned).toBe(0);
    expect(result.cleared).toBe(0);
    expect((await readEvidence(actionId)).automaticRecovery).toMatchObject({
      replay: "restored",
    });
  });
});
