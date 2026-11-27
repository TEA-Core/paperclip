import type { agents } from "@paperclipai/db";
import { asString, parseObject } from "../adapters/utils.js";
import { forbidden } from "../errors.js";

/**
 * How an agent's work reaches Paperclip.
 *
 * - `invoked`: Paperclip starts the agent's process and the run *is* the work.
 *   Everything Paperclip infers from a run — liveness, progress, disposition —
 *   is a valid reading of what the agent did.
 * - `external_pull`: the agent runs somewhere Paperclip does not start it
 *   (Claude Code Desktop, Cowork Desktop) and pulls its work through the
 *   Paperclip MCP tools out of band. A wake for such an agent is a doorbell,
 *   not the work, so what its run process did says nothing about the issue.
 *
 * This must be declared on the agent record. It is deliberately not inferred
 * from the adapter command: the `/bin/echo` "no-op wake" that operators reach
 * for is indistinguishable from a genuinely broken process agent, and guessing
 * would silently disable disposition recovery for the latter.
 */
export const AGENT_WORK_DELIVERY_MODES = ["invoked", "external_pull"] as const;

export type AgentWorkDelivery = (typeof AGENT_WORK_DELIVERY_MODES)[number];

export const AGENT_WORK_DELIVERY_RUNTIME_CONFIG_KEY = "workDelivery";

const EXTERNAL_PULL_SPELLINGS = new Set([
  "external_pull",
  "externalpull",
  "external-pull",
  "pull",
]);

type AgentWorkDeliveryInput = Pick<typeof agents.$inferSelect, "runtimeConfig">;

export function parseAgentWorkDelivery(agent: AgentWorkDeliveryInput): AgentWorkDelivery {
  const runtimeConfig = parseObject(agent.runtimeConfig);
  const declared = asString(runtimeConfig[AGENT_WORK_DELIVERY_RUNTIME_CONFIG_KEY], "")
    .trim()
    .toLowerCase();
  // Anything Paperclip cannot read falls back to `invoked`, which keeps every
  // recovery path the agent had before the declaration was added.
  return EXTERNAL_PULL_SPELLINGS.has(declared) ? "external_pull" : "invoked";
}

export function isExternalPullAgent(agent: AgentWorkDeliveryInput) {
  return parseAgentWorkDelivery(agent) === "external_pull";
}

/**
 * Fork (two-fleet routing): the `external_pull` declaration exempts an agent's
 * parked cards from recovery sweeps, so only a board actor may set or clear
 * it. Every write path that is reachable by an agent, a plugin or an import
 * that the board did not allow refuses a change with this error.
 */
export const AGENT_WORK_DELIVERY_BOARD_ONLY_CODE = "agent_work_delivery_board_only";

export function agentWorkDeliveryBoardOnlyError() {
  return forbidden("Only the board can change an agent's work delivery mode.", {
    code: AGENT_WORK_DELIVERY_BOARD_ONLY_CODE,
  });
}

/** The runtime config declares `external_pull` work delivery. */
export function declaresExternalPullWorkDelivery(runtimeConfig: unknown): boolean {
  return parseAgentWorkDelivery({ runtimeConfig: parseObject(runtimeConfig) }) === "external_pull";
}

/**
 * A hire approval payload declares `external_pull` either at the top level or
 * under `requestedAgentConfig`, the two shapes activation copies onto the agent.
 */
export function hireApprovalPayloadDeclaresExternalPull(payload: unknown): boolean {
  const record = parseObject(payload);
  return (
    declaresExternalPullWorkDelivery(record.runtimeConfig) ||
    declaresExternalPullWorkDelivery(parseObject(record.requestedAgentConfig).runtimeConfig)
  );
}
