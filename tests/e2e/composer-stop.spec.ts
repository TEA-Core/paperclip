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
import {
  attachEvidenceOrRethrow,
  buildRunningTimeoutEvidence,
  createStatusFrameCollector,
  observeLiveRuns,
  recordInstrumentationFailure,
  type InstrumentationFailure,
  type LiveRun,
  type ObservedRunRow,
  type RunningTimeoutApiError,
  type StatusMetadata,
} from "./support/composer-stop-evidence.js";

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
type SafeSnapshot = {
  url: string;
  status: number | null;
  ok: boolean;
  body: unknown;
  error: string | null;
};
// Same-attempt evidence read that never throws on a non-2xx, transport, or
// parse failure. It preserves status/body/error so a degraded or failed
// observation stays an observation failure instead of collapsing into an
// "unknown" state that the timeout classifier would misread as a transition.
async function safeSnapshot(
  request: APIRequestContext,
  url: string,
): Promise<SafeSnapshot> {
  try {
    const response = await request.get(url);
    const status = response.status();
    const raw = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw.slice(0, 2000);
    }
    return { url, status, ok: response.ok(), body, error: null };
  } catch (error) {
    return {
      url,
      status: null,
      ok: false,
      body: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function snapshotFailure(
  snapshot: SafeSnapshot,
  label: string,
  valid: boolean,
) {
  if (!snapshot.ok) {
    return `${label} request failed: status=${String(snapshot.status)} error=${String(snapshot.error)} body=${JSON.stringify(snapshot.body)}`;
  }
  if (!valid) {
    return `${label} response was malformed: status=${String(snapshot.status)} body=${JSON.stringify(snapshot.body)}`;
  }
  return null;
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
function isRecoveryActionShape(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const action = value as Record<string, unknown>;
  const evidence = action.evidence;
  return (
    typeof action.id === "string" &&
    (action.status === "active" ||
      action.status === "escalated" ||
      action.status === "resolved" ||
      action.status === "cancelled") &&
    typeof action.cause === "string" &&
    typeof evidence === "object" &&
    evidence !== null &&
    !Array.isArray(evidence)
  );
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
type ResolveResult = {
  body: unknown;
  resolveCompletedAtIso: string;
  recoveryActionPresentAtResolve: boolean;
  settledActionFoundAtResolve: boolean;
  providerAliveAtResolve: boolean;
};
type ResumeContext = {
  issueId: string;
  originalRunIds: string[];
  resolveCompletedAtIso: string | null;
  resumeInitiatedAtIso: string;
  resolveResponseBody: unknown;
  hasResolveEvidence: boolean;
  recoveryActionPresentAtResolve: boolean | null;
  settledActionFoundAtResolve: boolean | null;
  originalProviderAliveAtResolve: boolean | null;
  statusMetadata: StatusMetadata[];
  companyId: string;
  testInfo: TestInfo;
  observedRunRows: ObservedRunRow[];
  apiErrorsDuringWindow: RunningTimeoutApiError[];
  successfulPollCount: number;
  instrumentationFailures: InstrumentationFailure[];
};
async function running(
  request: APIRequestContext,
  issueId: string,
  adapter: "process" | "paperclip_runner",
  evidence?: ResumeEvidence[],
  resume?: ResumeContext,
) {
  let run: { id: string; status: string; runtimeMode?: string; processPid?: number } | undefined;
  const pollWindowStartMs = Date.now();
  const pollWindowStartIso = new Date(pollWindowStartMs).toISOString();
  try {
    await expect
      .poll(
        async () => {
          let runs: LiveRun[] = [];
          try {
            const body = await json(
              await request.get(`/api/issues/${issueId}/live-runs`),
            );
            if (!Array.isArray(body)) {
              throw new Error(
                `live-runs response was not an array: ${JSON.stringify(body).slice(0, 2000)}`,
              );
            }
            const validation = observeLiveRuns(
              body,
              resume ? resume.observedRunRows : undefined,
            );
            if (!validation.valid) {
              throw new Error(validation.error ?? "malformed live-runs row");
            }
            if (resume) {
              resume.successfulPollCount += 1;
            }
            runs = validation.rows;
          } catch (error) {
            if (resume) {
              resume.apiErrorsDuringWindow.push({
                atIso: new Date().toISOString(),
                url: `/api/issues/${issueId}/live-runs`,
                message: error instanceof Error ? error.message : String(error),
              });
            }
            return false;
          }
            run = runs.find((candidate) => candidate.status === "running");
            if (!run && evidence && resume) {
              try {
                evidence.push(
                  await resumeEvidence(request, issueId, "running-poll"),
                );
              } catch (error) {
                // resumeEvidence asserts 2xx; a transient failure is an
                // instrumentation failure, not evidence the resume failed.
                recordInstrumentationFailure(
                  resume.instrumentationFailures,
                  "running-poll-evidence",
                  error,
                );
              }
            }
          return !!run;
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  } catch (error) {
    if (!resume) throw error;
    const pollWindowEndMs = Date.now();
    const pollWindowMs = pollWindowEndMs - pollWindowStartMs;

    // Correction 1: make fresh, same-attempt final requests for all four
    // authoritative sources and preserve a safe status/body/error for each.
    // A per-request failure stays an observation failure; it never collapses
    // the issue state to "unknown" that a transition verdict would misread.
    const finalSnapshots = await Promise.all([
      safeSnapshot(request, `/api/issues/${issueId}`),
      safeSnapshot(request, `/api/issues/${issueId}/live-runs`),
      safeSnapshot(request, `/api/issues/${issueId}/recovery-actions`),
      safeSnapshot(request, `/api/issues/${issueId}/tree-control/state`),
    ]);
    const issueSnap = finalSnapshots[0];
    const recoverySnap = finalSnapshots[2];
    const issueOk =
      issueSnap.ok &&
      issueSnap.body !== null &&
      typeof issueSnap.body === "object";
    const issueBody = issueOk
      ? (issueSnap.body as Record<string, unknown>)
      : null;
    const liveRunsOk =
      finalSnapshots[1].ok && Array.isArray(finalSnapshots[1].body);
    const recoveryBody =
      recoverySnap.ok &&
      recoverySnap.body !== null &&
      typeof recoverySnap.body === "object"
        ? (recoverySnap.body as Record<string, unknown>)
        : null;
    const recoveryOk =
      recoveryBody !== null &&
      (recoveryBody.active === null || isRecoveryActionShape(recoveryBody.active)) &&
      Array.isArray(recoveryBody.actions) &&
      recoveryBody.actions.every(isRecoveryActionShape);
    const treeBody =
      finalSnapshots[3].ok &&
      finalSnapshots[3].body !== null &&
      typeof finalSnapshots[3].body === "object"
        ? (finalSnapshots[3].body as Record<string, unknown>)
        : null;
    const treeOk = treeBody !== null && "activePauseHold" in treeBody;
    const finalSnapshotFailure = [
      snapshotFailure(
        issueSnap,
        "issue",
        issueOk && typeof issueBody?.status === "string",
      ),
      snapshotFailure(finalSnapshots[1], "live-runs", liveRunsOk),
      snapshotFailure(recoverySnap, "recovery-actions", recoveryOk),
      snapshotFailure(finalSnapshots[3], "tree-control/state", treeOk),
    ]
      .filter((failure): failure is string => failure !== null)
      .join("; ");
    const finalIssueState = {
      status:
        typeof issueBody?.status === "string" ? (issueBody.status as string) : null,
      executionRunId:
        typeof issueBody?.executionRunId === "string"
          ? (issueBody.executionRunId as string)
          : null,
    };
    let finalContinuationDelivery: string | null | undefined;
    if (recoveryOk && recoveryBody) {
      const active = recoveryBody.active as Record<string, unknown> | null;
      const actions = recoveryBody.actions as Record<string, unknown>[];
      const lastEvidence =
        active?.evidence ?? actions[actions.length - 1]?.evidence;
      const cdRaw = evidenceField(lastEvidence, "continuationDelivery");
      finalContinuationDelivery =
        typeof cdRaw === "string" ? cdRaw : cdRaw === null ? null : undefined;
    }
    const evidence = buildRunningTimeoutEvidence({
      adapter,
      apiErrorsDuringWindow: resume.apiErrorsDuringWindow,
      instrumentationFailures: resume.instrumentationFailures,
      observedRunRows: resume.observedRunRows,
      successfulPollCount: resume.successfulPollCount,
      finalIssueStatus: finalIssueState.status,
      finalContinuationDelivery,
      hasResolveEvidence: resume.hasResolveEvidence,
      recoveryActionPresentAtResolve: resume.recoveryActionPresentAtResolve,
      settledActionFoundAtResolve: resume.settledActionFoundAtResolve,
      finalSnapshotFailure: finalSnapshotFailure || null,
      issueId,
      companyId: resume.companyId,
      pollWindowStartMs,
      pollWindowEndMs,
      originalRunIds: resume.originalRunIds,
      finalLiveRuns: finalSnapshots[1].body,
      statusMetadata: resume.statusMetadata,
      finalSnapshots,
      finalIssueState,
      resolveCompletedAtIso: resume.resolveCompletedAtIso,
      resumeInitiatedAtIso: resume.resumeInitiatedAtIso,
      resolveResponseBody: resume.resolveResponseBody,
      originalProviderAliveAtResolve: resume.originalProviderAliveAtResolve,
    });
    const originalError = error;
    await attachEvidenceOrRethrow(
      () => emitEvidence(
        resume.testInfo,
        "composer-stop-running-timeout-evidence",
        evidence,
      ),
      evidence,
      resume.instrumentationFailures,
      "running-timeout-evidence-attachment",
      error,
    );
    throw originalError;
  }
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
  const resolveCompletedAtIso = new Date().toISOString();
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
    recoveryActionPresentAtResolve: recovery.active != null,
    settledActionFoundAtResolve: settled != null,
    resolveCompletedAtIso,
    httpStatus: status,
    responseBody: body,
  });
  return {
    body: JSON.parse(body),
    resolveCompletedAtIso,
    recoveryActionPresentAtResolve: recovery.active != null,
    settledActionFoundAtResolve: settled != null,
    providerAliveAtResolve,
  };
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
    const statusMetadata: StatusMetadata[] = [];
    const instrumentationFailures: InstrumentationFailure[] = [];
    const resumeEvidenceLog: ResumeEvidence[] = [];
    let currentResumeContext: ResumeContext | undefined;
    const statusFrameCollector = createStatusFrameCollector(company.id);
    page.on("websocket", (socket) => {
        socket.on("framereceived", ({ payload: frame }) => {
          const text =
            typeof frame === "string" ? frame : new TextDecoder().decode(frame);
          const targetContext = currentResumeContext;
          statusFrameCollector.ingest(text, targetContext ? {
            issueId: targetContext.issueId,
            runId: targetContext.originalRunIds[0],
          } : undefined);
          statusMetadata.push(...statusFrameCollector.entries.splice(0));
          const targetFailures = currentResumeContext?.instrumentationFailures ?? instrumentationFailures;
          targetFailures.push(...statusFrameCollector.instrumentationFailures.splice(0));
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
      // Cross the isolated server's ten-second scheduler interval repeatedly,
      // retaining evidence without asserting an instantaneous empty snapshot.
      // A successor may already be scheduled by the time the resume request
      // returns; the later process reconcile must not duplicate that wake.
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        const [parentLiveRuns, childLiveRuns] = await Promise.all([
          safeSnapshot(request, `/api/issues/${parent.id}/live-runs`),
          safeSnapshot(request, `/api/issues/${child.id}/live-runs`),
        ]);
        resumeEvidenceLog.push({
          label: `after-resume-scheduler-window-${i + 1}`,
          capturedAt: new Date().toISOString(),
          parentLiveRuns,
          childLiveRuns,
        } as ResumeEvidence);
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
      const resumeInitiatedAtIso = new Date().toISOString();
      let parentResolve: ResolveResult | null = null;
      let childResolve: ResolveResult | null = null;
      if (adapter === "process") {
        const parentResumeSnapshot = await safeSnapshot(
          request,
          `/api/issues/${parent.id}/live-runs`,
        );
        const childResumeSnapshot = await safeSnapshot(
          request,
          `/api/issues/${child.id}/live-runs`,
        );
        resumeEvidenceLog.push(
          {
            label: "after-resume-before-process-reconcile",
            capturedAt: new Date().toISOString(),
            parentLiveRuns: parentResumeSnapshot,
            childLiveRuns: childResumeSnapshot,
          } as ResumeEvidence,
        );
        const parentLiveRuns = parentResumeSnapshot.ok &&
          Array.isArray(parentResumeSnapshot.body)
          ? parentResumeSnapshot.body
          : null;
        const childLiveRuns = childResumeSnapshot.ok &&
          Array.isArray(childResumeSnapshot.body)
          ? childResumeSnapshot.body
          : null;
        if (parentLiveRuns === null || childLiveRuns === null) {
          throw new Error(
            `composer-stop resume pre-reconcile observation failed: parent=${JSON.stringify(parentResumeSnapshot)} child=${JSON.stringify(childResumeSnapshot)}`,
          );
        }
        if (parentLiveRuns.length === 0) {
          parentResolve = await reconcileDemoExecution(
            request,
            parent.id,
            parentRun.id,
            testInfo,
            { stopClickedAt: clickedAt, stopObservedAt: stoppedAt },
          );
          resumeEvidenceLog.push(
            await resumeEvidence(request, parent.id, "after-parent-resolve"),
          );
        }
        if (childLiveRuns.length === 0) {
          childResolve = await reconcileDemoExecution(
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
      }
      const resumeContextFor = (
        issueId: string,
        originalRunId: string,
        resolve: ResolveResult | null,
      ): ResumeContext => ({
        issueId,
        originalRunIds: [originalRunId],
        resolveCompletedAtIso: resolve?.resolveCompletedAtIso ?? null,
        resumeInitiatedAtIso,
        resolveResponseBody: resolve?.body ?? null,
        // Only the process adapter runs the manual reconcile that yields a
        // ResolveResult; native keeps these null so no resolve facts are
        // fabricated for the native transition path.
        hasResolveEvidence: resolve !== null,
        recoveryActionPresentAtResolve:
          resolve?.recoveryActionPresentAtResolve ?? null,
        settledActionFoundAtResolve:
          resolve?.settledActionFoundAtResolve ?? null,
        originalProviderAliveAtResolve:
          resolve?.providerAliveAtResolve ?? null,
        statusMetadata,
        companyId: company.id,
        testInfo,
        observedRunRows: [],
        apiErrorsDuringWindow: [],
        successfulPollCount: 0,
        instrumentationFailures: [...instrumentationFailures],
      });
      // A verified stopped native runner can honor the explicitly selected
      // Wake agents option without another manual reconciliation step.
      const parentResumeContext = resumeContextFor(parent.id, parentRun.id, parentResolve);
      currentResumeContext = parentResumeContext;
      const resumedParentRun = await running(
        request,
        parent.id,
        adapter,
        resumeEvidenceLog,
        parentResumeContext,
      );
      const childResumeContext = resumeContextFor(child.id, childRun.id, childResolve);
      currentResumeContext = childResumeContext;
      const resumedChildRun = await running(
        request,
        child.id,
        adapter,
        resumeEvidenceLog,
        childResumeContext,
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
