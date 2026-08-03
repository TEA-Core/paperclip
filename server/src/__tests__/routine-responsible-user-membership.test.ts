import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  projects,
  routineRevisions,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres routine responsible-user tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("routine responsible-user resolution requires an active membership", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-responsible-user-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(options?: { memberUserId?: string; membershipStatus?: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const defaultResponsibleUserId = `default-user-${randomUUID()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Routines",
      status: "in_progress",
    });
    if (options?.memberUserId) {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: options.memberUserId,
        status: options.membershipStatus ?? "active",
        membershipRole: "owner",
        updatedAt: new Date(),
      });
    }

    return { companyId, agentId, projectId, defaultResponsibleUserId };
  }

  async function createRoutineAs(
    companyId: string,
    agentId: string,
    projectId: string,
    actor: { agentId?: string | null; userId?: string | null },
  ) {
    const svc = routineService(db, {
      heartbeat: { wakeup: async () => null },
    });
    return svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "reflection sweep",
        description: "Run the reflection routine",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      actor,
    );
  }

  /** The routine row and its latest revision must agree — runs read the revision first. */
  async function storedResponsibleUserIds(routineId: string) {
    const routine = await db
      .select({ responsibleUserId: routines.responsibleUserId })
      .from(routines)
      .where(eq(routines.id, routineId))
      .then((rows) => rows[0] ?? null);
    const revision = await db
      .select({
        responsibleUserId: routineRevisions.responsibleUserId,
        snapshot: routineRevisions.snapshot,
      })
      .from(routineRevisions)
      .where(eq(routineRevisions.routineId, routineId))
      .then((rows) => rows[0] ?? null);
    return {
      routine: routine?.responsibleUserId ?? null,
      revision: revision?.responsibleUserId ?? null,
      snapshot: (revision?.snapshot as { routine?: { responsibleUserId?: string | null } } | undefined)
        ?.routine?.responsibleUserId ?? null,
    };
  }

  it("falls back to the company default when the actor holds no membership", async () => {
    const { companyId, agentId, projectId, defaultResponsibleUserId } = await seedCompany();

    // Exactly what the built-in bundle seeder passes: an attribution label, not a user.
    const routine = await createRoutineAs(companyId, agentId, projectId, {
      agentId: null,
      userId: "built-in-bundles",
    });

    const stored = await storedResponsibleUserIds(routine.id);
    expect(stored.routine).toBe(defaultResponsibleUserId);
    expect(stored.revision).toBe(defaultResponsibleUserId);
    expect(stored.snapshot).toBe(defaultResponsibleUserId);
    expect(Object.values(stored)).not.toContain("built-in-bundles");
  });

  it("keeps the actor when they hold an active membership", async () => {
    const memberUserId = `member-${randomUUID()}`;
    const { companyId, agentId, projectId, defaultResponsibleUserId } = await seedCompany({ memberUserId });

    const routine = await createRoutineAs(companyId, agentId, projectId, {
      agentId: null,
      userId: memberUserId,
    });

    const stored = await storedResponsibleUserIds(routine.id);
    expect(stored.routine).toBe(memberUserId);
    expect(stored.revision).toBe(memberUserId);
    expect(stored.routine).not.toBe(defaultResponsibleUserId);
  });

  it("falls back when the actor's membership is not active", async () => {
    const memberUserId = `former-${randomUUID()}`;
    const { companyId, agentId, projectId, defaultResponsibleUserId } = await seedCompany({
      memberUserId,
      membershipStatus: "revoked",
    });

    const routine = await createRoutineAs(companyId, agentId, projectId, {
      agentId: null,
      userId: memberUserId,
    });

    const stored = await storedResponsibleUserIds(routine.id);
    expect(stored.routine).toBe(defaultResponsibleUserId);
  });

  it("still falls back to the company default when no actor user is supplied", async () => {
    const { companyId, agentId, projectId, defaultResponsibleUserId } = await seedCompany();

    const routine = await createRoutineAs(companyId, agentId, projectId, {});

    const stored = await storedResponsibleUserIds(routine.id);
    expect(stored.routine).toBe(defaultResponsibleUserId);
  });
});
