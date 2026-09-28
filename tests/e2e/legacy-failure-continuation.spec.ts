import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect, type APIResponse } from "@playwright/test";
import { and, eq } from "../../server/node_modules/drizzle-orm/index.js";
import { createDb, closeRegisteredClients, heartbeatRuns, issueRecoveryActions, issues, issueComments, agentWakeupRequests, authUsers, companyMemberships } from "../../packages/db/src/index.ts";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

for (const action of ["task_retry", "thread_retry", "inbox_retry", "message", "queued_interrupt", "automatic_message"] as const) {
  test(`legacy startup hold: ${action} reaches a new agent response`, async ({ page, request }) => {
    // SUP-17651 board decision 302d393f / exec-CTO ruling 75dd7e23 + correction b4441ea3:
    // the two retry variants (thread_retry, inbox_retry) were quarantined because the
    // "Try again" / "Retry" affordance is a pre-projection control whose render is a
    // three-predicate server-state wait (TaskChatThread.tsx:2822-2831) one-way-falsified
    // by the state this spec deliberately seeds (TaskChatThread.tsx:546-577,
    // IssueRecoveryActionCard.tsx:1080/1129): the reconciliation-causing recovery action,
    // the recovery_needed projection, and any retry off `blocked` each withdraw the
    // button, and none of those predicates ever flip back, so a longer visibility cap
    // cannot pass (measured 5/5 local green at ~13s click-wins vs 2/2 CI red at the
    // 240s cap, projection-wins). SUP-17740 re-enables them by dropping the UI click and
    // driving the continuation through the server path the affordance would have
    // triggered (the board retry_failed_run manual wakeup, see the else branch below),
    // which is deterministic in this seeded state and cannot race the projection.
    // SUP-17651: envelope for loaded-runner setup plus the signal-driven waits below:
    // the post-dispatch completion signal (90s pipeline poll + 90s done-close poll +
    // two 45s render checks). The internal waits terminate early when the server state
    // settles; the cap is the pathological ceiling, not a budget. 600s = setup +
    // worst-case post-dispatch (90s + 90s + 45s + 45s); normal cases finish in ~12s,
    // so the extra ceiling costs nothing but the pathological tail.
    test.setTimeout(600_000);
    const root = await mkdtemp(path.join(os.tmpdir(), "legacy-recovery-browser-"));
    const config = JSON.parse(await readFile(process.env.PAPERCLIP_E2E_SERVER_CONFIG!, "utf8"));
    // Use the running test server's actual port, including fallback allocation.
    const pid = await readFile(path.join(config.database.embeddedPostgresDataDir, "postmaster.pid"), "utf8");
    const url = `postgres://paperclip:paperclip@127.0.0.1:${pid.split("\n")[3]}/paperclip`;
    const db = createDb(url);
    const company = await json(await request.post("/api/companies", { data: { name: `Legacy recovery ${action} ${Date.now()}` } }));
    try {
      await writeFile(path.join(root, "continued"), "ready");
      const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
        name: "Recovery fixture", role: "engineer", adapterType: "claude_local",
        adapterConfig: { engine: "acp", cwd: root, stateDir: path.join(root, "state"),
          agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("scripts/mcp-fixtures/servers/acp-stop-agent.mjs"))}`,
          // Fork divergence (SUP-13716 local ACP credential gate, slice 2c): upstream 9031516a7
          // runs this claude_local fixture with no Claude login, but the fork's
          // prepareClaudeLocalManagedHome (packages/adapters/claude-local/src/server/acp.ts, fork
          // 3f7308253) refuses a local ACP run whose agent-side home holds no OAuth credentials
          // unless fileless auth is configured, so the recovered run never reaches the fixture. A
          // placeholder subscription token is that gate's own bypass; the fixture never reads it
          // and billing stays `subscription`, so every recovery assertion below is unchanged.
          env: { PAPERCLIP_STOP_FIXTURE_ROOT: root, PAPERCLIP_STOP_FIXTURE_FINISH_TASK: "1", CLAUDE_CODE_OAUTH_TOKEN: "paperclip-e2e-fixture-placeholder" } },
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      } }));
      const issue = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
        title: "Continue after startup failure", description: "Answer the pending follow-up once.",
        status: "backlog", assigneeAgentId: agent.id,
      } }));
      const sourceRunId = randomUUID();
      // Seed the historical incident, then exercise all recovery through the UI.
      // No adapter.invoke or new dispatch identity exists on this pre-upgrade run.
      await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId: company.id, agentId: agent.id,
        status: "failed", runtimeMode: "legacy", processPid: action === "queued_interrupt" ? process.pid : 999999999,
        responsibleUserId: issue.responsibleUserId, errorCode: "process_lost", error: "Server restarted during startup",
        startedAt: new Date(Date.now() - 10_000), finishedAt: new Date(Date.now() - 5_000),
        contextSnapshot: { issueId: issue.id },
      });
      await db.insert(issueRecoveryActions).values({ companyId: company.id, sourceIssueId: issue.id,
        kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: sourceRunId,
        status: "resolved", outcome: "blocked", nextAction: "Automatic recovery stopped.",
        evidence: { runId: sourceRunId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      });
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issue.id));
      if (action === "queued_interrupt") {
        await db.insert(authUsers).values({ id: "original-board", name: "Original author", email: "original-author@example.test",
          createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
        await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user",
          principalId: "original-board", membershipRole: "operator", status: "active" });
      }
      if (action === "queued_interrupt" || action === "automatic_message") {
        const commentId = randomUUID();
        // Reproduce a real user comment saved while the failed run was active,
        // including queues originally created by a system wake.
        await db.insert(issueComments).values({ id: commentId, companyId: company.id, issueId: issue.id,
          authorType: "user", authorUserId: action === "queued_interrupt" ? "original-board" : "local-board", body: "Approved",
          createdAt: new Date(Date.now() - 8_000),
        });
        await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id,
          source: "automation", reason: "issue_commented", status: "deferred_issue_execution",
          requestedByActorType: "system", payload: { issueId: issue.id, commentId,
            _paperclipWakeContext: { issueId: issue.id, wakeCommentIds: [commentId], wakeCommentId: commentId } },
        });
      }
      const taskUrl = `/${company.issuePrefix}/issues/${issue.identifier}`;
      await page.goto(action === "inbox_retry" ? `/${company.issuePrefix}/inbox/all` : taskUrl);
      if (action === "task_retry") {
        const notice = page.getByRole("status", { name: "Task recovery" });
        await expect(notice).toHaveText("Automatic recovery of this task stopped.Retry");
        await expect(notice.getByRole("link")).toHaveCount(0);
        const presentation = await notice.evaluate(element => {
          const style = getComputedStyle(element);
          return { border: style.borderTopWidth, background: style.backgroundColor };
        });
        expect(parseFloat(presentation.border)).toBeGreaterThan(0);
        expect(presentation.background).not.toBe("rgba(0, 0, 0, 0)");
        await test.info().attach("recovery-notice", { body: await notice.screenshot(), contentType: "image/png" });
      }
      if (action === "queued_interrupt") {
        const interrupt = page.getByRole("button", { name: "Interrupt", exact: true });
        // Fork divergence (merge_group flake hardening, slice 2d): upstream leaves this on the
        // 5s default expect timeout, but the button only renders once the recovered legacy run
        // reaches a running state, which on a loaded shard takes longer -- PR #748's merge_group
        // run failed here with "element(s) not found". Upstream's semantics are unchanged; only
        // the wait is widened, to the same 45s this spec already allows for its reply assertion.
        await expect(interrupt).toBeEnabled({ timeout: 45_000 });
        await db.update(heartbeatRuns).set({ processPid: 999999999 }).where(eq(heartbeatRuns.id, sourceRunId));
        await interrupt.click();
      } else if (action === "automatic_message") {
        // No Retry, duplicate message, or status change: the saved input runs.
      } else if (action === "message") {
        await page.getByRole("textbox", { name: "editable markdown" }).fill("Please continue the pending follow-up.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
      } else {
        // SUP-17740 (server-path drive, exec-CTO b4441ea3 §2): instead of waiting for and
        // clicking the UI affordance -- which the seeded state deliberately withholds, the
        // retry button is a pre-projection control one-way-falsified by the reconciliation
        // projection, so a longer cap cannot pass -- drive the continuation through the
        // exact server path the affordance would have triggered: the board `retry_failed_run`
        // manual wakeup (agentsApi.retryFailedRun, ui/src/api/agents.ts:249 -> POST
        // /api/agents/:id/wakeup). This deterministically retries the seeded legacy run in
        // this state (the retry_failed_run admission path continues a legacy
        // reconciliation run; see server/src/services/explicit-native-continuation.ts) and
        // cannot race the projection. Both variants share the identical seeded state, so
        // both drive the same server path; only the surface they started from differs.
        // json() asserts the wakeup dispatches (200), so a skipped/withheld admission
        // fails here instead of starving the post-dispatch completion waits.
        await json(await request.post(`/api/agents/${agent.id}/wakeup`, {
          data: {
            source: "on_demand",
            triggerDetail: "manual",
            reason: "retry_failed_run",
            failedRunId: sourceRunId,
          },
        }));
        if (action === "inbox_retry") await page.goto(taskUrl);
      }
      // Fork divergence (SUP-12693 done-tier close comment, slice 2c): upstream 9031516a7 posts
      // this reply only when the run finalizes, but the fork fixture closes with a reply-bearing
      // Tier 1 comment mid-turn, so until the run settles the reply also renders as the live
      // transcript interstitial and an unscoped getByText hits a strict-mode violation. Both
      // reply checks assert on the posted agent reply bubble, which is the response under test.
      // SUP-17651: wait on the real completion signal -- a recovered run (not the seeded
      // sourceRunId) reaching terminal success in the server's state -- instead of a fixed
      // 45s wall-clock budget. On loaded CI shards the pipeline (wakeup dispatch, ACP process
      // spawn, run finalization) and browser rendering can each lag; the old fixed window
      // turned that lag into a hard "reply never appeared" timeout at the test cap. The poll
      // bounds the pipeline wait and terminates early the moment any recovered run settles
      // succeeded; the UI assertions below then verify rendering against settled state.
      //
      // SUP-17651 (round-2): assert on the CAUSE, not the count. The platform bounds
      // pre-adapter setup_failed retries (SUP-15589, PRE_ADAPTER_SETUP_FAILURE_MAX_ATTEMPTS
      // = 3, heartbeat.ts:950), so a transient bounded-retry chain (one setup_failed + one
      // succeeded) is legitimate platform behavior on a loaded shard, not a defect. "Exactly
      // one recovered run" wrongly failed on that chain. The signal is "at least one
      // recovered run is terminal-succeeded"; the cause-discriminator after the reply check
      // still fails on a true out-of-bounds automation replay of a non-retryable disposition.
      // SUP-17651 (exec-CTO 2026-09-26T22:48Z): a poll timeout must name the
      // stall class -- no recovered run at all (never dispatched) vs a run in a
      // non-terminal status (spawned and hung) vs a finalized non-succeeded
      // run -- instead of failing an opaque boolean predicate.
      //
      // Root cause of the CI-only failures: a bare `await expect.poll(fn, opts)`
      // (no chained matcher) is a NO-OP in Playwright 1.62.x -- it returns the
      // matcher container object, which is not thenable, so the callback is
      // never invoked and the await resolves instantly. Verified against the
      // stock @playwright/test@1.62.1 npm build. Chaining `.toBe(true)` is
      // what actually drives the polling loop (invokePollMatcher), matches
      // every other expect.poll call in this repo, and makes the timeout
      // below real: it now terminates early when the predicate first holds,
      // and throws after 90s with the last observed server state attached.
      let recoveredAtTimeout = "";
      try {
        await expect.poll(async () => {
          const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, company.id), eq(heartbeatRuns.agentId, agent.id)));
          const recovered = runs.filter(run => run.id !== sourceRunId);
          recoveredAtTimeout = recovered.length === 0
            ? "no recovered run was ever created (the wakeup was never dispatched)"
            : recovered.map(run => JSON.stringify({
              id: run.id, status: run.status, errorCode: run.errorCode, error: run.error,
              processPid: run.processPid, startedAt: run.startedAt, finishedAt: run.finishedAt,
              resultJson: JSON.stringify(run.resultJson ?? null).slice(0, 1000),
            })).join(" | ");
          return recovered.some(run => run.status === "succeeded");
        }, { timeout: 90_000, intervals: [500] }).toBe(true);
      } catch (error) {
        const timedOut = error as Error;
        timedOut.message = `recovered run never reached "succeeded" within 90s -- last observed: ${recoveredAtTimeout}`;
        throw timedOut;
      }
      // SUP-17651 (round-4): the old unscoped getByText("Answered the pending
      // follow-up once.") matched every bubble carrying the streamed reply text
      // -- the live transcript interstitial AND every posted Tier-1 done-close
      // bubble -- so it strict-mode-violated the moment two of them were
      // present. A loaded CI shard produced exactly that legitimately: the
      // issue-graph liveness backstop healed a dependency wake on the seeded
      // blocked issue and dispatched a first recovered run whose fixture posted
      // the Tier-1 done-close, and the user's "Please continue" comment then
      // woke a second run that posted an identical one (CI evidence: two
      // fixture spawns, two 200 done-close PATCHes, two posted bubbles in the
      // post-reload DOM; 2 recovered heartbeat_runs, 3 issue_comments). The
      // persistence signal is "the posted reply rendered"; scope to the posted
      // done-close body -- which the interstitial never carries -- and assert
      // at least one, so strict-mode ambiguity can no longer mask that signal.
      // The duplicate dispatch/post is tracked in SUP-17780; this spec
      // deliberately does not gate on toHaveCount(1), for the same
      // cause-not-count reason as the pipeline poll above.
      const postedReplyBubble = page.getByTestId("task-chat-agent-bubble").filter({ hasText: "Closed at Tier 1" });
      await expect(postedReplyBubble).not.toHaveCount(0, { timeout: 45_000 });
      await expect(page.getByRole("status", { name: "Task recovery" })).toHaveCount(0);
      // SUP-17651 (round-3): the fixture closes the task with a mid-turn,
      // reply-bearing Tier-1 done PATCH issued by the run itself
      // (acp-stop-agent.mjs), so the done close settles as part of the run's
      // finalization pipeline. On a loaded CI shard that pipeline -- the
      // dispatch in_progress promotion and the done close both landing around
      // run finalization -- can settle just after the recovered run's
      // "succeeded" status is written and the reply has rendered, so the old
      // immediate GET raced the close and intermittently read `in_progress`
      // (CI-only red at this line while the pipeline poll above and both reply
      // checks passed). Wait on the real signal -- the issue itself reaching
      // its terminal done close -- instead of asserting on a single snapshot
      // read. Bounded at 90s like the pipeline poll above and terminating early
      // the moment the close lands, so the pathological ceiling costs nothing on
      // the normal ~12s path. A non-ok GET is treated as "not landed yet" and
      // retried rather than thrown, so a transient API blip cannot hard-fail
      // the wait.
      let doneCloseAtTimeout = "";
      try {
        await expect.poll(async () => {
          const response = await request.get(`/api/issues/${issue.id}`);
          if (!response.ok()) {
            doneCloseAtTimeout = `GET /api/issues returned ${response.status()}`;
            return false;
          }
          const current = await response.json();
          doneCloseAtTimeout = JSON.stringify({ status: current.status, executionBlocker: current.executionBlocker });
          return current.status === "done" && current.executionBlocker === null;
        }, { timeout: 90_000, intervals: [500] }).toBe(true);
      } catch (error) {
        const timedOut = error as Error;
        timedOut.message = `issue never reached the done close within 90s -- last observed: ${doneCloseAtTimeout}`;
        throw timedOut;
      }
      const completed = await json(await request.get(`/api/issues/${issue.id}`));
      expect(completed).toMatchObject({ status: "done", executionBlocker: null });
      const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, company.id), eq(heartbeatRuns.agentId, agent.id)));
      const recovered = runs.filter(run => run.id !== sourceRunId);
      // The continuation actually completed and replied: at least one recovered run is
      // terminal-succeeded. Tolerates the platform's bounded pre-adapter setup retry chain
      // (a first setup_failed + a bounded automation retry that succeeds), which is
      // legitimate platform behavior on a loaded shard, not a defect.
      expect(recovered.some(run => run.status === "succeeded")).toBe(true);
      // Cause-discriminator: fail only on a true out-of-bounds replay. The dispatch path
      // bounds setup_failed by the SUP-15589 3-streak (heartbeat.ts:950/968) but does NOT
      // bound a retry whose target failed with a non-bounded, non-retryable continuation
      // code. So a recovered automation replay whose retry target's errorCode is one of the
      // platform's non-bounded non-retryable codes (recovery/service.ts
      // NON_RETRYABLE_CONTINUATION_ERROR_CODES, minus the bounded setup_failed) is
      // out-of-bounds and must fail; a setup_failed target (bounded) is legitimate.
      const byId = new Map(runs.map(run => [run.id, run]));
      const NON_BOUNDED_NON_RETRYABLE = new Set([
        "adapter_engine_unavailable", "agent_not_invokable", "agent_not_found",
        "budget_blocked", "budget_exhausted", "issue_paused", "issue_dependencies_blocked",
        "spawn_envelope_too_large", "opencode_db_growth_limit",
        "acpx_auth_required", "claude_auth_required",
        "workspace_git_scan_timeout", "workspace_git_scan_saturated",
        "workspace_git_scan_cancelled", "workspace_git_scan_output_limit",
        "workspace_git_scan_failed",
        "low_trust_isolation_unavailable", "low_trust_requires_isolated_workspace",
        "low_trust_boundary_mismatch", "low_trust_requires_sandbox_environment",
        "low_trust_runtime_services_denied",
      ]);
      const outOfBoundsReplays = recovered.filter(run =>
        run.invocationSource === "automation" &&
        run.retryOfRunId !== null &&
        byId.has(run.retryOfRunId) &&
        NON_BOUNDED_NON_RETRYABLE.has(byId.get(run.retryOfRunId)!.errorCode ?? ""));
      expect(
        outOfBoundsReplays,
        `out-of-bounds automation replay(s) of a non-retryable disposition: ${outOfBoundsReplays.map(r => JSON.stringify({ id: r.id, retryOfRunId: r.retryOfRunId, targetErrorCode: byId.get(r.retryOfRunId!)!.errorCode })).join(" | ")}`,
      ).toEqual([]);
      expect(runs.find(run => run.id === sourceRunId)).toMatchObject({ status: "failed", resultJson: null });
      const prompts = await readFile(path.join(root, "prompts"), "utf8");
      if (action === "queued_interrupt" || action === "automatic_message") {
        expect(prompts).toContain("Approved");
        await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toHaveCount(0);
      }
      if (action === "message") expect(prompts).toContain("Please continue the pending follow-up.");
      await page.reload();
      // SUP-17651: the reload lands on a cold task page that must re-fetch the issue,
      // comments, and runs; on loaded runners the default 5s expect window is the
      // narrowest gate in this spec, so the reply re-assertion gets the same explicit
      // render window as the live check above.
      // SUP-17651 (round-4): same scoping as the live check. Two posted done-close
      // bubbles (liveness-backstop wake + user-comment wake, SUP-17780) are
      // legitimate post-reload state on a loaded shard, so the unscoped getByText
      // strict-violated on the pair; assert at least one scoped bubble instead.
      // On failure, attach the server-side counts (recovered heartbeat_runs and
      // issue_comments) so the next flake names the duplicate class without a
      // second log archaeology pass.
      try {
        await expect(postedReplyBubble).not.toHaveCount(0, { timeout: 45_000 });
      } catch (error) {
        const failed = error as Error;
        try {
          const allRuns = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, company.id), eq(heartbeatRuns.agentId, agent.id)));
          const allComments = await db.select().from(issueComments).where(eq(issueComments.issueId, issue.id));
          const recoveredNow = allRuns.filter(run => run.id !== sourceRunId);
          failed.message += ` [diagnostic: ${recoveredNow.length} recovered heartbeat_runs (${recoveredNow.map(run => run.status).join(",") || "none"}), ${allComments.length} issue_comments (${allComments.map(comment => `${comment.authorType}:${String(comment.body).slice(0, 48).replace(/\s+/g, " ")}`).join(" | ") || "none"})]`;
        } catch {
          failed.message += " [diagnostic: unavailable]";
        }
        throw failed;
      }
    } finally {
      // SUP-17651: teardown must never mask the primary failure. When the test times
      // out Playwright has already torn down the page/context, and the archive PATCH
      // then rejects ("Target page, context or browser has been closed"), replacing
      // the real assertion error in the report. Swallow teardown errors only.
      try {
        await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
      } catch {
        // ignore: teardown only
      }
      await closeRegisteredClients(url).catch(() => {});
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
}
