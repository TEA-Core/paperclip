import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  externalObjects,
  issueDeliveryReceiptLinks,
  issueDeliveryReceipts,
} from "@paperclipai/db";
import { and, eq, lt, or } from "drizzle-orm";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import {
  resolveGitHubTokenCandidatesForRepo,
  type GitHubTokenResolution,
} from "./github-credential.js";
import { canonicalizeExternalObjectUrl } from "@paperclipai/shared/external-objects-server";
import { logActivityInTransaction } from "./activity-log.js";

type RecoveryBody = {
  owner: unknown;
  repo: unknown;
  pullRequestNumber: unknown;
  headSha: unknown;
  reason: unknown;
  idempotencyKey: unknown;
};

export type DeliveryReceiptRecoveryInput = {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  headSha: string;
  reason: string;
  idempotencyKey: string;
};

export type DeliveryReceiptActor = {
  actorType: "user" | "board" | "agent";
  actorId: string;
  runId?: string | null;
  boardApiKeyId?: string | null;
  agentId?: string | null;
};

export type DeliveryReceiptClaim = {
  receiptId: string;
  claimToken: string;
  headSha: string;
};

const claimExpiryMs = 10 * 60 * 1000;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

export function normalizeDeliveryReceiptRecoveryInput(body: RecoveryBody): DeliveryReceiptRecoveryInput {
  const allowed = new Set(["owner", "repo", "pullRequestNumber", "headSha", "reason", "idempotencyKey"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new Error(`Unknown recovery field: ${key}`);
  }
  const owner = requiredString(body.owner, "owner").toLowerCase();
  const repo = requiredString(body.repo, "repo").toLowerCase();
  const pullRequestNumber = requiredPositiveInteger(body.pullRequestNumber, "pullRequestNumber");
  const headSha = requiredString(body.headSha, "headSha");
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("headSha must be a 40-character lowercase hexadecimal SHA-1");
  const reason = requiredString(body.reason, "reason");
  const idempotencyKey = requiredString(body.idempotencyKey, "idempotencyKey");
  if (idempotencyKey.length > 255) throw new Error("idempotencyKey is too long");
  return { owner, repo, pullRequestNumber, headSha, reason, idempotencyKey };
}

export function buildRecoveredExternalObjectIdentity(input: {
  owner: string;
  repo: string;
  pullRequestNumber: number;
}) {
  const canonical = canonicalizeExternalObjectUrl(
    `https://github.com/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pull/${input.pullRequestNumber}`,
  );
  if (!canonical) throw new Error("Unable to canonicalize the recovered PR URL");
  return {
    sanitizedCanonicalUrl: canonical.sanitizedCanonicalUrl,
    canonicalIdentityHash: canonical.canonicalIdentityHash,
    canonicalIdentity: canonical.canonicalIdentity,
  };
}

async function readPullRequest(candidate: GitHubTokenResolution, input: DeliveryReceiptRecoveryInput) {
  const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.pullRequestNumber}`;
  let response: Response;
  try {
    response = await ghFetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${candidate.token}`,
        "user-agent": "paperclip-delivery-receipt-recovery",
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch {
    return { ok: false as const, status: 0, message: "network_error" };
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) return { ok: false as const, status: response.status, message: typeof body?.message === "string" ? body.message : null };
  const head = body?.head as Record<string, unknown> | undefined;
  const headRepo = head?.repo as Record<string, unknown> | undefined;
  const headRepoOwner = typeof headRepo?.owner === "object" && headRepo.owner
    ? ((headRepo.owner as Record<string, unknown>).login as string | undefined)
    : undefined;
  return {
    ok: true as const,
    headRepoOwner: typeof headRepoOwner === "string" ? headRepoOwner : null,
    headRepoName: typeof headRepo?.name === "string" ? headRepo.name : null,
    branchName: typeof head?.ref === "string" ? head.ref : null,
    headSha: typeof head?.sha === "string" ? head.sha.toLowerCase() : null,
    open: body?.state === "open" && body?.merged !== true,
    draft: body?.draft === true,
  };
}

