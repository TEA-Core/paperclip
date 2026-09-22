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
    test.setTimeout(120_000);
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
        await page.getByRole("button", { name: action === "thread_retry" ? "Try again" : "Retry", exact: true }).click();
        if (action === "inbox_retry") await page.goto(taskUrl);
      }
      // Fork divergence (SUP-12693 done-tier close comment, slice 2c): upstream 9031516a7 posts
      // this reply only when the run finalizes, but the fork fixture closes with a reply-bearing
      // Tier 1 comment mid-turn, so until the run settles the reply also renders as the live
      // transcript interstitial and an unscoped getByText hits a strict-mode violation. Both
      // reply checks assert on the posted agent reply bubble, which is the response under test.
      await expect(page.getByTestId("task-chat-agent-bubble").getByText("Answered the pending follow-up once.", { exact: false })).toBeVisible({ timeout: 45_000 });
      await expect(page.getByRole("status", { name: "Task recovery" })).toHaveCount(0);
      const completed = await json(await request.get(`/api/issues/${issue.id}`));
      expect(completed).toMatchObject({ status: "done", executionBlocker: null });
      const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, company.id), eq(heartbeatRuns.agentId, agent.id)));
      expect(runs.filter(run => run.id !== sourceRunId)).toHaveLength(1);
      expect(runs.find(run => run.id === sourceRunId)).toMatchObject({ status: "failed", resultJson: null });
      const prompts = await readFile(path.join(root, "prompts"), "utf8");
      if (action === "queued_interrupt" || action === "automatic_message") {
        expect(prompts).toContain("Approved");
        await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toHaveCount(0);
      }
      if (action === "message") expect(prompts).toContain("Please continue the pending follow-up.");
      await page.reload();
      await expect(page.getByTestId("task-chat-agent-bubble").getByText("Answered the pending follow-up once.", { exact: false })).toBeVisible();
    } finally {
      await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
      await closeRegisteredClients(url);
      await rm(root, { recursive: true, force: true });
    }
  });
}
