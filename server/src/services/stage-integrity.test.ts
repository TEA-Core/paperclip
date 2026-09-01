import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueExecutionDecisions,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import {
  evaluateStageIntegrity,
  type StageIntegrityRecord,
  type StageIntegrityResult,
} from "./stage-integrity.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stage-integrity tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const APPROVAL_STAGE_ID = "00000000-0000-0000-0000-0000000000a1";
const REVIEW_STAGE_ID = "00000000-0000-0000-0000-0000000000a2";
const AGENT_AUTHOR = "22222222-2222-2222-2222-222222222222";
const AGENT_REVIEWER = "11111111-1111-1111-1111-111111111111";
const AGENT_LEAD = "33333333-3333-3333-3333-333333333333";
const USER_REVIEWER = "reviewer-user";
const USER_AUTHOR = "author-user";

const EXECUTION_POLICY = {
  mode: "normal",
  commentRequired: true,
  stages: [{ id: APPROVAL_STAGE_ID, type: "approval", approvalsNeeded: 1 }],
};

// A minimal "clean" execution state: exactly one completed stage, no skipped
// stages, no return assignee. The helper only reads skippedStageIds,
// completedStageIds and returnAssignee, so the rest is intentionally absent.
function cleanState(overrides: Record<string, unknown> = {}) {
  return {
    completedStageIds: [APPROVAL_STAGE_ID],
    returnAssignee: null,
    ...overrides,
  };
}

