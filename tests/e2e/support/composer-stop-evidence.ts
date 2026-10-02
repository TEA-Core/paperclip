export const RUNNING_TIMEOUT_VERDICTS = {
  RESUME_TRANSITION_OBSERVED: "RESUME_TRANSITION_OBSERVED",
  LATE_TRANSITION: "LATE_TRANSITION",
  NO_TRANSITION: "NO_TRANSITION",
  OBSERVATION_FAILURE: "OBSERVATION_FAILURE",
  INSTRUMENTATION_FAILURE: "INSTRUMENTATION_FAILURE",
} as const;

export type RunningTimeoutVerdict =
  (typeof RUNNING_TIMEOUT_VERDICTS)[keyof typeof RUNNING_TIMEOUT_VERDICTS];
export type Adapter = "process" | "paperclip_runner";

export type InstrumentationFailure = {
  atIso: string;
  stage: string;
  message: string;
  issueId?: string;
  runId?: string;
};

export type EvidenceOwnership = {
  issueId: string;
  runId: string;
};

export type ObservedRunRow = {
  id: string;
  status: string;
  runtimeMode?: string;
  invocationSource?: string;
  continuationAttempt?: number;
  observedAtIso: string;
};

export type StatusMetadata = Record<string, string | null> & {
  eventCreatedAt?: string;
  issueId?: string | null;
};

export type LiveRun = {
  id: string;
  status: string;
  runtimeMode?: string;
  invocationSource?: string;
  continuationAttempt?: number;
  processPid?: number;
};

export type RunningTimeoutInput = {
  adapter: Adapter;
  apiErrorsDuringWindow: RunningTimeoutApiError[];
  instrumentationFailures: InstrumentationFailure[];
  observedRunRows: ObservedRunRow[];
  successfulPollCount: number;
  finalNewRunIds: string[];
  newRunIds?: string[];
  observedNewRunRunning?: boolean;
  anyNewRunRunning: boolean;
  finalIssueStatus: string | null;
  finalContinuationDelivery: string | null | undefined;
  hasResolveEvidence: boolean;
  recoveryActionPresentAtResolve: boolean | null;
  settledActionFoundAtResolve: boolean | null;
  finalSnapshotFailure: string | null;
};

export type RunningTimeoutClassification = {
  verdict: RunningTimeoutVerdict;
  message: string;
};

export type RunningTimeoutApiError = {
  atIso: string;
  url: string;
  message: string;
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function recordInstrumentationFailure(
  failures: InstrumentationFailure[],
  stage: string,
  error: unknown,
  atIso = new Date().toISOString(),
  ownership?: EvidenceOwnership,
) {
  if (failures.length >= 25) return;
  failures.push({ atIso, stage, message: errorMessage(error), ...ownership });
}

export function validateLiveRuns(value: unknown): {
  valid: boolean;
  rows: LiveRun[];
  error: string | null;
} {
  if (!Array.isArray(value)) {
    return {
      valid: false,
      rows: [],
      error: `live-runs response was not an array: ${JSON.stringify(value).slice(0, 2000)}`,
    };
  }
  const rows: LiveRun[] = [];
  for (const [index, candidate] of value.entries()) {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.status !== "string") {
      return {
        valid: false,
        rows: [],
        error: `live-runs row ${index} was malformed: ${JSON.stringify(candidate).slice(0, 2000)}`,
      };
    }
    rows.push({
      id: candidate.id,
      status: candidate.status,
      runtimeMode: typeof candidate.runtimeMode === "string" ? candidate.runtimeMode : undefined,
      invocationSource: typeof candidate.invocationSource === "string" ? candidate.invocationSource : undefined,
      continuationAttempt: typeof candidate.continuationAttempt === "number" ? candidate.continuationAttempt : undefined,
      processPid: typeof candidate.processPid === "number" ? candidate.processPid : undefined,
    });
  }
  return { valid: true, rows, error: null };
}

