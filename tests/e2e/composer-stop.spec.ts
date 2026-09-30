import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  test,
  expect,
  type APIRequestContext,
  type APIResponse,
  type Page,
  type TestInfo,
} from "@playwright/test";

async function json(response: APIResponse) {
  const text = await response.text();
  expect(response.ok(), `${response.url()}: ${response.status()} ${text}`).toBe(
    true,
  );
  return JSON.parse(text);
}
async function task(
  request: APIRequestContext,
  companyId: string,
  data: Record<string, unknown>,
) {
  return json(
    await request.post(`/api/companies/${companyId}/issues`, {
      data: { title: "Composer stop acceptance", status: "backlog", ...data },
    }),
  );
}
type ResumeEvidence = Record<string, unknown> & {
  label: string;
  capturedAt: string;
};
function evidenceField(value: unknown, key: string) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}
async function resumeEvidence(
  request: APIRequestContext,
  issueId: string,
  label: string,
): Promise<ResumeEvidence> {
  const [issue, liveRuns, recovery, tree] = await Promise.all([
    json(await request.get(`/api/issues/${issueId}`)),
    json(await request.get(`/api/issues/${issueId}/live-runs`)),
    json(await request.get(`/api/issues/${issueId}/recovery-actions`)),
    json(await request.get(`/api/issues/${issueId}/tree-control/state`)),
  ]);
  return {
    label,
    capturedAt: new Date().toISOString(),
    issue: {
      status: issue.status,
      executionRunId: issue.executionRunId,
      checkoutRunId: issue.checkoutRunId,
      assigneeAgentId: issue.assigneeAgentId,
    },
    liveRuns: liveRuns.map((run: Record<string, unknown>) => ({
      id: run.id,
      status: run.status,
      runtimeMode: run.runtimeMode,
      invocationSource: run.invocationSource,
      triggerDetail: run.triggerDetail,
      continuationAttempt: run.continuationAttempt,
    })),
    recovery: {
      active: recovery.active
        ? {
            id: recovery.active.id,
            status: recovery.active.status,
            cause: recovery.active.cause,
            runId: evidenceField(recovery.active.evidence, "runId"),
            continuationDelivery: evidenceField(
              recovery.active.evidence,
              "continuationDelivery",
            ),
          }
        : null,
      actions: recovery.actions.map((action: Record<string, unknown>) => ({
        id: action.id,
        status: action.status,
        cause: action.cause,
        runId: evidenceField(action.evidence, "runId"),
        continuationDelivery: evidenceField(
          action.evidence,
          "continuationDelivery",
        ),
      })),
    },
    tree: {
      activePauseHold: tree.activePauseHold
        ? { id: tree.activePauseHold.id }
        : null,
    },
  };
}
async function running(
  request: APIRequestContext,
  issueId: string,
  adapter: "process" | "paperclip_runner",
  evidence?: ResumeEvidence[],
) {
  let run:
    | { id: string; status: string; runtimeMode?: string; processPid?: number }
    | undefined;
  await expect
    .poll(
      async () => {
        const runs = await json(
          await request.get(`/api/issues/${issueId}/live-runs`),
        );
        run = runs.find(
          (candidate: { status: string }) => candidate.status === "running",
        );
        if (!run && evidence) {
          evidence.push(await resumeEvidence(request, issueId, "running-poll"));
        }
        return !!run;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  let fullRun = await json(await request.get(`/api/heartbeat-runs/${run!.id}`));
  await expect
    .poll(
      async () => {
        fullRun = await json(
          await request.get(`/api/heartbeat-runs/${run!.id}`),
        );
        return fullRun.runtimeMode;
      },
      { timeout: 15_000 },
    )
    .toBe(adapter === "process" ? "legacy" : "native");
  if (adapter === "process") {
    await expect
      .poll(
        async () => {
          fullRun = await json(
            await request.get(`/api/heartbeat-runs/${run!.id}`),
          );
          return fullRun.processPid;
        },
        { timeout: 15_000 },
      )
      .toBeTruthy();
  }
  return fullRun;
}
type ResolveTiming = { stopClickedAt: number; stopObservedAt: number };
async function reconcileDemoExecution(
  request: APIRequestContext,
  issueId: string,
  runId: string,
  testInfo: TestInfo,
  timing: ResolveTiming,
) {
  // These deterministic fixtures only print output. No external action occurred.
  // Master requires recorded outcomes before a cancelled provider can restart.
  const activity = await json(
    await request.get(`/api/issues/${issueId}/activity`),
  );
  // FORK DIVERGENCE (D9 deferred: the fork's in-file release promotes parked input at Stop,
  // slice 2d): upstream's wake-queue release answers an operator Stop with its
  // `executionCancellationAcknowledged` pre-drain exit, so the queued comment stays deferred and
  // the reconciliation action keeps naming the run that was stopped. This fold keeps the fork's
  // in-file releaseIssueExecutionAndPromote live (operator decision 2026-09-15, D9 / SUP-16581;
  // see server/src/__tests__/heartbeat-process-recovery.test.ts and
  // heartbeat-comment-wake-batching.test.ts, which carry the same divergence inverted), so the
  // Stop promotes the parked comment into a SUCCESSOR run on this card. When the subtree pause
  // then cancels that successor, the source-scoped action is re-identified onto it
  // (fingerprint `legacy-execution:<run.id>` + supersedeOnIdentityChange), and it settles
  // resolved-with-replay-blocked -- so `recovery.active` is null and the settled activity names
  // the successor, not `runId`. The child card has no successor and still matches on the first
  // arm, which is why only the parent needed this. Reconcile whichever run the action actually
  // settled on; restore the single-arm lookup in the change that makes the module release live.
  const settled =
    activity.find(
      (entry: { action: string; runId: string }) =>
        entry.action === "issue.execution_recovery_settled" &&
        entry.runId === runId,
    ) ??
    activity.find(
      (entry: { action: string; runId: string }) =>
        entry.action === "issue.execution_recovery_settled",
    );
  const recovery = await json(
    await request.get(`/api/issues/${issueId}/recovery-actions`),
  );
  const actionId = recovery.active?.id ?? settled?.details?.recoveryActionId;
  expect(actionId).toBeTruthy();
  const reconciledRunId: string = settled?.runId ?? runId;
  // The 409 guard (validateExecutionReconciliation,
  // server/src/services/execution-recovery-resolution.ts) process.kills the run named by
  // executionReconciliation.runId — reconciledRunId here — and only lets resolve through when
  // BOTH that run's recorded processPid and -processGroupId are dead. Capture that run's own
  // PIDs plus the original run's PIDs and their test-side liveness at the resolve attempt, so a
  // real 409 is decidable between "Stop had not reaped the provider" (a guard-checked PID is
  // alive at resolve) and "resolve fired before stop-completion was observable" (every
  // guard-checked PID is dead at resolve, i.e. the guard observed a provider the spec never
  // awaited or a PID reused between the two kill(2) checks).
  type RunPids = { processPid?: number; processGroupId?: number };
  const [targetRun, originalRun] = await Promise.all([
    json(await request.get(`/api/heartbeat-runs/${reconciledRunId}`)) as Promise<RunPids>,
    json(await request.get(`/api/heartbeat-runs/${runId}`)) as Promise<RunPids>,
  ]);
  const guardPids: { pid: number; role: string }[] = [];
  if (typeof targetRun.processPid === "number")
    guardPids.push({ pid: targetRun.processPid, role: "processPid" });
  if (
    typeof targetRun.processGroupId === "number" &&
    targetRun.processGroupId > 0
  )
    guardPids.push({ pid: -targetRun.processGroupId, role: "processGroupId" });
  const originalPids: { pid: number; role: string }[] = [];
  if (typeof originalRun.processPid === "number")
    originalPids.push({ pid: originalRun.processPid, role: "processPid" });
  if (
    typeof originalRun.processGroupId === "number" &&
    originalRun.processGroupId > 0
  )
    originalPids.push({ pid: -originalRun.processGroupId, role: "processGroupId" });
  const resolveAttemptedAt = Date.now();
  const liveness = guardPids.map((entry) =>
    probePidLiveness(entry.pid, entry.role),
  );
  const stopInitiationToResolveMs = resolveAttemptedAt - timing.stopClickedAt;
  const stopCompletionToResolveMs = resolveAttemptedAt - timing.stopObservedAt;
  const providerAliveAtResolve = liveness.some((entry) => entry.alive);

  const response = await request.post(
    `/api/issues/${issueId}/recovery-actions/resolve`,
    {
      data: {
        actionId,
        outcome: "restored",
        sourceIssueStatus: "todo",
        executionReconciliation: {
          runId: reconciledRunId,
          providerStopped: true,
          actionOutcome: "not_performed",
          outcomeEvidence:
            "The deterministic acceptance fixture only emits console/protocol output. The verified stopped process performed no external actions.",
        },
      },
    },
  );
  const status = response.status();
  const body = await response.text();
  if (!response.ok()) {
    const verdict = providerAliveAtResolve
      ? "H1_REAPING_LATE: a guard-checked PID of the reconciled run was alive at resolve; inspect guardPids[].cmdline/groupMembers to confirm it is the immortal provider fixture ('stop fixture ready'/'working') rather than an unrelated reused pid — Stop had not reaped the provider before recovery resolve."
      : "H2_OBSERVATION_RACE: every guard-checked PID of the reconciled run was dead at resolve, yet the guard observed a live provider; resolve raced stop-completion observability (the guard checked a pid the spec never awaited, or a pid was reused between the spec's and the guard's kill(2) checks).";
    const evidence = {
      kind: "composer-stop-resolve-conflict",
      issueId,
      originalRunId: runId,
      reconciledRunId,
      reconciledRunIsOriginal: reconciledRunId === runId,
      guardPids: liveness,
      originalRunPids: originalPids,
      providerAliveAtResolve,
      stopClickedAtIso: new Date(timing.stopClickedAt).toISOString(),
      stopObservedAtIso: new Date(timing.stopObservedAt).toISOString(),
      resolveAttemptedAtIso: new Date(resolveAttemptedAt).toISOString(),
      stopInitiationToResolveMs,
      stopCompletionToResolveMs,
      verdict,
      httpStatus: status,
      responseBody: body,
    };
    await emitEvidence(testInfo, "composer-stop-409-evidence", evidence);
    throw new Error(
      `composer-stop recovery resolve ${status} (issue=${issueId}, reconciledRun=${reconciledRunId}, originalRun=${runId}): ` +
        `stopInitiationToResolve=${stopInitiationToResolveMs}ms stopCompletionToResolve=${stopCompletionToResolveMs}ms ` +
        `guardLiveness=${JSON.stringify(liveness)} originalRunPids=${JSON.stringify(originalPids)} :: ${verdict} :: body=${body}`,
    );
  }
  await emitEvidence(testInfo, "composer-stop-resolve-evidence", {
    kind: "composer-stop-resolve-evidence",
    issueId,
    originalRunId: runId,
    reconciledRunId,
    reconciledRunIsOriginal: reconciledRunId === runId,
    guardPids: liveness,
    originalRunPids: originalPids,
    providerAliveAtResolve,
    stopInitiationToResolveMs,
    stopCompletionToResolveMs,
    httpStatus: status,
  });
  return JSON.parse(body);
}

async function menu(page: Page, action: string) {
  await page
    .getByRole("button", { name: "More task actions", exact: true })
    .click();
  await page
    .locator('[data-slot="popover-content"]')
    .getByRole("button", { name: action, exact: true })
    .click();
}
function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The 409 guard (validateExecutionReconciliation) probes liveness with
// process.kill(pid, 0) — a positive pid for the recorded provider, a negative
// pid for the process group. These probes run in the same OS as the guard, so
// they agree on liveness. For a real 409 we additionally fingerprint the live
// pid via /proc so "the provider was not reaped yet" (H1) is decidable from
// "the pid was reused by an unrelated process / the guard observed a stale
// provider" (H2). /proc is Linux-only; when a field is unreadable we degrade to
// liveness-only rather than failing the diagnostic run.
function procField(statRaw: string, index: number): number | undefined {
  const close = statRaw.lastIndexOf(")");
  if (close < 0) return undefined;
  const field = statRaw.slice(close + 2).trim().split(/\s+/)[index];
  const value = Number(field);
  return Number.isNaN(value) ? undefined : value;
}
function procCmdline(pid: number): string | undefined {
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean)
      .join(" ");
    return args ? args.slice(0, 400) : undefined;
  } catch {
    return undefined;
  }
}
function procPpid(pid: number): number | undefined {
  try {
    return procField(readFileSync(`/proc/${pid}/stat`, "utf8"), 1);
  } catch {
    return undefined;
  }
}
function processGroupMembers(pgid: number): number[] {
  let entries: string[] = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }
  const members: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const pgrp = procField(
        readFileSync(`/proc/${entry}/stat`, "utf8"),
        2,
      );
      if (pgrp === pgid) members.push(Number(entry));
    } catch {
      // Process exited or is unreadable between the kill(0) probe and the read.
    }
  }
  return members;
}
type PidLiveness = {
  pid: number;
  role: string;
  alive: boolean;
  cmdline?: string;
  ppid?: number;
  groupMembers?: { pid: number; cmdline?: string }[];
};
function probePidLiveness(pid: number, role: string): PidLiveness {
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  const result: PidLiveness = { pid, role, alive };
  if (!alive) return result;
  const target = Math.abs(pid);
  if (pid < 0) {
    result.groupMembers = processGroupMembers(target).map((member) => ({
      pid: member,
      cmdline: procCmdline(member),
    }));
    const leader = result.groupMembers[0];
    if (leader) result.ppid = procPpid(leader.pid);
  } else {
    result.cmdline = procCmdline(target);
    result.ppid = procPpid(target);
  }
  return result;
}

