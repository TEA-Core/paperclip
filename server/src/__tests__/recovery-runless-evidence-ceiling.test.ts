import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import type { IssueRecoveryAction } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  DEFAULT_RECOVERY_ACTION_MAX_ATTEMPTS,
  issueRecoveryActionService,
  type UpsertIssueRecoveryActionInput,
} from "../services/issue-recovery-actions.js";

// loadConfig() in recovery/service.ts validates bind mode eagerly. Not needed
// here (we drive the upsert service directly), kept for parity with the sibling
// recovery suites so the module graph stays stable.
process.env.PAPERCLIP_BIND = "loopback";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-agnostic recovery-ceiling tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// SUP-17408: the verbatim run-agnostic evidence key sets the three looping
// detectors emit. NONE of them carries `latestRunId` — which is exactly what the
// old `staleRepark`-gated ceiling required on both sides of the lineage before
// it could mint the terminal exhausted successor.
const RUN_AGNOSTIC_CAUSES: Array<{
  cause: string;
  kind: "stranded_assigned_issue" | "blocked_without_blockers" | "no_live_path_owner_unavailable";
  fingerprint: string;
  evidence: Record<string, unknown>;
  nextAction: string;
}> = [
  {
    cause: "execution_hold_unresolved",
    kind: "stranded_assigned_issue",
    fingerprint: "execution_hold_unresolved:fixed-issue",
    evidence: {
      executionHoldCause: "run_failed",
      executionHoldNextAction: "Verify the stopped execution.",
      executionHoldRecoveryActionId: "hold-1",
      identifier: "FIXED-1",
      source: "recovery.reconcile_execution_hold_unresolved",
      status: "in_progress",
    },
    nextAction: "The card is held by a resolved execution-reconciliation hold.",
  },
  {
    cause: "blocked_without_blockers",
    kind: "blocked_without_blockers",
    fingerprint: "bwob:fixed-issue",
    evidence: {
      blockedAt: "2026-09-22T00:00:00.000Z",
      healAttemptCount: 0,
      identifier: "FIXED-1",
      msInViolation: 900_000,
      status: "blocked",
    },
    nextAction: "Review this blocked issue.",
  },
  {
    cause: "no_live_path_owner_unavailable",
    kind: "no_live_path_owner_unavailable",
    fingerprint: "no_live_path_owner_unavailable:fixed-issue",
    evidence: {
      agentId: "agent-fixed",
      agentInvokabilityMessage: "agent not invokable",
      agentInvokabilityReason: "missing_credential",
      agentInvokable: false,
      identifier: "FIXED-1",
      msSinceUpdate: 900_000,
      status: "in_review",
    },
    nextAction: "Restore a live execution path.",
  },
];

