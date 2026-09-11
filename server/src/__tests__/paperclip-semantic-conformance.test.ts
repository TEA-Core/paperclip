import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  CAPABILITY_HIGH_RISK_SEMANTIC_VECTORS,
  CAPABILITY_SEMANTIC_CONFORMANCE_IDS,
  CapabilityMockSemanticConformanceAdapter,
  runSemanticConformanceKit,
} from "../vendor/paperclip-runner/testing.js";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  PaperclipProductionSemanticConformanceAdapter,
  seedPaperclipSemanticConformance,
  type PaperclipSemanticConformanceIds,
} from "./helpers/paperclip-semantic-conformance.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-semantic-conformance-home";
  process.env.PAPERCLIP_INSTANCE_ID = "semantic-conformance";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-semantic-conformance-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const embeddedSupport = await getEmbeddedPostgresTestSupport();
const describeEmbedded = embeddedSupport.supported ? describe : describe.skip;

if (!embeddedSupport.supported) {
  console.warn(`Skipping semantic production conformance: ${embeddedSupport.reason ?? "unsupported host"}`);
}

describeEmbedded("Paperclip semantic mock/production conformance", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let mock: CapabilityMockSemanticConformanceAdapter | null = null;

  const base = CAPABILITY_SEMANTIC_CONFORMANCE_IDS;
  const ids: PaperclipSemanticConformanceIds = {
    companyId: base.companyId,
    actorId: base.actorId,
    foreignCompanyId: "20000000-0000-4000-8000-000000000002",
    foreignTaskId: base.foreignTaskId,
    blockerTaskId: base.blockerTaskId,
    worlds: {
      default: { taskId: base.defaultTaskId, runId: base.defaultRunId, capabilities: [] },
      "cross-company": {
        taskId: base.crossCompanyTaskId,
        runId: base.crossCompanyRunId,
        capabilities: ["dependencies:write"],
      },
      interaction: { taskId: base.interactionTaskId, runId: base.interactionRunId, capabilities: [] },
      "terminal-blocked": {
        taskId: base.blockedTerminalTaskId,
        runId: base.blockedTerminalRunId,
        capabilities: [],
      },
      terminal: { taskId: base.terminalTaskId, runId: base.terminalRunId, capabilities: [] },
    },
  };

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-semantic-conformance-");
    const db = createDb(temporary.connectionString);
    await seedPaperclipSemanticConformance(db, ids);
    mock = await CapabilityMockSemanticConformanceAdapter.create();
  }, 30_000);

  afterAll(async () => {
    await mock?.stop();
    await temporary?.cleanup();
  });

  it("matches authorization, state, audit, retry, document, continuation, and terminal semantics", async () => {
    if (!temporary || !mock) throw new Error("semantic_conformance_fixture_not_started");
    const production = await PaperclipProductionSemanticConformanceAdapter.create(
      createDb(temporary.connectionString),
      ids,
    );

    // TEA-Core fork: every non-board close to `done` must carry a done-tier declaration in its
    // close comment (SUP-12693; board actors are the only exemption), which upstream's semantic
    // contract does not model. So the finish_task vectors run through BOTH adapters with a Tier-1
    // declaration appended to the summary — mock and production must still agree on every other
    // field — and one production-only check pins the divergence: an undeclared close is refused.
    const TIER_1_DECLARATION =
      "Closed at Tier 1 (landed, not liveness-probed): semantic conformance fixture. Liveness unverified.";
    const upstreamVectors = CAPABILITY_HIGH_RISK_SEMANTIC_VECTORS.filter(
      (vector) => vector.operationId !== "finish_task",
    );
    const finishVectors = CAPABILITY_HIGH_RISK_SEMANTIC_VECTORS.filter(
      (vector) => vector.operationId === "finish_task",
    );
    const tierDeclaredFinishVectors = finishVectors.map((vector) => {
      const input = vector.input as { idempotencyKey: string; summary: string };
      return {
        ...vector,
        id: `${vector.id}-tier-declared`,
        input: {
          ...input,
          idempotencyKey: `${input.idempotencyKey}-tier-declared`,
          summary: `${input.summary}\n\n${TIER_1_DECLARATION}`,
        },
      };
    });
    expect(finishVectors.map((vector) => vector.id)).toEqual(["terminal-with-dependency", "terminal-finish"]);

    const report = await runSemanticConformanceKit({
      vectors: upstreamVectors,
      adapters: [mock, production],
    });

    expect(report.rows).toHaveLength(upstreamVectors.length);
    expect(report.rows.every((row) => row.adapterIds.join(",") === "capability-mock,paperclip-production-services"))
      .toBe(true);
    expect(report.rows.find((row) => row.vectorId === "progress-duplicate-retry")?.observation.audit)
      .toEqual([]);
    expect(report.rows.find((row) => row.vectorId === "document-stale-revision")?.observation.authorization)
      .toEqual({ outcome: "denied", code: "document_revision_conflict" });
    expect(report.rows.find((row) => row.vectorId === "continuation-request")?.observation.state)
      .toMatchObject({ interactions: [{ continuationPolicy: "wake_assignee" }] });
    expect(report.rows.every((row) => row.observation.receipt?.operationReceiptPresent === true))
      .toBe(true);

    // The divergence itself: production refuses an undeclared close and leaves the task open.
    const undeclared = await production.execute(finishVectors[0]!);
    expect(undeclared.authorization).toEqual({ outcome: "denied", code: "semantic_rule_violation" });
    expect(undeclared.state).toMatchObject({ task: { status: "in_progress" } });

    const finishReport = await runSemanticConformanceKit({
      vectors: tierDeclaredFinishVectors,
      adapters: [mock, production],
    });
    expect(finishReport.rows).toHaveLength(2);
    expect(finishReport.rows.find((row) => row.vectorId === "terminal-with-dependency-tier-declared")?.observation.state)
      .toMatchObject({ task: { status: "done" }, dependencies: [expect.any(String)] });
    expect(finishReport.rows.find((row) => row.vectorId === "terminal-finish-tier-declared")?.observation.state)
      .toMatchObject({ task: { status: "done" } });
  }, 30_000);
});
