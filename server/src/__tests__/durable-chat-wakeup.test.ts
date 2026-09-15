import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
  agents,
  companies,
  createDb,
  heartbeatRuns,
  agentWakeupRequests,
  chatConversations,
  chatActions,
  chatEndpoints,
  chatMessageLinks,
  chatPublications,
  issueComments,
  issueRecoveryActions,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import {
  authorizeFailedChatRunRetryWake,
  authorizeCommittedChatResponse,
  CommittedChatResponseAuthorizationError,
  registerCommittedChatResponseAuthority,
  createDurableChatWakeupRequest,
  FailedChatRunRetryAuthorizationError,
  registerFailedChatRunRetryAuthority,
} from "../services/durable-chat-wakeup.js";
import { conflict } from "../errors.js";
import type { ServerAdapterModule } from "../adapters/index.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import {
  registerServerAdapter,
  runningProcesses,
  unregisterServerAdapter,
} from "../adapters/index.js";

describe("durable inbound chat scheduler receipts", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const liveRunIds = new Set<string>();
  const unregisterAuthorities: Array<() => void> = [];
  const execute = vi.fn<ServerAdapterModule["execute"]>(async (input) => {
    const issueId = String(input.context.issueId);
    await db.insert(issueComments).values({
      companyId: input.agent.companyId,
      issueId,
      authorAgentId: input.agent.id,
      createdByRunId: input.runId,
      body: "Exact retry dispatched",
    });
    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, issueId));
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "Exact retry dispatched",
    };
  });
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase(
      "chat-wakeup-receipts-",
    );
    db = createDb(temporary.connectionString);
    registerServerAdapter({
      type: "durable_chat_retry_test",
      execute,
      testEnvironment: async () => ({
        adapterType: "durable_chat_retry_test",
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
    });
  }, 30_000);
  afterEach(() => {
    execute.mockClear();
    for (const unregister of unregisterAuthorities.splice(0)) unregister();
    for (const runId of liveRunIds) runningProcesses.delete(runId);
    liveRunIds.clear();
  });
  afterAll(async () => {
    unregisterServerAdapter("durable_chat_retry_test");
    await temporary.cleanup();
  });

  async function fixture(deferred = false) {
    const companyId = randomUUID(),
      agentId = randomUUID(),
      issueId = randomUUID(),
      activeRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Durable wake",
      issuePrefix: `D${companyId.slice(0, 7)}`,
      defaultResponsibleUserId: "board-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Maya",
      role: "ceo",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    });
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      status: "running",
      // This fixture-owned slot has no provider process/work. Its retirement
      // must not impersonate an ambiguous legacy provider failure.
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { issueId: deferred ? issueId : randomUUID() },
    });
    runningProcesses.set(activeRunId, {
      child: {} as never,
      graceSec: 0,
      processGroupId: null,
    });
    liveRunIds.add(activeRunId);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Bound chat task",
      status: "in_progress",
      assigneeAgentId: agentId,
      responsibleUserId: "board-user",
      ...(deferred
        ? {
            executionRunId: activeRunId,
            executionAgentNameKey: "maya",
            executionLockedAt: new Date(),
          }
        : {}),
    });
    const heartbeat = heartbeatService(db);
    const authorize = vi.fn(async () => {});
    const request = (commentId = randomUUID(), actor = "board-user") =>
      createDurableChatWakeupRequest({
        id: randomUUID(),
        companyId,
        agentId,
        issueId,
        commentId,
        requestedByActorType: "user",
        requestedByActorId: actor,
        requestedAt: new Date(),
        authorize,
      });
    const wake = (durableChatRequest: ReturnType<typeof request>) =>
      queueIssueAssignmentWakeup({
        heartbeat,
        issue: { id: issueId, assigneeAgentId: agentId, status: "in_progress" },
        reason: "External chat message received",
        mutation: "chat_message_received",
        contextSource: "chat:slack",
        requestedByActorType: "user",
        requestedByActorId: durableChatRequest.requestedByActorId,
        wakeCommentId: durableChatRequest.commentId,
        durableChatRequest,
        rethrowOnError: true,
      });
    return {
      companyId,
      agentId,
      issueId,
      activeRunId,
      heartbeat,
      authorize,
      request,
      wake,
    };
  }

  async function executionHold(f: { companyId: string; issueId: string; agentId: string }) {
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      ownerType: "board", returnOwnerAgentId: f.agentId,
      cause: "legacy_execution_requires_reconciliation", status: "resolved",
      fingerprint: randomUUID(), evidence: { automaticRecovery: { replay: "blocked" } },
      nextAction: "Check the stopped execution.",
    }).returning();
    return () => db.update(issueRecoveryActions).set({ evidence: {} }).where(eq(issueRecoveryActions.id, action!.id));
  }

  it("defers held inbound chat exactly once and keeps its authority separate from a generic wake", async () => {
    const f = await fixture();
    const clearHold = await executionHold(f);
    const request = f.request();
    const wake = () => f.heartbeat.wakeup(f.agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
      payload: { issueId: f.issueId, commentId: request.commentId },
      contextSnapshot: { issueId: f.issueId, source: "chat:slack", wakeCommentId: request.commentId },
      requestedByActorType: "user", requestedByActorId: request.requestedByActorId,
      durableChatRequest: request,
    });
    for (let i = 0; i < 3; i++) expect(await wake()).toBeNull();
    const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      id: request.id, idempotencyKey: request.idempotencyKey, requestedAt: request.requestedAt,
      status: "deferred_issue_execution", runId: null, requestedByActorId: request.requestedByActorId,
      payload: { _paperclipWakeContext: { source: "chat:slack", wakeCommentIds: [request.commentId] } },
    });
    expect(f.authorize).toHaveBeenCalledTimes(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, request.id))).toHaveLength(0);
    await clearHold();
    const generic = await f.heartbeat.wakeup(f.agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "issue_resumed",
      payload: { issueId: f.issueId }, requestedByActorType: "user", requestedByActorId: "board-user",
    });
    expect(generic?.status).toBe("queued");
    expect(generic?.contextSnapshot?.wakeCommentIds).toBeUndefined();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.id)))[0]).toMatchObject({
      status: "deferred_issue_execution", runId: null,
    });
  });

  async function retryFixture(deferred = false) {
    const f = await fixture(deferred);
    const applicationId = randomUUID(),
      connectionId = randomUUID(),
      endpointId = randomUUID();
    const failedRunId = randomUUID(),
      actionId = randomUUID();
    const commentIds = [randomUUID(), randomUUID()];
    const taskKey = `D${f.companyId.slice(0, 7)}-1`;
    await db
      .update(issues)
      .set({ identifier: taskKey })
      .where(eq(issues.id, f.issueId));
    await db.insert(toolApplications).values({
      id: applicationId,
      companyId: f.companyId,
      name: "Retry authority",
      type: "chat",
    });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId: f.companyId,
      applicationId,
      name: "Retry",
      uid: `retry-${connectionId}`,
      connectionPurpose: "channel",
      transport: "chat_sdk",
      status: "active",
    });
    await db.insert(chatEndpoints).values({
      id: endpointId,
      companyId: f.companyId,
      connectionId,
      provider: "slack",
      publicId: randomUUID(),
      assignedAgentId: f.agentId,
      status: "active",
    });
    await db.insert(heartbeatRuns).values({
      id: failedRunId,
      companyId: f.companyId,
      agentId: f.agentId,
      status: "failed",
      finishedAt: new Date(),
      contextSnapshot: {
        issueId: f.issueId,
        taskKey,
        source: "chat:slack",
        wakeCommentIds: commentIds,
      },
    });
    await db.insert(issueComments).values(
      commentIds.map((id) => ({
        id,
        companyId: f.companyId,
        issueId: f.issueId,
        authorUserId: "board-user",
        body: "Exact original request",
      })),
    );
    await db.insert(chatActions).values({
      id: actionId,
      companyId: f.companyId,
      endpointId,
      kind: "failed_run_retry",
      providerActionId: `failed_run_retry:${failedRunId}`,
      status: "issued",
      payload: { issueId: f.issueId, failedRunId },
    });
    const context = {
      issueId: f.issueId,
      source: "chat:slack",
      taskKey,
      wakeCommentId: commentIds[1],
      wakeCommentIds: commentIds,
      retryOfRunId: failedRunId,
      chatFailedRunRetry: { version: 1, actionId, failedRunId },
    };
    const request = createDurableChatWakeupRequest({
      ...f.request(commentIds[1]),
      id: actionId,
      failedRunRetry: { failedRunId },
    });
    const authority = vi.fn(
      async (
        _tx: unknown,
        input: { contextSnapshot: Record<string, unknown>; phase: string },
      ) => {
        expect(input.contextSnapshot).toMatchObject(context);
      },
    );
    const register = () => {
      const dispose = registerFailedChatRunRetryAuthority(db, authority);
      unregisterAuthorities.push(dispose);
      return dispose;
    };
    const wake = (options: Record<string, unknown> = {}) =>
      f.heartbeat.wakeup(f.agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "retry_failed_chat_run",
        payload: { ...context },
        contextSnapshot: { ...context },
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        durableChatRequest: request,
        allowRunCoalescing: true,
        ...options,
      });
    return {
      ...f,
      failedRunId,
      actionId,
      context,
      commentIds,
      request,
      authority,
      register,
      wake,
    };
  }

  it("fails closed for a persisted retry when its live authority is unavailable", async () => {
    const f = await retryFixture();
    await expect(f.wake()).rejects.toBeInstanceOf(
      FailedChatRunRetryAuthorizationError,
    );
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, f.actionId)),
    ).toEqual([]);
  });

  it("does not turn a forged retry selector into authority", async () => {
    const f = await fixture();
    await expect(
      f.heartbeat.wakeup(f.agentId, {
        payload: { issueId: f.issueId },
        contextSnapshot: {
          chatFailedRunRetry: {
            version: 1,
            actionId: randomUUID(),
            failedRunId: randomUUID(),
          },
        },
        requestedByActorType: "user",
        requestedByActorId: "board-user",
      }),
    ).rejects.toBeInstanceOf(FailedChatRunRetryAuthorizationError);
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, f.agentId)),
    ).toEqual([]);
  });

  it("preserves exact retry provenance and a deeply frozen server-only selector", async () => {
    const f = await retryFixture();
    f.register();
    expect(Object.isFrozen(f.request.failedRunRetry)).toBe(true);
    const run = await f.wake();
    expect(run).toMatchObject({
      status: "queued",
      retryOfRunId: f.failedRunId,
      wakeupRequestId: f.actionId,
      contextSnapshot: f.context,
    });
    expect(f.authority).toHaveBeenCalledTimes(1);
    expect(f.authority.mock.calls[0][1]).toMatchObject({ phase: "admission" });
    await f.wake();
    expect(f.authority).toHaveBeenCalledTimes(1);
  });

  it("cannot coalesce an exact retry into active or deferred ordinary work", async () => {
    const f = await retryFixture(true);
    const ordinary = f.request;
    await queueIssueAssignmentWakeup({
      heartbeat: f.heartbeat,
      issue: {
        id: f.issueId,
        assigneeAgentId: f.agentId,
        status: "in_progress",
      },
      reason: "External chat message received",
      mutation: "chat_message_received",
      contextSource: "chat:slack",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      wakeCommentId: f.commentIds[0],
      durableChatRequest: createDurableChatWakeupRequest({
        ...ordinary,
        id: randomUUID(),
        commentId: f.commentIds[0],
        failedRunRetry: undefined,
      }),
      rethrowOnError: true,
    });
    f.register();
    await f.wake();
    const receipts = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, f.agentId));
    expect(receipts).toHaveLength(2);
    expect(
      receipts.every(
        (row) =>
          row.status === "deferred_issue_execution" && row.coalescedCount === 0,
      ),
    ).toBe(true);
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.wakeupRequestId, f.actionId)),
    ).toEqual([]);
  });

  it("rediscovers a retry from durable provenance even if its hint was stripped", async () => {
    const f = await retryFixture();
    const { chatFailedRunRetry: _selector, ...contextSnapshot } = f.context;
    await expect(
      authorizeFailedChatRunRetryWake(db, db, {
        phase: "execution",
        wakeupRequestId: f.actionId,
        companyId: f.companyId,
        agentId: f.agentId,
        issueId: f.issueId,
        contextSnapshot,
      }),
    ).rejects.toBeInstanceOf(FailedChatRunRetryAuthorizationError);
  });

  it("an older service disposer cannot remove a newer retry authority", async () => {
    const f = await retryFixture();
    const oldDispose = f.register();
    const replacement = vi.fn(async () => {});
    unregisterAuthorities.push(
      registerFailedChatRunRetryAuthority(db, replacement),
    );
    oldDispose();
    await f.wake();
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(f.authority).not.toHaveBeenCalled();
  });

  it.each([false, true])("cancels a revoked deferred retry without reopening its batch (execution hold=%s)", async (held) => {
    const f = await retryFixture(true);
    const clearHold = held ? await executionHold(f) : null;
    f.register();
    await f.wake();
    await clearHold?.();
    f.authority.mockImplementation(async (_tx, input) => {
      if (input.phase === "promotion")
        throw conflict("Current chat access was revoked");
    });
    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, f.issueId));
    await f.heartbeat.cancelRun(f.activeRunId, "Fixture predecessor finished", {
      suppressImmediateRecovery: true,
    });
    await f.heartbeat.drainActiveRunExecutions();
    const [receipt] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, f.actionId));
    expect(receipt).toMatchObject({ status: "cancelled", runId: null });
    expect(receipt.payload).toMatchObject({ wakeCommentIds: f.commentIds });
    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({ status: "done", executionRunId: null });
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.wakeupRequestId, f.actionId)),
    ).toEqual([]);
    expect(f.authority.mock.calls.map((call) => call[1].phase)).toEqual([
      "admission",
      "promotion",
    ]);
  });

  it("denies a queued retry at execution when current authority is revoked", async () => {
    const f = await retryFixture();
    f.register();
    const queued = await f.wake();
    f.authority.mockImplementation(async (_tx, input) => {
      if (input.phase === "execution")
        throw conflict("Current chat access was revoked", {
          code: "chat_failed_run_retry_not_authorized",
        });
    });
    await f.heartbeat.cancelRun(
      f.activeRunId,
      "Fixture execution slot released",
      { suppressImmediateRecovery: true },
    );
    await f.heartbeat.drainActiveRunExecutions();
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, queued!.id));
    expect(run).toMatchObject({
      status: "failed",
      retryOfRunId: f.failedRunId,
      nativeSessionId: null,
      errorCode: "chat_failed_run_retry_not_authorized",
    });
    expect(run.error).toContain("Current chat access was revoked");
    const [issue] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, f.issueId));
    expect(issue).toMatchObject({ status: "blocked", executionRunId: null });
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, f.agentId)),
    ).toHaveLength(3);
    expect(f.authority.mock.calls.map((call) => call[1].phase)).toEqual([
      "admission",
      "execution",
    ]);
  });

  it.each([false, true])("Fork divergence (D9 deferred, slice 2c): preserves the exact retry column and comment batch during promotion (execution hold=%s)", async (held) => {
    const f = await retryFixture(true);
    const clearHold = held ? await executionHold(f) : null;
    f.register();
    await f.wake();
    await clearHold?.();
    // A separate fixture-owned run occupies the agent slot after the issue's
    // predecessor releases it, so this asserts promotion before execution.
    const blockerId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: blockerId,
      companyId: f.companyId,
      agentId: f.agentId,
      status: "running",
      contextSnapshot: { issueId: randomUUID() },
    });
    runningProcesses.set(blockerId, {
      child: {} as never,
      graceSec: 0,
      processGroupId: null,
    });
    liveRunIds.add(blockerId);
    await f.heartbeat.cancelRun(f.activeRunId, "Fixture predecessor finished", {
      suppressImmediateRecovery: true,
    });
    await f.heartbeat.drainActiveRunExecutions();
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.wakeupRequestId, f.actionId));
    // Fork divergence (D9 deferred, slice 2c): upstream's wake-queue promotion (#13038,
    // finalizePromotedWake for an authorized failed-chat retry) stamps the promoted run's
    // retryOfRunId COLUMN with the failed run. This fold keeps the fork's in-file
    // releaseIssueExecutionAndPromote as the live release (operator decision 2026-09-15). Its
    // promotion inserts the run without that column. The fold-2c Q2 fence does add upstream's
    // promotion-phase authority check (phases asserted below). What this case protects still
    // holds on the fork: the promoted run carries the exact comment batch and retry lineage in
    // its context snapshot (retryOfRunId and the chatFailedRunRetry selector that the
    // execution-phase check reads), and the receipt is promoted once. Inverted rather than
    // deleted so the divergence stays guarded. Restore upstream's retryOfRunId assertion in the
    // change that makes the wake-queue module release live.
    expect(run).toMatchObject({
      status: "queued",
      retryOfRunId: null,
      contextSnapshot: f.context,
    });
    const [receipt] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, f.actionId));
    expect(receipt).toMatchObject({ status: "queued", runId: run.id });
    expect(f.authority.mock.calls.map((call) => call[1].phase)).toEqual([
      "admission",
      "promotion",
    ]);
  });

  it.each([false, true])(
    "rechecks current retry authority immediately before dispatch (revoked=%s)",
    async (revoked) => {
      const f = await retryFixture();
      await db
        .update(agents)
        .set({ adapterType: "durable_chat_retry_test" })
        .where(eq(agents.id, f.agentId));
      f.register();
      const queued = await f.wake();
      let executionChecks = 0;
      f.authority.mockImplementation(async (_tx, input) => {
        if (input.phase === "execution" && ++executionChecks === 2 && revoked) {
          throw conflict("Current chat access was revoked before dispatch", {
            code: "chat_failed_run_retry_not_authorized",
          });
        }
      });
      await f.heartbeat.cancelRun(
        f.activeRunId,
        "Fixture execution slot released",
        { suppressImmediateRecovery: true },
      );
      await f.heartbeat.drainActiveRunExecutions();
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queued!.id));
      expect(executionChecks).toBe(2);
      expect(execute).toHaveBeenCalledTimes(revoked ? 0 : 1);
      expect(run).toMatchObject({
        status: revoked ? "failed" : "succeeded",
        retryOfRunId: f.failedRunId,
        nativeSessionId: null,
      });
      if (revoked)
        expect(run.errorCode).toBe("chat_failed_run_retry_not_authorized");
      expect(
        await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, f.agentId)),
      ).toHaveLength(3);
      expect(f.authority.mock.calls.map((call) => call[1].phase)).toEqual([
        "admission",
        "execution",
        "execution",
      ]);
    },
  );

  it.each([
    { forceFreshSession: true },
    { resumeFromRunId: randomUUID() },
    { resumeSessionParams: { sessionId: "unrelated-provider-session" } },
    { resumeSessionDisplayId: "unrelated-provider-session" },
  ])(
    "does not admit routing overrides on an exact retry (%j)",
    async (override) => {
      const f = await retryFixture();
      f.register();
      await expect(
        f.wake({ contextSnapshot: { ...f.context, ...override } }),
      ).rejects.toBeInstanceOf(FailedChatRunRetryAuthorizationError);
      expect(f.authority).not.toHaveBeenCalled();
      expect(
        await db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, f.actionId)),
      ).toEqual([]);
    },
  );

  const ownershipFenceScopes = [
    { withDeferredInput: false, sourceKind: "inbound_wakeup" },
    { withDeferredInput: true, sourceKind: "inbound_wakeup" },
    { withDeferredInput: false, sourceKind: "unrelated_action" },
    { withDeferredInput: false, sourceKind: "missing" },
  ].flatMap((scope) => [false, true].map((preProvider) => ({ ...scope, preProvider })));
  const isForkD9LegacyReleaseScope = (scope: (typeof ownershipFenceScopes)[number]) =>
    scope.sourceKind !== "inbound_wakeup" && !scope.withDeferredInput && !scope.preProvider;

  async function runOwnershipFenceScenario({
    withDeferredInput,
    sourceKind,
    preProvider,
  }: (typeof ownershipFenceScopes)[number]) {
    const f = await retryFixture();
    await db
      .update(agents)
      .set({ adapterType: "durable_chat_retry_test" })
      .where(eq(agents.id, f.agentId));
    await db
      .update(chatActions)
      .set({ kind: sourceKind, payload: { issueId: f.issueId } })
      .where(eq(chatActions.id, f.actionId));
    if (sourceKind === "missing")
      await db.delete(chatActions).where(eq(chatActions.id, f.actionId));
    const { failedRunRetry: _retry, ...ordinaryRequest } = f.request;
    const wakeOriginal = (id: string, commentId: string) =>
      f.heartbeat.wakeup(f.agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "chat_message_received",
        requestedByActorType: "user",
        requestedByActorId: "board-user",
        payload: {
          issueId: f.issueId,
          wakeCommentId: commentId,
          wakeCommentIds: [commentId],
        },
        contextSnapshot: {
          issueId: f.issueId,
          taskKey: f.context.taskKey,
          source: "chat:slack",
          wakeCommentId: commentId,
          wakeCommentIds: [commentId],
        },
        durableChatRequest: createDurableChatWakeupRequest({
          ...ordinaryRequest,
          id,
          commentId,
        }),
        allowRunCoalescing: false,
      });
    if (preProvider) {
      execute.mockResolvedValueOnce({
        exitCode: 1, signal: null, timedOut: false,
        summary: "Fixture failed before provider work",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      });
    } else {
      execute.mockRejectedValueOnce(new Error("Original chat provider outcome is unknown"));
    }
    const original = await wakeOriginal(f.actionId, f.commentIds[1]);
    const deferredId = randomUUID();
    if (withDeferredInput) {
      const [owner] = await db
        .select()
        .from(chatActions)
        .where(eq(chatActions.id, f.actionId));
      await db.insert(chatActions).values({
        ...owner,
        id: deferredId,
        providerActionId: `wakeup:${deferredId}`,
      });
      expect(await wakeOriginal(deferredId, f.commentIds[0])).toBeNull();
      const [receipt] = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, deferredId));
      expect(receipt.status).toBe("deferred_issue_execution");
    }
    await f.heartbeat.cancelRun(
      f.activeRunId,
      "Fixture execution slot released",
      { suppressImmediateRecovery: true },
    );
    await f.heartbeat.drainActiveRunExecutions();
    return { f, original, deferredId };
  }

  it.each(ownershipFenceScopes.filter((scope) => !isForkD9LegacyReleaseScope(scope)))(
    "fences generic recovery by actual original chat ownership ($sourceKind, deferred=$withDeferredInput, pre-provider=$preProvider)",
    async ({ withDeferredInput, sourceKind, preProvider }) => {
      const { f, original, deferredId } = await runOwnershipFenceScenario({
        withDeferredInput,
        sourceKind,
        preProvider,
      });
      const genericRecoveryExpected = preProvider && sourceKind !== "inbound_wakeup";
      const nextExecutionExpected = preProvider && (withDeferredInput || genericRecoveryExpected);
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, original!.id));
      expect(run).toMatchObject({
        status: "failed",
        retryOfRunId: null,
        wakeupRequestId: f.actionId,
      });
      expect(execute).toHaveBeenCalledTimes(
        nextExecutionExpected ? 2 : 1,
      );
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, f.agentId));
      expect(runs).toHaveLength(
        nextExecutionExpected ? 4 : 3,
      );
      expect(
        runs.some(
          (entry) =>
            (entry.contextSnapshot as Record<string, unknown>)?.source ===
            "issue.continuation_recovery",
        ),
      ).toBe(genericRecoveryExpected);
      const [issue] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, f.issueId));
      expect(issue).toMatchObject({
        status:
          nextExecutionExpected ? "done" : preProvider ? "blocked" : "in_progress",
        executionRunId: null,
      });
      if (withDeferredInput) {
        const [receipt] = await db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, deferredId));
        const next = runs.find((entry) => entry.id === receipt.runId);
        if (!preProvider) {
          // Unknown earlier effects require reconciliation. Preserve the
          // separate user's durable cause, without dispatching it on this
          // cancellation/failure path or relabeling it as an automatic retry.
          expect(receipt).toMatchObject({ status: "deferred_issue_execution", runId: null });
          expect(next).toBeUndefined();
          return;
        }
        expect(next).toMatchObject({
          status: "succeeded",
          retryOfRunId: null,
          wakeupRequestId: deferredId,
          contextSnapshot: {
            source: "chat:slack",
            wakeCommentIds: [f.commentIds[0]],
          },
        });
      }
    },
  );

  // Fork divergence (D9 deferred, slice 2c): these two cases are a legacy original chat run that
  // failed with an unknown provider outcome and is NOT chat-owned (its chat_actions row is an
  // unrelated_action, or is gone). The shared legacy terminalization creates the board
  // `legacy_execution_requires_reconciliation` hold on both paths. Upstream then releases the run
  // through the generic legacy pre-drain exit of its wake-queue module release (as of 5545f6d,
  // the #13275 era; decidePreDrain: legacyExecutionNeedsReconciliation -> released, since #13132),
  // which applies to EVERY legacy run, so nothing executes after the original. That module release
  // is dormant under D9: this fold keeps the fork's in-file releaseIssueExecutionAndPromote live
  // (operator decision 2026-09-15), which does not consult the hold and queues and executes an
  // uncounted immediate issue_continuation_needed recovery run. The fold-2c Q2 fence (20494e0e6)
  // mirrors upstream's exit for chat-owned runs only, which is why the inbound_wakeup cases above
  // pass unedited. 84a537085 inverted the same class for non-chat runs in
  // heartbeat-process-recovery.test.ts ('does not bypass unknown process outcomes through immediate
  // continuation recovery' and siblings). What still holds on the fork: the original run fails
  // without retry lineage, no chat-owner block is placed, the recovery run carries none of the chat
  // input, and the execution lock is released. Inverted rather than deleted so the divergence stays
  // guarded (operator ruling Q2, 2026-09-15). The D9 port must restore upstream's assertions (put
  // these two cases back in the it.each above) and delete this block.
  it.each(ownershipFenceScopes.filter(isForkD9LegacyReleaseScope))(
    "Fork divergence (D9 deferred, slice 2c): fences generic recovery by actual original chat ownership ($sourceKind, deferred=$withDeferredInput, pre-provider=$preProvider)",
    async (scope) => {
      const { f, original } = await runOwnershipFenceScenario(scope);
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, original!.id));
      expect(run).toMatchObject({
        status: "failed",
        retryOfRunId: null,
        wakeupRequestId: f.actionId,
      });
      expect(
        await db
          .select()
          .from(issueRecoveryActions)
          .where(eq(issueRecoveryActions.sourceIssueId, f.issueId)),
      ).toEqual([
        expect.objectContaining({
          ownerType: "board",
          cause: "legacy_execution_requires_reconciliation",
          status: "active",
          returnOwnerAgentId: f.agentId,
          fingerprint: `legacy-execution:${original!.id}`,
        }),
      ]);
      const runs = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, f.agentId));
      expect(runs).toHaveLength(4);
      const recoveryRuns = runs.filter(
        (entry) =>
          (entry.contextSnapshot as Record<string, unknown>)?.source ===
          "issue.continuation_recovery",
      );
      expect(recoveryRuns).toEqual([
        expect.objectContaining({
          status: "succeeded",
          retryOfRunId: original!.id,
          scheduledRetryAttempt: 0,
          contextSnapshot: expect.objectContaining({
            wakeReason: "issue_continuation_needed",
            retryReason: "issue_continuation_needed",
            retryOfRunId: original!.id,
          }),
        }),
      ]);
      expect(recoveryRuns[0]!.contextSnapshot).not.toHaveProperty("wakeCommentIds");
      expect(recoveryRuns[0]!.contextSnapshot).not.toHaveProperty("chatFailedRunRetry");
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls.map(([input]) => input.runId)).toEqual([
        original!.id,
        recoveryRuns[0]!.id,
      ]);
      const [issue] = await db
        .select()
        .from(issues)
        .where(eq(issues.id, f.issueId));
      expect(issue).toMatchObject({ status: "done", executionRunId: null });
    },
  );

  it("keeps committed-response authority exact-Db scoped and separate from retry hints", async () => {
    const input = {
      companyId: randomUUID(),
      issueId: randomUUID(),
      agentId: randomUUID(),
      runId: randomUUID(),
      resultId: randomUUID(),
    };
    const otherDb = {} as typeof db;
    const authority = vi.fn(async () => undefined);
    const dispose = registerCommittedChatResponseAuthority(db, authority);
    try {
      await expect(
        authorizeCommittedChatResponse(otherDb, db, input),
      ).rejects.toBeInstanceOf(CommittedChatResponseAuthorizationError);
      expect(authority).not.toHaveBeenCalled();
      await authorizeCommittedChatResponse(db, db, input);
      expect(authority).toHaveBeenCalledExactlyOnceWith(db, input);
    } finally {
      dispose();
    }
    await expect(
      authorizeCommittedChatResponse(db, db, input),
    ).rejects.toBeInstanceOf(CommittedChatResponseAuthorizationError);
  });

  it("preserves the current committed-response authority and exact transient failure", async () => {
    const input = {
      companyId: randomUUID(),
      issueId: randomUUID(),
      agentId: randomUUID(),
      runId: randomUUID(),
      resultId: randomUUID(),
    };
    const first = registerCommittedChatResponseAuthority(
      db,
      async () => undefined,
    );
    const storageFailure = new Error("temporary source storage failure");
    const second = registerCommittedChatResponseAuthority(db, async () => {
      throw storageFailure;
    });
    try {
      first();
      await expect(authorizeCommittedChatResponse(db, db, input)).rejects.toBe(
        storageFailure,
      );
    } finally {
      second();
    }
  });

  it("does not discard a deferred retry on transient authority storage failure", async () => {
    const f = await retryFixture(true);
    f.register();
    await f.wake();
    const failure = new Error("Fixture authorization store unavailable");
    f.authority.mockRejectedValueOnce(failure);
    await expect(
      f.heartbeat.cancelRun(f.activeRunId, "Fixture predecessor finished", {
        suppressImmediateRecovery: true,
      }),
    ).rejects.toBe(failure);
    const [receipt] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, f.actionId));
    expect(receipt).toMatchObject({
      status: "deferred_issue_execution",
      runId: null,
    });
    expect(receipt.payload).toMatchObject({ wakeCommentIds: f.commentIds });
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.wakeupRequestId, f.actionId)),
    ).toEqual([]);
  });

  it("retries and competing workers create one queued receipt and one run", async () => {
    const f = await fixture();
    const request = f.request();
    await Promise.all([f.wake(request), f.wake(request)]);
    await f.wake(request);
    const receipts = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, request.id));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      status: "queued",
      idempotencyKey: request.idempotencyKey,
    });
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, f.agentId),
            eq(heartbeatRuns.wakeupRequestId, request.id),
          ),
        ),
    ).toHaveLength(1);
    expect(f.authorize).toHaveBeenCalledTimes(1);
  });

  it("records a stable receipt when merging into a deferred wake and never merges the replay twice", async () => {
    const f = await fixture(true);
    const first = f.request(),
      second = f.request();
    await f.wake(first);
    await f.wake(second);
    await f.wake(second);
    const rows = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, f.agentId));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === first.id)).toMatchObject({
      status: "deferred_issue_execution",
      coalescedCount: 1,
    });
    expect(rows.find((row) => row.id === second.id)).toMatchObject({
      status: "coalesced",
      payload: { coalescedIntoWakeupRequestId: first.id },
    });
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, f.agentId)),
    ).toHaveLength(1);
  });

  it("keeps different actors in separate deferred receipts", async () => {
    const f = await fixture(true);
    await f.wake(f.request());
    await f.wake(f.request(randomUUID(), "another-user"));
    const rows = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, f.agentId));
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) =>
          row.status === "deferred_issue_execution" && row.coalescedCount === 0,
      ),
    ).toBe(true);
  });

  it("records queued-run coalescence once with the stable receipt ID", async () => {
    const f = await fixture();
    const first = f.request(),
      second = f.request();
    await f.wake(first);
    const [firstReceipt] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, first.id));
    await db
      .update(issues)
      .set({
        executionRunId: firstReceipt.runId,
        executionAgentNameKey: "maya",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, f.issueId));
    await f.wake(second);
    await f.wake(second);
    const [receipt] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, second.id));
    expect(receipt).toMatchObject({
      status: "coalesced",
      runId: firstReceipt.runId,
      coalescedCount: 1,
    });
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, f.agentId)),
    ).toHaveLength(2);
  });

  it("rejects a stable receipt ID reused for a different authenticated actor", async () => {
    const f = await fixture();
    const first = f.request();
    await f.wake(first);
    const conflicting = createDurableChatWakeupRequest({
      ...first,
      requestedByActorId: "different-user",
    });
    await expect(f.wake(conflicting)).rejects.toThrow(
      "chat_inbound_wakeup_receipt_conflict",
    );
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, f.agentId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, f.agentId)),
    ).toHaveLength(2);
  });

  it("never readmits or dispatches a cancelled receipt on replay", async () => {
    const f = await fixture();
    const request = f.request();
    await f.wake(request);
    const [receipt] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, request.id));
    await db
      .update(agentWakeupRequests)
      .set({ status: "cancelled" })
      .where(eq(agentWakeupRequests.id, request.id));
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, receipt.runId!));
    await f.wake(request);
    expect(f.authorize).toHaveBeenCalledTimes(1);
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, f.agentId)),
    ).toHaveLength(2);
  });

  it("does not accept a JSON copy of the internal scheduling capability", async () => {
    const f = await fixture();
    const request = f.request();
    await expect(f.wake(JSON.parse(JSON.stringify(request)))).rejects.toThrow(
      "chat_inbound_wakeup_binding_denied",
    );
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, f.agentId)),
    ).toEqual([]);
  });

  it("rechecks current authorization in the scheduling transaction", async () => {
    const f = await fixture();
    f.authorize.mockRejectedValueOnce(new Error("reach revoked"));
    await expect(f.wake(f.request())).rejects.toThrow("reach revoked");
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, f.agentId)),
    ).toEqual([]);
  });

  it.each([
    { provider: "slack", state: "active", callerMarkers: false },
    { provider: "telegram", state: "completed", callerMarkers: false },
    { provider: "slack", state: "active", callerMarkers: true },
  ] as const)(
    "rejects generic failed-chat retry before admission ($provider/$state; caller markers: $callerMarkers)",
    async ({ provider, state, callerMarkers }) => {
      // Keep the fixture-owned unrelated run occupying the only execution slot.
      // This exercises real heartbeat admission without starting an adapter.
      const f = await fixture();
      const applicationId = randomUUID();
      const connectionId = randomUUID();
      const endpointId = randomUUID();
      const conversationId = randomUUID();
      const originalCommentId = randomUUID();
      const failedCommentId = randomUUID();
      const taskKey = `D${f.companyId.slice(0, 7)}-1`;
      await db
        .update(issues)
        .set({
          identifier: taskKey,
          description: "Original request A: describe the original photo.",
        })
        .where(eq(issues.id, f.issueId));
      await db.insert(toolApplications).values({
        id: applicationId,
        companyId: f.companyId,
        name: "Failed chat retry",
        type: "chat",
      });
      await db.insert(toolConnections).values({
        id: connectionId,
        companyId: f.companyId,
        applicationId,
        name: `${provider} failed chat retry`,
        uid: `chat-retry-${connectionId}`,
        connectionPurpose: "channel",
        transport: "chat_sdk",
        enabled: true,
        status: "active",
      });
      await db.insert(chatEndpoints).values({
        id: endpointId,
        companyId: f.companyId,
        connectionId,
        provider,
        publicId: randomUUID(),
        assignedAgentId: f.agentId,
        status: "active",
      });
      await db.insert(chatConversations).values({
        id: conversationId,
        companyId: f.companyId,
        endpointId,
        issueId: f.issueId,
        externalConversationId: `${provider}-retry-dm`,
        externalThreadId: `${provider}-retry-thread`,
        externalLabel: `${provider} retry fixture`,
        sessionGeneration: 1,
        isDirectMessage: true,
        state: "active",
      });
      await db.insert(issueComments).values([
        {
          id: originalCommentId,
          companyId: f.companyId,
          issueId: f.issueId,
          authorUserId: "board-user",
          body: "Original request A: describe the original photo.",
        },
        {
          id: failedCommentId,
          companyId: f.companyId,
          issueId: f.issueId,
          authorUserId: "board-user",
          body: "Later request B: explain the new queue behavior, not the photo.",
        },
      ]);
      await db.insert(chatMessageLinks).values(
        [originalCommentId, failedCommentId].map((commentId, index) => ({
          companyId: f.companyId,
          endpointId,
          conversationId,
          commentId,
          providerMessageId: `${provider}-retry-${index}`,
          direction: "inbound",
        })),
      );
      const request = f.request(failedCommentId);
      await queueIssueAssignmentWakeup({
        heartbeat: f.heartbeat,
        issue: {
          id: f.issueId,
          assigneeAgentId: f.agentId,
          status: "in_progress",
        },
        reason: "External chat message received",
        mutation: "chat_message_received",
        contextSource: `chat:${provider}`,
        taskKey,
        requestedByActorType: request.requestedByActorType,
        requestedByActorId: request.requestedByActorId,
        wakeCommentId: failedCommentId,
        durableChatRequest: request,
        rethrowOnError: true,
      });
      const [admitted] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.wakeupRequestId, request.id));
      expect(admitted).toMatchObject({
        status: "queued",
        contextSnapshot: {
          taskKey,
          source: `chat:${provider}`,
          wakeCommentId: failedCommentId,
          wakeCommentIds: [failedCommentId],
        },
      });
      // Simulate a transient execution failure, not an integrity fault or a
      // manual edit to any live runner root. The admitted request stays intact.
      await db
        .update(heartbeatRuns)
        .set({ status: "failed", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, admitted.id));
      await db
        .update(agentWakeupRequests)
        .set({ status: "failed", finishedAt: new Date() })
        .where(eq(agentWakeupRequests.id, request.id));
      await db
        .update(issues)
        .set({
          status: "blocked",
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
        })
        .where(eq(issues.id, f.issueId));
      if (state === "completed") {
        await db
          .update(chatConversations)
          .set({ state: "completed" })
          .where(eq(chatConversations.id, conversationId));
      }
      const snapshot = async () => ({
        runs: await db
          .select()
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.agentId, f.agentId))
          .orderBy(heartbeatRuns.id),
        receipts: await db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.agentId, f.agentId))
          .orderBy(agentWakeupRequests.id),
        issue: await db.select().from(issues).where(eq(issues.id, f.issueId)),
        conversation: await db
          .select()
          .from(chatConversations)
          .where(eq(chatConversations.id, conversationId)),
        publications: await db
          .select()
          .from(chatPublications)
          .where(eq(chatPublications.conversationId, conversationId)),
      });
      const before = await snapshot();
      // This is the existing IssueDetail/Inbox generic wakeup API, deliberately
      // lacking a failed-run ID. It must not silently retry A in a UUID-keyed
      // session after losing B's exact chat comment and admission authority.
      const rejection = await f.heartbeat
        .wakeup(f.agentId, {
          source: "on_demand",
          triggerDetail: "manual",
          reason: "retry_failed_run",
          payload: {
            issueId: f.issueId,
            ...(callerMarkers
              ? {
                  retryOfRunId: admitted.id,
                  taskKey,
                  commentId: failedCommentId,
                }
              : {}),
          },
          ...(callerMarkers
            ? {
                contextSnapshot: {
                  source: `chat:${provider}`,
                  retryOfRunId: admitted.id,
                  wakeCommentId: failedCommentId,
                  wakeCommentIds: [failedCommentId],
                },
              }
            : {}),
          requestedByActorType: "user",
          requestedByActorId: "board-user",
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect.soft(rejection).toMatchObject({
        status: 409,
        details: { code: "chat_failed_run_retry_requires_authorized_context" },
      });
      const after = await snapshot();
      expect.soft(after.receipts).toEqual(before.receipts);
      expect.soft(after.runs).toEqual(before.runs);
      expect.soft(after.issue).toEqual(before.issue);
      expect.soft(after.conversation).toEqual(before.conversation);
      expect.soft(after.publications).toEqual(before.publications);
      expect(f.authorize).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves ordinary non-chat manual retry admission", async () => {
    const f = await fixture();
    const retry = await f.heartbeat.wakeup(f.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "retry_failed_run",
      payload: { issueId: f.issueId },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });
    expect(retry).toMatchObject({
      status: "queued",
      contextSnapshot: {
        issueId: f.issueId,
        taskKey: f.issueId,
        wakeReason: "retry_failed_run",
      },
    });
    const receipts = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, f.agentId));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ status: "queued", runId: retry!.id });
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, f.agentId)),
    ).toHaveLength(2);
  });
});