describeEmbeddedPostgres("issueRecoveryActionService run-agnostic evidence ceiling (SUP-17408)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-agnostic-recovery-ceiling-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndIssue() {
    const companyId = randomUUID();
    const sourceIssueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Run-Agnostic Ceiling Co",
      issuePrefix: "RUN",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Looping recovery source",
      status: "in_progress",
      priority: "high",
    });
    return { companyId, sourceIssueId };
  }

  // Repeatedly upsert the same (cause, fingerprint) with run-agnostic evidence,
  // resolving each active predecessor before the next upsert — the exact
  // resolve -> re-park loop the detectors produce every ~30s sweep tick.
  async function driveLineage(input: UpsertIssueRecoveryActionInput, maxTicks: number) {
    const svc = issueRecoveryActionService(db);
    const ticks: IssueRecoveryAction[] = [];
    for (let tick = 1; tick <= maxTicks; tick++) {
      const row = await svc.upsertSourceScoped(input);
      ticks.push(row);
      if (row.status === "escalated") break;
      await svc.resolveActiveForIssue({
        companyId: input.companyId,
        sourceIssueId: input.sourceIssueId,
        actionId: row.id,
        status: "resolved",
        outcome: "restored",
        resolutionNote: "new_source_execution_path",
      });
    }
    return ticks;
  }

  for (const shape of RUN_AGNOSTIC_CAUSES) {
    it(`terminates the ${shape.cause} lineage at the attempt ceiling despite run-agnostic evidence`, async () => {
      const { companyId, sourceIssueId } = await seedCompanyAndIssue();
      const input: UpsertIssueRecoveryActionInput = {
        companyId,
        sourceIssueId,
        kind: shape.kind,
        ownerType: "board",
        cause: shape.cause,
        fingerprint: shape.fingerprint,
        evidence: shape.evidence,
        nextAction: shape.nextAction,
        wakePolicy: null,
        monitorPolicy: null,
        maxAttempts: null,
      };

      const ticks = await driveLineage(input, DEFAULT_RECOVERY_ACTION_MAX_ATTEMPTS + 3);

      // The first `MAX_ATTEMPTS` upserts stay `active`, one attempt each.
      for (let i = 1; i <= DEFAULT_RECOVERY_ACTION_MAX_ATTEMPTS; i++) {
        expect(ticks[i - 1]?.status).toBe("active");
        expect(ticks[i - 1]?.attemptCount).toBe(i);
      }

      // The next upsert crosses the cumulative ceiling and must mint the
      // terminal board-facing row instead of looping to a fresh `active` row.
      const terminal = ticks[DEFAULT_RECOVERY_ACTION_MAX_ATTEMPTS];
      expect(terminal?.status).toBe("escalated");
      expect(terminal?.outcome).toBe("exhausted");
      expect(terminal?.ownerType).toBe("board");
      expect(terminal?.cause).toBe(shape.cause);
      expect(terminal?.fingerprint).toBe(shape.fingerprint);
      expect(terminal?.attemptCount).toBe(DEFAULT_RECOVERY_ACTION_MAX_ATTEMPTS);
      expect(terminal?.maxAttempts).toBe(DEFAULT_RECOVERY_ACTION_MAX_ATTEMPTS);
      expect((terminal?.evidence?.recoveryBudget as { state?: string } | undefined)?.state).toBe(
        "exhausted",
      );

      // No live row survives past the ceiling: only the terminal escalated row
      // is in the active/escalated set, every predecessor is resolved.
      const inFlight = await db
        .select({ id: issueRecoveryActions.id })
        .from(issueRecoveryActions)
        .where(
          and(
            eq(issueRecoveryActions.sourceIssueId, sourceIssueId),
            inArray(issueRecoveryActions.status, ["active", "escalated"]),
          ),
        );
      expect(inFlight).toHaveLength(1);
      expect(inFlight[0]?.id).toBe(terminal?.id);
    });
  }

  it("is idempotent after the ceiling is consumed — subsequent upserts return the terminal row, not a fresh active one", async () => {
    const { companyId, sourceIssueId } = await seedCompanyAndIssue();
    const shape = RUN_AGNOSTIC_CAUSES[1]!; // blocked_without_blockers
    const input: UpsertIssueRecoveryActionInput = {
      companyId,
      sourceIssueId,
      kind: shape.kind,
      ownerType: "board",
      cause: shape.cause,
      fingerprint: shape.fingerprint,
      evidence: shape.evidence,
      nextAction: shape.nextAction,
      wakePolicy: null,
      monitorPolicy: null,
      maxAttempts: null,
    };

    const ticks = await driveLineage(input, DEFAULT_RECOVERY_ACTION_MAX_ATTEMPTS + 3);
    const terminal = ticks[ticks.length - 1]!;
    expect(terminal.status).toBe("escalated");
    expect(terminal.outcome).toBe("exhausted");

    const svc = issueRecoveryActionService(db);
    // Two more sweep ticks: the terminal row is returned unchanged; no new row.
    for (let i = 0; i < 2; i++) {
      const again = await svc.upsertSourceScoped(input);
      expect(again.id).toBe(terminal.id);
      expect(again.status).toBe("escalated");
      expect(again.outcome).toBe("exhausted");
      expect(again.attemptCount).toBe(DEFAULT_RECOVERY_ACTION_MAX_ATTEMPTS);
    }
    // 5 resolved predecessors + 1 terminal row = 6 rows; no extra active row.
    const rows = await db
      .select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
    expect(rows).toHaveLength(DEFAULT_RECOVERY_ACTION_MAX_ATTEMPTS + 1);
  });
});
