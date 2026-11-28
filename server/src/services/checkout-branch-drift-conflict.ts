import { conflict } from "../errors.js";

/**
 * A managed-start checkout drift refusal is the caller's checkout state, not a
 * server fault: routes return it as a 409 that carries the evidence. Any other
 * error is returned unchanged.
 *
 * The check reads the refusal's shape (`code` plus `resultJson.workspaceValidation`)
 * instead of `instanceof`, so it does not import the runtime service module.
 */
export function checkoutBranchDriftAsHttpConflict(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const { code, resultJson } = error as Error & { code?: unknown; resultJson?: unknown };
  if (code !== "workspace_validation_failed") return error;
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return error;
  const validation = (resultJson as { workspaceValidation?: unknown }).workspaceValidation;
  if (!validation || typeof validation !== "object" || Array.isArray(validation)) return error;
  if ((validation as { reason?: unknown }).reason !== "checkout_branch_drift") return error;
  return conflict(error.message, { code: "checkout_branch_drift", ...validation });
}