export function observeLiveRuns(
  value: unknown,
  observedRunRows?: ObservedRunRow[],
  observedAtIso = new Date().toISOString(),
): { valid: boolean; rows: LiveRun[]; error: string | null } {
  const result = validateLiveRuns(value);
  if (!result.valid || !observedRunRows) return result;
  observedRunRows.push(...result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    runtimeMode: row.runtimeMode,
    invocationSource: row.invocationSource,
    continuationAttempt: row.continuationAttempt,
    observedAtIso,
  })));
  return result;
}

export function createStatusFrameCollector(companyId: string) {
  const entries: StatusMetadata[] = [];
  const instrumentationFailures: InstrumentationFailure[] = [];
  return {
    entries,
    instrumentationFailures,
    ingest(frame: string | Uint8Array, ownership?: EvidenceOwnership) {
      let event: unknown;
      try {
        event = JSON.parse(typeof frame === "string" ? frame : new TextDecoder().decode(frame));
      } catch {
        return;
      }
      if (!isRecord(event) || event.companyId !== companyId || event.type !== "heartbeat.run.status") return;
      if (!ownership) return;
      if (!isRecord(event.payload)) {
        recordInstrumentationFailure(
          instrumentationFailures,
          "websocket-status-frame",
          "owned heartbeat.run.status payload was malformed",
          new Date().toISOString(),
          ownership,
        );
        return;
      }
      const payload = event.payload;
      if (
        (typeof payload.issueId === "string" && payload.issueId !== ownership.issueId) ||
        (typeof payload.runId === "string" && payload.runId !== ownership.runId)
      ) {
        return;
      }
      if (
        typeof payload.issueId !== "string" ||
        typeof payload.runId !== "string" ||
        typeof payload.status !== "string"
      ) {
        recordInstrumentationFailure(
          instrumentationFailures,
          "websocket-status-frame",
          "owned heartbeat.run.status payload was incomplete",
          new Date().toISOString(),
          ownership,
        );
        return;
      }
      const entry: StatusMetadata = {};
      for (const key of ["runId", "agentId", "status", "issueId", "deliveryId", "startedAt", "finishedAt"] as const) {
        const value = payload[key];
        if (value === null || typeof value === "string") entry[key] = value;
      }
      if (typeof event.createdAt === "string") entry.eventCreatedAt = event.createdAt;
      entries.push(entry);
    },
  };
}

