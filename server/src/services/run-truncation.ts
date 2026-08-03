/**
 * Classification of adapter runs that exit cleanly but did not actually finish.
 *
 * A CLI agent whose stream is cut off mid-step still exits 0 and reports no error message, so an
 * exit-code-only success test records it as `succeeded`. Downstream that produces a successful run
 * with no disposition, which opens a `missing_disposition` recovery action. The terminal
 * `step_finish.reason` emitted by the agent's own stream is the field that distinguishes these
 * cases, and it is the one the run finaliser must consult.
 *
 *   | case                  | exit 0 | output tokens | finish reason | outcome     |
 *   | --------------------- | ------ | ------------- | ------------- | ----------- |
 *   | pull-agent no-op wake | yes    | 0             | absent        | `succeeded` |
 *   | truncated mid-step    | yes    | 0             | `unknown`     | `failed`    |
 *   | output cap hit        | yes    | >0            | `length`      | `failed`    |
 *   | normal completion     | yes    | >0            | clean         | `succeeded` |
 *
 * Token counts alone cannot separate row 1 from row 2, which is why the finish reason is
 * load-bearing: pull agents emit no step stream at all, so their finish reason is absent rather
 * than `unknown`.
 */

export const TRUNCATED_MID_STEP_ERROR_CODE = "truncated_mid_step";
export const OUTPUT_CAP_REACHED_ERROR_CODE = "output_cap_reached";
export const MISSING_EXIT_CODE_ERROR_CODE = "exit_code_missing";

export interface RunTruncationVerdict {
  errorCode: string;
  errorMessage: string;
}

/**
 * Returns a failure verdict when the terminal step reason shows the run was cut off, or `null`
 * when the run finished on its own terms (including adapters that emit no step stream).
 */
export function classifyRunTruncation(input: {
  finishReason?: string | null;
  outputTokens?: number | null;
}): RunTruncationVerdict | null {
  const reason = typeof input.finishReason === "string" ? input.finishReason.trim().toLowerCase() : "";
  if (!reason) return null;

  if (reason === "length") {
    return {
      errorCode: OUTPUT_CAP_REACHED_ERROR_CODE,
      errorMessage:
        "Run hit the output-token cap mid-step (final step_finish reason=\"length\") and stopped before " +
        "recording a disposition.",
    };
  }

  // `unknown` with output is an agent that stopped for a reason the adapter could not name but
  // still produced work; only the zero-output form is the truncation signature.
  if (reason === "unknown" && (input.outputTokens ?? 0) === 0) {
    return {
      errorCode: TRUNCATED_MID_STEP_ERROR_CODE,
      errorMessage:
        "Run was truncated mid-step (final step_finish reason=\"unknown\" with zero output tokens) and " +
        "produced no result.",
    };
  }

  return null;
}

export function missingExitCodeVerdict(): RunTruncationVerdict {
  return {
    errorCode: MISSING_EXIT_CODE_ERROR_CODE,
    errorMessage: "Adapter returned no exit code, so the run cannot be confirmed to have completed.",
  };
}

export interface AdapterRunOutcome {
  outcome: "succeeded" | "failed" | "timed_out";
  verdict: RunTruncationVerdict | null;
}

/**
 * Decides a run's outcome from what the adapter reported. Split out of the run finaliser so the
 * whole decision table is directly testable; the finaliser still owns the cases decided by run
 * state rather than by the adapter (cancellation, an already-terminal run row).
 */
export function resolveAdapterRunOutcome(input: {
  timedOut: boolean;
  exitCode: number | null | undefined;
  errorMessage?: string | null;
  finishReason?: string | null;
  outputTokens?: number | null;
}): AdapterRunOutcome {
  if (input.timedOut) return { outcome: "timed_out", verdict: null };

  // Truncation is checked before the exit code because an adapter may already have synthesized a
  // non-zero exit for the same stream — opencode-local does. Reading the finish reason first keeps
  // the specific `truncated_mid_step` / `output_cap_reached` code instead of flattening the run to
  // a generic `adapter_failed`, and the two layers stay independently correct.
  const verdict = classifyRunTruncation({
    finishReason: input.finishReason,
    outputTokens: input.outputTokens,
  });
  if (verdict) return { outcome: "failed", verdict };

  // Fail closed: a lost process or a crashed adapter must not read as a clean exit.
  if (input.exitCode == null) return { outcome: "failed", verdict: missingExitCodeVerdict() };

  if (input.exitCode !== 0 || input.errorMessage) return { outcome: "failed", verdict: null };

  return { outcome: "succeeded", verdict: null };
}
