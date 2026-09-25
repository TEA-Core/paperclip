import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { issueService } from "../issues.js";

// SUP-17462 (consumer child of SUP-16541): the seven `dbOrTx === db`
// constructor-identity checks in issues.ts are now `isTransactionHandle(dbOrTx)`
// with the branch inverted. A service built on a transaction handle and driven
// without an explicit handle used to misclassify itself as the pool (a handle is
// always `=== ` itself), so it opened nested transactions, published activity
// inline, and ran post-commit actions before the caller's commit. These tests
// pin the corrected fate-sharing on a real Postgres transaction.
//
// The distinguishing assertion is a spy on the handle's `transaction` method:
// a drizzle nested savepoint would still roll back with the outer transaction,
// so fate alone cannot tell "direct write on the caller's tx" apart from a
// nested one — only the call can.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issueService transaction-fate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A deterministic, self-contained failure for the addComment audit write: any
// INSERT into activity_log raises this exception. DDL inside a Postgres
// transaction is transactional, so the transaction test rolls the blocker back
// with everything else.
const AUDIT_BLOCKER_FUNCTION = "sup17462_block_activity_log_inserts";
const AUDIT_BLOCKER_TRIGGER = "sup17462_block_activity_log_inserts";
const AUDIT_BLOCKER_MARKER = "audit write blocked by SUP-17462 test";

const CREATE_AUDIT_BLOCKER_SQL = [
  `CREATE FUNCTION ${AUDIT_BLOCKER_FUNCTION}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION '${AUDIT_BLOCKER_MARKER}'; END; $$ LANGUAGE plpgsql;`,
  `CREATE TRIGGER ${AUDIT_BLOCKER_TRIGGER} BEFORE INSERT ON activity_log FOR EACH STATEMENT EXECUTE FUNCTION ${AUDIT_BLOCKER_FUNCTION}();`,
].join("\n");

function errorMessageChain(error: unknown): string {
  let current: unknown = error;
  let chain = "";
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    chain += `${current.message}\n`;
    current = current.cause;
  }
  return chain;
}