export function classifyRunningTimeout(input: RunningTimeoutInput): RunningTimeoutClassification {
  const {
    adapter,
    apiErrorsDuringWindow,
    instrumentationFailures,
    successfulPollCount,
    finalNewRunIds,
    newRunIds = finalNewRunIds,
    anyNewRunRunning,
    observedNewRunRunning = anyNewRunRunning,
    finalIssueStatus,
    finalContinuationDelivery,
    hasResolveEvidence,
    recoveryActionPresentAtResolve,
    settledActionFoundAtResolve,
    finalSnapshotFailure,
  } = input;
  if (finalSnapshotFailure) {
    return {
      verdict: RUNNING_TIMEOUT_VERDICTS.OBSERVATION_FAILURE,
      message: finalSnapshotFailure,
    };
  }
  if (instrumentationFailures.length > 0) {
    const failure = instrumentationFailures[0];
    return {
      verdict: RUNNING_TIMEOUT_VERDICTS.INSTRUMENTATION_FAILURE,
      message: `running-window instrumentation failed at ${failure.stage}: ${failure.message}`,
    };
  }
  if (apiErrorsDuringWindow.length > 0) {
    const error = apiErrorsDuringWindow[0];
    return {
      verdict: RUNNING_TIMEOUT_VERDICTS.OBSERVATION_FAILURE,
      message: `a running-window live-runs observation failed before timeout: ${error.url} ${error.message}`,
    };
  }
  if (successfulPollCount === 0) {
    return {
      verdict: RUNNING_TIMEOUT_VERDICTS.OBSERVATION_FAILURE,
      message: "the running-window live-runs observation captured no successful reads",
    };
  }
  if (
    adapter === "process" &&
    hasResolveEvidence &&
    newRunIds.length === 0 &&
    recoveryActionPresentAtResolve !== true &&
    settledActionFoundAtResolve !== true
  ) {
    return {
      verdict: RUNNING_TIMEOUT_VERDICTS.OBSERVATION_FAILURE,
      message: "FIXTURE_OBSERVATION_ENDED_EARLY: the process reconcile observed neither an active nor a settled recovery action at resolve time, so it scheduled no successor wakeup and the resume had nothing to act on.",
    };
  }
  if (finalNewRunIds.length > 0 && !observedNewRunRunning) {
    return {
      verdict: RUNNING_TIMEOUT_VERDICTS.LATE_TRANSITION,
      message: `successor run row(s) ${JSON.stringify(finalNewRunIds)} appeared only in the final snapshot`,
    };
  }
  if (anyNewRunRunning) {
    return {
      verdict: RUNNING_TIMEOUT_VERDICTS.RESUME_TRANSITION_OBSERVED,
      message: `successor run reached 'running' within the observation window; final issue status=${String(finalIssueStatus)} continuationDelivery=${String(finalContinuationDelivery)}`,
    };
  }
  return {
    verdict: RUNNING_TIMEOUT_VERDICTS.NO_TRANSITION,
    message: "no successor run reached 'running' within the observation window",
  };
}

export type RunningTimeoutEvidenceInput = Omit<RunningTimeoutInput, "finalNewRunIds" | "anyNewRunRunning"> & {
  issueId: string;
  companyId: string;
  pollWindowStartMs: number;
  pollWindowEndMs: number;
  originalRunIds: string[];
  finalLiveRuns: unknown;
  statusMetadata: StatusMetadata[];
  finalSnapshots: unknown[];
  finalIssueState: { status: string | null; executionRunId: string | null };
  resolveCompletedAtIso: string | null;
  resumeInitiatedAtIso: string;
  resolveResponseBody?: unknown;
  originalProviderAliveAtResolve?: boolean | null;
};

function validateFinalLiveRuns(value: unknown): {
  rows: Array<{ id: string; status: string }>;
  error: string | null;
} {
  let candidates: unknown = value;
  if (isRecord(value) && "body" in value) candidates = value.body;
  const result = validateLiveRuns(candidates);
  return {
    rows: result.rows.map((row) => ({ id: row.id, status: row.status })),
    error: result.valid ? null : result.error,
  };
}

