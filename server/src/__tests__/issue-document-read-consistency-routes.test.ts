import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companyMemberships, createDb } from "@paperclipai/db";
import {
  ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
  isSystemIssueDocumentKey,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue document read consistency route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const LEDGER_KEY = "census-chain-ledger";

type DocumentResponse = {
  id: string;
  issueId: string;
  key: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  body?: string;
};

function agreementFields(doc: DocumentResponse) {
  return {
    id: doc.id,
    issueId: doc.issueId,
    key: doc.key,
    latestRevisionId: doc.latestRevisionId,
    latestRevisionNumber: doc.latestRevisionNumber,
    body: doc.body,
  };
}

describeEmbeddedPostgres("issue document read consistency routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: ReturnType<typeof createApp>;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-document-read-consistency-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    app = createApp(companyId);

    await db.insert(companies).values({
      id: companyId,
      name: "Document read consistency",
      issuePrefix: "DRC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createStorage(): StorageService {
    return {
      provider: "local_disk",
      putFile: vi.fn(async () => {
        throw new Error("Unexpected storage.putFile call in document read consistency route test");
      }),
      getObject: vi.fn(async () => {
        throw new Error("Unexpected storage.getObject call in document read consistency route test");
      }),
      headObject: vi.fn(async () => ({ exists: false })),
      deleteObject: vi.fn(async () => undefined),
    };
  }

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", issueRoutes(db, createStorage()));
    app.use(errorHandler);
    return app;
  }

  async function createIssue(title: string): Promise<{ id: string; identifier: string }> {
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({ title, status: "todo", priority: "medium" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.id, identifier: res.body.identifier };
  }

  async function putDocument(issueRef: string, key: string, body: string, baseRevisionId?: string) {
    return request(app)
      .put(`/api/issues/${issueRef}/documents/${key}`)
      .send({ title: key, format: "markdown", body, ...(baseRevisionId ? { baseRevisionId } : {}) });
  }

  async function listDocuments(issueRef: string): Promise<DocumentResponse[]> {
    const res = await request(app).get(`/api/issues/${issueRef}/documents`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as DocumentResponse[];
  }

  it("never classifies the census chain ledger key as a system document", () => {
    expect(isSystemIssueDocumentKey(LEDGER_KEY)).toBe(false);
    expect(isSystemIssueDocumentKey(ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY)).toBe(true);
  });

  it("makes a created and then updated ledger immediately visible to list and get with matching fields", async () => {
    const carrier = await createIssue("Census chain carrier");

    const created = await putDocument(carrier.identifier, LEDGER_KEY, "last-census-serial: 79");
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ issueId: carrier.id, key: LEDGER_KEY, latestRevisionNumber: 1 });

    for (const issueRef of [carrier.identifier, carrier.id]) {
      const listed = await listDocuments(issueRef);
      const listedLedger = listed.find((doc) => doc.key === LEDGER_KEY);
      expect(listedLedger, `list ${issueRef}`).toBeDefined();

      const fetched = await request(app).get(`/api/issues/${issueRef}/documents/${LEDGER_KEY}`);
      expect(fetched.status, JSON.stringify(fetched.body)).toBe(200);
      expect(agreementFields(fetched.body)).toEqual(agreementFields(listedLedger!));
      expect(agreementFields(fetched.body)).toEqual(agreementFields(created.body));
    }

    const updated = await putDocument(
      carrier.identifier,
      LEDGER_KEY,
      "last-census-serial: 80",
      created.body.latestRevisionId,
    );
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({
      id: created.body.id,
      issueId: carrier.id,
      key: LEDGER_KEY,
      latestRevisionNumber: 2,
      body: "last-census-serial: 80",
    });

    const listedAfterUpdate = (await listDocuments(carrier.id)).find((doc) => doc.key === LEDGER_KEY);
    const fetchedAfterUpdate = await request(app).get(`/api/issues/${carrier.id}/documents/${LEDGER_KEY}`);
    expect(fetchedAfterUpdate.status, JSON.stringify(fetchedAfterUpdate.body)).toBe(200);
    expect(agreementFields(fetchedAfterUpdate.body)).toEqual(agreementFields(listedAfterUpdate!));
    expect(agreementFields(fetchedAfterUpdate.body)).toEqual(agreementFields(updated.body));
  });

  it("keeps listed non-system keys and directly fetchable non-system keys in agreement", async () => {
    const carrier = await createIssue("Mixed document carrier");
    const keys = [LEDGER_KEY, "plan", ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY];
    for (const key of keys) {
      const res = await putDocument(carrier.id, key, `# ${key}`);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }

    const listed = await listDocuments(carrier.id);
    const listedKeys = listed.map((doc) => doc.key);
    expect(listedKeys).toEqual([LEDGER_KEY, "plan"]);

    const fetchableNonSystemKeys: string[] = [];
    for (const key of keys) {
      const fetched = await request(app).get(`/api/issues/${carrier.id}/documents/${key}`);
      expect(fetched.status, `${key}: ${JSON.stringify(fetched.body)}`).toBe(200);
      if (!isSystemIssueDocumentKey(fetched.body.key)) fetchableNonSystemKeys.push(fetched.body.key);
      const listedDoc = listed.find((doc) => doc.key === key);
      if (listedDoc) expect(agreementFields(fetched.body)).toEqual(agreementFields(listedDoc));
    }
    expect(fetchableNonSystemKeys.sort()).toEqual([...listedKeys].sort());

    const withSystem = await request(app).get(`/api/issues/${carrier.id}/documents?includeSystem=true`);
    expect(withSystem.status, JSON.stringify(withSystem.body)).toBe(200);
    expect(withSystem.body.map((doc: DocumentResponse) => doc.key)).toEqual([
      LEDGER_KEY,
      ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
      "plan",
    ]);
  });

  it("names the resolved issue on a missing-document 404 so a read of the wrong card is visible", async () => {
    const carrier = await createIssue("Ledger carrier");
    const wakeCard = await createIssue("Run wake card");
    const created = await putDocument(carrier.id, LEDGER_KEY, "last-census-serial: 80");
    expect(created.status, JSON.stringify(created.body)).toBe(201);

    const wrongCardRead = await request(app).get(`/api/issues/${wakeCard.id}/documents/${LEDGER_KEY}`);
    expect(wrongCardRead.status).toBe(404);
    expect(wrongCardRead.body).toEqual({
      error: "Document not found",
      issueId: wakeCard.id,
      issueIdentifier: wakeCard.identifier,
      key: LEDGER_KEY,
    });

    const identifierRead = await request(app).get(
      `/api/issues/${wakeCard.identifier.toLowerCase()}/documents/${LEDGER_KEY.toUpperCase()}`,
    );
    expect(identifierRead.status).toBe(404);
    expect(identifierRead.body).toMatchObject({
      issueId: wakeCard.id,
      issueIdentifier: wakeCard.identifier,
      key: LEDGER_KEY,
    });

    const rightCardRead = await request(app).get(`/api/issues/${carrier.identifier}/documents/${LEDGER_KEY}`);
    expect(rightCardRead.status, JSON.stringify(rightCardRead.body)).toBe(200);
    expect(rightCardRead.body).toMatchObject({ issueId: carrier.id, key: LEDGER_KEY });
  });
});