describeEmbeddedPostgres("issueService built on a transaction handle", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("issues-tx-fate");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(issueThreadInteractions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (stopDb) await stopDb();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function seedIssue(
    companyId: string,
    title = "Original title",
    status: "in_progress" | "blocked" = "in_progress",
    assigneeAgentId?: string,
  ): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title,
      status,
      priority: "medium",
      ...(assigneeAgentId ? { assigneeAgentId } : {}),
    });
    return issueId;
  }

  async function seedAgent(companyId: string): Promise<string> {
    const agentId = randomUUID();
    // An active root agent: assignable work target with a healthy org chain.
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      status: "active",
      reportsTo: null,
    });
    return agentId;
  }

  it("update on a tx handle opens no nested transaction and shares the outer tx's fate", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, "Original title");

    const outer = await db
      .transaction(async (tx) => {
        const nestedTx = vi.spyOn(tx, "transaction");
        const svc = issueService(tx as unknown as Parameters<typeof issueService>[0]);
        // No explicit handle: dbOrTx defaults to the caller's transaction.
        await svc.update(issueId, { title: "changed inside caller tx" });
        // The old `dbOrTx === db` was always true here (a handle equals itself)
        // and opened `db.transaction(runUpdate)`. The predicate branch must not.
        expect(nestedTx).not.toHaveBeenCalled();
        throw new Error("sup17462-rollback-sentinel");
      })
      .catch((error: unknown) => error);

    expect(outer).toBeInstanceOf(Error);
    expect((outer as Error).message).toContain("sup17462-rollback-sentinel");

    const row = await db
      .select({ title: issues.title })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    // The write went through the caller's transaction, so the rollback undoes it.
    expect(row?.title).toBe("Original title");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("issueService(tx).update(id, { status: 'in_progress' }, tx) takes the in-transaction branch (native-safe-replacement witness)", async () => {
    // This mirrors native-runtime/native-safe-replacement.ts:357 exactly:
    // issueService(tx).update(task.id, { status: "in_progress" }, tx). It is the
    // site where a hand-written mitigation was silently defeated by the old
    // identity check opening a nested transaction.
    //
    // The seed matters: `in_progress` requires an assignee and a real
    // status transition (blocked -> in_progress), so the update reaches the
    // transaction discriminator at the tail of `update` instead of throwing in
    // the pre-flight assignee check before it. Without that, the nested-tx spy
    // would never observe the defective branch.
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const issueId = await seedIssue(companyId, "Witness", "blocked", agentId);

    const outer = await db
      .transaction(async (tx) => {
        const nestedTx = vi.spyOn(tx, "transaction");
        const svc = issueService(tx as unknown as Parameters<typeof issueService>[0]);
        // Explicit `tx` handle + a service built on the same handle: the old
        // `dbOrTx === db` was always true here (a handle equals itself) and
        // opened `db.transaction(runUpdate)`. The predicate branch must not.
        await svc.update(issueId, { status: "in_progress" }, tx);
        expect(nestedTx).not.toHaveBeenCalled();
        throw new Error("sup17462-rollback-sentinel");
      })
      .catch((error: unknown) => error);

    expect(outer).toBeInstanceOf(Error);
    expect((outer as Error).message).toContain("sup17462-rollback-sentinel");

    // The write went through the caller's transaction, so the rollback undoes
    // the blocked -> in_progress transition.
    const row = await db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.status).toBe("blocked");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("update on the pool handle still opens its own transaction and commits inline", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, "Original title");

    const poolTx = vi.spyOn(db, "transaction");
    const svc = issueService(db);
    await svc.update(issueId, { title: "changed on the pool" });

    // Pool path is unchanged: the service owns the transaction it runs in.
    expect(poolTx).toHaveBeenCalled();

    const row = await db
      .select({ title: issues.title })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row?.title).toBe("changed on the pool");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("addComment on a tx handle routes its audit through logActivityInTransaction, so a failing audit rolls the comment back", async () => {
    const companyId = await seedCompany();
    const issueId = await seedIssue(companyId, "Answer with a comment");
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        supersedeOnUserComment: true,
        questions: [{
          id: "scope",
          prompt: "Pick one",
          selectionMode: "single",
          options: [{ id: "a", label: "A" }],
        }],
      } as never,
    });

    // A genuine human comment supersedes the pending interaction. When the
    // supersede audit write fails, the comment must not commit: on a tx handle
    // the audit routes through logActivityInTransaction, which propagates the
    // error out of addComment (rather than logActivity's best-effort catch
    // swallowing it), so the caller's transaction is aborted and rolled back.
    //
    // This pins the post-fix addComment audit behaviour. The old/new delta on
    // this specific call is not observable from the outer handle — the legacy
    // `dbOrTx === db` path's append-savepoint also ends up fate-sharing the
    // audit — so the old/new discrimination for the handle-identity swap is
    // pinned by the `update` tests above; this test guards the audit's
    // fate-sharing guarantee against regression.
    let addCommentError: unknown;
    await db
      .transaction(async (tx) => {
        // The blocker is created inside the transaction, so it is rolled back
        // with everything else when the audit trips it.
        await tx.execute(sql.raw(CREATE_AUDIT_BLOCKER_SQL));
        const svc = issueService(tx as unknown as Parameters<typeof issueService>[0]);
        try {
          await svc.addComment(issueId, "Use option A", { userId: "local-board" });
        } catch (error) {
          addCommentError = error;
        }
      })
      .catch(() => {
        // The outer transaction is rolled back when the audit trips the blocker.
      });

    // The audit failure surfaced through the mutation, not the activity logger's
    // swallow: it carries the blocker marker down the error-cause chain.
    expect(addCommentError).toBeInstanceOf(Error);
    expect(errorMessageChain(addCommentError)).toContain(AUDIT_BLOCKER_MARKER);

    // The comment did not commit.
    const commentRows = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(commentRows).toHaveLength(0);

    // The interaction was not expired (rolled back with the comment).
    const interaction = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId))
      .then((rows) => rows[0]);
    expect(interaction?.status).toBe("pending");

    // No audit row survived.
    const auditRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "issue.thread_interaction_expired"));
    expect(auditRows).toHaveLength(0);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