// Evidence is authoritative in the Playwright attachment (persisted on failure).
// When PAPERCLIP_STOP_EVIDENCE_DIR is set — a diagnostic-only harness, unset in
// CI — also mirror each record to disk so a passing baseline's numbers remain
// inspectable after Playwright cleans test-results.
async function emitEvidence(
  testInfo: TestInfo,
  name: string,
  evidence: unknown,
) {
  const body = JSON.stringify(evidence, null, 2);
  await testInfo.attach(name, { body, contentType: "application/json" });
  const dir = process.env.PAPERCLIP_STOP_EVIDENCE_DIR;
  if (!dir) return;
  // The parent and child reconciles share `name`; scope the mirror per issue so
  // both records survive (a passing baseline otherwise keeps only the last).
  const issueId =
    typeof evidence === "object" && evidence !== null
      ? (evidence as { issueId?: unknown }).issueId
      : undefined;
  const fileSuffix = typeof issueId === "string" ? `-${issueId}` : "";
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${name}${fileSuffix}.json`, body);
  } catch {
    // Best-effort mirror; the attachment above stays authoritative.
  }
}

test.setTimeout(120_000);

for (const adapter of ["process", "paperclip_runner"] as const) {
  test(`${adapter}: queue, composer Stop, subtree pause/cancel, and resume`, async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      adapter === "paperclip_runner" && !process.env.PAPERCLIP_STOP_FAKE_CODEX,
      "Set PAPERCLIP_STOP_FAKE_CODEX and PAPERCLIP_RUNNER_BINARY for real runnerd with the deterministic provider.",
    );
    const company = await json(
      await request.post("/api/companies", {
        data: { name: `Composer Stop ${adapter} ${Date.now()}` },
      }),
    );
    const originalSettings = await json(
      await request.get("/api/instance/settings/experimental"),
    );
    const statusMetadata: Record<string, string | null>[] = [];
    const resumeEvidenceLog: ResumeEvidence[] = [];
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload: frame }) => {
        try {
          const event = JSON.parse(
            typeof frame === "string" ? frame : frame.toString("utf8"),
          );
          if (
            event.companyId !== company.id ||
            event.type !== "heartbeat.run.status"
          )
            return;
          // Retain only scalar status routing evidence for this owned company,
          // never raw frames, provider output, errors, or tool payloads.
          const entry: Record<string, string | null> = {};
          for (const key of [
            "runId",
            "agentId",
            "status",
            "issueId",
            "deliveryId",
            "startedAt",
            "finishedAt",
          ] as const) {
            const value = event.payload?.[key];
            if (value === null || typeof value === "string") entry[key] = value;
          }
          if (typeof event.createdAt === "string")
            entry.eventCreatedAt = event.createdAt;
          statusMetadata.push(entry);
        } catch {
          // Non-JSON frames are irrelevant and are not retained.
        }
      });
    });
    try {
      await json(
        await request.patch("/api/instance/settings/experimental", {
          data: { enableClassicTaskInterface: false, enableNativeRunner: true },
        }),
      );
      async function agent(name: string) {
        return json(
          await request.post(`/api/companies/${company.id}/agents`, {
            data: {
              name,
              role: "engineer",
              adapterType: adapter,
              adapterConfig:
                adapter === "process"
                  ? {
                      command: process.execPath,
                      args: [
                        "-e",
                        "console.log('stop fixture ready'); setInterval(() => console.log('working'), 200);",
                      ],
                      graceSec: 1,
                    }
                  : { provider: "codex", model: "gpt-5.1-codex-mini" },
              runtimeConfig: {
                heartbeat: { enabled: false, wakeOnDemand: true },
              },
            },
          }),
        );
      }
      const owner = await agent("Stop fixture parent");
      const childOwner = await agent("Stop fixture child");
      const otherOwner = await agent("Stop fixture unrelated");
      const parent = await task(request, company.id, {
        assigneeAgentId: owner.id,
      });
      const child = await task(request, company.id, {
        title: "Child work",
        parentId: parent.id,
        assigneeAgentId: childOwner.id,
        // Fork divergence (SUP-11047 assigned-backlog-blocking guard, slice 2c): upstream
        // 8cfd30fb0 creates this child as an assigned `backlog` issue under a parent (the
        // task() helper defaults status to `backlog`), which the fork rejects with 422 (fork
        // 2a88a588e) because assignment wakeup skips `backlog`, so a child that gates its
        // parent would never be woken. `parkDeliberately` is that guard's own escape hatch and
        // is stripped before insert (server/src/services/issues.ts), so the child is still
        // created as `backlog`, the loop below still flips it to `todo`, and every run, Stop,
        // pause/cancel and resume assertion is unchanged.
        parkDeliberately: true,
      });
      const completed = await task(request, company.id, {
        title: "Finished child",
        parentId: parent.id,
        status: "done",
      });
      const other = await task(request, company.id, {
        title: "Unrelated work",
        assigneeAgentId: otherOwner.id,
      });
      for (const issue of [parent, child, other])
        await json(
          await request.patch(`/api/issues/${issue.id}`, {
            data: { status: "todo" },
          }),
        );
      const parentRun = await running(request, parent.id, adapter);
      const childRun = await running(request, child.id, adapter);
      const otherRun = await running(request, other.id, adapter);
      if (adapter === "paperclip_runner") {
        // A run row becomes live before its provider turn starts. Prove that the
        // deterministic provider is active before attempting interruption.
        await expect
          .poll(
            async () => {
              const calls = await readFile(
                process.env.PAPERCLIP_STOP_CODEX_LOG!,
                "utf8",
              ).catch(() => "");
              return calls.split("turn/start").length - 1;
            },
            { timeout: 30_000 },
          )
          .toBeGreaterThanOrEqual(3);
      }
      expect(parentRun.runtimeMode).toBe(
        adapter === "process" ? "legacy" : "native",
      );
      await page.goto(`/${company.issuePrefix}/issues/${parent.identifier}`);
      const stop = page.getByRole("button", { name: "Stop", exact: true });
      await expect(stop).toBeVisible({ timeout: 30_000 });
      const editor = page.getByRole("textbox", { name: "editable markdown" });
      await editor.fill("Please check mobile too.");
      await expect(stop).toHaveCount(0);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(stop).toBeVisible();
      const comments = await json(
        await request.get(`/api/issues/${parent.id}/comments`),
      );
      expect(JSON.stringify(comments)).toContain("Please check mobile too.");
      // The comment only appears in the queue once the server admits it into a
      // queued-comment wake, which can lag the comment post. Wait for that
      // observable instead of asserting on a single snapshot.
      await expect
        .poll(
          async () => {
            const queue = await json(
              await request.get(`/api/issues/${parent.id}/queued-comments`),
            );
            return queue.entries.some(
              (entry: { comment: { body: string } }) =>
                entry.comment.body.includes("Please check mobile too."),
            );
          },
          { timeout: 30_000 },
        )
        .toBe(true);

      let dispatchedAt = 0;
      page.on("request", (req) => {
        if (req.method() === "POST" && req.url().endsWith(`/heartbeat-runs/${parentRun.id}/cancel`))
          dispatchedAt = Date.now();
      });
      const clickedAt = Date.now();
      await stop.click();
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
      await expect(
        page.getByRole("button", { name: "Dismiss notification" }),
      ).toHaveCount(0);
      await expect.poll(async () =>
        (await json(await request.get(`/api/heartbeat-runs/${parentRun.id}`))).status,
        { timeout: 35_000 },
      ).toBe("cancelled");
      const stoppedAt = Date.now();
      expect(dispatchedAt - clickedAt).toBeLessThan(2000);
      expect(dispatchedAt).toBeGreaterThan(0);
      if (adapter === "process") {
        expect(parentRun.processPid).toBeTruthy();
        await expect
          .poll(() => processAlive(parentRun.processPid), { timeout: 3000 })
          .toBe(false);
        await expect
          .poll(() => processAlive(childRun.processPid), { timeout: 3000 })
          .toBe(true);
      } else {
        const finalRun = await json(
          await request.get(`/api/heartbeat-runs/${parentRun.id}`),
        );
        expect(finalRun.resultJson?.nativeCancellation?.dispatchState).toBe(
          "acknowledged",
        );
        expect(
          await readFile(process.env.PAPERCLIP_STOP_CODEX_LOG!, "utf8"),
        ).toContain("turn/interrupt");
      }
      await testInfo.attach(`${adapter}-timing`, {
        body: JSON.stringify({
          clickToRequestMs: dispatchedAt - clickedAt,
          requestToStoppedMs: stoppedAt - dispatchedAt,
        }),
        contentType: "application/json",
      });
      expect(
        (await json(await request.get(`/api/issues/${parent.id}/tree-control/state`))).activePauseHold,
      ).toBeNull();
      expect((await json(await request.get(`/api/heartbeat-runs/${childRun.id}`))).status).toBe("running");
      await expect(editor).toBeVisible();
      await expect(page.getByText("Subtree is paused.", { exact: true })).toHaveCount(0);
      // Pausing future work is a separate, explicit subtree action.
      await menu(page, "Pause subtree");
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
      await expect.poll(async () => (await json(await request.get(`/api/heartbeat-runs/${childRun.id}`))).status,
        { timeout: 35_000 }).toBe("cancelled");
      if (adapter === "process") {
        await expect.poll(() => processAlive(childRun.processPid), { timeout: 3000 }).toBe(false);
      }
      expect(
        (
          await json(
            await request.get(`/api/issues/${parent.id}/tree-control/state`),
          )
        ).activePauseHold,
      ).toBeTruthy();
      expect(
        (await json(await request.get(`/api/heartbeat-runs/${otherRun.id}`)))
          .status,
      ).toBe("running");
      await expect(
        page.getByText("Subtree is paused.", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Dismiss notification" }),
      ).toHaveCount(0);
      if (adapter === "paperclip_runner") {
        await expect(
          page.getByRole("button", { name: /^Run cancelled/ }),
        ).toHaveClass(/text-muted-foreground/);
      }
      await page.reload();
      await expect(
        page.getByText("Subtree is paused.", { exact: true }),
      ).toBeVisible();
      // Cross the isolated server's ten-second scheduler interval repeatedly.
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        expect(
          await json(await request.get(`/api/issues/${parent.id}/live-runs`)),
        ).toEqual([]);
        expect(
          await json(await request.get(`/api/issues/${child.id}/live-runs`)),
        ).toEqual([]);
      }
      await menu(page, "Resume subtree");
      await page.getByRole("dialog").getByRole("checkbox").check();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Resume subtree", exact: true })
        .click();
      // Closing this dialog waits on a server-backed subtree resume, so the 5s
      // default expect timeout is not enough on a loaded shard: PR #748's
      // merge_group run saw "14 x locator resolved to 1 element" here before
      // timing out. The rest of this spec already uses 15-35s for its
      // server-backed waits; match that.
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
      if (adapter === "process") {
        // Legacy processes lack runner stop/action proof, so releasing the hold
        // preserves their recovery gate until the fixture reconciles them.
        expect(await json(await request.get(`/api/issues/${parent.id}/live-runs`))).toEqual([]);
        expect(await json(await request.get(`/api/issues/${child.id}/live-runs`))).toEqual([]);
        await reconcileDemoExecution(
          request,
          parent.id,
          parentRun.id,
          testInfo,
          { stopClickedAt: clickedAt, stopObservedAt: stoppedAt },
        );
        resumeEvidenceLog.push(
          await resumeEvidence(request, parent.id, "after-parent-resolve"),
        );
        await reconcileDemoExecution(
          request,
          child.id,
          childRun.id,
          testInfo,
          { stopClickedAt: clickedAt, stopObservedAt: stoppedAt },
        );
        resumeEvidenceLog.push(
          await resumeEvidence(request, child.id, "after-child-resolve"),
        );
      }
      // A verified stopped native runner can honor the explicitly selected
      // Wake agents option without another manual reconciliation step.
      const resumedParentRun = await running(
        request,
        parent.id,
        adapter,
        resumeEvidenceLog,
      );
      const resumedChildRun = await running(
        request,
        child.id,
        adapter,
        resumeEvidenceLog,
      );
      expect(resumedParentRun.id).not.toBe(parentRun.id);
      expect(resumedChildRun.id).not.toBe(childRun.id);
      if (adapter === "paperclip_runner") {
        await expect.poll(async () => {
          const calls = await readFile(process.env.PAPERCLIP_STOP_CODEX_LOG!, "utf8");
          return calls.split("turn/start").length - 1;
        }, { timeout: 30_000 }).toBeGreaterThanOrEqual(5);
        await page.screenshot({ path: testInfo.outputPath("native-resumed.png"), fullPage: true });
      }
      await menu(page, "Pause subtree");
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
      await expect(
        page.getByText("Subtree is paused.", { exact: true }),
      ).toBeVisible();
      await menu(page, "Cancel subtree...");
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByRole("heading", { name: "Cancel subtree?" }),
      ).toBeVisible();
      await expect(
        dialog.locator('textarea, input[type="checkbox"]'),
      ).toHaveCount(0);
      await dialog.getByRole("button", { name: "Keep tasks" }).click();
      expect(
        (await json(await request.get(`/api/issues/${parent.id}`))).status,
      ).not.toBe("cancelled");
      await menu(page, "Cancel subtree...");
      await dialog
        .getByRole("button", { name: "Cancel 2 tasks", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await json(await request.get(`/api/issues/${child.id}`))).status,
        )
        .toBe("cancelled");
      expect(
        (await json(await request.get(`/api/issues/${parent.id}`))).status,
      ).toBe("cancelled");
      expect(
        (await json(await request.get(`/api/issues/${completed.id}`))).status,
      ).toBe("done");
      expect(
        (await json(await request.get(`/api/heartbeat-runs/${otherRun.id}`)))
          .status,
      ).toBe("running");
      // The child was never opened, so no child run-history cache can hide a
      // missing task association. Observe this new run's retryable terminal
      // delivery before judging the final notification state.
      await expect
        .poll(
          () =>
            statusMetadata.find(
              (entry) =>
                entry.runId === resumedChildRun.id &&
                entry.status === "cancelled" &&
                typeof entry.deliveryId === "string" &&
                entry.deliveryId.length > 0,
            ),
          // The real status-delivery sweep runs every 15 seconds.
          { timeout: 20_000 },
        )
        .toMatchObject({
          runId: resumedChildRun.id,
          issueId: child.id,
          status: "cancelled",
        });
      await expect(
        page.getByRole("button", { name: "Dismiss notification" }),
      ).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`${adapter}-cancelled.png`),
      });
    } finally {
      const statusEvidence = JSON.stringify(statusMetadata, null, 2);
      // The company is disposable and scoped to this test invocation.
      await request.patch(`/api/companies/${company.id}`, {
        data: { status: "archived" },
      });
      await request.patch("/api/instance/settings/experimental", {
        data: {
          enableClassicTaskInterface:
            originalSettings.enableClassicTaskInterface,
          enableNativeRunner: originalSettings.enableNativeRunner,
        },
      });
      await testInfo.attach("owned-company-status-metadata", {
        body: statusEvidence,
        contentType: "application/json",
      });
      if (resumeEvidenceLog.length > 0) {
        await testInfo.attach("resume-evidence", {
          body: JSON.stringify(resumeEvidenceLog, null, 2),
          contentType: "application/json",
        });
      }
    }
  });
}
