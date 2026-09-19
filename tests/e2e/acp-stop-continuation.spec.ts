import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  const body = await response.text();
  expect(response.ok(), `${response.url()}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body);
}

for (const { unfinishedWrite, stopResponse } of [{ unfinishedWrite: false, stopResponse: false }, { unfinishedWrite: true, stopResponse: false }, { unfinishedWrite: false, stopResponse: true }]) {
  test(`embedded ACP Stop: ${unfinishedWrite ? "Interrupt continues without replaying the write" : stopResponse ? "composer Stop preserves queued input and accepts a new direction" : "Interrupt delivers queued input in the same session"}`, async ({ page, request }) => {
    test.setTimeout(120_000);
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-stop-browser-"));
    const company = await json(await request.post("/api/companies", { data: { name: `ACP Stop ${Date.now()}` } }));
    const originalSettings = await json(await request.get("/api/instance/settings/experimental"));
    try {
      await json(await request.patch("/api/instance/settings/experimental", { data: { enableClassicTaskInterface: false } }));
      const owner = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
        name: "ACP Stop fixture", role: "engineer", adapterType: "claude_local",
        adapterConfig: { engine: "acp", cwd: root, stateDir: path.join(root, "state"),
          agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("scripts/mcp-fixtures/servers/acp-stop-agent.mjs"))}`,
          // Fork divergence (SUP-13716 local ACP credential gate, slice 2c): upstream 018ca5daa
          // runs this claude_local fixture with no Claude login, but the fork's
          // prepareClaudeLocalManagedHome (packages/adapters/claude-local/src/server/acp.ts, fork
          // 3f7308253) refuses a local ACP run whose agent-side home holds no OAuth credentials
          // unless fileless auth is configured, so no prompt is ever sent. A placeholder
          // subscription token is that gate's own bypass; the fixture never reads it and billing
          // stays `subscription`, so every Stop/continuation assertion below is unchanged.
          env: { PAPERCLIP_STOP_FIXTURE_ROOT: root, PAPERCLIP_STOP_FIXTURE_FINISH_TASK: "1", CLAUDE_CODE_OAUTH_TOKEN: "paperclip-e2e-fixture-placeholder", ...(unfinishedWrite ? { PAPERCLIP_STOP_FIXTURE_TOOL: "write" } : {}) },
        }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      } }));
      const issue = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
        title: "ACP Stop continuation", status: "backlog", assigneeAgentId: owner.id,
      } }));
      await json(await request.patch(`/api/issues/${issue.id}`, { data: { status: "todo" } }));
      await expect.poll(async () => (await readFile(path.join(root, "prompts"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length, { timeout: 45_000 }).toBe(1);
      const [active] = await json(await request.get(`/api/issues/${issue.id}/live-runs`));
      expect(active).toBeTruthy();
      await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
      const editor = page.getByRole("textbox", { name: "editable markdown" });
      await editor.fill("List my recent Drive files.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(async () => JSON.stringify(await json(await request.get(`/api/issues/${issue.id}/queued-comments`))))
        .toContain("List my recent Drive files.");

      // Both actions stop the response; composer Stop must not create a task hold.
      let stopped;
      if (stopResponse) {
        await page.getByRole("button", { name: "Stop", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "Interrupt", exact: true }).click();
      }
      await expect.poll(async () => {
        stopped = await json(await request.get(`/api/heartbeat-runs/${active.id}`));
        return stopped.resultJson?.executionCancellation?.state;
      }, { timeout: 30_000 }).toBe("acknowledged");
      expect(stopped.status).toBe("cancelled");
      expect(stopped.resultJson.executionCancellation.state).toBe("acknowledged");
      const writesAtStop = unfinishedWrite ? await readFile(path.join(root, "writes"), "utf8") : null;
      await page.reload();
      if (stopResponse) {
        await expect(page.getByTestId("paused-composer-takeover")).toHaveCount(0);
        await expect(editor).toBeVisible();
        expect((await json(await request.get(`/api/issues/${issue.id}/tree-control/state`))).activePauseHold).toBeNull();
        await expect(page.getByRole("button", { name: "Resume task", exact: true })).toHaveCount(0);
        // FORK DIVERGENCE (D9/SUP-16581 keeps the fork's in-file releaseIssueExecutionAndPromote live, slice 2d):
        // the fork adopts the saved input into a successor run the moment an acknowledged Stop lands,
        // instead of parking it for a new direction to join.
        //
        // Upstream's release is the wake-queue module's, whose pre-drain rule
        // (modules/wake-queue/domain/policy.ts `executionCancellationAcknowledged` -> released)
        // exits before the deferred-wake drain on an operator Stop, so the queue survives the Stop
        // and the next explicit comment coalesces both messages into one run. That module is dormant
        // in the fork (D9 / SUP-16581); the live in-file releaseIssueExecutionAndPromote has no such
        // exit, so the drain promotes the deferred wake shortly after the Stop. The same operator
        // decision (2026-09-15) is already recorded server-side:
        // server/src/__tests__/heartbeat-process-recovery.test.ts "preserves deferred input on a
        // clean Stop and adopts it once on the next explicit comment" carries upstream's assertions
        // INVERTED rather than deleted. Restore the five upstream lines below in that same change:
        //   const saved = await json(await request.get(`/api/issues/${issue.id}/queued-comments`));
        //   expect(JSON.stringify(saved.entries)).toContain("List my recent Drive files.");
        //   expect((await readFile(path.join(root, "prompts"), "utf8")).trim().split("\n")).toHaveLength(1);
        //   await editor.fill("Please continue with the saved request.");
        //   await page.getByRole("button", { name: "Send", exact: true }).click();
        //
        // Everything else this journey guards still holds on the fork arm: Stop ends only the
        // response (no takeover, no pause hold, no Resume gate -- asserted above), the saved input is
        // never dropped, and it is delivered exactly once in the same session by exactly one
        // successor run (asserted below).
        await expect.poll(async () => (await readFile(path.join(root, "prompts"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length, { timeout: 30_000 }).toBe(2);
        const saved = await json(await request.get(`/api/issues/${issue.id}/queued-comments`));
        expect(saved.entries).toHaveLength(0);
      }
      // Fork divergence (SUP-12693 done-tier close comment, slice 2c): upstream 018ca5daa posts
      // this reply only when the run finalizes, but the fork fixture closes with a reply-bearing
      // Tier 1 comment mid-turn, so until the run settles the reply also renders as the live
      // transcript interstitial and an unscoped getByText hits a strict-mode violation. Assert
      // on the posted agent reply bubble, which is the answer this journey checks for.
      await expect(page.getByTestId("task-chat-agent-bubble").getByText("Answered the pending follow-up once.", { exact: false })).toBeVisible({ timeout: 30_000 });
      await expect.poll(async () => (await json(await request.get(`/api/issues/${issue.id}/live-runs`))).length).toBe(0);
      const prompts = (await readFile(path.join(root, "prompts"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(prompts).toHaveLength(2);
      expect(new Set(prompts.map(prompt => prompt.sessionId)).size).toBe(1);
      // Interrupt delivers immediately; on the fork arm, Stop's successor run carries the saved
      // input (upstream: the new direction includes it -- see the FORK DIVERGENCE note above).
      const continuationPrompts = prompts.slice(1);
      expect(JSON.stringify(continuationPrompts)).toContain("List my recent Drive files.");
      expect(await readFile(path.join(root, "completed"), "utf8")).toBe("follow-up\n");
      const completedIssue = await json(await request.get(`/api/issues/${issue.id}`));
      expect(completedIssue.executionBlocker).toBeNull();
      expect(completedIssue.status).toBe("done");
      if (unfinishedWrite) expect(await readFile(path.join(root, "writes"), "utf8")).toBe(writesAtStop);
      await expect(page.getByRole("dialog")).toHaveCount(0);
    } finally {
      await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
      await request.patch("/api/instance/settings/experimental", { data: { enableClassicTaskInterface: originalSettings.enableClassicTaskInterface } });
      await rm(root, { recursive: true, force: true });
    }
  });
}
