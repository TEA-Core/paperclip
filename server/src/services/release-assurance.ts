import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agents, issues, releaseAssuranceEvents } from "@paperclipai/db";
import type { EnrollReleaseAssurance, ReleaseAssuranceDecision } from "@paperclipai/shared";
import { and, asc, eq } from "drizzle-orm";
import { isUniqueViolation } from "../db-errors.js";
import { conflict, notFound } from "../errors.js";
import { logActivityInTransaction } from "./activity-log.js";
import { readApprovalPullRequest } from "./approval-status-reconciler.js";
import { resolveLinkedPullRequestsWithState } from "./merge-arming.js";

/**
 * Release-assurance control plane, SHADOW mode (SUP-20771, design report §3.1–3.3).
 *
 * The ledger records enrollment (HOLD) and head-bound GO / NO-GO decisions and
 * evaluates the durable veto. Nothing here admits a PR: the publisher plans the
 * `release-assurance/approved` status and records that it was NOT written. There
 * is deliberately no flag that turns publication on — the database only
 * expresses `shadow`, and a later slice owns the admitting change.
 */

export const RELEASE_ASSURANCE_STATUS_CONTEXT = "release-assurance/approved" as const;
export const RELEASE_ASSURANCE_POLICY_REVISION = 1;

export type ReleaseAssuranceEventRow = typeof releaseAssuranceEvents.$inferSelect;

export type ReleaseAssuranceActor = {
  actorType: "user" | "agent";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  boardApiKeyId?: string | null;
};

export type LivePullRequest =
  | { ok: true; open: boolean; headSha: string | null }
  | { ok: false; message: string };

export type ReleaseAssuranceDeps = {
  /** PRs this card is linked to; the enrollment binds only one of these. */
  linkedPullRequests(companyId: string, issueId: string): Promise<Array<{ owner: string; repo: string; number: number }>>;
  readLivePullRequest(companyId: string, target: { owner: string; repo: string; number: number }): Promise<LivePullRequest>;
};

export function releaseAssuranceDeps(db: Db): ReleaseAssuranceDeps {
  return {
    linkedPullRequests: (companyId, issueId) =>
      resolveLinkedPullRequestsWithState(db, companyId, issueId, { includeDrafts: true }),
    readLivePullRequest: async (companyId, target) => {
      const live = await readApprovalPullRequest(db, companyId, target);
      const body = live.ok && live.body && typeof live.body === "object" ? (live.body as Record<string, unknown>) : null;
      if (!live.ok || !body) return { ok: false, message: `GitHub PR read failed: HTTP ${live.status}` };
      const head = body.head as { sha?: unknown } | undefined;
      return {
        ok: true,
        open: body.state === "open" && body.merged !== true,
        headSha: typeof head?.sha === "string" ? head.sha.toLowerCase() : null,
      };
    },
  };
}

/**
 * The one-stage execution policy a release-assurance card carries (§4.1): a
 * single `approval` stage whose only participant is the RA seat. It is not
 * installed by this slice; `normalizeIssueExecutionPolicy` refuses the authority
 * unless a trusted caller opts in, so no create/PATCH body can select it.
 */
export function buildReleaseAssurancePolicy(raAgentId: string) {
  return {
    mode: "normal" as const,
    commentRequired: true,
    approvalAuthority: "release_assurance" as const,
    stages: [{ type: "approval" as const, approvalsNeeded: 1 as const, participants: [{ type: "agent" as const, agentId: raAgentId }] }],
  };
}

export type ReleaseAssuranceVerdict = "not_enrolled" | "held" | "go" | "no_go";

/**
 * The durable veto (§3.3), evaluated from ledger rows alone. Enrollment persists
 * across head changes and a head without a GO is held; a NO-GO is sticky for its
 * head and beats a GO on that same head whatever order they arrived in.
 */
export function evaluateReleaseAssuranceHead(
  events: Array<Pick<ReleaseAssuranceEventRow, "kind" | "headSha">>,
  headSha: string,
): ReleaseAssuranceVerdict {
  if (!events.some((event) => event.kind === "hold")) return "not_enrolled";
  const forHead = events.filter((event) => event.headSha === headSha);
  if (forHead.some((event) => event.kind === "no_go")) return "no_go";
  return forHead.some((event) => event.kind === "go") ? "go" : "held";
}

