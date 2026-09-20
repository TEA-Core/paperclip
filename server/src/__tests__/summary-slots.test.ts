import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  companies,
  createDb,
  documentRevisions,
  documents,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  projectWorkspaces,
  projects,
  summarySlots,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { writeSummarySlotSchema, type WriteSummarySlotResponse } from "@paperclipai/shared";
import {
  resolveSummaryGenerationReturnAssignee,
  summarySlotService,
} from "../services/summary-slots.ts";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
} from "../services/issue-execution-policy.ts";
import { withBuiltInAgentMarker } from "../services/built-in-agent-metadata.ts";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres summary-slot tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("summary slot service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-summary-slots-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(summarySlots);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issueRecoveryActions);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(activityLog);
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
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function seedProject(companyId: string) {
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "Paperclip App" });
    return projectId;
  }

  async function seedProjectWorkspace(companyId: string, projectId: string) {
    const projectWorkspaceId = randomUUID();
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary workspace",
    });
    return projectWorkspaceId;
  }

  async function seedExecutionWorkspace(
    companyId: string,
    projectId: string,
    projectWorkspaceId: string | null = null,
  ) {
    const executionWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: `Execution workspace ${executionWorkspaceId}`,
    });
    return executionWorkspaceId;
  }

  async function seedSummarizer(companyId: string, ready = true) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Summarizer",
      role: "general",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: ready ? { model: "gpt-5.4" } : {},
      metadata: withBuiltInAgentMarker(null, { key: "summarizer", featureKeys: ["summarizer"] }),
    });
    return agentId;
  }

  async function seedPlainAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { model: "gpt-5.4" },
    });
    return agentId;
  }

  async function seedRun(companyId: string, agentId: string, issueId?: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      // Finalization attributes the slot's surviving revision back to the issue that
      // drove it via the writing run's context snapshot (see
      // summary-slot-finalization.ts). Name the driving issue so a real write is
      // correctly classified as this generation's own.
      contextSnapshot: issueId ? { issueId } : {},
    });
    return runId;
  }

  function projectSelector(companyId: string, projectId: string) {
    return { companyId, scopeKind: "project", slotKey: "header", scopeId: projectId };
  }

  function executionWorkspaceSelector(companyId: string, executionWorkspaceId: string) {
    return {
      companyId,
      scopeKind: "execution_workspace",
      slotKey: "header",
      scopeId: executionWorkspaceId,
    };
  }

  describe("reads and target visibility", () => {
    it("returns an empty slot state before any generation", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const svc = summarySlotService(db);
      const result = await svc.getSlot(projectSelector(companyId, projectId));
      expect(result).toEqual({ slot: null, document: null, generatingIssue: null });
    });

    it("rejects targets that do not exist in the company", async () => {
      const companyId = await seedCompany();
      const svc = summarySlotService(db);
      await expect(svc.getSlot(projectSelector(companyId, randomUUID()))).rejects.toMatchObject({
        status: 404,
      });
    });

    it("rejects a project owned by another company (company scoping)", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany();
      const foreignProjectId = await seedProject(otherCompanyId);
      const svc = summarySlotService(db);
      await expect(svc.getSlot(projectSelector(companyId, foreignProjectId))).rejects.toMatchObject({
        status: 404,
      });
    });

    it("rejects an execution workspace owned by another company", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany();
      const otherProjectId = await seedProject(otherCompanyId);
      const foreignExecutionWorkspaceId = await seedExecutionWorkspace(otherCompanyId, otherProjectId);
      const svc = summarySlotService(db);

      await expect(
        svc.getSlot(executionWorkspaceSelector(companyId, foreignExecutionWorkspaceId)),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("rejects a workspaces_overview selector that carries a scopeId", async () => {
      const companyId = await seedCompany();
      const svc = summarySlotService(db);
      await expect(
        svc.getSlot({ companyId, scopeKind: "workspaces_overview", slotKey: "header", scopeId: randomUUID() }),
      ).rejects.toMatchObject({ status: 422 });
    });
  });

  describe("generate", () => {
    it("fails when the Summarizer built-in is not configured", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const svc = summarySlotService(db);
      await expect(
        svc.generate(projectSelector(companyId, projectId), { userId: "board-user" }),
      ).rejects.toMatchObject({ status: 422, details: { code: "summarizer_not_configured" } });
    });

    it("creates a summarizer task, links it, and marks the slot generating", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const otherProjectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      await db.insert(issues).values([
        {
          companyId,
          projectId,
          identifier: `${issuePrefix(companyId)}-101`,
          issueNumber: 101,
          title: "Waiting on board approval",
          status: "blocked",
          priority: "high",
        },
        {
          companyId,
          projectId,
          identifier: `${issuePrefix(companyId)}-102`,
          issueNumber: 102,
          title: "Implement summary cards",
          status: "in_progress",
          priority: "medium",
        },
        {
          companyId,
          projectId,
          identifier: `${issuePrefix(companyId)}-103`,
          issueNumber: 103,
          title: "Ship the previous summary",
          status: "done",
          priority: "low",
        },
        {
          companyId,
          projectId: otherProjectId,
          identifier: `${issuePrefix(companyId)}-104`,
          issueNumber: 104,
          title: "Other project issue",
          status: "blocked",
          priority: "critical",
        },
      ]);

      const result = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });

      expect(result.alreadyGenerating).toBe(false);
      expect(result.slot.status).toBe("generating");
      expect(result.slot.generatingIssueId).toBe(result.generatingIssue.id);

      const issueRow = await db
        .select()
        .from(issues)
        .where(eq(issues.id, result.generatingIssue.id))
        .then((rows) => rows[0]!);
      expect(issueRow.assigneeAgentId).toBe(summarizerAgentId);
      expect(issueRow.companyId).toBe(companyId);
      expect(issueRow.title).toMatch(/^Summarize project on \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
      expect(issueRow.hiddenAt).toBeInstanceOf(Date);
      expect(issueRow.description).toContain(
        '"generationIssueId": "' + result.generatingIssue.id + '"',
      );
      expect(issueRow.description).toContain("Call `/summarize-status`");
      expect(issueRow.description).not.toContain("Follow the Summarizer skill");
      expect(issueRow.description).toContain(
        `GET /api/companies/${companyId}/summary-slots/project/header?scopeId=${projectId}`,
      );
      expect(issueRow.description).not.toContain(
        "do not call the revisions or issues-list endpoints",
      );
      expect(issueRow.description).toContain(
        `PUT /api/companies/${companyId}/summary-slots/project/header`,
      );
      expect(issueRow.description).toContain(
        "opens with the 1–3 specific, concrete, actionable items",
      );
      expect(issueRow.description).toContain("unblock this work");
      expect(issueRow.description).toContain(
        "read whatever issues you need to understand the state",
      );
      expect(issueRow.description).toContain(
        "a reader who has not memorized issue ids or threads",
      );
      expect(issueRow.description).toContain(
        "a trailing list of issue links or any link dump",
      );
      expect(issueRow.description).toContain("Not a task list");
      expect(issueRow.description).toContain(
        "first plain-text `STATUS:` line immediately",
      );
      expect(issueRow.description).toContain("sentinel-wrapped summary draft");
      expect(issueRow.description).toContain("## Prebuilt scope snapshot");
      expect(issueRow.description).toContain("### Blocked");
      expect(issueRow.description).toContain("Waiting on board approval");
      expect(issueRow.description).toContain("### In progress");
      expect(issueRow.description).toContain("Implement summary cards");
      expect(issueRow.description).toContain("### Recently done");
      expect(issueRow.description).toContain("Ship the previous summary");
      expect(issueRow.description).toContain(`/${issuePrefix(companyId)}/issues/`);
      expect(issueRow.description).not.toContain("/PAP/issues/");
      expect(issueRow.description).not.toContain("Other project issue");
    });

    it("does not label the token block as the PUT request body and documents the actual body shape", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      const result = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      const issueRow = await db
        .select()
        .from(issues)
        .where(eq(issues.id, result.generatingIssue.id))
        .then((rows) => rows[0]!);
      const description = issueRow.description!;

      // The token block must NOT be labelled as the write payload / request body.
      expect(description).not.toContain("Use this write payload:");
      // It IS explicitly labelled as not the request body.
      expect(description).toContain("NOT the request body");

      // The PUT body fields are documented with markdown as the only required one.
      expect(description).toContain("`markdown` (string, required)");
      expect(description).toContain("unknown fields are rejected");

      // The write route shows scopeId resolution (matching the read route discipline).
      expect(description).toContain(
        `PUT /api/companies/${companyId}/summary-slots/project/header?scopeId=${projectId}`,
      );

      // The token is still parseable by the same regex the server uses.
      const tokenMatch = description.match(/```json\n([\s\S]*?)\n```/);
      expect(tokenMatch).not.toBeNull();
      const token = JSON.parse(tokenMatch![1]);
      expect(token).toEqual({
        scopeKind: "project",
        scopeId: projectId,
        slotKey: "header",
        generationIssueId: result.generatingIssue.id,
      });

      // The documented body shape round-trips through writeSummarySlotSchema.
      const body = {
        markdown: "Test summary",
        generationIssueId: result.generatingIssue.id,
        baseRevisionId: null,
        model: "test-model",
      };
      expect(() => writeSummarySlotSchema.parse(body)).not.toThrow();

      // Unknown fields (the token keys sent as a body) are rejected.
      expect(() =>
        writeSummarySlotSchema.parse({ ...body, scopeKind: "project", slotKey: "header" }),
      ).toThrow();
    });

    it("keeps summaries and snapshots isolated between execution workspaces", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const projectWorkspaceId = await seedProjectWorkspace(companyId, projectId);
      const firstExecutionWorkspaceId = await seedExecutionWorkspace(companyId, projectId, projectWorkspaceId);
      const secondExecutionWorkspaceId = await seedExecutionWorkspace(companyId, projectId, projectWorkspaceId);
      await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      await db.insert(issues).values([
        {
          companyId,
          projectId,
          projectWorkspaceId,
          executionWorkspaceId: firstExecutionWorkspaceId,
          identifier: `${issuePrefix(companyId)}-201`,
          issueNumber: 201,
          title: "First workspace task",
          status: "in_progress",
          priority: "medium",
        },
        {
          companyId,
          projectId,
          projectWorkspaceId,
          executionWorkspaceId: secondExecutionWorkspaceId,
          identifier: `${issuePrefix(companyId)}-202`,
          issueNumber: 202,
          title: "Second workspace task",
          status: "blocked",
          priority: "high",
        },
      ]);

      const firstSelector = executionWorkspaceSelector(companyId, firstExecutionWorkspaceId);
      const secondSelector = executionWorkspaceSelector(companyId, secondExecutionWorkspaceId);
      const generated = await svc.generate(firstSelector, { userId: "board-user" });

      expect(generated.slot).toMatchObject({
        scopeKind: "execution_workspace",
        scopeId: firstExecutionWorkspaceId,
        status: "generating",
      });
      const generationIssue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, generated.generatingIssue.id))
        .then((rows) => rows[0]!);
      expect(generationIssue.description).toContain("First workspace task");
      expect(generationIssue.description).not.toContain("Second workspace task");
      expect(generationIssue.description).toContain('"scopeKind": "execution_workspace"');
      expect(generationIssue.description).toContain(`"scopeId": "${firstExecutionWorkspaceId}"`);
      await expect(svc.getSlot(secondSelector)).resolves.toEqual({
        slot: null,
        document: null,
        generatingIssue: null,
      });
    });

    it("dedupes concurrent generate clicks without creating an orphan task", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      const [first, second] = await Promise.all([
        svc.generate(projectSelector(companyId, projectId), { userId: "board-user" }),
        svc.generate(projectSelector(companyId, projectId), { userId: "board-user" }),
      ]);

      expect(second.generatingIssue.id).toBe(first.generatingIssue.id);
      expect([first.alreadyGenerating, second.alreadyGenerating].sort()).toEqual([false, true]);

      const issueRows = await db.select().from(issues).where(eq(issues.companyId, companyId));
      expect(issueRows).toHaveLength(1);
    });

    it("creates a fresh task once the previous generation task is terminal", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      const first = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      await issueService(db).update(first.generatingIssue.id, { status: "done" });

      const failed = await svc.getSlot(projectSelector(companyId, projectId));
      expect(failed.slot).toMatchObject({
        status: "failed",
        generatingIssueId: null,
        failureReason: expect.stringContaining("finished without writing a summary"),
      });

      const second = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      expect(second.alreadyGenerating).toBe(false);
      expect(second.generatingIssue.id).not.toBe(first.generatingIssue.id);
      expect(second.slot).toMatchObject({
        status: "generating",
        failureReason: null,
        generatingIssueId: second.generatingIssue.id,
      });

      const issueRows = await db.select().from(issues).where(eq(issues.companyId, companyId));
      expect(issueRows).toHaveLength(2);
    });

    it("marks the slot failed when its generation task is cancelled without a write", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      const generated = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      await issueService(db).update(generated.generatingIssue.id, { status: "cancelled" });

      const result = await svc.getSlot(projectSelector(companyId, projectId));
      expect(result.slot).toMatchObject({
        status: "failed",
        generatingIssueId: null,
        failureReason: expect.stringContaining("was cancelled before writing a summary"),
      });
    });

    it("classifies a new generation over an inherited document as failed when it never writes (stale-document regression)", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      // A PRIOR generation wrote and finished, leaving a document + last_generated_at
      // that survive across generations (upsertSlot never clears them).
      const priorDoc = await db
        .insert(documents)
        .values({
          companyId,
          format: "markdown",
          latestBody: "# Prior generation summary",
        })
        .returning()
        .then((rows) => rows[0]!);
      await db.insert(summarySlots).values({
        companyId,
        scopeKind: "project",
        slotKey: "header",
        scopeId: projectId,
        documentId: priorDoc.id,
        status: "idle",
        generatingIssueId: null,
        lastGeneratedAt: new Date("2020-01-01T00:00:00.000Z"),
      });

      // Arm a FRESH generation over the inherited slot, then cancel it without writing.
      const generated = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      const armed = await db
        .select()
        .from(summarySlots)
        .where(eq(summarySlots.companyId, companyId))
        .then((rows) => rows[0]!);
      // The new generation inherited the prior document + timestamp but is fresh.
      expect(armed.documentId).toBe(priorDoc.id);
      expect(armed.status).toBe("generating");

      await issueService(db).update(generated.generatingIssue.id, { status: "cancelled" });

      // A present document must NOT mark this never-written generation as `idle`.
      const result = await svc.getSlot(projectSelector(companyId, projectId));
      expect(result.slot).toMatchObject({
        status: "failed",
        generatingIssueId: null,
        failureReason: expect.stringContaining("was cancelled before writing a summary"),
      });
    });

    it("classifies an unwritten generation as failed when it inherits a prior generation's real write (identity regression)", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      // A PRIOR generation lands a REAL write: a document + revision + a writing run
      // whose context snapshot names that prior generation issue. This is the
      // surviving revision the next generation will inherit.
      const first = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      const priorRunId = await seedRun(companyId, summarizerAgentId, first.generatingIssue.id);
      await db
        .update(issues)
        .set({ checkoutRunId: priorRunId })
        .where(eq(issues.id, first.generatingIssue.id));
      const priorWrite = await svc.write(
        {
          ...projectSelector(companyId, projectId),
          markdown: "# Prior generation summary",
          generationIssueId: first.generatingIssue.id,
        },
        { agentId: summarizerAgentId, runId: priorRunId },
      );
      expect(priorWrite.revision.revisionNumber).toBe(1);

      // The prior generation finished and DID write, so it finalizes to idle, leaving
      // the real revision + document that survive across generations.
      await issueService(db).update(first.generatingIssue.id, { status: "done" });
      const afterFirst = await svc.getSlot(projectSelector(companyId, projectId));
      expect(afterFirst.slot).toMatchObject({ status: "idle", documentId: afterFirst.document!.id });

      // Arm a FRESH generation over the inherited slot, then cancel it without writing.
      const second = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });

      // COLLISION SETUP: place the later generation's creation instant one millisecond
      // before the surviving revision's `last_generated_at`, in the prior write's
      // normalized millisecond. Under the rejected strict
      // `last_generated_at > created_at` discriminator that ordering reads as "this
      // generation wrote" and would classify it `idle`; only generation identity can
      // tell the inherited prior write from a current-generation write. The write
      // evidence (`last_generated_at`, stamped by `write()`) is NOT mutated — only the
      // later generation's creation boundary is arranged, the boundary a resubmit
      // race can produce. Setting it equal to the write (the prior review's mutated
      // setup) would make the strict `>` false and let the rejected heuristic also
      // pass, so the boundary must sit strictly before the write.
      const lastWrittenAt = afterFirst.slot.lastGeneratedAt!;
      expect(lastWrittenAt).toBeInstanceOf(Date);
      await db
        .update(issues)
        .set({ createdAt: new Date(lastWrittenAt.getTime() - 1) })
        .where(eq(issues.id, second.generatingIssue.id));
      const laterGeneration = await db
        .select({ createdAt: issues.createdAt })
        .from(issues)
        .where(eq(issues.id, second.generatingIssue.id))
        .then((rows) => rows[0]!);
      // Read-back proves the normalized boundary is strictly before the write, i.e.
      // `last_generated_at > created_at` holds: the rejected strict heuristic would
      // classify this unwritten generation `idle` (wrong); identity classifies it
      // `failed` (right).
      expect(lastWrittenAt.getTime()).toBeGreaterThan(laterGeneration.createdAt.getTime());

      const armed = await db
        .select()
        .from(summarySlots)
        .where(eq(summarySlots.companyId, companyId))
        .then((rows) => rows[0]!);
      // The new generation inherited the prior document but wrote nothing.
      expect(armed.documentId).toBe(afterFirst.document!.id);
      expect(armed.status).toBe("generating");

      await issueService(db).update(second.generatingIssue.id, { status: "cancelled" });

      // The surviving revision was created by the PRIOR generation's run, not this
      // one. Identity must mark this never-written generation `failed`, not `idle` —
      // a timestamp in the same normalized millisecond as the inherited write cannot
      // tell the two apart, but the writing run's context snapshot can.
      const result = await svc.getSlot(projectSelector(companyId, projectId));
      expect(result.slot).toMatchObject({
        status: "failed",
        generatingIssueId: null,
        failureReason: expect.stringContaining("was cancelled before writing a summary"),
      });
    });
  });

  describe("dead generation binding reclaim (SUP-16945)", () => {
    const GRACE_MS = 30 * 60 * 1_000;

    async function ageSlotBinding(issueId: string, ageMs: number) {
      // The dead-binding age predicate measures from the slot's arm time
      // (summary_slots.updated_at), so backdate the SLOT to age the binding — not
      // the issue row.
      await db
        .update(summarySlots)
        .set({ updatedAt: new Date(Date.now() - ageMs) })
        .where(eq(summarySlots.generatingIssueId, issueId));
    }

    it("reclaims a dead non-terminal binding on generate and re-arms a fresh generation", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      const first = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      expect(first.alreadyGenerating).toBe(false);
      expect(first.slot.status).toBe("generating");

      // The generation task loses its live path but is never terminal: no run, no
      // recovery action, and aged past the reclaim grace. This is the wedge.
      await ageSlotBinding(first.generatingIssue.id, GRACE_MS + 5 * 60 * 1_000);

      const second = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      expect(second.alreadyGenerating).toBe(false);
      expect(second.generatingIssue.id).not.toBe(first.generatingIssue.id);
      expect(second.slot).toMatchObject({
        status: "generating",
        generatingIssueId: second.generatingIssue.id,
      });
    });

    it("reclaims a dead non-terminal binding on getSlot and clears the slot to an un-wedged state", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      const generated = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      await ageSlotBinding(generated.generatingIssue.id, GRACE_MS + 5 * 60 * 1_000);

      const result = await svc.getSlot(projectSelector(companyId, projectId));
      // The slot is no longer wedged: binding cleared and completed to failed (the
      // dead generation never wrote a surviving revision) so the refresh sweep can
      // regenerate.
      expect(result.slot!.status).toBe("failed");
      expect(result.slot!.generatingIssueId).toBeNull();
      expect(result.slot!.failureReason).toContain("stopped before writing a summary");
      expect(result.generatingIssue).toBeNull();

      // A subsequent generate re-arms a fresh task (the wedge is gone).
      const regenerated = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      expect(regenerated.alreadyGenerating).toBe(false);
      expect(regenerated.slot.status).toBe("generating");
      expect(regenerated.slot.generatingIssueId).toBe(regenerated.generatingIssue.id);
    });

    it("does NOT reclaim a healthy in-flight generation that holds a live run", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      const generated = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      const runId = await seedRun(companyId, summarizerAgentId, generated.generatingIssue.id);
      // In flight: the generation task is bound to a live run.
      await db
        .update(issues)
        .set({ executionRunId: runId })
        .where(eq(issues.id, generated.generatingIssue.id));
      await ageSlotBinding(generated.generatingIssue.id, GRACE_MS + 5 * 60 * 1_000);

      const result = await svc.getSlot(projectSelector(companyId, projectId));
      expect(result.slot!.status).toBe("generating");
      expect(result.slot!.generatingIssueId).toBe(generated.generatingIssue.id);
      expect(result.generatingIssue?.id).toBe(generated.generatingIssue.id);

      const again = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      expect(again.alreadyGenerating).toBe(true);
      expect(again.generatingIssue.id).toBe(generated.generatingIssue.id);
    });

    it("does NOT reclaim a dead-looking generation that still has an active recovery action", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      const generated = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      await db.insert(issueRecoveryActions).values({
        companyId,
        sourceIssueId: generated.generatingIssue.id,
        kind: "active_run_watchdog",
        status: "active",
        ownerType: "agent",
        cause: "stuck_generation",
        fingerprint: randomUUID(),
        evidence: {},
        nextAction: "Recover the stalled summary generation.",
      });
      await ageSlotBinding(generated.generatingIssue.id, GRACE_MS + 5 * 60 * 1_000);

      const result = await svc.getSlot(projectSelector(companyId, projectId));
      expect(result.slot!.status).toBe("generating");
      expect(result.slot!.generatingIssueId).toBe(generated.generatingIssue.id);
    });

    it("does NOT reclaim a freshly armed generation inside the grace window", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      const generated = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      // No run, no recovery, but only seconds old — inside the grace window.
      const result = await svc.getSlot(projectSelector(companyId, projectId));
      expect(result.slot!.status).toBe("generating");
      expect(result.slot!.generatingIssueId).toBe(generated.generatingIssue.id);

      const again = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      expect(again.alreadyGenerating).toBe(true);
    });

    it("leaves idle slots untouched by the dead-binding reclaim", async () => {
      const companyId = await seedCompany();
      const projectA = await seedProject(companyId);
      const projectB = await seedProject(companyId);
      await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      // Two genuinely-idle slots (idle status, no generating binding) with their own
      // documents — the reclaim must not touch them.
      const docA = await db
        .insert(documents)
        .values({ companyId, format: "markdown", latestBody: "# A" })
        .returning()
        .then((rows) => rows[0]!);
      const docB = await db
        .insert(documents)
        .values({ companyId, format: "markdown", latestBody: "# B" })
        .returning()
        .then((rows) => rows[0]!);
      await db.insert(summarySlots).values([
        {
          companyId,
          scopeKind: "project",
          slotKey: "header",
          scopeId: projectA,
          documentId: docA.id,
          status: "idle",
          generatingIssueId: null,
        },
        {
          companyId,
          scopeKind: "project",
          slotKey: "header",
          scopeId: projectB,
          documentId: docB.id,
          status: "idle",
          generatingIssueId: null,
        },
      ]);

      const [slotA, slotB] = await Promise.all([
        svc.getSlot(projectSelector(companyId, projectA)),
        svc.getSlot(projectSelector(companyId, projectB)),
      ]);
      expect(slotA.slot).toMatchObject({ status: "idle", generatingIssueId: null, documentId: docA.id });
      expect(slotB.slot).toMatchObject({ status: "idle", generatingIssueId: null, documentId: docB.id });
    });

    it("reclaims a terminal bound issue on getSlot when its terminal transition did not clear the binding", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      const generated = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });

      // Model an orphaned terminal binding: the generating issue is terminal but its
      // terminal transition did NOT clear the slot binding (legacy data or an
      // interrupted transition). A direct status write bypasses the normal
      // finalizeSummarySlotsForTerminalIssue release path, leaving the slot still
      // armed to a terminal issue.
      await db
        .update(issues)
        .set({ status: "cancelled" })
        .where(eq(issues.id, generated.generatingIssue.id));

      // The read path reclaims it: a terminal generation can never write a summary,
      // so the binding is dead without any age / live-run / recovery check.
      const result = await svc.getSlot(projectSelector(companyId, projectId));
      expect(result.slot!.status).toBe("failed");
      expect(result.slot!.generatingIssueId).toBeNull();
      expect(result.slot!.failureReason).toContain("stopped before writing a summary");
      expect(result.generatingIssue).toBeNull();

      // A subsequent generate re-arms a fresh task instead of the dead terminal one.
      const regenerated = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      expect(regenerated.alreadyGenerating).toBe(false);
      expect(regenerated.generatingIssue.id).not.toBe(generated.generatingIssue.id);
      expect(regenerated.slot.status).toBe("generating");
    });

    it("measures binding age from the slot arm time, not the issue creation time", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      const generated = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });

      // Make the ISSUE look old but keep the slot's arm time fresh (within the grace
      // window). If the age predicate read issue.createdAt this would be reclaimed;
      // it must NOT be, because the binding was just armed.
      await db
        .update(issues)
        .set({ createdAt: new Date(Date.now() - (GRACE_MS + 5 * 60 * 1_000)) })
        .where(eq(issues.id, generated.generatingIssue.id));

      const result = await svc.getSlot(projectSelector(companyId, projectId));
      expect(result.slot!.status).toBe("generating");
      expect(result.slot!.generatingIssueId).toBe(generated.generatingIssue.id);
    });
  });

  describe("summarizer writes", () => {
    async function startGeneration(companyId: string, projectId: string, summarizerAgentId: string) {
      const svc = summarySlotService(db);
      const generated = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      const runId = await seedRun(companyId, summarizerAgentId, generated.generatingIssue.id);
      // Simulate the summarizer run checking out its linked generation task.
      await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, generated.generatingIssue.id));
      return { svc, generationIssueId: generated.generatingIssue.id, runId };
    }

    it("writes a board-readable revision, preserves the previous revision, and keeps the slot armed for the live generation task", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const { svc, generationIssueId, runId } = await startGeneration(companyId, projectId, summarizerAgentId);

      const initial = await svc.write(
        {
          ...projectSelector(companyId, projectId),
          markdown:
            "Quiet scope — nothing is in flight and nothing is waiting on you. First summary for this scope.\n\n**Next:** nothing needs a decision from you right now; the next thing worth watching is the first issue landing here.",
          model: "cheap-model",
          generationIssueId,
        },
        { agentId: summarizerAgentId, runId },
      );

      const nextGeneration = await svc.generate(projectSelector(companyId, projectId), {
        userId: "board-user",
      });
      const nextRunId = await seedRun(companyId, summarizerAgentId, nextGeneration.generatingIssue.id);
      await db
        .update(issues)
        .set({ checkoutRunId: nextRunId })
        .where(eq(issues.id, nextGeneration.generatingIssue.id));
      const written = await svc.write(
        {
          ...projectSelector(companyId, projectId),
          markdown:
            "**Decide:**\n- The change is done and the review is sitting with you — [T-123](/T/issues/T-123). **I suggest:** approve it, the tests are green.\n\nNothing else moved since last time.",
          baseRevisionId: initial.revision.id,
          generationIssueId: nextGeneration.generatingIssue.id,
          model: "cheap-model",
        },
        { agentId: summarizerAgentId, runId: nextRunId },
      );

      expect(written.revision.revisionNumber).toBe(2);
      expect(written.document.body).toMatch(/^\*\*Decide:\*\*[\s\S]*\*\*I suggest:\*\*/m);
      expect(written.document.body).not.toMatch(/^Issues: /m);
      expect(written.slot.status).toBe("generating");
      expect(written.slot.generatingIssueId).toBe(generationIssueId);
      expect(written.slot.documentId).toBe(written.document.id);
      expect(written.slot.lastGeneratedByAgentId).toBe(summarizerAgentId);
      expect(written.slot.lastModel).toBe("cheap-model");

      const revisions = await svc.listRevisions(projectSelector(companyId, projectId));
      expect(revisions.revisions).toHaveLength(2);
      expect(revisions.revisions[0]!.id).toBe(written.revision.id);
      expect(revisions.revisions[1]!.id).toBe(initial.revision.id);
      expect(revisions.revisions[1]!.body).toContain("First summary for this scope.");
    });

    it("serializes concurrent writes for the same slot into sequential revisions instead of leaking a revision unique-index violation", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const { svc, generationIssueId, runId } = await startGeneration(companyId, projectId, summarizerAgentId);

      // Pre-seed a document at revision 1 and point the still-generating slot at it so
      // both concurrent writers read the same latestRevisionNumber and both compute the
      // same next revision (the document_revisions_document_revision_uq shape). Because
      // the slot stays armed after a write (SUP-15773), both writes target this document.
      const seedDocumentId = randomUUID();
      await db.insert(documents).values({
        id: seedDocumentId,
        companyId,
        latestBody: "# Seeded",
        latestRevisionNumber: 1,
      });
      await db.insert(documentRevisions).values({
        companyId,
        documentId: seedDocumentId,
        revisionNumber: 1,
        body: "# Seeded",
      });
      await db
        .update(summarySlots)
        .set({ documentId: seedDocumentId })
        .where(
          and(
            eq(summarySlots.companyId, companyId),
            eq(summarySlots.scopeKind, "project"),
            eq(summarySlots.scopeId, projectId),
            eq(summarySlots.slotKey, "header"),
          ),
        );

      const makeWrite = (markdown: string) =>
        svc.write(
          { ...projectSelector(companyId, projectId), markdown, generationIssueId },
          { agentId: summarizerAgentId, runId },
        );

      const settled = await Promise.allSettled([
        makeWrite("# Concurrent write A"),
        makeWrite("# Concurrent write B"),
      ]);

      const fulfilled = settled.filter(
        (r): r is PromiseFulfilledResult<WriteSummarySlotResponse> => r.status === "fulfilled",
      );
      const rejected = settled.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );

      // The slot row lock serializes the two writers: both land, each computing its
      // next revision from the latest document state — never the same revision number.
      // No raw unique-index error is exposed.
      expect(rejected).toHaveLength(0);
      expect(fulfilled).toHaveLength(2);

      const revisionNumbers = fulfilled.map((r) => r.value.revision.revisionNumber).sort((a, b) => a - b);
      expect(revisionNumbers).toEqual([2, 3]);

      // Both revisions land on the same (seeded) document.
      expect(new Set(fulfilled.map((r) => r.value.document.id)).size).toBe(1);
      expect(fulfilled[0]!.value.document.id).toBe(seedDocumentId);

      const revisions = await svc.listRevisions(projectSelector(companyId, projectId));
      expect(revisions.revisions).toHaveLength(3);
      expect(revisions.revisions[0]!.revisionNumber).toBe(3);
      expect(revisions.revisions[2]!.revisionNumber).toBe(1);
    });

    it("allows a second write for the same generation task after a changes_requested bounce, then releases the link only at terminal", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const { svc, generationIssueId, runId } = await startGeneration(companyId, projectId, summarizerAgentId);

      // First revision lands; the slot must stay armed for the still-active task.
      const first = await svc.write(
        { ...projectSelector(companyId, projectId), markdown: "# Summary v1", generationIssueId },
        { agentId: summarizerAgentId, runId },
      );
      expect(first.revision.revisionNumber).toBe(1);
      expect(first.slot.status).toBe("generating");
      expect(first.slot.generatingIssueId).toBe(generationIssueId);

      // The summarizer submits the summary for review. Arm a single review stage
      // whose participant is a board reviewer and whose return assignee is the
      // summarizer — the agent that owns the slot write — so the bounce lands the
      // task back on the same principal that can write the slot.
      const reviewStageId = randomUUID();
      const reviewerUserId = "board-reviewer";
      await issueService(db).update(generationIssueId, {
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          returnAssigneeAgentId: summarizerAgentId,
          stages: [
            {
              id: reviewStageId,
              type: "review",
              approvalsNeeded: 1,
              participants: [{ id: randomUUID(), type: "user", userId: reviewerUserId }],
            },
          ],
        },
        status: "in_review",
        executionState: {
          status: "pending",
          currentStageId: reviewStageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "user", userId: reviewerUserId },
          returnAssignee: { type: "agent", agentId: summarizerAgentId },
          deliveryAuthor: { type: "agent", agentId: summarizerAgentId },
          lastDecisionId: null,
          lastDecisionOutcome: null,
        },
      });

      // Drive the ACTUAL review-bounce through the execution engine: the reviewer
      // requests changes and the engine bounces the SAME generation task back to
      // the summarizer (executionState.status = "changes_requested", issue back
      // in_progress). This is the transition a real changes_requested verdict
      // performs — not a comment, so the regression cannot be faked by a stale
      // slot link.
      const armedIssue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, generationIssueId))
        .then((rows) => rows[0]!);
      const policy = normalizeIssueExecutionPolicy(armedIssue.executionPolicy ?? null);
      const bounce = applyIssueExecutionPolicyTransition({
        issue: armedIssue,
        policy,
        previousPolicy: policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { userId: reviewerUserId },
        commentBody: "Lead with the decision; the draft buries it.",
      });
      expect(bounce.decision?.outcome).toBe("changes_requested");
      await issueService(db).update(
        generationIssueId,
        bounce.patch as Partial<typeof issues.$inferInsert>,
      );
      const bouncedIssue = await db
        .select()
        .from(issues)
        .where(eq(issues.id, generationIssueId))
        .then((rows) => rows[0]!);
      expect(bouncedIssue.status).toBe("in_progress");
      expect(bouncedIssue.assigneeAgentId).toBe(summarizerAgentId);
      expect(bouncedIssue.executionState).toMatchObject({
        status: "changes_requested",
        lastDecisionOutcome: "changes_requested",
      });

      // The bounce hands the task back to the summarizer on a fresh run; the
      // execution engine re-checks out the task, re-stamping checkoutRunId.
      // Mirror that so the write guard's run-match holds.
      const resubmitRunId = await seedRun(companyId, summarizerAgentId, generationIssueId);
      await db
        .update(issues)
        .set({ checkoutRunId: resubmitRunId })
        .where(eq(issues.id, generationIssueId));

      // After the real bounce the SAME generation task writes a corrected revision
      // with no board re-arm in between (SUP-15773).
      const second = await svc.write(
        {
          ...projectSelector(companyId, projectId),
          markdown: "# Summary v2 (corrected)",
          baseRevisionId: first.revision.id,
          generationIssueId,
        },
        { agentId: summarizerAgentId, runId: resubmitRunId },
      );
      expect(second.revision.revisionNumber).toBe(2);
      expect(second.slot.status).toBe("generating");
      expect(second.slot.generatingIssueId).toBe(generationIssueId);

      // The link is cleared exactly once, at the terminal transition.
      await issueService(db).update(generationIssueId, { status: "done" });
      const afterTerminal = await svc.getSlot(projectSelector(companyId, projectId));
      expect(afterTerminal.slot).toMatchObject({ status: "idle", generatingIssueId: null });
      expect(afterTerminal.generatingIssue).toBeNull();

      // A terminal generation task that still holds the slot link (a write request
      // that captured the link just before the terminal transition) must be refused
      // by the terminal-status guard — NOT the earlier active-link guard. Re-arm the
      // link to the now-terminal task to model that in-flight race: the guard order
      // is active-link (5) then terminal-status (6), so only a present link lets the
      // request reach the terminal-status refusal. Use the resubmission run, the run
      // that owns the task after the bounce.
      await db
        .update(summarySlots)
        .set({ generatingIssueId: generationIssueId })
        .where(
          and(
            eq(summarySlots.companyId, companyId),
            eq(summarySlots.scopeKind, "project"),
            eq(summarySlots.slotKey, "header"),
            eq(summarySlots.scopeId, projectId),
          ),
        );
      await expect(
        svc.write(
          {
            ...projectSelector(companyId, projectId),
            markdown: "# Too late",
            baseRevisionId: second.revision.id,
            generationIssueId,
          },
          { agentId: summarizerAgentId, runId: resubmitRunId },
        ),
      ).rejects.toMatchObject({
        status: 403,
        message: "Summary write is not available from a terminal generation task",
      });
    });

    it("returns only the 20 most recent summary revisions", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const { svc, generationIssueId, runId } = await startGeneration(companyId, projectId, summarizerAgentId);
      const written = await svc.write(
        { ...projectSelector(companyId, projectId), markdown: "# Summary v1", generationIssueId },
        { agentId: summarizerAgentId, runId },
      );

      await db.insert(documentRevisions).values(
        Array.from({ length: 24 }, (_, index) => ({
          companyId,
          documentId: written.document.id,
          revisionNumber: index + 2,
          body: `# Summary v${index + 2}`,
        })),
      );

      const revisions = await svc.listRevisions(projectSelector(companyId, projectId));
      expect(revisions.revisions).toHaveLength(20);
      expect(revisions.revisions[0]!.revisionNumber).toBe(25);
      expect(revisions.revisions.at(-1)!.revisionNumber).toBe(6);
    });

    it("appends further revisions and enforces optimistic baseRevisionId", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const { svc, generationIssueId, runId } = await startGeneration(companyId, projectId, summarizerAgentId);

      const first = await svc.write(
        { ...projectSelector(companyId, projectId), markdown: "# Summary v1", generationIssueId },
        { agentId: summarizerAgentId, runId },
      );

      // A stale baseRevisionId must be rejected.
      const second = await summarySlotService(db).generate(projectSelector(companyId, projectId), {
        userId: "board-user",
      });
      const runId2 = await seedRun(companyId, summarizerAgentId, second.generatingIssue.id);
      await db.update(issues).set({ checkoutRunId: runId2 }).where(eq(issues.id, second.generatingIssue.id));

      await expect(
        svc.write(
          {
            ...projectSelector(companyId, projectId),
            markdown: "# Summary v2",
            baseRevisionId: randomUUID(),
            generationIssueId: second.generatingIssue.id,
          },
          { agentId: summarizerAgentId, runId: runId2 },
        ),
      ).rejects.toMatchObject({ status: 409 });

      const ok = await svc.write(
        {
          ...projectSelector(companyId, projectId),
          markdown: "# Summary v2",
          baseRevisionId: first.revision.id,
          generationIssueId: second.generatingIssue.id,
        },
        { agentId: summarizerAgentId, runId: runId2 },
      );
      expect(ok.revision.revisionNumber).toBe(2);
    });

    it("rejects writes from a non-Summarizer agent", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const plainAgentId = await seedPlainAgent(companyId);
      const { svc, runId } = await startGeneration(companyId, projectId, summarizerAgentId);

      await expect(
        svc.write(
          { ...projectSelector(companyId, projectId), markdown: "# Sneaky" },
          { agentId: plainAgentId, runId },
        ),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("rejects Summarizer writes that do not run from the linked generation task", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const { generationIssueId } = await startGeneration(companyId, projectId, summarizerAgentId);
      const svc = summarySlotService(db);

      await expect(
        svc.write(
          { ...projectSelector(companyId, projectId), markdown: "# Wrong run", generationIssueId },
          { agentId: summarizerAgentId, runId: randomUUID() },
        ),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("rejects using one generation task to write a different slot", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const otherProjectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const { svc, generationIssueId, runId } = await startGeneration(companyId, projectId, summarizerAgentId);

      await expect(
        svc.write(
          { ...projectSelector(companyId, otherProjectId), markdown: "# Wrong slot", generationIssueId },
          { agentId: summarizerAgentId, runId },
        ),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("rejects writes when there is no active generation", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const svc = summarySlotService(db);

      await expect(
        svc.write(
          { ...projectSelector(companyId, projectId), markdown: "# No generation" },
          { agentId: summarizerAgentId, runId: randomUUID() },
        ),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("summary-generation return assignee (SUP-15768)", () => {
    it("resolves the Summarizer as the forced return assignee for a generation issue", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const svc = summarySlotService(db);
      const generated = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });

      const forced = await resolveSummaryGenerationReturnAssignee(db, {
        id: generated.generatingIssue.id,
        companyId,
      });
      expect(forced).toEqual({ type: "agent", agentId: summarizerAgentId, userId: null });
    });

    it("routes to the Summarizer even when the built-in is needs_setup (agentId present, status not ready)", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const svc = summarySlotService(db);
      const generated = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });

      // Simulate the Summarizer losing its adapter config after the generation
      // task was created. The slot link and generation issue persist, and a
      // review bounce must still land on the Summarizer (the only writer of the
      // slot), not on a policy `returnAssigneeAgentId` (SUP-15768 round-2 finding A).
      await db
        .update(agents)
        .set({ adapterConfig: {} })
        .where(eq(agents.id, summarizerAgentId));

      const forced = await resolveSummaryGenerationReturnAssignee(db, {
        id: generated.generatingIssue.id,
        companyId,
      });
      expect(forced).toEqual({ type: "agent", agentId: summarizerAgentId, userId: null });
    });

    it("returns null for an issue that is not a linked generation task", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      await seedSummarizer(companyId);
      await seedPlainAgent(companyId);

      const forced = await resolveSummaryGenerationReturnAssignee(db, {
        id: randomUUID(),
        companyId,
      });
      expect(forced).toBeNull();
    });

    it("reproduces the SUP-15750 shape: one bounce lands on the Summarizer, not returnAssigneeAgentId", async () => {
      const companyId = await seedCompany();
      const projectId = await seedProject(companyId);
      const summarizerAgentId = await seedSummarizer(companyId);
      const coderLeAgentId = await seedPlainAgent(companyId);
      const reviewerAgentId = await seedPlainAgent(companyId);
      const svc = summarySlotService(db);
      const generated = await svc.generate(projectSelector(companyId, projectId), { userId: "board-user" });
      const generationIssueId = generated.generatingIssue.id;

      const policy = normalizeIssueExecutionPolicy({
        returnAssigneeAgentId: coderLeAgentId,
        stages: [{ type: "review", participants: [{ type: "agent", agentId: reviewerAgentId }] }],
      })!;
      const reviewStageId = policy.stages[0].id;

      const forced = await resolveSummaryGenerationReturnAssignee(db, {
        id: generationIssueId,
        companyId,
      });
      expect(forced).toEqual({ type: "agent", agentId: summarizerAgentId, userId: null });

      const transition = applyIssueExecutionPolicyTransition({
        issue: {
          id: generationIssueId,
          companyId,
          status: "in_review",
          assigneeAgentId: reviewerAgentId,
          assigneeUserId: null,
          executionPolicy: policy,
          executionState: {
            status: "pending",
            currentStageId: reviewStageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: reviewerAgentId },
            returnAssignee: { type: "agent", agentId: coderLeAgentId },
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        },
        policy,
        requestedStatus: "in_progress",
        requestedAssigneePatch: {},
        actor: { agentId: reviewerAgentId },
        commentBody: "Needs fixes",
        forcedReturnAssignee: forced,
      });

      expect(transition.patch.status).toBe("in_progress");
      expect(transition.patch.assigneeAgentId).toBe(summarizerAgentId);
      expect(transition.patch.executionState).toMatchObject({
        status: "changes_requested",
        returnAssignee: { type: "agent", agentId: summarizerAgentId },
      });
    });
  });
});
