import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueRelations,
  issueWorkProducts,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  workAssessments,
} from "@paperclipai/db";
import {
  DEPENDENCY_WAKE_WITHHELD_ACTION,
  readAttributedLandingDischarge,
  SHARED_CARRIER_REFUSAL_MARKER,
} from "../services/blocker-closure.js";
import { commitNativeStatusDecision } from "../services/native-runtime/status-decision-committer.js";
import { recoveryService } from "../services/recovery/service.js";
import {
  NATIVE_STATUS_ARBITER_POLICY_VERSION,
  type NativeStatusDecision,
} from "../services/native-runtime/status-arbiter.js";
import {
  buildIssueBlockersResolvedWakeStateKey,
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
} from "../services/issue-dependency-wakeups.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const ATTRIBUTED_LANDING_ACTION = "issue.done_close_landing_attributed";
const sharedCarrierReason = `shared branch head abc123 does not carry this card's identifier prefix SUP-9999; landing deferred to carrier SUP-8888`;
const benignReason = "publish blocked: missing sign-off";

describe("SUP-17092/A dependency wake attributed-landing withhold", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const carrierAgentId = randomUUID();
  const dependentAgentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-dep-wake-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Dep wake", issuePrefix: "DEPW" });
    await db.insert(agents).values([
      { id: carrierAgentId, companyId, name: "Carrier agent", adapterType: "codex_local", status: "running" },
      { id: dependentAgentId, companyId, name: "Dependent agent", adapterType: "codex_local", status: "idle" },
    ]);
  }, 30_000);

  afterAll(async () => temporary?.cleanup());

  describe("readAttributedLandingDischarge predicate (bullet 1)", () => {
    it("reads clause 1 (attribution row) with priority and rich fields", async () => {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "clause1",
        status: "done",
        assigneeAgentId: carrierAgentId,
        workMode: "standard",
        executionState: {
          approvalStatus: { publishSkipped: { reason: sharedCarrierReason } },
        },
      });
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "done_close_landing_backstop",
        action: ATTRIBUTED_LANDING_ACTION,
        entityType: "issue",
        entityId: issueId,
        details: {
          skipReason: "shared-carrier deferral",
          carrierIdentifier: "SUP-8888",
          pr: "corp/repo#42",
          deadlocked: true,
        },
      });

      const discharge = await readAttributedLandingDischarge(db, companyId, issueId);
      expect(discharge).toEqual({
        attributed: true,
        source: "attribution_row",
        reason: "shared-carrier deferral",
        carrierIdentifier: "SUP-8888",
        pr: "corp/repo#42",
        deadlocked: true,
      });
    });

    it("reads clause 2 (live publishSkipped marker) with no attribution row", async () => {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "clause2",
        status: "done",
        assigneeAgentId: carrierAgentId,
        workMode: "standard",
        executionState: {
          approvalStatus: { publishSkipped: { reason: sharedCarrierReason } },
        },
      });

      const discharge = await readAttributedLandingDischarge(db, companyId, issueId);
      expect(discharge).toEqual({
        attributed: true,
        source: "publish_skipped",
        reason: sharedCarrierReason,
        carrierIdentifier: null,
        pr: null,
        deadlocked: null,
      });
    });

    it("resolves carrierIdentifier from carrierOwnerId when carrierIdentifier is absent", async () => {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "carrier-owner",
        status: "done",
        assigneeAgentId: carrierAgentId,
        workMode: "standard",
      });
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "done_close_landing_backstop",
        action: ATTRIBUTED_LANDING_ACTION,
        entityType: "issue",
        entityId: issueId,
        details: { skipReason: "owner-based", carrierOwnerId: "SUP-7777" },
      });

      const discharge = await readAttributedLandingDischarge(db, companyId, issueId);
      expect(discharge.attributed).toBe(true);
      expect(discharge.source).toBe("attribution_row");
      expect(discharge.carrierIdentifier).toBe("SUP-7777");
    });

    it("is NOT attributed when publishSkipped.reason is present but lacks the marker", async () => {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "benign",
        status: "done",
        assigneeAgentId: carrierAgentId,
        workMode: "standard",
        executionState: {
          approvalStatus: { publishSkipped: { reason: benignReason } },
        },
      });

      const discharge = await readAttributedLandingDischarge(db, companyId, issueId);
      expect(discharge.attributed).toBe(false);
      expect(discharge.source).toBeNull();
      expect(discharge.reason).toBeNull();
    });

    it("is NOT attributed when neither clause holds", async () => {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "clean",
        status: "done",
        assigneeAgentId: carrierAgentId,
        workMode: "standard",
      });

      const discharge = await readAttributedLandingDischarge(db, companyId, issueId);
      expect(discharge).toEqual({
        attributed: false,
        source: null,
        reason: null,
        carrierIdentifier: null,
        pr: null,
        deadlocked: null,
      });
    });

    it("is NOT attributed for an armed/exact-head close", async () => {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "armed",
        status: "done",
        assigneeAgentId: carrierAgentId,
        workMode: "standard",
        executionState: {
          approvalStatus: { publishedHeadSha: "exacthead1234", publishArmed: true },
        },
      });

      const discharge = await readAttributedLandingDischarge(db, companyId, issueId);
      expect(discharge.attributed).toBe(false);
    });

    it("is NOT attributed for a publishFailure", async () => {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "publish-failure",
        status: "done",
        assigneeAgentId: carrierAgentId,
        workMode: "standard",
        executionState: {
          approvalStatus: { publishFailure: { reason: "network unreachable" } },
        },
      });

      const discharge = await readAttributedLandingDischarge(db, companyId, issueId);
      expect(discharge.attributed).toBe(false);
    });

    it("prioritizes clause 1 over clause 2 when both are present", async () => {
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "both",
        status: "done",
        assigneeAgentId: carrierAgentId,
        workMode: "standard",
        executionState: {
          approvalStatus: { publishSkipped: { reason: sharedCarrierReason } },
        },
      });
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "done_close_landing_backstop",
        action: ATTRIBUTED_LANDING_ACTION,
        entityType: "issue",
        entityId: issueId,
        details: { skipReason: "row-wins", carrierIdentifier: "SUP-5555" },
      });

      const discharge = await readAttributedLandingDischarge(db, companyId, issueId);
      expect(discharge.source).toBe("attribution_row");
      expect(discharge.reason).toBe("row-wins");
      expect(discharge.carrierIdentifier).toBe("SUP-5555");
    });
  });

  // ---- Producer behavior via the native status-decision committer (bullets 2/3/5) ----

  interface Scenario {
    blockerId: string;
    dependentId: string;
    runId: string;
    assessmentId: string;
  }

  /**
   * Seed a fresh native "blocker done + one wakeable dependent" scenario.
   * The blocker has no executionWorkspaceId so the workspace-finalize barrier
   * does not gate the dependent's readiness (readiness resolves purely on the
   * in-transaction done status).
   */
  async function seedNativeBlockerDone(
    suffix: string,
    options: { publishSkippedReason?: string; publishedHeadSha?: string; attributionRow?: boolean } = {},
  ): Promise<Scenario> {
    const blockerId = randomUUID();
    const dependentId = randomUUID();
    const runId = randomUUID();
    const contractId = randomUUID();
    const resultId = randomUUID();
    const assessmentId = randomUUID();
    const workProductId = randomUUID();
    const now = new Date();

    const executionState =
      options.publishSkippedReason || options.publishedHeadSha
        ? {
            approvalStatus: {
              ...(options.publishSkippedReason
                ? { publishSkipped: { reason: options.publishSkippedReason } }
                : {}),
              ...(options.publishedHeadSha ? { publishedHeadSha: options.publishedHeadSha } : {}),
            },
          }
        : null;

    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: `blocker ${suffix}`,
      status: "in_progress",
      assigneeAgentId: carrierAgentId,
      workMode: "standard",
      executionState,
    });
    await db.insert(issues).values({
      id: dependentId,
      companyId,
      title: `dependent ${suffix}`,
      status: "blocked",
      assigneeAgentId: dependentAgentId,
      workMode: "standard",
    });
    await db.insert(issueRelations).values({
      companyId,
      type: "blocks",
      issueId: blockerId,
      relatedIssueId: dependentId,
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: carrierAgentId,
      status: "succeeded",
      runtimeMode: "native",
      runtimeModeResolvedAt: now,
      nativeIssueId: blockerId,
      contextSnapshot: { issueId: blockerId, suffix },
      completionContractId: contractId,
      completionContractSha256: `contract:${suffix}`,
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId: blockerId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "depwake-v1", criteria: [{ id: "objective", requirement: suffix }] },
      canonicalSha256: `contract:${suffix}`,
      createdByActorType: "system",
      createdByActorId: "dep-wake-test",
    });
    await db.insert(nativeRunResults).values({
      id: resultId,
      companyId,
      issueId: blockerId,
      runId,
      completionContractId: contractId,
      serverFingerprint: `fingerprint:${suffix}`,
      schemaStatus: "accepted",
      resultJson: {
        suffix,
        result: {
          reportedWorkDisposition: "done",
          summary: `blocker ${suffix} done`,
          completionClaim: {
            contractRevision: "depwake-v1",
            objectiveSatisfied: true,
            criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [`work_product:${workProductId}`] }],
            remainingWork: [],
          },
          verification: [{ commandOrCheck: "fixture", status: "passed", artifactRef: `work_product:${workProductId}` }],
        },
        terminal: { runTerminalState: "succeeded" },
      },
      canonicalSha256: `result:${suffix}`,
    });
    await db.insert(issueWorkProducts).values({
      id: workProductId,
      companyId,
      issueId: blockerId,
      type: "artifact",
      provider: "paperclip",
      title: `${suffix} evidence`,
      status: "ready_for_review",
      reviewState: "approved",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workAssessments).values({
      id: assessmentId,
      companyId,
      issueId: blockerId,
      runId,
      contractId,
      resultId,
      triggerKind: "native_result",
      triggerActorCompanyId: companyId,
      priorIssueStatus: "in_progress",
      priorStatusVersion: 0,
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      assessmentJson: { suffix },
      inputDigest: `assessment:${suffix}`,
      createdAt: now,
    });
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId: blockerId,
      phase: "assessing",
      resultId,
      assessmentId,
    });

    if (options.attributionRow) {
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "done_close_landing_backstop",
        action: ATTRIBUTED_LANDING_ACTION,
        entityType: "issue",
        entityId: blockerId,
        details: {
          skipReason: "shared-carrier deferral",
          carrierIdentifier: "SUP-8888",
          pr: "corp/repo#42",
          deadlocked: true,
        },
      });
    }

    return { blockerId, dependentId, runId, assessmentId };
  }

  async function commitDone(scenario: Scenario) {
    const decision: NativeStatusDecision = {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "done",
      toStatus: "done",
      reasonCode: "completion_contract_satisfied",
      unblockDescriptor: null,
      effects: [{ kind: "release_checkout" }],
    };
    return commitNativeStatusDecision({
      db,
      companyId,
      issueId: scenario.blockerId,
      runId: scenario.runId,
      assessmentId: scenario.assessmentId,
      priorStatus: "in_progress",
      priorStatusVersion: 0,
      priorDecisionId: null,
      decision,
    });
  }

  async function countDependentWakes(dependentId: string, blockerId: string) {
    const idempotencyKey = `issue_blockers_resolved:${dependentId}:${blockerId}`;
    const rows = await db
      .select({
        id: agentWakeupRequests.id,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
        agentId: agentWakeupRequests.agentId,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, companyId),
          eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
        ),
      );
    return rows;
  }

  async function countWithheldActivity(dependentId: string) {
    const rows = await db
      .select({
        action: activityLog.action,
        entityId: activityLog.entityId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, DEPENDENCY_WAKE_WITHHELD_ACTION),
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, dependentId),
        ),
      );
    return rows;
  }

  it("withholds the dependent wake via clause 2 (live publishSkipped marker): 0 wake rows + 1 withheld activity", async () => {
    const scenario = await seedNativeBlockerDone("w-clause2", {
      publishSkippedReason: sharedCarrierReason,
    });

    await commitDone(scenario);

    const wakes = await countDependentWakes(scenario.dependentId, scenario.blockerId);
    expect(wakes, "no issue_blockers_resolved wake may be enqueued").toHaveLength(0);

    const withheld = await countWithheldActivity(scenario.dependentId);
    expect(withheld, "exactly one dependency_wake_withheld audit row").toHaveLength(1);
    expect(withheld[0]!.details).toMatchObject({
      wakeReason: "issue_blockers_resolved",
      dependentIssueId: scenario.dependentId,
      resolvedBlockerIssueId: scenario.blockerId,
      producer: "native_status_decision",
      attributionSource: "publish_skipped",
      refusalReason: sharedCarrierReason,
    });
  });

  it("withholds the dependent wake via clause 1 (attribution row): 0 wake rows + 1 withheld activity", async () => {
    const scenario = await seedNativeBlockerDone("w-clause1", {
      attributionRow: true,
      publishedHeadSha: "deadbeef",
    });

    await commitDone(scenario);

    const wakes = await countDependentWakes(scenario.dependentId, scenario.blockerId);
    expect(wakes, "no issue_blockers_resolved wake may be enqueued").toHaveLength(0);

    const withheld = await countWithheldActivity(scenario.dependentId);
    expect(withheld).toHaveLength(1);
    expect(withheld[0]!.details).toMatchObject({
      producer: "native_status_decision",
      attributionSource: "attribution_row",
      carrierIdentifier: "SUP-8888",
    });
  });

  it("emits the dependent wake with the idempotency key when the landing is NOT attributed (positive)", async () => {
    const scenario = await seedNativeBlockerDone("positive", {
      publishedHeadSha: "published123",
    });

    await commitDone(scenario);

    const wakes = await countDependentWakes(scenario.dependentId, scenario.blockerId);
    expect(wakes, "the dependent wake must be enqueued").toHaveLength(1);
    expect(wakes[0]!.reason).toBe(ISSUE_BLOCKERS_RESOLVED_WAKE_REASON);
    expect(wakes[0]!.idempotencyKey).toBe(
      `issue_blockers_resolved:${scenario.dependentId}:${scenario.blockerId}`,
    );

    const withheld = await countWithheldActivity(scenario.dependentId);
    expect(withheld, "no withhold audit row when the wake is emitted").toHaveLength(0);
  });

  it("is level-triggered (clause 2): pass 1 withholds, pass 2 (publishSkipped cleared) emits", async () => {
    // Pass 1: live publishSkipped marker, no attribution row -> withhold.
    const pass1 = await seedNativeBlockerDone("2pass-p1", {
      publishSkippedReason: sharedCarrierReason,
    });
    await commitDone(pass1);
    expect(await countDependentWakes(pass1.dependentId, pass1.blockerId)).toHaveLength(0);
    expect(await countWithheldActivity(pass1.dependentId)).toHaveLength(1);

    // Pass 2: same card shape, but the landing republished -> publishSkipped
    // cleared and publishedHeadSha set -> predicate returns attributed:false.
    const pass2 = await seedNativeBlockerDone("2pass-p2", {
      publishedHeadSha: "republished456",
    });
    await commitDone(pass2);
    const emitted = await countDependentWakes(pass2.dependentId, pass2.blockerId);
    expect(emitted, "the dependent wake must be emitted on the cleared pass").toHaveLength(1);
    expect(emitted[0]!.idempotencyKey).toBe(
      `issue_blockers_resolved:${pass2.dependentId}:${pass2.blockerId}`,
    );
  });

  // ---- Producer behavior via the periodic recovery backstop (5th producer) ----

  describe("recovery backstop (issue_graph_liveness_backstop producer)", () => {
    // Isolated company so the backstop's candidate query never picks up the
    // blocked dependents seeded by the native committer scenarios above.
    const backstopCompanyId = randomUUID();
    const bsCarrierAgentId = randomUUID();
    const bsDependentAgentId = randomUUID();

    beforeAll(async () => {
      // The backstop calls loadConfig(), which reads .paperclip/config.json from
      // the worktree; that file is not readable in the test sandbox (EACCES).
      // Point PAPERCLIP_CONFIG at a path that does not exist so readConfigFile()
      // returns null and loadConfig() falls back to env-only defaults.
      process.env.PAPERCLIP_CONFIG = path.join(
        os.tmpdir(),
        `paperclip-backstop-test-noconfig-${randomUUID()}.json`,
      );
      // loadConfig's bind validation rejects the sandbox HOST=0.0.0.0 under the
      // default local_trusted deployment mode; force the loopback bind it expects.
      process.env.PAPERCLIP_BIND = "loopback";
      await db.insert(companies).values({
        id: backstopCompanyId,
        name: "Backstop company",
        issuePrefix: "BSPK",
      });
      await db.insert(agents).values([
        { id: bsCarrierAgentId, companyId: backstopCompanyId, name: "BS carrier", adapterType: "codex_local", status: "running" },
        { id: bsDependentAgentId, companyId: backstopCompanyId, name: "BS dependent", adapterType: "codex_local", status: "idle" },
      ]);
    });

    /**
     * Seed a "resolved blocker + one blocked dependent" pair for the backstop.
     * The blocker is done with no executionWorkspaceId so the workspace-finalize
     * barrier does not gate the dependent's readiness. `resolvedBlockerIssueId`
     * therefore resolves to the blocker and the backstop's not-ready skip does
     * not fire.
     */
    async function seedBackstopScenario(
      suffix: string,
      options: { publishSkippedReason?: string; publishedHeadSha?: string; attributionRow?: boolean } = {},
    ) {
      const blockerId = randomUUID();
      const dependentId = randomUUID();
      const executionState =
        options.publishSkippedReason || options.publishedHeadSha
          ? {
              approvalStatus: {
                ...(options.publishSkippedReason
                  ? { publishSkipped: { reason: options.publishSkippedReason } }
                  : {}),
                ...(options.publishedHeadSha ? { publishedHeadSha: options.publishedHeadSha } : {}),
              },
            }
          : null;

      await db.insert(issues).values({
        id: blockerId,
        companyId: backstopCompanyId,
        title: `backstop blocker ${suffix}`,
        status: "done",
        assigneeAgentId: bsCarrierAgentId,
        workMode: "standard",
        executionState,
      });
      await db.insert(issues).values({
        id: dependentId,
        companyId: backstopCompanyId,
        title: `backstop dependent ${suffix}`,
        status: "blocked",
        assigneeAgentId: bsDependentAgentId,
        workMode: "standard",
      });
      await db.insert(issueRelations).values({
        companyId: backstopCompanyId,
        type: "blocks",
        issueId: blockerId,
        relatedIssueId: dependentId,
      });
      if (options.attributionRow) {
        await db.insert(activityLog).values({
          companyId: backstopCompanyId,
          actorType: "system",
          actorId: "done_close_landing_backstop",
          action: ATTRIBUTED_LANDING_ACTION,
          entityType: "issue",
          entityId: blockerId,
          details: {
            skipReason: "shared-carrier deferral",
            carrierIdentifier: "SUP-8888",
            pr: "corp/repo#42",
            deadlocked: true,
          },
        });
      }
      return { blockerId, dependentId };
    }

    function makeService() {
      const calls: Array<{ agentId: string; opts?: Record<string, unknown> }> = [];
      const enqueueWakeup = (async (
        agentId: string,
        opts?: Record<string, unknown>,
      ) => {
        calls.push({ agentId, opts });
        return { id: randomUUID() };
      }) as unknown as Parameters<typeof recoveryService>[1]["enqueueWakeup"];
      return { calls, service: recoveryService(db, { enqueueWakeup }) };
    }

    // The shared countWithheldActivity helper filters by the outer company id;
    // the backstop seeds its own company, so count within backstopCompanyId.
    async function countBackstopWithheld(dependentId: string) {
      return db
        .select({
          action: activityLog.action,
          entityId: activityLog.entityId,
          details: activityLog.details,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, backstopCompanyId),
            eq(activityLog.action, DEPENDENCY_WAKE_WITHHELD_ACTION),
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, dependentId),
          ),
        );
    }

    // Scope each sweep to the single dependent of this blocker so the backstop
    // never picks up candidates from sibling tests sharing backstopCompanyId.
    const backstopOpts = (blockerIssueId: string) => ({
      rearmWindowMs: 3_600_000,
      rearmMaxCount: 10,
      companyId: backstopCompanyId,
      blockerIssueId,
    });

    it("withholds via clause 2 (live publishSkipped marker): enqueueWakeup not called + 1 withheld row", async () => {
      const { blockerId, dependentId } = await seedBackstopScenario("rs-clause2", {
        publishSkippedReason: sharedCarrierReason,
      });
      const { calls, service } = makeService();

      await service.reconcileResolvedDependencyWakeBackstop(backstopOpts(blockerId));

      expect(calls, "the backstop must not call enqueueWakeup when attributed").toHaveLength(0);
      const withheld = await countBackstopWithheld(dependentId);
      expect(withheld, "exactly one dependency_wake_withheld audit row").toHaveLength(1);
      expect(withheld[0]!.details).toMatchObject({
        wakeReason: "issue_blockers_resolved",
        dependentIssueId: dependentId,
        resolvedBlockerIssueId: blockerId,
        producer: "issue_graph_liveness_backstop",
        attributionSource: "publish_skipped",
        refusalReason: sharedCarrierReason,
        carrierIdentifier: null,
      });
    });

    it("withholds via clause 1 (attribution row): enqueueWakeup not called + 1 withheld row", async () => {
      const { blockerId, dependentId } = await seedBackstopScenario("rs-clause1", {
        attributionRow: true,
        publishedHeadSha: "deadbeef",
      });
      const { calls, service } = makeService();

      await service.reconcileResolvedDependencyWakeBackstop(backstopOpts(blockerId));

      expect(calls).toHaveLength(0);
      const withheld = await countBackstopWithheld(dependentId);
      expect(withheld).toHaveLength(1);
      expect(withheld[0]!.details).toMatchObject({
        producer: "issue_graph_liveness_backstop",
        attributionSource: "attribution_row",
        carrierIdentifier: "SUP-8888",
        resolvedBlockerIssueId: blockerId,
      });
    });

    it("emits the wake when the landing is NOT attributed (positive): enqueueWakeup called once, 0 withheld", async () => {
      const { blockerId, dependentId } = await seedBackstopScenario("rs-positive", {
        publishedHeadSha: "publishedHead123",
      });
      const { calls, service } = makeService();

      await service.reconcileResolvedDependencyWakeBackstop(backstopOpts(blockerId));

      expect(calls, "the backstop must enqueue the wake when not attributed").toHaveLength(1);
      expect(calls[0]!.agentId).toBe(bsDependentAgentId);
      expect(calls[0]!.opts).toMatchObject({
        reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
        idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
          dependentIssueId: dependentId,
          blockerIssueIds: [blockerId],
          blockedTransitionAt: null,
        }),
        payload: { issueId: dependentId, resolvedBlockerIssueId: blockerId },
      });
      expect(await countBackstopWithheld(dependentId), "no withhold row when the wake is emitted").toHaveLength(0);
    });

    it("writes at most one withhold row across repeated backstop passes (dedup)", async () => {
      const { blockerId, dependentId } = await seedBackstopScenario("rs-dedup", {
        publishSkippedReason: sharedCarrierReason,
      });
      const { calls, service } = makeService();

      await service.reconcileResolvedDependencyWakeBackstop(backstopOpts(blockerId));
      await service.reconcileResolvedDependencyWakeBackstop(backstopOpts(blockerId));

      expect(calls).toHaveLength(0);
      expect(await countBackstopWithheld(dependentId), "deduped to a single row across passes").toHaveLength(1);
    });

    it("is level-triggered: pass 1 (attributed) withholds, pass 2 (cleared) emits", async () => {
      const { blockerId, dependentId } = await seedBackstopScenario("rs-2pass", {
        publishSkippedReason: sharedCarrierReason,
      });
      const { calls, service } = makeService();

      await service.reconcileResolvedDependencyWakeBackstop(backstopOpts(blockerId));
      expect(calls).toHaveLength(0);
      expect(await countBackstopWithheld(dependentId)).toHaveLength(1);

      // Clear the live marker: republished -> publishedHeadSha set, no publishSkipped.
      await db
        .update(issues)
        .set({ executionState: { approvalStatus: { publishedHeadSha: "republished456" } } })
        .where(eq(issues.id, blockerId));

      await service.reconcileResolvedDependencyWakeBackstop(backstopOpts(blockerId));
      expect(calls, "the wake must be emitted on the cleared pass").toHaveLength(1);
      expect(calls[0]!.agentId).toBe(bsDependentAgentId);
      expect(await countBackstopWithheld(dependentId), "no second withhold row").toHaveLength(1);
    });
  });

  // ---- AC#5b: the recovery HEAL lane (zero-blocker blocked_without_blockers)
  // must NOT re-dispatch / reclassify a parked shared-carrier card. This is the
  // "cannot reclassify the rejected close as dependency restoration" half of AC#5,
  // proved at the real reconcileBlockedWithoutBlockers seam rather than by calling
  // the hasUsableUnblockDescriptor predicate in isolation.
  describe("recovery heal-lane exemption for a parked shared-carrier card (AC#5b)", () => {
    const healCompanyId = randomUUID();
    const healAgentId = randomUUID();

    it("a blocked card carrying the shared-carrier park descriptor is exempted (no re-dispatch, no escalation, card stays blocked)", async () => {
      // loadConfig-based deps resolve against a non-existent config so the bare
      // embedded DB falls back to env-only defaults (same trick as the backstop
      // describe above).
      process.env.PAPERCLIP_CONFIG = path.join(
        os.tmpdir(),
        `paperclip-heal-exempt-test-noconfig-${randomUUID()}.json`,
      );
      process.env.PAPERCLIP_BIND = "loopback";
      await db.insert(companies).values({
        id: healCompanyId,
        name: "Heal-exempt company",
        issuePrefix: "HEAL",
      });
      await db.insert(agents).values([
        { id: healAgentId, companyId: healCompanyId, name: "Heal agent", adapterType: "codex_local", status: "idle" },
      ]);

      const parkedId = randomUUID();
      await db.insert(issues).values({
        id: parkedId,
        companyId: healCompanyId,
        title: "parked shared-carrier card",
        status: "blocked",
        assigneeAgentId: healAgentId,
        workMode: "standard",
        // The EXACT descriptor shape the done-close-landing backstop parks a
        // deadlocked shared-carrier card with: a non-empty board action naming the
        // unblock path.
        unblockDescriptor: {
          owner: "board",
          action:
            "Park resolved by the board: land the shared-carrier branch corp/repo#42 owned by SUP-8888; this card is not a live dependency until it lands.",
        },
      });

      const calls: Array<{ agentId: string }> = [];
      const enqueueWakeup = (async (agentId: string) => {
        calls.push({ agentId });
        return { id: randomUUID() };
      }) as unknown as Parameters<typeof recoveryService>[1]["enqueueWakeup"];
      const service = recoveryService(db, { enqueueWakeup });

      const result = await service.reconcileBlockedWithoutBlockers({
        companyId: healCompanyId,
        now: new Date("2026-09-23T00:00:00Z"),
      });

      // AC#5: the recovery lane leaves the parked card alone — counted as exempt,
      // NOT healed back to `todo` and NOT escalated to the board.
      expect(result.checked).toBe(1);
      expect(result.unblockDescriptorExemptSkipped).toBe(1);
      expect(result.healed).toBe(0);
      expect(result.escalated).toBe(0);
      // No assignee wakeup was enqueued for the parked card.
      expect(calls).toHaveLength(0);
      // The card is still `blocked` — not reclassified.
      const [after] = await db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, parkedId));
      expect(after!.status).toBe("blocked");
    });
  });
});
