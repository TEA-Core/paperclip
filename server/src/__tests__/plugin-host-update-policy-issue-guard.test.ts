import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  invites,
  issues,
  principalPermissionGrants,
  projects,
} from "@paperclipai/db";
import {
  LOW_TRUST_REVIEW_PRESET,
  LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
} from "@paperclipai/shared";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const pluginId = "plugin-record-id";

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: () => {},
        subscribe: () => {},
        clear: () => {},
      };
    },
  } as any;
}

async function createCompany(db: ReturnType<typeof createDb>, prefix: string) {
  return db
    .insert(companies)
    .values({
      name: `${prefix} ${randomUUID()}`,
      issuePrefix: `${prefix}${randomUUID().slice(0, 6).toUpperCase()}`,
    })
    .returning()
    .then((rows) => rows[0]!);
}

describeEmbeddedPostgres("plugin-host updatePolicy issue guard", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-update-policy-issue-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(invites);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(issues);
    await db.delete(companies);
    await db.delete(projects);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("rejects an unsatisfiable low-trust authorizationPolicy on the issue branch before any DB write", async () => {
    const company = await createCompany(db, "PIG");
    const targetIssue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "Guard target issue",
        status: "todo",
        priority: "medium",
        responsibleUserId: "board-user",
      })
      .returning()
      .then((rows) => rows[0]!);

    const services = buildHostServices(db, pluginId, "permissions-extension", createEventBusStub());

    const unsatisfiablePolicy = {
      mode: "low_trust_review",
      reviewPreset: {
        id: "low_trust_review",
        version: 1,
        rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
      },
    };

    await expect(
      services.authorization.updatePolicy({
        companyId: company.id,
        resourceType: "issue",
        resourceId: targetIssue.id,
        policy: unsatisfiablePolicy,
      }),
    ).rejects.toMatchObject({ status: 422 });

    const row = await db.query.issues.findFirst({ where: (i, { eq }) => eq(i.id, targetIssue.id) });
    expect(row!.executionPolicy).toBeNull();
    services.dispose();
  });

  it("accepts a satisfiable low-trust policy carrying a trustBoundary and writes it", async () => {
    const company = await createCompany(db, "PIG");
    const targetIssue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "Satisfiable target issue",
        status: "todo",
        priority: "medium",
        responsibleUserId: "board-user",
      })
      .returning()
      .then((rows) => rows[0]!);

    const services = buildHostServices(db, pluginId, "permissions-extension", createEventBusStub());

    const satisfiablePolicy = {
      mode: "low_trust_review",
      reviewPreset: {
        id: "low_trust_review",
        version: 1,
        rawOutputDisposition: LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION,
      },
      trustBoundary: {
        mode: LOW_TRUST_REVIEW_PRESET,
        companyId: company.id,
        rootIssueId: targetIssue.id,
      },
    };

    const updated = await services.authorization.updatePolicy({
      companyId: company.id,
      resourceType: "issue",
      resourceId: targetIssue.id,
      policy: satisfiablePolicy,
    });

    expect(updated.policy).toMatchObject({
      mode: "low_trust_review",
      trustBoundary: { rootIssueId: targetIssue.id },
    });

    const row = await db.query.issues.findFirst({ where: (i, { eq }) => eq(i.id, targetIssue.id) });
    expect(row!.executionPolicy).toMatchObject({
      authorizationPolicy: {
        mode: "low_trust_review",
        trustBoundary: { rootIssueId: targetIssue.id },
      },
    });
    services.dispose();
  });

  it("clears the authorizationPolicy when policy is null", async () => {
    const company = await createCompany(db, "PIG");
    const targetIssue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "Clear target issue",
        status: "todo",
        priority: "medium",
        responsibleUserId: "board-user",
        executionPolicy: {
          authorizationPolicy: { mode: "low_trust_review" },
        },
      })
      .returning()
      .then((rows) => rows[0]!);

    const services = buildHostServices(db, pluginId, "permissions-extension", createEventBusStub());

    const updated = await services.authorization.updatePolicy({
      companyId: company.id,
      resourceType: "issue",
      resourceId: targetIssue.id,
      policy: null,
    });

    expect(updated.policy).toBeNull();

    const row = await db.query.issues.findFirst({ where: (i, { eq }) => eq(i.id, targetIssue.id) });
    expect(row!.executionPolicy).toEqual({});
    services.dispose();
  });
});