async function readWithCandidates(db: Db, companyId: string, input: DeliveryReceiptRecoveryInput) {
  const candidates: GitHubTokenResolution[] = await resolveGitHubTokenCandidatesForRepo(db, companyId, input.owner, input.repo);
  if (candidates.length === 0) throw new Error("GitHub credentials unavailable");
  let last: { status: number; message: string | null } | null = null;
  for (const candidate of candidates) {
    const result = await readPullRequest(candidate, input);
    if (result.ok || (result.status !== 401 && result.status !== 403)) return result;
    last = result;
  }
  throw new Error(`GitHub PR read failed: HTTP ${last?.status ?? 0} ${last?.message ?? ""}`.trim());
}

export async function recoverDeliveryReceipt(input: {
  db: Db;
  companyId: string;
  issueId: string;
  sourceRunId?: string | null;
  actor: DeliveryReceiptActor;
  recovery: DeliveryReceiptRecoveryInput;
  deliveryBranch: string | null;
  projectRepo: { owner: string; repo: string };
}) {
  const { db, companyId, issueId, recovery, projectRepo } = input;
  if (
    recovery.owner.toLowerCase() !== projectRepo.owner.toLowerCase() ||
    recovery.repo.toLowerCase() !== projectRepo.repo.toLowerCase()
  ) {
    throw new Error("PR repository does not match the project repository");
  }
  const existing = await db
    .select()
    .from(issueDeliveryReceipts)
    .where(and(
      eq(issueDeliveryReceipts.companyId, companyId),
      eq(issueDeliveryReceipts.idempotencyKey, recovery.idempotencyKey),
    ))
    .then((rows) => rows[0] ?? null);
  if (existing) {
    const same = existing.sourceIssueId === issueId && existing.provider === "github" && existing.owner.toLowerCase() === recovery.owner.toLowerCase() && existing.repo.toLowerCase() === recovery.repo.toLowerCase() && existing.pullRequestNumber === recovery.pullRequestNumber && existing.headSha === recovery.headSha && existing.recoveryReason === recovery.reason;
    if (!same) throw new Error("idempotency key conflicts with an existing receipt");
    return { receipt: existing, replayed: true };
  }
  const live = await readWithCandidates(db, companyId, recovery);
  if (!live.ok) throw new Error(`GitHub PR read failed: HTTP ${live.status} ${live.message ?? ""}`.trim());
  if (!live.open || live.draft) throw new Error("PR must be open and non-draft");
  if (live.headRepoOwner?.toLowerCase() !== recovery.owner.toLowerCase() || live.headRepoName?.toLowerCase() !== recovery.repo.toLowerCase()) {
    throw new Error("PR head repository does not match the requested repository");
  }
  if (!live.branchName) throw new Error("PR head branch is unavailable");
  if (live.headSha !== recovery.headSha) throw new Error("PR head does not match the requested receipt head");
  if (input.deliveryBranch && live.branchName !== input.deliveryBranch) throw new Error("PR branch does not match the delivery branch");
  const now = new Date();
  const externalId = `${recovery.owner.toLowerCase()}/${recovery.repo.toLowerCase()}#pull/${recovery.pullRequestNumber}`;
  const externalObjectIdentity = buildRecoveredExternalObjectIdentity(recovery);
  return db.transaction(async (tx) => {
    const prior = await tx
      .select()
      .from(issueDeliveryReceipts)
      .where(and(
        eq(issueDeliveryReceipts.companyId, companyId),
        eq(issueDeliveryReceipts.idempotencyKey, recovery.idempotencyKey),
      ))
      .then((rows) => rows[0] ?? null);
    if (prior) {
      const same = prior.sourceIssueId === issueId && prior.owner.toLowerCase() === recovery.owner.toLowerCase() && prior.repo.toLowerCase() === recovery.repo.toLowerCase() && prior.pullRequestNumber === recovery.pullRequestNumber && prior.headSha === recovery.headSha && prior.recoveryReason === recovery.reason;
      if (!same) throw new Error("idempotency key conflicts with an existing receipt");
      return { receipt: prior, replayed: true };
    }
    const [external] = await tx.insert(externalObjects).values({
      companyId,
      providerKey: "github",
      pluginId: null,
      objectType: "pull_request",
      externalId,
      sanitizedCanonicalUrl: externalObjectIdentity.sanitizedCanonicalUrl,
      canonicalIdentityHash: externalObjectIdentity.canonicalIdentityHash,
      displayKey: `GitHub Pull Request`,
      iconKey: "github",
      displayTitle: `${recovery.owner}/${recovery.repo}#${recovery.pullRequestNumber}`,
      data: { headRef: live.branchName, headSha: recovery.headSha, state: "open", draft: false },
      statusCategory: "open",
      liveness: "fresh",
      isTerminal: false,
      lastResolvedAt: now,
      updatedAt: now,
    } satisfies typeof externalObjects.$inferInsert).onConflictDoUpdate({
      target: [externalObjects.companyId, externalObjects.providerKey, externalObjects.objectType, externalObjects.externalId],
      set: { data: { headRef: live.branchName, headSha: recovery.headSha, state: "open", draft: false }, lastResolvedAt: now, updatedAt: now },
    }).returning();
    if (!external) throw new Error("Unable to resolve the recovered PR external object");
    const [receipt] = await tx.insert(issueDeliveryReceipts).values({
      companyId,
      sourceIssueId: issueId,
      provider: "github",
      owner: recovery.owner,
      repo: recovery.repo,
      pullRequestNumber: recovery.pullRequestNumber,
      headSha: recovery.headSha,
      branchName: live.branchName ?? input.deliveryBranch ?? "",
      sourceRunId: input.sourceRunId ?? null,
      sourceDeliveryRecord: { projectRepo, liveHeadSha: live.headSha },
      recoveryReason: recovery.reason,
      authorizedByActorType: input.actor.actorType,
      authorizedByActorId: input.actor.actorId,
      authorizedByRunId: input.actor.runId ?? null,
      idempotencyKey: recovery.idempotencyKey,
      state: "ready",
    }).returning();
    if (!receipt) throw new Error("Unable to create the delivery receipt");
    await tx.insert(issueDeliveryReceiptLinks).values({
      companyId,
      receiptId: receipt.id,
      sourceIssueId: issueId,
      externalObjectId: external.id,
      provider: "github",
      owner: recovery.owner,
      repo: recovery.repo,
      pullRequestNumber: recovery.pullRequestNumber,
      headSha: recovery.headSha,
    });
    await logActivityInTransaction(tx as unknown as Db, {
      companyId,
      actorType: input.actor.actorType === "board" ? "user" : input.actor.actorType,
      actorId: input.actor.actorId,
      agentId: input.actor.agentId ?? null,
      runId: input.actor.runId ?? null,
      boardApiKeyId: input.actor.boardApiKeyId ?? null,
      action: "issue.delivery_receipt_recovered",
      entityType: "issue_delivery_receipt",
      entityId: receipt.id,
      issueId,
      details: { owner: recovery.owner, repo: recovery.repo, pullRequestNumber: recovery.pullRequestNumber, headSha: recovery.headSha, idempotencyKey: recovery.idempotencyKey },
    });
    return { receipt, replayed: false };
  });
}

