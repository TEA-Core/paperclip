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