export type PlannedReleaseAssuranceStatus = {
  context: typeof RELEASE_ASSURANCE_STATUS_CONTEXT;
  state: "success" | "pending" | "failure";
  sha: string;
  description: string;
  targetUrl: string;
};

export type ReleaseAssurancePublication = {
  kind: "shadow";
  /** What a later admitting slice would write; nothing was sent to GitHub. */
  planned: PlannedReleaseAssuranceStatus | null;
};

/**
 * Shadow status publisher (§3.2). Plans the status for a verdict and returns it
 * without any I/O, so `release-assurance/approved` can never reach GitHub from
 * this code path. A non-enrolled PR plans nothing.
 */
export function publishReleaseAssuranceStatus(input: {
  issueId: string;
  headSha: string;
  verdict: ReleaseAssuranceVerdict;
}): ReleaseAssurancePublication {
  if (input.verdict === "not_enrolled") return { kind: "shadow", planned: null };
  const base = { context: RELEASE_ASSURANCE_STATUS_CONTEXT, sha: input.headSha, targetUrl: `/api/issues/${input.issueId}/release-decisions` };
  if (input.verdict === "go") {
    return { kind: "shadow", planned: { ...base, state: "success", description: `released by release-assurance for ${input.headSha}` } };
  }
  const denied = input.verdict === "no_go";
  return {
    kind: "shadow",
    planned: { ...base, state: denied ? "failure" : "pending", description: denied ? "release-assurance NO-GO" : "release-assurance hold" },
  };
}

const payloadDigest = (payload: Record<string, unknown>) =>
  createHash("sha256").update(JSON.stringify(Object.keys(payload).sort().map((key) => [key, payload[key]]))).digest("hex");