export type DeliveryReceiptPublicationLookup =
  | { kind: "missing" }
  | { kind: "blocked"; reason: "head_mismatch" | "state_unavailable" }
  | { kind: "claimed"; claim: DeliveryReceiptClaim };

export async function claimDeliveryReceipt(db: Db, input: { companyId: string; issueId: string; owner: string; repo: string; pullRequestNumber: number; headSha: string }): Promise<DeliveryReceiptClaim | null> {
  const owner = input.owner.toLowerCase();
  const repo = input.repo.toLowerCase();
  const now = new Date();
  const stale = new Date(now.getTime() - claimExpiryMs);
  const claimToken = randomUUID();
  const rows = await db.update(issueDeliveryReceipts).set({ state: "claimed", claimToken, claimedAt: now, updatedAt: now }).where(and(eq(issueDeliveryReceipts.companyId, input.companyId), eq(issueDeliveryReceipts.sourceIssueId, input.issueId), eq(issueDeliveryReceipts.provider, "github"), eq(issueDeliveryReceipts.owner, owner), eq(issueDeliveryReceipts.repo, repo), eq(issueDeliveryReceipts.pullRequestNumber, input.pullRequestNumber), eq(issueDeliveryReceipts.headSha, input.headSha), or(eq(issueDeliveryReceipts.state, "ready"), and(eq(issueDeliveryReceipts.state, "claimed"), lt(issueDeliveryReceipts.claimedAt, stale))))).returning({ id: issueDeliveryReceipts.id, headSha: issueDeliveryReceipts.headSha });
  const row = rows[0];
  return row ? { receiptId: row.id, claimToken, headSha: row.headSha } : null;
}

