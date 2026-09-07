import type { agents } from "@paperclipai/db";
import { asString, parseObject } from "../adapters/utils.js";
import { parseHeartbeatPolicy } from "./heartbeat-policy.js";

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
 * True when Paperclip can never start a run for this agent: it is declared
 * `external_pull` (work reaches Paperclip out of band, e.g. a GitLab MR-bot
 * seat), or its heartbeat is fully off (no periodic timer AND no on-demand
 * wake). For such seats every run-derived metric — run counts, cost,
 * run-linked comments, and even the active-episode duration — is structurally
 * zero or unmeasurable, so evaluating run-derived triggers against them is
 * meaningless and produces a "blocked only by a cancelled review card" loop.
 */
export function hasNoPlatformDispatchPath(agent: AgentWorkDeliveryInput): boolean {
  if (isExternalPullAgent(agent)) return true;
  const policy = parseHeartbeatPolicy(agent);
  return policy.enabled === false && policy.wakeOnDemand === false;
}