describeEmbeddedPostgres("plugin-host wiki handoff issue update guard (SUP-21752)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const CANONICAL = "33333333-3333-4333-8333-333333333333";
  const INTRUDER = "22222222-2222-4222-8222-222222222222";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-wiki-handoff-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    const { pluginManagedResources: pmr, plugins: plg } = await import("@paperclipai/db");
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(pmr);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(plg);
    await db.delete(projects);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedWikiHandoff() {
    const { pluginManagedResources: pmr, plugins: plg } = await import("@paperclipai/db");
    const company = await createCompany(db, "WKH");
    const pluginRowId = randomUUID();
    await db.insert(plg).values({
      id: pluginRowId,
      pluginKey: "paperclipai.plugin-llm-wiki",
      packageName: "@paperclipai/plugin-llm-wiki",
      version: "0.1.0",
      apiVersion: 1,
      categories: [],
      manifestJson: {} as never,
      status: "ready",
      installOrder: 1,
    });
    await db.insert(agents).values([
      {
        id: CANONICAL,
        companyId: company.id,
        name: "Wiki Maintainer",
        role: "knowledge-maintainer",
        status: "paused",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: INTRUDER,
        companyId: company.id,
        name: "coder-LE",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ] as never);
    await db.insert(pmr).values({
      companyId: company.id,
      pluginId: pluginRowId,
      pluginKey: "paperclipai.plugin-llm-wiki",
      resourceKind: "agent",
      resourceKey: "wiki-maintainer",
      resourceId: CANONICAL,
      defaultsJson: {},
    });
    const issue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "[PPC ER] Weekly Report — handoff to Wiki Maintainer",
        description: "Canonical wiki path wiki/projects/example/reports/2026-10-29.md",
        status: "todo",
        priority: "medium",
        assigneeAgentId: CANONICAL,
      })
      .returning()
      .then((rows) => rows[0]!);
    return { company, issue };
  }

  it("rejects a plugin-host update that moves a Wiki handoff off the canonical maintainer", async () => {
    const { company, issue } = await seedWikiHandoff();
    const services = buildHostServices(db, pluginId, "permissions-extension", createEventBusStub());

    await expect(
      services.issues.update({
        issueId: issue.id,
        companyId: company.id,
        patch: { assigneeAgentId: INTRUDER },
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: {
        subGuard: "wiki_handoff",
        reason: "wiki_handoff_non_canonical_assignee",
      },
    });

    const row = await db.query.issues.findFirst({ where: (i, { eq }) => eq(i.id, issue.id) });
    expect(row!.assigneeAgentId).toBe(CANONICAL);
    services.dispose();
  });

  it("rejects a plugin-host assignee write that self-satisfies an incomplete review stage on any issue", async () => {
    const { company } = await seedWikiHandoff();
    const stageId = randomUUID();
    const issue = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "Ordinary guarded issue",
        status: "in_review",
        priority: "medium",
        assigneeAgentId: CANONICAL,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [
            {
              id: stageId,
              type: "review",
              approvalsNeeded: 1,
              participants: [{ id: randomUUID(), type: "agent", agentId: INTRUDER, userId: null }],
            },
          ],
        } as never,
        executionState: {
          status: "pending",
          currentStageId: stageId,
          currentStageIndex: 0,
          currentStageType: "review",
          currentParticipant: { type: "agent", agentId: INTRUDER, userId: null },
          returnAssignee: null,
          reviewRequest: null,
          completedStageIds: [],
          skippedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
        } as never,
      })
      .returning()
      .then((rows) => rows[0]!);

    const services = buildHostServices(db, pluginId, "permissions-extension", createEventBusStub());
    await expect(
      services.issues.update({
        issueId: issue.id,
        companyId: company.id,
        patch: { assigneeAgentId: INTRUDER },
      }),
    ).rejects.toMatchObject({ status: 422 });

    const row = await db.query.issues.findFirst({ where: (i, { eq }) => eq(i.id, issue.id) });
    expect(row!.assigneeAgentId).toBe(CANONICAL);
    services.dispose();
  });

  it("allows a plugin-host update that keeps the canonical maintainer", async () => {
    const { company, issue } = await seedWikiHandoff();
    const services = buildHostServices(db, pluginId, "permissions-extension", createEventBusStub());

    const updated = await services.issues.update({
      issueId: issue.id,
      companyId: company.id,
      patch: { description: "Updated by the wiki plugin host" },
    });
    expect(updated.assigneeAgentId).toBe(CANONICAL);
    expect(updated.description).toBe("Updated by the wiki plugin host");
    services.dispose();
  });
});
