/**
 * SUP-16741 live probe — issue-list projection vs single-issue read.
 *
 * Boots the real `issueRoutes` over a real HTTP listener backed by an embedded
 * Postgres, seeds an armed execution ladder, then reads the company issue list
 * and the single-issue endpoint over HTTP. The list rows must NOT carry the
 * `executionPolicy` / `executionState` / `executionWorkspaceSettings` keys
 * (absent, not `null`), while the single read must still return the stored
 * ladder. Prints a bounded, verbatim evidence block and exits non-zero if the
 * list read still asserts a ladder state the single read contradicts.
 *
 * Invoked by `deliver.sh` Phase 3.3 via the issue's `## Verification` section:
 *   node --import ./server/node_modules/tsx/dist/loader.mjs server/scripts/probe-issue-list-execution-projection.ts
 */

import { randomUUID } from "node:crypto";
import express from "express";
import {
  activityLog,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  issueRelations,
  issues,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { errorHandler } from "../src/middleware/index.js";
import { issueRoutes } from "../src/routes/issues.js";

const FIELDS = ["executionPolicy", "executionState", "executionWorkspaceSettings"] as const;
const ARMED_POLICY = { sentinel: "armed-ladder", stages: [{ type: "review" }] };
const ARMED_STATE = { sentinel: "armed-state", status: "pending" };
const ARMED_WORKSPACE_SETTINGS = { sentinel: "armed-workspace" };

const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-list-projection-probe-");
const db = createDb(tempDb.connectionString);
let server: import("node:http").Server | null = null;

try {
  const companyId = randomUUID();
  const operatorUserId = `user-${randomUUID()}`;
  const armedIssueId = randomUUID();
  const blockedArmedIssueId = randomUUID();
  const now = new Date();

  await db.insert(companies).values({
    id: companyId,
    name: `Execution projection probe ${companyId}`,
    issuePrefix: `EP${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
  });
  await db.insert(authUsers).values({
    id: operatorUserId,
    name: "Operator",
    email: `${operatorUserId}@example.com`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(companyMemberships).values({
    companyId,
    principalType: "user",
    principalId: operatorUserId,
    status: "active",
    membershipRole: "operator",
  });
  await db.insert(issues).values([
    {
      id: armedIssueId,
      companyId,
      identifier: "EP-ARMED",
      title: "Issue with an armed ladder",
      status: "in_review",
      priority: "medium",
      executionPolicy: ARMED_POLICY,
      executionState: ARMED_STATE,
      executionWorkspaceSettings: ARMED_WORKSPACE_SETTINGS,
    },
    {
      id: blockedArmedIssueId,
      companyId,
      identifier: "EP-BLOCKED",
      title: "Blocked issue with an armed ladder",
      status: "blocked",
      priority: "medium",
      executionPolicy: ARMED_POLICY,
      executionState: ARMED_STATE,
      executionWorkspaceSettings: ARMED_WORKSPACE_SETTINGS,
    },
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "session",
      userId: operatorUserId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "operator", status: "active" }],
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(db, {} as never));
  app.use(errorHandler);

  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const pick = (body: unknown, id: string) =>
    (Array.isArray(body) ? body : []).find(
      (row) => (row as { id?: string }).id === id,
    ) as Record<string, unknown> | undefined;
  const presence = (row: Record<string, unknown> | undefined) =>
    FIELDS.map(
      (field) =>
        `${field}=${row && Object.prototype.hasOwnProperty.call(row, field) ? "present" : "absent"}`,
    ).join(" ");

  const listRes = await fetch(`${base}/api/companies/${companyId}/issues`);
  const listRow = pick(await listRes.json(), armedIssueId);
  const blockedRes = await fetch(`${base}/api/companies/${companyId}/issues?attention=blocked`);
  const blockedRow = pick(await blockedRes.json(), blockedArmedIssueId);
  const singleRes = await fetch(`${base}/api/issues/${armedIssueId}`);
  const singleBody = (await singleRes.json()) as Record<string, unknown>;

  const listAssertsLadder = listRow !== undefined && FIELDS.some((field) => field in listRow);
  const singleHasLadder =
    singleBody.executionPolicy != null &&
    singleBody.executionState != null &&
    singleBody.executionWorkspaceSettings != null;
  const ok = !listAssertsLadder && singleHasLadder;

  console.log("SUP-16741 probe — list projection vs single read (branch, real HTTP + embedded Postgres)");
  console.log(`GET /api/companies/{companyId}/issues -> ${listRes.status}`);
  console.log(`  armed list row: ${presence(listRow)}`);
  console.log(`GET /api/companies/{companyId}/issues?attention=blocked -> ${blockedRes.status}`);
  console.log(`  blocked list row: ${presence(blockedRow)}`);
  console.log(`GET /api/issues/{armedIssueId} -> ${singleRes.status}`);
  console.log(`  executionPolicy=${JSON.stringify(singleBody.executionPolicy)}`);
  console.log(`  executionState=${JSON.stringify(singleBody.executionState)}`);
  console.log(`  executionWorkspaceSettings=${JSON.stringify(singleBody.executionWorkspaceSettings)}`);
  console.log(
    ok
      ? "OK: list rows do not assert a ladder state; the single read still returns the armed ladder"
      : "FAIL: list row still asserts a ladder state the single read contradicts",
  );

  process.exitCode = ok ? 0 : 1;
} finally {
  server?.close();
  await db.delete(issueRelations);
  await db.delete(activityLog);
  await db.delete(issues);
  await db.delete(companyMemberships);
  await db.delete(companies);
  await db.delete(authUsers);
  await tempDb.cleanup();
}
