import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

d("issue checkout by the pending-stage participant", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-diag-ck-");
    db = createDb(tempDb.connectionString);
  }, 30_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  it("keeps an in_review card with a pending approval stage in_review when its participant checks it out", async () => {
    const svc = issueService(db);
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    const cto = randomUUID();
    await db.insert(agents).values({ id: cto, companyId, name: "exec-CTO", role: "cto", status: "active", reportsTo: null, adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const stageId = randomUUID();
    const participant = { type: "agent", agentId: cto, userId: null };
    const issue = await svc.create(companyId, { title: "orphan probe", description: null, status: "in_review", priority: "medium", assigneeAgentId: cto });
    await db.update(issues).set({
      executionPolicy: { mode: "normal", commentRequired: true, stages: [{ id: stageId, type: "approval", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "agent", agentId: cto, userId: null }] }] },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "approval", currentParticipant: participant, returnAssignee: participant, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, changesRequestedCount: 0 },
    }).where(eq(issues.id, issue.id));

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: cto, status: "running", contextSnapshot: { issueId: issue.id } });
    const checkedOut = await svc.checkout(issue.id, cto, ["todo", "backlog", "blocked", "in_review", "in_progress"], runId);
    const persisted = await db.select({ status: issues.status, state: issues.executionState }).from(issues).where(eq(issues.id, issue.id)).then((r) => r[0]);
    expect(checkedOut.status).toBe("in_review");
    expect((persisted.state as { status?: string } | null)?.status).toBe("pending");
    expect(persisted.status).toBe("in_review");
  }, 60_000);
});