export function releaseAssuranceService(db: Db, deps: ReleaseAssuranceDeps = releaseAssuranceDeps(db)) {
  const listEvents = (executor: Db, companyId: string, issueId: string) =>
    executor
      .select()
      .from(releaseAssuranceEvents)
      .where(and(eq(releaseAssuranceEvents.companyId, companyId), eq(releaseAssuranceEvents.issueId, issueId)))
      .orderBy(asc(releaseAssuranceEvents.sequence));

  /**
   * Serializes per card on the issue row, then either replays an identical event
   * or appends a new one. Reusing an event id with a different payload is a 409.
   */
  async function append(input: {
    companyId: string;
    issueId: string;
    eventId: string;
    actor: ReleaseAssuranceActor;
    payload: Record<string, unknown>;
    row: Omit<typeof releaseAssuranceEvents.$inferInsert, "companyId" | "issueId" | "eventId" | "payloadDigest" | "recordedByActorType" | "recordedByActorId">;
    guard: (events: ReleaseAssuranceEventRow[]) => void;
  }) {
    const digest = payloadDigest({ ...input.payload, issueId: input.issueId });
    try {
      return await db.transaction(async (tx) => {
        const [issue] = await tx
          .select({ id: issues.id })
          .from(issues)
          .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
          .for("update");
        if (!issue) throw notFound("Issue not found");
        const events = await listEvents(tx as unknown as Db, input.companyId, input.issueId);
        const prior = (await tx
          .select()
          .from(releaseAssuranceEvents)
          .where(and(eq(releaseAssuranceEvents.companyId, input.companyId), eq(releaseAssuranceEvents.eventId, input.eventId))))[0];
        if (prior) {
          if (prior.issueId !== input.issueId || prior.payloadDigest !== digest) {
            throw conflict("eventId was already used for a different release-assurance event");
          }
          return { event: prior, events, replayed: true };
        }
        input.guard(events);
        const [event] = await tx.insert(releaseAssuranceEvents).values({
          ...input.row,
          companyId: input.companyId,
          issueId: input.issueId,
          eventId: input.eventId,
          payloadDigest: digest,
          recordedByActorType: input.actor.actorType,
          recordedByActorId: input.actor.actorId,
        }).returning();
        if (!event) throw new Error("Unable to record the release-assurance event");
        await logActivityInTransaction(tx as unknown as Db, {
          companyId: input.companyId,
          actorType: input.actor.actorType,
          actorId: input.actor.actorId,
          agentId: input.actor.agentId ?? null,
          runId: input.actor.runId ?? null,
          boardApiKeyId: input.actor.boardApiKeyId ?? null,
          action: `issue.release_assurance_${event.kind}`,
          entityType: "issue",
          entityId: input.issueId,
          issueId: input.issueId,
          details: {
            eventId: event.eventId, sequence: event.sequence, owner: event.owner, repo: event.repo,
            pullRequestNumber: event.pullRequestNumber, headSha: event.headSha, publicationMode: event.publicationMode,
          },
        });
        return { event, events: [...events, event], replayed: false };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict("A conflicting release-assurance event already exists");
      throw error;
    }
  }

  return {
    listEvents: (companyId: string, issueId: string) => listEvents(db, companyId, issueId),

    /** Board enrollment: durably HOLD the card + exact PR before any scout starts. */
    async enroll(input: { companyId: string; issueId: string; actor: ReleaseAssuranceActor; body: EnrollReleaseAssurance }) {
      const owner = input.body.owner.toLowerCase();
      const repo = input.body.repo.toLowerCase();
      const linked = await deps.linkedPullRequests(input.companyId, input.issueId);
      if (!linked.some((pr) => pr.owner.toLowerCase() === owner && pr.repo.toLowerCase() === repo && pr.number === input.body.pullRequestNumber)) {
        throw conflict("The pull request is not linked to this card");
      }
      const [seat] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, input.body.raAgentId), eq(agents.companyId, input.companyId)));
      if (!seat) throw conflict("raAgentId is not an agent of this company");
      return append({
        companyId: input.companyId,
        issueId: input.issueId,
        eventId: input.body.eventId,
        actor: input.actor,
        payload: { kind: "hold", owner, repo, pullRequestNumber: input.body.pullRequestNumber, raAgentId: input.body.raAgentId, reason: input.body.reason },
        row: {
          kind: "hold", owner, repo, pullRequestNumber: input.body.pullRequestNumber, headSha: null,
          policyRevision: RELEASE_ASSURANCE_POLICY_REVISION, raAgentId: input.body.raAgentId, reason: input.body.reason,
        },
        guard: (events) => {
          if (events.some((event) => event.kind === "hold")) throw conflict("This card is already enrolled in release assurance");
        },
      });
    },

    /** Record a GO / NO-GO bound to the live head; the head must still be the PR head. */
    async decide(input: { companyId: string; issueId: string; actor: ReleaseAssuranceActor; body: ReleaseAssuranceDecision }) {
      const { body } = input;
      const payload = { kind: body.decision, headSha: body.headSha, reason: body.reason,
        ...(body.decision === "go" ? { evidenceDigest: body.evidenceDigest, ciRunIds: [...body.ciRunIds].sort((a, b) => a - b) } : {}) };
      const hold = (await listEvents(db, input.companyId, input.issueId)).find((event) => event.kind === "hold");
      if (!hold) throw conflict("This card is not enrolled in release assurance");
      // A replay of an already-recorded decision answers from the ledger, even after the head moved.
      const [replay] = await db
        .select({ id: releaseAssuranceEvents.id })
        .from(releaseAssuranceEvents)
        .where(and(eq(releaseAssuranceEvents.companyId, input.companyId), eq(releaseAssuranceEvents.eventId, body.eventId)));
      if (!replay) {
        const live = await deps.readLivePullRequest(input.companyId, { owner: hold.owner, repo: hold.repo, number: hold.pullRequestNumber });
        if (!live.ok) throw conflict(`Live PR head is unavailable: ${live.message}`);
        if (!live.open) throw conflict("The pull request is not open");
        if (live.headSha !== body.headSha) throw conflict("PR head moved; a decision must name the current head", { liveHeadSha: live.headSha });
      }
      const result = await append({
        companyId: input.companyId,
        issueId: input.issueId,
        eventId: body.eventId,
        actor: input.actor,
        payload,
        row: {
          kind: body.decision, owner: hold.owner, repo: hold.repo, pullRequestNumber: hold.pullRequestNumber, headSha: body.headSha,
          policyRevision: hold.policyRevision, raAgentId: hold.raAgentId, reason: body.reason,
          ...(body.decision === "go" ? { evidenceDigest: body.evidenceDigest, ciRunIds: payload.ciRunIds as number[] } : {}),
        },
        guard: (events) => {
          if (evaluateReleaseAssuranceHead(events, body.headSha) === "no_go") {
            throw conflict("This head has a recorded NO-GO; fix it on a new head");
          }
        },
      });
      const verdict = evaluateReleaseAssuranceHead(result.events, body.headSha);
      return { ...result, verdict, publication: publishReleaseAssuranceStatus({ issueId: input.issueId, headSha: body.headSha, verdict }) };
    },
  };
}