describeEmbeddedPostgres("stage-integrity (ADR-073 shared predicate)", () => {
  let db: Db;
  let companyId: string;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stage-integrity-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  beforeEach(async () => {
    await db.delete(issueExecutionDecisions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);

    const companyRows = await db
      .insert(companies)
      .values({ name: "Test Company", issuePrefix: "SUP" })
      .returning();
    companyId = companyRows[0]!.id;
  });

  afterEach(async () => {
    await db.delete(issueExecutionDecisions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  async function insertAgent(id: string, name: string) {
    await db.insert(agents).values({ id, companyId, name });
  }

  async function insertIssue(overrides: { createdByAgentId?: string | null; createdByUserId?: string | null } = {}) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Test Issue",
      status: "in_review",
      identifier: "SUP-42",
      executionPolicy: EXECUTION_POLICY,
      executionState: cleanState(),
      createdByAgentId: overrides.createdByAgentId ?? null,
      createdByUserId: overrides.createdByUserId ?? null,
    });
    return issueId;
  }

  async function insertDecision(
    issueId: string,
    overrides: {
      stageId?: string;
      actorAgentId?: string | null;
      actorUserId?: string | null;
      outcome?: string;
      createdAt?: Date;
    } = {},
  ) {
    await db.insert(issueExecutionDecisions).values({
      companyId,
      issueId,
      stageId: overrides.stageId ?? APPROVAL_STAGE_ID,
      stageType: "approval",
      actorAgentId: overrides.actorAgentId ?? null,
      actorUserId: overrides.actorUserId ?? USER_REVIEWER,
      outcome: overrides.outcome ?? "approved",
      body: "Approved",
      createdAt: overrides.createdAt ?? new Date("2026-08-20T00:00:00Z"),
    });
  }

  function record(
    issueId: string,
    overrides: Partial<Pick<StageIntegrityRecord, "createdByAgentId" | "createdByUserId" | "executionState" | "executionPolicy">> = {},
  ): StageIntegrityRecord {
    return {
      id: issueId,
      createdByAgentId: null,
      createdByUserId: null,
      executionState: cleanState(),
      executionPolicy: EXECUTION_POLICY,
      ...overrides,
    };
  }

  function isOk(result: StageIntegrityResult): result is { ok: true } {
    return result.ok === true;
  }

  it("accepts a clean ladder decided by an independent reviewer", async () => {
    await insertAgent(AGENT_REVIEWER, "Reviewer");
    const issueId = await insertIssue();
    await insertDecision(issueId, { actorAgentId: AGENT_REVIEWER });

    const result = await evaluateStageIntegrity(db, record(issueId));

    expect(isOk(result)).toBe(true);
  });

  it("accepts a clean ladder decided by an independent user", async () => {
    const issueId = await insertIssue();
    await insertDecision(issueId, { actorUserId: USER_REVIEWER });

    const result = await evaluateStageIntegrity(db, record(issueId));

    expect(isOk(result)).toBe(true);
  });

  it("refuses a card reaching approval with an auto-skipped stage", async () => {
    const issueId = await insertIssue();
    await insertDecision(issueId);

    const result = await evaluateStageIntegrity(
      db,
      record(issueId, {
        executionState: cleanState({ skippedStageIds: [REVIEW_STAGE_ID] }),
      }),
    );

    expect(result).toEqual({
      ok: false,
      reason: "guard-b:skipped-stage",
      detail: `skipped stages present: ${REVIEW_STAGE_ID}`,
    });
  });

  it("refuses when a completed stage's latest decision was made by the card's author (agent)", async () => {
    await insertAgent(AGENT_AUTHOR, "Author");
    const issueId = await insertIssue({ createdByAgentId: AGENT_AUTHOR });
    await insertDecision(issueId, { actorAgentId: AGENT_AUTHOR });

    const result = await evaluateStageIntegrity(db, record(issueId, { createdByAgentId: AGENT_AUTHOR }));

    expect(isOk(result)).toBe(false);
    if (!isOk(result)) {
      expect(result.reason).toBe("guard-b:decision-by-author-or-return-assignee");
    }
  });

  it("refuses when a completed stage's latest decision was made by the card's author (user)", async () => {
    const issueId = await insertIssue({ createdByUserId: USER_AUTHOR });
    await insertDecision(issueId, { actorUserId: USER_AUTHOR });

    const result = await evaluateStageIntegrity(db, record(issueId, { createdByUserId: USER_AUTHOR }));

    expect(isOk(result)).toBe(false);
    if (!isOk(result)) {
      expect(result.reason).toBe("guard-b:decision-by-author-or-return-assignee");
    }
  });

  it("refuses when a completed stage's latest decision was made by the returnAssignee", async () => {
    await insertAgent(AGENT_LEAD, "Lead");
    const issueId = await insertIssue();
    await insertDecision(issueId, { actorAgentId: AGENT_LEAD });

    const result = await evaluateStageIntegrity(
      db,
      record(issueId, {
        executionPolicy: { ...EXECUTION_POLICY, returnAssigneeAgentId: AGENT_LEAD },
      }),
    );

    expect(isOk(result)).toBe(false);
    if (!isOk(result)) {
      expect(result.reason).toBe("guard-b:decision-by-author-or-return-assignee");
    }
  });

  it("honours the LATEST decision: an author's earlier decision superseded by a reviewer passes", async () => {
    await insertAgent(AGENT_AUTHOR, "Author");
    await insertAgent(AGENT_REVIEWER, "Reviewer");
    const issueId = await insertIssue({ createdByAgentId: AGENT_AUTHOR });
    await insertDecision(issueId, {
      actorAgentId: AGENT_AUTHOR,
      createdAt: new Date("2026-08-19T00:00:00Z"),
    });
    await insertDecision(issueId, {
      actorAgentId: AGENT_REVIEWER,
      createdAt: new Date("2026-08-20T00:00:00Z"),
    });

    const result = await evaluateStageIntegrity(db, record(issueId, { createdByAgentId: AGENT_AUTHOR }));

    expect(isOk(result)).toBe(true);
  });

  it("refuses a card with a completed stage lacking a decision row", async () => {
    const issueId = await insertIssue();
    // No decision row is inserted for the completed approval stage.

    const result = await evaluateStageIntegrity(db, record(issueId));

    expect(result).toEqual({
      ok: false,
      reason: "guard-b:stage-without-decision",
      detail: `completed stage ${APPROVAL_STAGE_ID} has no issue_execution_decisions row`,
    });
  });

  it("refuses when no completed stage is recorded", async () => {
    const issueId = await insertIssue();

    const result = await evaluateStageIntegrity(
      db,
      record(issueId, { executionState: cleanState({ completedStageIds: [] }) }),
    );

    expect(result).toEqual({
      ok: false,
      reason: "guard-b:no-completed-stage",
      detail: "no completed stages recorded in executionState",
    });
  });

  it("refuses when a completed stage is not in the execution policy", async () => {
    const issueId = await insertIssue();

    const result = await evaluateStageIntegrity(
      db,
      record(issueId, {
        executionState: cleanState({ completedStageIds: [APPROVAL_STAGE_ID, REVIEW_STAGE_ID] }),
      }),
    );

    expect(result).toEqual({
      ok: false,
      reason: "guard-b:stage-not-in-policy",
      detail: `completed stage ${REVIEW_STAGE_ID} is not in executionPolicy.stages`,
    });
  });

  it("fails closed when the execution state is missing entirely (unverifiable)", async () => {
    const issueId = await insertIssue();

    const result = await evaluateStageIntegrity(db, record(issueId, { executionState: null }));

    // No completed stages recorded → refusal (a first stamp may not be issued
    // on a record we cannot verify — ADR-091 D4).
    expect(isOk(result)).toBe(false);
    if (!isOk(result)) {
      expect(result.reason).toBe("guard-b:no-completed-stage");
    }
  });
});
