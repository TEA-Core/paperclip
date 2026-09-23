import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueLabels,
  issueRelations,
  issues,
  labels,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { issueService } from "../services/issues.js";
import { TASK_WATCHDOG_ORIGIN_KIND } from "../services/task-watchdog-scope.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres ADR-103 M4 parent-edge tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * ADR-103 M4 (SUP-17183): the `parent_id` write is TOTAL. A decomposition edge
 * (create or re-parent) must be refused with 409 when it would take the parent's
 * laddered-child count from <2 to >=2 and arm the ADR-072 close ladder on a
 * parent whose pointer has already advanced and whose policy no longer carries
 * the conforming close-ladder shape. A rejected write persists nothing.
 *
 * These tests pin the gate against a real database, so a regression that drops
 * the gate from either write path cannot survive.
 */
describeEmbeddedPostgres("parent edge that would add an undischargeable ladder (ADR-103 M4)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb:
    | Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>
    | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-parent-edge-m4-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueLabels);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(labels);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const heartbeatStub = {
    requestWakeup: async () => null,
    enqueueWakeup: async () => null,
  } as any;

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        memberships: [
          { companyId, membershipRole: "owner", status: "active" },
        ],
        isInstanceAdmin: false,
        source: "session",
      };
      next();
    });
    app.use("/api", issueRoutes(db, heartbeatStub));
    app.use(errorHandler);
    return app;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "board-user",
      membershipRole: "owner",
      grantedByUserId: null,
    });
    return { companyId, issuePrefix };
  }

  async function seedSupportQaeAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "support-QAE",
      status: "active",
    });
    return agentId;
  }

  /**
   * A valid executionState whose pointer has (or has not) advanced past the
   * support-QAE review stage.
   */
  function executionStateFor(completedStageIds: string[]) {
    return {
      status: "pending",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: null,
      completedStageIds,
      skippedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    };
  }

  /**
   * The SUP-16872 work card: a review stage that has already RUN (the pointer
   * is advanced) but whose policy still lacks the review:coder-LE and
   * approval:exec-CTO close-ladder rungs (the shape can no longer be added
   * late). `advanced` toggles the pointer so the mirror case can be built.
   */
  async function seedAdvancedNonConformingParent(
    companyId: string,
    issuePrefix: string,
    issueNumber: number,
    supportQaeAgentId: string,
    advanced: boolean,
  ) {
    const id = randomUUID();
    const stageId = randomUUID();
    const [row] = await db
      .insert(issues)
      .values({
        id,
        companyId,
        issueNumber,
        identifier: `${issuePrefix}-${issueNumber}`,
        title: "Work card whose ladder already advanced",
        status: "in_progress",
        priority: "medium",
        executionPolicy: {
          stages: [
            {
              id: stageId,
              type: "review",
              participants: [{ type: "agent", agentId: supportQaeAgentId }],
            },
          ],
        },
        executionState: executionStateFor(advanced ? [stageId] : []),
      })
      .returning({ id: issues.id, identifier: issues.identifier });
    return { id: row.id, identifier: row.identifier, stageId };
  }

  /** A single qualifying laddered child (a manual child that has run a stage). */
  async function seedQualifyingChild(
    companyId: string,
    issuePrefix: string,
    issueNumber: number,
    parentId: string,
    supportQaeAgentId: string,
  ) {
    const id = randomUUID();
    const stageId = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      issueNumber,
      identifier: `${issuePrefix}-${issueNumber}`,
      parentId,
      parentLinkKind: "decomposition",
      title: "First laddered work child",
      status: "todo",
      priority: "medium",
      originKind: "manual",
      executionPolicy: {
        stages: [
          {
            id: stageId,
            type: "review",
            participants: [{ type: "agent", agentId: supportQaeAgentId }],
          },
        ],
      },
      executionState: executionStateFor([stageId]),
    });
    return id;
  }

  /**
   * A company-scoped label row. The carve-out is matched by NAME on both sides
   * of the machinery (the label id is company-scoped and neither predicate is),
   * so the row has to be real for either side to see it — and an ordinary label
   * seeded the same way is what proves the carve-out is gated on the name
   * rather than on merely carrying labels.
   */
  async function seedLabel(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(labels).values({
      id,
      companyId,
      name,
      color: "#000000",
    });
    return id;
  }

  async function edgeFor(issueId: string) {
    const rows = await db
      .select({
        parentId: issues.parentId,
        parentLinkKind: issues.parentLinkKind,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    return rows[0] ?? null;
  }

  it("rejects (409) a decomposition edge that would arm the close ladder on an advanced, non-conforming parent (SUP-16872)", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const supportQaeAgentId = await seedSupportQaeAgent(companyId);
    const parent = await seedAdvancedNonConformingParent(
      companyId,
      issuePrefix,
      1,
      supportQaeAgentId,
      true,
    );
    await seedQualifyingChild(
      companyId,
      issuePrefix,
      2,
      parent.id,
      supportQaeAgentId,
    );

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Second laddered work child", parentId: parent.id });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    // The refusal names the parent and offers both lawful resolutions.
    expect(res.body.error).toContain(parent.identifier);
    const detailsJson = JSON.stringify(res.body.details ?? {});
    expect(detailsJson).toContain("'process'");
    expect(detailsJson).toContain("programme");
    // A rejected write persists nothing: no second child under the parent and
    // no row at all for the new title.
    const children = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.parentId, parent.id)));
    expect(children).toHaveLength(1);
    const byTitle = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.title, "Second laddered work child")));
    expect(byTitle).toHaveLength(0);
  });

  it("rejects (409) a re-parent into an advanced, non-conforming parent and leaves the child's parent_id unchanged", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const supportQaeAgentId = await seedSupportQaeAgent(companyId);
    const parent = await seedAdvancedNonConformingParent(
      companyId,
      issuePrefix,
      1,
      supportQaeAgentId,
      true,
    );
    await seedQualifyingChild(
      companyId,
      issuePrefix,
      2,
      parent.id,
      supportQaeAgentId,
    );

    // A benign parent the child currently sits under.
    const otherParentId = randomUUID();
    await db.insert(issues).values({
      id: otherParentId,
      companyId,
      issueNumber: 3,
      identifier: `${issuePrefix}-3`,
      title: "Benign parent",
      status: "todo",
      priority: "medium",
    });
    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      issueNumber: 4,
      identifier: `${issuePrefix}-4`,
      parentId: otherParentId,
      parentLinkKind: "decomposition",
      title: "Reparentable child",
      status: "todo",
      priority: "medium",
      originKind: "manual",
    });

    const res = await request(createApp(companyId))
      .patch(`/api/issues/${childId}`)
      .send({ parentId: parent.id });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toContain(parent.identifier);
    // The rejected re-parent persists nothing: the edge still points to the
    // benign parent.
    const edge = await edgeFor(childId);
    expect(edge?.parentId).toBe(otherParentId);
  });

  it("allows the same second decomposition edge when the parent's pointer has not advanced (the ladder can still arm)", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const supportQaeAgentId = await seedSupportQaeAgent(companyId);
    const parent = await seedAdvancedNonConformingParent(
      companyId,
      issuePrefix,
      1,
      supportQaeAgentId,
      false,
    );
    await seedQualifyingChild(
      companyId,
      issuePrefix,
      2,
      parent.id,
      supportQaeAgentId,
    );

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Second laddered work child", parentId: parent.id });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const edge = await edgeFor(res.body.id);
    expect(edge?.parentId).toBe(parent.id);
    expect(edge?.parentLinkKind).toBe("decomposition");
  });

  it("allows an edge declared process even when the parent is advanced and non-conforming", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const supportQaeAgentId = await seedSupportQaeAgent(companyId);
    const parent = await seedAdvancedNonConformingParent(
      companyId,
      issuePrefix,
      1,
      supportQaeAgentId,
      true,
    );
    await seedQualifyingChild(
      companyId,
      issuePrefix,
      2,
      parent.id,
      supportQaeAgentId,
    );

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Process courier child",
        parentId: parent.id,
        parentLinkKind: "process",
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const edge = await edgeFor(res.body.id);
    expect(edge?.parentId).toBe(parent.id);
    expect(edge?.parentLinkKind).toBe("process");
  });

  it("allows a platform-drawn child (task_watchdog) on the same advanced, non-conforming parent", async () => {
    // The M4 regression, pinned. `countLadderedChildren` has never counted a
    // card the platform itself drew (SUP-15451), but the gate added the incoming
    // child to that count unconditionally — so the watchdog's own review card
    // took a 409 on exactly the parent state that makes a watchdog fire. The
    // parent here is byte-for-byte the one the first test 409s on; only the
    // incoming child's origin kind differs.
    //
    // This runs against the service rather than the HTTP route on purpose:
    // `origin_kind` is not a wire field (the create schema is `.strict()` and
    // does not carry it), so the watchdog sets it by calling `issuesSvc.create`
    // directly — task-watchdogs.ts does exactly this, with `parentId` pointing
    // at the watched card. The service create is therefore the real call site
    // the 409 was fired from.
    const { companyId, issuePrefix } = await seedCompany();
    const supportQaeAgentId = await seedSupportQaeAgent(companyId);
    const parent = await seedAdvancedNonConformingParent(
      companyId,
      issuePrefix,
      1,
      supportQaeAgentId,
      true,
    );
    await seedQualifyingChild(
      companyId,
      issuePrefix,
      2,
      parent.id,
      supportQaeAgentId,
    );

    const created = await issueService(db).create(companyId, {
      title: `Watchdog review for ${parent.identifier}`,
      parentId: parent.id,
      status: "todo",
      priority: "medium",
      originKind: TASK_WATCHDOG_ORIGIN_KIND,
      originId: parent.id,
    });

    const row = await db
      .select({
        parentId: issues.parentId,
        parentLinkKind: issues.parentLinkKind,
        originKind: issues.originKind,
      })
      .from(issues)
      .where(eq(issues.id, created.id))
      .then((rows) => rows[0] ?? null);
    expect(row?.parentId).toBe(parent.id);
    expect(row?.originKind).toBe(TASK_WATCHDOG_ORIGIN_KIND);
    // The card lands as an ordinary decomposition edge: the fix is that the gate
    // no longer COUNTS it, not that the platform has to relabel its own edges.
    expect(row?.parentLinkKind).toBe("decomposition");
  });

  it("still refuses a manual decomposition child in that same state, so the gate is narrowed and not disabled", async () => {
    // The control for the test above, through the SAME service entry point so
    // the only difference between the two is the incoming child's origin kind.
    // A manually filed child must still take the 409, and must still persist
    // nothing.
    const { companyId, issuePrefix } = await seedCompany();
    const supportQaeAgentId = await seedSupportQaeAgent(companyId);
    const parent = await seedAdvancedNonConformingParent(
      companyId,
      issuePrefix,
      1,
      supportQaeAgentId,
      true,
    );
    await seedQualifyingChild(
      companyId,
      issuePrefix,
      2,
      parent.id,
      supportQaeAgentId,
    );

    await expect(
      issueService(db).create(companyId, {
        title: "Manual second laddered work child",
        parentId: parent.id,
        status: "todo",
        priority: "medium",
        originKind: "manual",
      }),
    ).rejects.toThrow(/ADR-103 M4/);

    const byTitle = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.title, "Manual second laddered work child"),
        ),
      );
    expect(byTitle).toHaveLength(0);
  });

  it("allows a re-parent of a platform-drawn child into an advanced, non-conforming parent", async () => {
    // The re-parent path reads the origin kind off the stored row rather than
    // the payload (origin_kind is create-only), so it needs its own pin.
    const { companyId, issuePrefix } = await seedCompany();
    const supportQaeAgentId = await seedSupportQaeAgent(companyId);
    const parent = await seedAdvancedNonConformingParent(
      companyId,
      issuePrefix,
      1,
      supportQaeAgentId,
      true,
    );
    await seedQualifyingChild(
      companyId,
      issuePrefix,
      2,
      parent.id,
      supportQaeAgentId,
    );

    const otherParentId = randomUUID();
    await db.insert(issues).values({
      id: otherParentId,
      companyId,
      issueNumber: 3,
      identifier: `${issuePrefix}-3`,
      title: "Benign parent",
      status: "todo",
      priority: "medium",
    });
    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      issueNumber: 4,
      identifier: `${issuePrefix}-4`,
      parentId: otherParentId,
      parentLinkKind: "decomposition",
      title: "Watchdog review card being re-homed",
      status: "todo",
      priority: "medium",
      originKind: TASK_WATCHDOG_ORIGIN_KIND,
    });

    const res = await request(createApp(companyId))
      .patch(`/api/issues/${childId}`)
      .send({ parentId: parent.id });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const edge = await edgeFor(childId);
    expect(edge?.parentId).toBe(parent.id);
  });

  it("allows a work-type:redo child on the same advanced, non-conforming parent (carve-out label)", async () => {
    // The round-1 regression, pinned. `countLadderedChildren` has never counted
    // a child carrying one of the four carve-out labels (SUP-15464 /
    // SUP-15533 / SUP-16586 / SUP-17177), but round 1 mirrored only three of
    // the counter's four edge-time exclusions onto the incoming edge and left
    // this one out — so the gate still 409'd a child the counter demonstrably
    // excludes. The parent here is byte-for-byte the one the first test 409s
    // on, and the child differs from that test's child in exactly one respect:
    // it names the `work-type:redo` label on the create.
    //
    // This is not a marginal population. An ADR-041 bounce files redo children
    // under a parent that has by construction already run a review stage — that
    // IS condition 2 of the gate — so before this change a bounce landing on an
    // already-decomposed, non-conforming card could not file its redo child at
    // all.
    const { companyId, issuePrefix } = await seedCompany();
    const supportQaeAgentId = await seedSupportQaeAgent(companyId);
    const redoLabelId = await seedLabel(companyId, "work-type:redo");
    const parent = await seedAdvancedNonConformingParent(
      companyId,
      issuePrefix,
      1,
      supportQaeAgentId,
      true,
    );
    await seedQualifyingChild(
      companyId,
      issuePrefix,
      2,
      parent.id,
      supportQaeAgentId,
    );

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Redo child for the bounce",
        parentId: parent.id,
        labelIds: [redoLabelId],
      });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const edge = await edgeFor(res.body.id);
    expect(edge?.parentId).toBe(parent.id);
    // The card lands as an ordinary decomposition edge: the fix is that the
    // gate no longer COUNTS it, not that the filer has to relabel the edge.
    expect(edge?.parentLinkKind).toBe("decomposition");
    // And the label really is attached, so the allow and the close-time
    // exclusion are reading the same fact about the same row.
    const attached = await db
      .select({ labelId: issueLabels.labelId })
      .from(issueLabels)
      .where(eq(issueLabels.issueId, res.body.id as string));
    expect(attached.map((row) => row.labelId)).toEqual([redoLabelId]);
  });

  it("allows an architecture-review child but still refuses an unlabelled sibling, so the carve-out is label-gated", async () => {
    // The control for the test above at the same parent state: the carve-out is
    // gated on the LABEL, exactly as it is at close time, and not on anything
    // about the shape of the request. An ordinary label that is not one of the
    // four does not buy an exemption either.
    const { companyId, issuePrefix } = await seedCompany();
    const supportQaeAgentId = await seedSupportQaeAgent(companyId);
    const archLabelId = await seedLabel(
      companyId,
      "work-type:architecture-review",
    );
    const unrelatedLabelId = await seedLabel(companyId, "area:server");
    const parent = await seedAdvancedNonConformingParent(
      companyId,
      issuePrefix,
      1,
      supportQaeAgentId,
      true,
    );
    await seedQualifyingChild(
      companyId,
      issuePrefix,
      2,
      parent.id,
      supportQaeAgentId,
    );
    const app = createApp(companyId);

    const allowed = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Architecture review of the parent's close gate",
        parentId: parent.id,
        labelIds: [archLabelId],
      });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);

    const refused = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title: "Ordinary second work child",
        parentId: parent.id,
        labelIds: [unrelatedLabelId],
      });
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toContain(parent.identifier);
    const byTitle = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.title, "Ordinary second work child"),
        ),
      );
    expect(byTitle).toHaveLength(0);
  });

  it("allows a re-parent of a carve-out-labelled child into an advanced, non-conforming parent", async () => {
    // The re-parent path resolves the label set off the stored row, so it needs
    // its own pin: the create-side fix does not reach it.
    const { companyId, issuePrefix } = await seedCompany();
    const supportQaeAgentId = await seedSupportQaeAgent(companyId);
    const deliveryLabelId = await seedLabel(
      companyId,
      "work-type:delivery",
    );
    const parent = await seedAdvancedNonConformingParent(
      companyId,
      issuePrefix,
      1,
      supportQaeAgentId,
      true,
    );
    await seedQualifyingChild(
      companyId,
      issuePrefix,
      2,
      parent.id,
      supportQaeAgentId,
    );

    const otherParentId = randomUUID();
    await db.insert(issues).values({
      id: otherParentId,
      companyId,
      issueNumber: 3,
      identifier: `${issuePrefix}-3`,
      title: "Benign parent",
      status: "todo",
      priority: "medium",
    });
    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      issueNumber: 4,
      identifier: `${issuePrefix}-4`,
      parentId: otherParentId,
      parentLinkKind: "decomposition",
      title: "Delivery carrier being re-homed",
      status: "todo",
      priority: "medium",
      originKind: "manual",
    });
    await db.insert(issueLabels).values({
      issueId: childId,
      labelId: deliveryLabelId,
      companyId,
    });

    const res = await request(createApp(companyId))
      .patch(`/api/issues/${childId}`)
      .send({ parentId: parent.id });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const edge = await edgeFor(childId);
    expect(edge?.parentId).toBe(parent.id);
  });

  it("allows a re-parent whose own body attaches the carve-out label in the same request", async () => {
    // The label set the gate judges is the one the WRITE WILL LEAVE, not the
    // one stored before it — the same rule the status already follows. A PATCH
    // that carves the child out and moves it in one body must not be refused
    // for the label set it is in the act of replacing.
    const { companyId, issuePrefix } = await seedCompany();
    const supportQaeAgentId = await seedSupportQaeAgent(companyId);
    const redoLabelId = await seedLabel(companyId, "work-type:redo");
    const parent = await seedAdvancedNonConformingParent(
      companyId,
      issuePrefix,
      1,
      supportQaeAgentId,
      true,
    );
    await seedQualifyingChild(
      companyId,
      issuePrefix,
      2,
      parent.id,
      supportQaeAgentId,
    );

    const otherParentId = randomUUID();
    await db.insert(issues).values({
      id: otherParentId,
      companyId,
      issueNumber: 3,
      identifier: `${issuePrefix}-3`,
      title: "Benign parent",
      status: "todo",
      priority: "medium",
    });
    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      issueNumber: 4,
      identifier: `${issuePrefix}-4`,
      parentId: otherParentId,
      parentLinkKind: "decomposition",
      title: "Child carved out as it is re-homed",
      status: "todo",
      priority: "medium",
      originKind: "manual",
    });

    const res = await request(createApp(companyId))
      .patch(`/api/issues/${childId}`)
      .send({ parentId: parent.id, labelIds: [redoLabelId] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const edge = await edgeFor(childId);
    expect(edge?.parentId).toBe(parent.id);
    const attached = await db
      .select({ labelId: issueLabels.labelId })
      .from(issueLabels)
      .where(eq(issueLabels.issueId, childId));
    expect(attached.map((row) => row.labelId)).toEqual([redoLabelId]);
  });

  it("allows a decomposition edge when the parent has no laddered children yet (count would reach only 1)", async () => {
    const { companyId, issuePrefix } = await seedCompany();
    const supportQaeAgentId = await seedSupportQaeAgent(companyId);
    const parent = await seedAdvancedNonConformingParent(
      companyId,
      issuePrefix,
      1,
      supportQaeAgentId,
      true,
    );
    // No qualifying child is seeded, so the new edge takes the count from 0 -> 1.

    const res = await request(createApp(companyId))
      .post(`/api/companies/${companyId}/issues`)
      .send({ title: "Only laddered work child", parentId: parent.id });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const edge = await edgeFor(res.body.id);
    expect(edge?.parentId).toBe(parent.id);
  });
});
