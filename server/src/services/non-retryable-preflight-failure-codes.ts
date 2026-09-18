import { CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE } from "./chat-control-recovery-stop.js";

// FORK-DIVERGENCE(e2big-wake-env): launch refused because the spawn envelope
// (argv + env) would exceed the kernel limit. Recorded on the run so recovery
// treats it as non-retryable preflight rather than a transient spawn blip.
export const SPAWN_ENVELOPE_TOO_LARGE_FAILURE_CODE = "spawn_envelope_too_large";

// Fold 2c / D12 (operator decision 2026-09-15): upstream first-strike refusals.
// A run that failed with one of these codes is structurally refused, not
// transiently failed — re-dispatching the same agent onto the same issue policy
// computes the same refusal and fails identically. Upstream blocks these on the
// FIRST failure (wake-queue isImmediateRecoverySourceBlocked ->
// sourceRequiresExplicitRecovery); the fork does the same in
// releaseIssueExecutionAndPromote (isNonRetryablePreflightFailedRun).
//
// This set lives in a leaf module (not heartbeat.ts) because recovery/service.ts
// must read it too, and heartbeat.ts imports recovery/service.ts — importing
// heartbeat from recovery would close an import cycle. heartbeat.ts re-exports
// nothing; both modules import from here.
export const NON_RETRYABLE_PREFLIGHT_FAILURE_CODES = new Set<string>([
  "low_trust_isolation_unavailable",
  "low_trust_requires_isolated_workspace",
  "low_trust_boundary_mismatch",
  "low_trust_requires_sandbox_environment",
  "low_trust_runtime_services_denied",
  "chat_failed_run_retry_not_authorized",
  CHAT_CONTROL_RECOVERY_UNRESOLVED_CODE,
  SPAWN_ENVELOPE_TOO_LARGE_FAILURE_CODE,
]);

export function isNonRetryablePreflightFailureCode(
  errorCode: string | null | undefined,
): boolean {
  return errorCode != null && NON_RETRYABLE_PREFLIGHT_FAILURE_CODES.has(errorCode);
}