export async function claimDeliveryReceiptForPublication(
  db: Db,
  input: { companyId: string; issueId: string; owner: string; repo: string; pullRequestNumber: number; headSha: string },
): Promise<DeliveryReceiptPublicationLookup> {
  const candidates = await db
    .select({ headSha: issueDeliveryReceipts.headSha, state: issueDeliveryReceipts.state })
    .from(issueDeliveryReceipts)
    .innerJoin(
      issueDeliveryReceiptLinks,
      and(
        eq(issueDeliveryReceiptLinks.companyId, issueDeliveryReceipts.companyId),
        eq(issueDeliveryReceiptLinks.receiptId, issueDeliveryReceipts.id),
        eq(issueDeliveryReceiptLinks.sourceIssueId, issueDeliveryReceipts.sourceIssueId),
        eq(issueDeliveryReceiptLinks.headSha, issueDeliveryReceipts.headSha),
      ),
    )
    .where(and(
      eq(issueDeliveryReceipts.companyId, input.companyId),
      eq(issueDeliveryReceipts.sourceIssueId, input.issueId),
      eq(issueDeliveryReceipts.provider, "github"),
      eq(issueDeliveryReceipts.owner, input.owner.toLowerCase()),
      eq(issueDeliveryReceipts.repo, input.repo.toLowerCase()),
      eq(issueDeliveryReceipts.pullRequestNumber, input.pullRequestNumber),
      eq(issueDeliveryReceiptLinks.provider, "github"),
      eq(issueDeliveryReceiptLinks.owner, input.owner.toLowerCase()),
      eq(issueDeliveryReceiptLinks.repo, input.repo.toLowerCase()),
      eq(issueDeliveryReceiptLinks.pullRequestNumber, input.pullRequestNumber),
    ));
  if (candidates.length === 0) return { kind: "missing" };
  const exact = candidates.find((candidate) => candidate.headSha === input.headSha);
  if (!exact) return { kind: "blocked", reason: "head_mismatch" };
  const claim = await claimDeliveryReceipt(db, input);
  return claim ? { kind: "claimed", claim } : { kind: "blocked", reason: "state_unavailable" };
}

export async function consumeDeliveryReceipt(db: Db, claim: DeliveryReceiptClaim): Promise<boolean> {
  const rows = await db.update(issueDeliveryReceipts).set({ state: "consumed", consumedAt: new Date(), updatedAt: new Date() }).where(and(eq(issueDeliveryReceipts.id, claim.receiptId), eq(issueDeliveryReceipts.claimToken, claim.claimToken), eq(issueDeliveryReceipts.headSha, claim.headSha), eq(issueDeliveryReceipts.state, "claimed"))).returning({ id: issueDeliveryReceipts.id });
  return rows.length === 1;
}

export async function invalidateDeliveryReceipt(db: Db, claim: DeliveryReceiptClaim): Promise<boolean> {
  const rows = await db.update(issueDeliveryReceipts).set({ state: "invalidated", invalidatedAt: new Date(), updatedAt: new Date() }).where(and(eq(issueDeliveryReceipts.id, claim.receiptId), eq(issueDeliveryReceipts.claimToken, claim.claimToken), eq(issueDeliveryReceipts.state, "claimed"))).returning({ id: issueDeliveryReceipts.id });
  return rows.length === 1;
}