export function buildRunningTimeoutEvidence(input: RunningTimeoutEvidenceInput) {
  const pollFailures = input.instrumentationFailures.filter((failure) => {
    const atMs = Date.parse(failure.atIso);
    const inPollWindow = atMs >= input.pollWindowStartMs && atMs <= input.pollWindowEndMs;
    if (!inPollWindow) return false;
    if (failure.stage !== "websocket-status-frame") return true;
    return (
      failure.issueId === input.issueId &&
      failure.runId !== undefined &&
      input.originalRunIds.includes(failure.runId)
    );
  });
  const finalLiveRunsResult = validateFinalLiveRuns(input.finalLiveRuns);
  const finalRunRows = finalLiveRunsResult.rows;
  const pollingRunIds = new Set(input.observedRunRows.map((row) => row.id));
  const finalOnlyRunIds = finalRunRows
    .map((row) => row.id)
    .filter((id) => !pollingRunIds.has(id));
  const distinctRunIds = [
    ...new Set([...pollingRunIds, ...finalRunRows.map((row) => row.id)]),
  ];
  const newRunIds = distinctRunIds.filter((id) => !input.originalRunIds.includes(id));
  const observedNewRunRunning = input.observedRunRows.some(
    (row) => newRunIds.includes(row.id) && row.status === "running",
  );
  const anyNewRunRunning =
    observedNewRunRunning ||
    finalRunRows.some(
      (row) => newRunIds.includes(row.id) && row.status === "running",
    );
  const finalSnapshotFailure = [
    input.finalSnapshotFailure,
    finalLiveRunsResult.error ? `live-runs final snapshot: ${finalLiveRunsResult.error}` : null,
  ]
    .filter((failure): failure is string => failure !== null)
    .join("; ") || null;
  const classification = classifyRunningTimeout({
    ...input,
    instrumentationFailures: pollFailures,
    finalNewRunIds: finalOnlyRunIds.filter((id) => !input.originalRunIds.includes(id)),
    newRunIds,
    observedNewRunRunning,
    anyNewRunRunning,
    finalSnapshotFailure,
  });
  const statusFramesDuringWindow = input.statusMetadata.filter((entry) => {
    if (entry.issueId !== input.issueId || typeof entry.eventCreatedAt !== "string") return false;
    const atMs = Date.parse(entry.eventCreatedAt);
    return atMs >= input.pollWindowStartMs && atMs <= input.pollWindowEndMs;
  });
  const newRunStatuses = new Map<string, string[]>();
  for (const row of input.observedRunRows) {
    if (!newRunIds.includes(row.id)) continue;
    const statuses = newRunStatuses.get(row.id) ?? [];
    if (!statuses.includes(row.status)) statuses.push(row.status);
    newRunStatuses.set(row.id, statuses);
  }
  return {
    kind: "composer-stop-running-timeout-evidence",
    issueId: input.issueId,
    adapter: input.adapter,
    companyId: input.companyId,
    pollWindowStartIso: new Date(input.pollWindowStartMs).toISOString(),
    pollWindowEndIso: new Date(input.pollWindowEndMs).toISOString(),
    pollWindowMs: input.pollWindowEndMs - input.pollWindowStartMs,
    resolveCompletedAtIso: input.resolveCompletedAtIso,
    resolveToPollWindowStartMs: input.resolveCompletedAtIso
      ? input.pollWindowStartMs - Date.parse(input.resolveCompletedAtIso)
      : null,
    resumeInitiatedAtIso: input.resumeInitiatedAtIso,
    hasResolveEvidence: input.hasResolveEvidence,
    resolveResponseBody: input.resolveResponseBody ?? null,
    originalProviderAliveAtResolve: input.originalProviderAliveAtResolve ?? null,
    recoveryActionPresentAtResolve: input.recoveryActionPresentAtResolve,
    settledActionFoundAtResolve: input.settledActionFoundAtResolve,
    observedRunRows: input.observedRunRows,
    distinctRunIds,
    newRunIds,
    newRunStatuses: Object.fromEntries(newRunStatuses),
    finalLiveRuns: input.finalLiveRuns,
    finalSnapshots: input.finalSnapshots,
    finalIssueState: input.finalIssueState,
    finalContinuationDelivery: input.finalContinuationDelivery,
    apiErrorsDuringWindow: input.apiErrorsDuringWindow,
    instrumentationFailures: pollFailures,
    statusFramesDuringWindow,
    verdict: classification.verdict,
    verdictMessage: classification.message,
  };
}

export async function attachEvidenceOrRethrow(
  attach: () => Promise<void>,
  evidence: { verdict?: RunningTimeoutVerdict; instrumentationFailures?: InstrumentationFailure[] },
  failures: InstrumentationFailure[],
  stage: string,
  originalError: unknown,
) {
  try {
    await attach();
  } catch (error) {
    recordInstrumentationFailure(failures, stage, error);
    evidence.instrumentationFailures = failures;
    evidence.verdict = RUNNING_TIMEOUT_VERDICTS.INSTRUMENTATION_FAILURE;
    throw originalError;
  }
}
