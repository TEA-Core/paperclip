import { isUniqueViolation } from "../db-errors.js";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  executionWorkspaces,
  issueChildCarrierAttributions,
  issueExecutionDecisions,
  issues,
} from "@paperclipai/db";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { resolveGitHubTokenCandidatesForRepo } from "./github-credential.js";
import { isStrictAncestorIssueIdOf } from "./issues.js";
import { logActivity } from "./activity-log.js";

export const CHILD_CARRIER_ATTRIBUTION_ACTOR_ID = "system:child-carrier-attribution";

export const CHILD_CARRIER_STAMP_SKIP =
  "status:skipped:child-carrier-attribution: child approval records the decision only; paperclip/approved is not published and the carrier is not armed";

export const CHILD_CARRIER_OWNER_GATE_SKIP =
  "status:skipped:child-carrier-owner-gate: a required child attribution is missing, pending, stale, incomplete, or extra; the carrier owner does not stamp or arm";

const SHA_RE = /^[0-9a-f]{40,64}$/;

export type ChildCarrierLivePullRequest = {
  owner: string;
  repo: string;
  number: number;
  headRef: string | null;
  headSha: string | null;
  state: string | null;
  draft: boolean | null;
  merged: boolean | null;
  headRepoFullName: string | null;
  baseRef: string | null;
};

export type ChildCarrierResolution =
  | { kind: "absent" }
  | {
      kind: "resolved";
      headSha: string;
      displayName: string;
      pr: { owner: string; repo: string; number: number };
      childCarrierAttribution: true;
    }
  | { kind: "unresolvable"; reason: string };

type CommitEnumerator = (input: {
  token: string;
  owner: string;
  repo: string;
  pullRequestNumber: number;
  headSha: string;
  baseRef: string | null;
  childBranch: string;
}) => Promise<{ ok: true; shas: string[] } | { ok: false; reason: string }>;

export const childCarrierCommits: { enumerate: CommitEnumerator } = {
  enumerate: enumerateChildCarrierCommits,
};

function parseRepoUrl(repoUrl: string | null): { owner: string; repo: string } | null {
  if (!repoUrl) return null;
  const match = repoUrl.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/#?]+?)(?:\.git)?\/?$/i);
  if (!match?.groups) return null;
  return { owner: match.groups.owner!, repo: match.groups.repo! };
}

function normalizeShas(shas: string[]): string[] | null {
  const normalized = shas.map((sha) => sha.toLowerCase());
  if (normalized.length === 0 || normalized.some((sha) => !SHA_RE.test(sha))) return null;
  return [...new Set(normalized)].sort();
}

async function readChildWorkspace(db: Db, companyId: string, issueId: string) {
  const [issue] = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      status: issues.status,
      executionWorkspaceId: issues.executionWorkspaceId,
      executionState: issues.executionState,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
    .limit(1);
  if (!issue?.executionWorkspaceId) return null;
  const [workspace] = await db
    .select({
      branchName: executionWorkspaces.branchName,
      sourceIssueId: executionWorkspaces.sourceIssueId,
      repoUrl: executionWorkspaces.repoUrl,
    })
    .from(executionWorkspaces)
    .where(and(
      eq(executionWorkspaces.id, issue.executionWorkspaceId),
      eq(executionWorkspaces.companyId, companyId),
    ))
    .limit(1);
  if (!workspace?.branchName || !workspace.repoUrl) return null;
  const source = workspace.sourceIssueId?.trim() ?? "";
  if (source && source !== issueId) return null;
  const repo = parseRepoUrl(workspace.repoUrl);
  if (!repo) return null;
  return { issue, branch: workspace.branchName, repo };
}

function readClaim(executionState: unknown): { prNumber: number; headSha: string | null } | null {
  if (!executionState || typeof executionState !== "object" || Array.isArray(executionState)) return null;
  const claim = (executionState as Record<string, unknown>).childCarrierClaim;
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) return null;
  const record = claim as Record<string, unknown>;
  const prNumber = record.prNumber;
  if (typeof prNumber !== "number" || !Number.isInteger(prNumber) || prNumber <= 0) return null;
  const headSha = typeof record.headSha === "string" && SHA_RE.test(record.headSha.toLowerCase())
    ? record.headSha.toLowerCase()
    : null;
  return { prNumber, headSha };
}

function readBindingPr(executionState: unknown, cardBranch: string): { prNumber: number } | null {
  if (!executionState || typeof executionState !== "object" || Array.isArray(executionState)) return null;
  const delivery = (executionState as Record<string, unknown>).delivery;
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) return null;
  const record = delivery as Record<string, unknown>;
  const branch = typeof record.branch === "string" ? record.branch : null;
  const prNumber = record.prNumber;
  if (!branch || branch === cardBranch) return null;
  return typeof prNumber === "number" && Number.isInteger(prNumber) && prNumber > 0 ? { prNumber } : null;
}

async function fetchLivePullRequest(
  db: Db,
  companyId: string,
  owner: string,
  repo: string,
  number: number,
): Promise<{ ok: true; live: ChildCarrierLivePullRequest } | { ok: false; reason: string }> {
  const candidates = await resolveGitHubTokenCandidatesForRepo(db, companyId, owner, repo);
  if (candidates.length === 0) return { ok: false, reason: "child carrier pull request cannot be verified without a GitHub token" };
  let last = "child carrier pull request open-state verification failed";
  for (const candidate of candidates) {
    const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
    let response: Response;
    try {
      response = await ghFetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${candidate.token}`,
          "user-agent": "paperclip-child-carrier-attribution",
          "x-github-api-version": "2022-11-28",
        },
      });
    } catch {
      last = "child carrier pull request open-state verification failed: network_error";
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      last = `child carrier pull request open-state verification failed: HTTP ${response.status}`;
      continue;
    }
    if (!response.ok) return { ok: false, reason: `child carrier pull request open-state verification failed: HTTP ${response.status}` };
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const head = body?.head as Record<string, unknown> | undefined;
    const headRepo = head?.repo as Record<string, unknown> | undefined;
    const base = body?.base as Record<string, unknown> | undefined;
    return {
      ok: true,
      live: {
        owner,
        repo,
        number,
        headRef: typeof head?.ref === "string" ? head.ref : null,
        headSha: typeof head?.sha === "string" ? head.sha.toLowerCase() : null,
        state: typeof body?.state === "string" ? body.state : null,
        draft: typeof body?.draft === "boolean" ? body.draft : null,
        merged: typeof body?.merged === "boolean" ? body.merged : null,
        headRepoFullName: typeof headRepo?.full_name === "string" ? headRepo.full_name : null,
        baseRef: typeof base?.ref === "string" ? base.ref : null,
      },
    };
  }
  return { ok: false, reason: last };
}

async function enumerateChildCarrierCommits(input: {
  token: string;
  owner: string;
  repo: string;
  pullRequestNumber: number;
  headSha: string;
  baseRef: string | null;
  childBranch: string;
}): Promise<{ ok: true; shas: string[] } | { ok: false; reason: string }> {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${input.token}`,
    "user-agent": "paperclip-child-carrier-attribution",
    "x-github-api-version": "2022-11-28",
  };
  const prShas: string[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.pullRequestNumber}/commits?per_page=100&page=${page}`;
    let response: Response;
    try {
      response = await ghFetch(url, { headers });
    } catch {
      return { ok: false, reason: "child carrier commit enumeration failed: network_error" };
    }
    if (!response.ok) return { ok: false, reason: `child carrier commit enumeration failed: HTTP ${response.status}` };
    const body = await response.json().catch(() => null);
    if (!Array.isArray(body)) return { ok: false, reason: "child carrier commit enumeration returned an unreadable list" };
    for (const row of body) {
      const sha = (row as { sha?: unknown }).sha;
      if (typeof sha !== "string" || !SHA_RE.test(sha.toLowerCase())) {
        return { ok: false, reason: "child carrier commit enumeration returned a non-sha" };
      }
      prShas.push(sha.toLowerCase());
    }
    const link = response.headers?.get?.("link") ?? "";
    const hasNext = /<[^>]+>;\s*rel="next"/i.test(link);
    if (body.length < 100 && hasNext) {
      return { ok: false, reason: "child carrier commit enumeration is incomplete" };
    }
    if (body.length < 100) break;
    if (page === 20) return { ok: false, reason: "child carrier commit enumeration is incomplete" };
  }
  if (prShas.at(-1) !== input.headSha) {
    return { ok: false, reason: "child carrier head is not the tip of the enumerated pull request commits" };
  }
  if (!input.baseRef) return { ok: false, reason: "child carrier commit enumeration has no base branch" };
  const compareUrl = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/compare/${encodeURIComponent(input.baseRef)}...${encodeURIComponent(input.childBranch)}`;
  let compare: Response;
  try {
    compare = await ghFetch(compareUrl, { headers });
  } catch {
    return { ok: false, reason: "child branch commit enumeration failed: network_error" };
  }
  if (!compare.ok) return { ok: false, reason: `child branch commit enumeration failed: HTTP ${compare.status}` };
  const compareLink = compare.headers?.get?.("link") ?? "";
  if (/<[^>]+>;\s*rel="next"/i.test(compareLink)) {
    return { ok: false, reason: "child branch commit enumeration is incomplete" };
  }
  const compared = await compare.json().catch(() => null) as {
    total_commits?: unknown;
    commits?: Array<{ sha?: unknown }>;
  } | null;
  if (!compared || !Array.isArray(compared.commits) || typeof compared.total_commits !== "number") {
    return { ok: false, reason: "child branch commit enumeration is incomplete" };
  }
  if (compared.total_commits !== compared.commits.length) {
    return { ok: false, reason: "child branch commit enumeration is incomplete" };
  }
  const childShas = new Set<string>();
  for (const row of compared.commits) {
    if (typeof row.sha !== "string" || !SHA_RE.test(row.sha.toLowerCase())) {
      return { ok: false, reason: "child branch commit enumeration returned a non-sha" };
    }
    childShas.add(row.sha.toLowerCase());
  }
  const prShaSet = new Set(prShas);
  for (const sha of childShas) {
    if (!prShaSet.has(sha)) {
      return { ok: false, reason: "child carrier commit enumeration is missing a child commit" };
    }
  }
  const intersection = normalizeShas([...childShas].filter((sha) => prShaSet.has(sha)));
  if (!intersection) return { ok: true, shas: [] };
  return { ok: true, shas: intersection };

}

async function findCarrierAncestors(
  db: Db,
  companyId: string,
  childIssueId: string,
  branchName: string,
  repo: { owner: string; repo: string },
): Promise<string[]> {
  const rows = await db
    .select({
      sourceIssueId: executionWorkspaces.sourceIssueId,
      repoUrl: executionWorkspaces.repoUrl,
    })
    .from(executionWorkspaces)
    .where(and(
      eq(executionWorkspaces.companyId, companyId),
      eq(executionWorkspaces.branchName, branchName),
    ));
  const ancestors: string[] = [];
  for (const row of rows) {
    const source = row.sourceIssueId?.trim() ?? "";
    const candidateRepo = parseRepoUrl(row.repoUrl);
    if (
      !source
      || source === childIssueId
      || !candidateRepo
      || candidateRepo.owner.toLowerCase() !== repo.owner.toLowerCase()
      || candidateRepo.repo.toLowerCase() !== repo.repo.toLowerCase()
    ) continue;
    const [owner] = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.id, source)))
      .limit(1);
    if (!owner || owner.status === "cancelled") continue;
    const [owned] = await db
      .select({
        sourceIssueId: executionWorkspaces.sourceIssueId,
        repoUrl: executionWorkspaces.repoUrl,
        branchName: executionWorkspaces.branchName,
      })
      .from(executionWorkspaces)
      .innerJoin(issues, eq(issues.executionWorkspaceId, executionWorkspaces.id))
      .where(and(eq(issues.id, source), eq(issues.companyId, companyId)))
      .limit(1);
    const ownedRepo = parseRepoUrl(owned?.repoUrl ?? null);
    const ownedSource = owned?.sourceIssueId?.trim() ?? "";
    if (!owned || owned.sourceIssueId === undefined || !ownedRepo || owned.branchName !== branchName) continue;
    if (
      ownedRepo.owner.toLowerCase() !== repo.owner.toLowerCase()
      || ownedRepo.repo.toLowerCase() !== repo.repo.toLowerCase()
    ) continue;
    if (ownedSource && ownedSource !== source) continue;
    if (!(await isStrictAncestorIssueIdOf(db, companyId, childIssueId, source))) continue;
    if (!ancestors.includes(source)) ancestors.push(source);
  }
  return ancestors;
}

async function readCurrent(db: Db, companyId: string, childIssueId: string) {
  const [row] = await db
    .select()
    .from(issueChildCarrierAttributions)
    .where(and(
      eq(issueChildCarrierAttributions.companyId, companyId),
      eq(issueChildCarrierAttributions.childIssueId, childIssueId),
      eq(issueChildCarrierAttributions.state, "current"),
    ))
    .limit(1);
  return row ?? null;
}

async function writeCurrent(
  db: Db,
  input: {
    companyId: string;
    childIssueId: string;
    ancestorIssueId: string;
    owner: string;
    repo: string;
    pullRequestNumber: number;
    branchName: string;
    headSha: string;
    commitShas: string[];
  },
) {
  const now = new Date();
  await db
    .update(issueChildCarrierAttributions)
    .set({ state: "invalidated", invalidatedAt: now, updatedAt: now })
    .where(and(
      eq(issueChildCarrierAttributions.companyId, input.companyId),
      eq(issueChildCarrierAttributions.childIssueId, input.childIssueId),
      eq(issueChildCarrierAttributions.state, "current"),
      sql`${issueChildCarrierAttributions.headSha} <> ${input.headSha}`,
    ));
  const existing = await readCurrent(db, input.companyId, input.childIssueId);
  if (existing && existing.headSha === input.headSha && existing.pullRequestNumber === input.pullRequestNumber) {
    await db
      .update(issueChildCarrierAttributions)
      .set({
        ancestorIssueId: input.ancestorIssueId,
        owner: input.owner,
        repo: input.repo,
        branchName: input.branchName,
        commitShas: input.commitShas,
        ...(normalizeShas(existing.commitShas)?.join() === normalizeShas(input.commitShas)?.join()
          && existing.branchName === input.branchName
          && existing.ancestorIssueId === input.ancestorIssueId
          ? {}
          : { childDecisionId: null }),
        provenance: { source: "control-plane-verification", headSha: input.headSha },
        updatedAt: now,
      })
      .where(eq(issueChildCarrierAttributions.id, existing.id));
    return existing.id;
  }
  const [sameHead] = await db
    .select({
      id: issueChildCarrierAttributions.id,
      commitShas: issueChildCarrierAttributions.commitShas,
      branchName: issueChildCarrierAttributions.branchName,
      ancestorIssueId: issueChildCarrierAttributions.ancestorIssueId,
    })
    .from(issueChildCarrierAttributions)
    .where(and(
      eq(issueChildCarrierAttributions.companyId, input.companyId),
      eq(issueChildCarrierAttributions.childIssueId, input.childIssueId),
      eq(issueChildCarrierAttributions.pullRequestNumber, input.pullRequestNumber),
      eq(issueChildCarrierAttributions.headSha, input.headSha),
    ))
    .limit(1);
  if (sameHead) {
    await db
      .update(issueChildCarrierAttributions)
      .set({
        state: "current",
        invalidatedAt: null,
        ancestorIssueId: input.ancestorIssueId,
        owner: input.owner,
        repo: input.repo,
        branchName: input.branchName,
        commitShas: input.commitShas,
        ...(normalizeShas(sameHead.commitShas)?.join() === normalizeShas(input.commitShas)?.join()
          && sameHead.branchName === input.branchName
          && sameHead.ancestorIssueId === input.ancestorIssueId
          ? {}
          : { childDecisionId: null }),
        writtenByActorType: "system",
        writtenByActorId: CHILD_CARRIER_ATTRIBUTION_ACTOR_ID,
        provenance: { source: "control-plane-verification", headSha: input.headSha },
        updatedAt: now,
      })
      .where(eq(issueChildCarrierAttributions.id, sameHead.id));
    return sameHead.id;
  }

  try {
    const [inserted] = await db
      .insert(issueChildCarrierAttributions)
      .values({
        companyId: input.companyId,
        childIssueId: input.childIssueId,
        ancestorIssueId: input.ancestorIssueId,
        provider: "github",
        owner: input.owner.toLowerCase(),
        repo: input.repo.toLowerCase(),
        pullRequestNumber: input.pullRequestNumber,
        branchName: input.branchName,
        headSha: input.headSha,
        commitShas: input.commitShas,
        state: "current",
        writtenByActorType: "system",
        writtenByActorId: CHILD_CARRIER_ATTRIBUTION_ACTOR_ID,
        provenance: { source: "control-plane-verification", headSha: input.headSha },
      })
      .returning({ id: issueChildCarrierAttributions.id });
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "system",
      actorId: CHILD_CARRIER_ATTRIBUTION_ACTOR_ID,
      action: "issue.child_carrier_attribution_recorded",
      entityType: "issue_child_carrier_attribution",
      entityId: inserted!.id,
      issueId: input.childIssueId,
      details: {
        ancestorIssueId: input.ancestorIssueId,
        pullRequestNumber: input.pullRequestNumber,
        headSha: input.headSha,
        commitCount: input.commitShas.length,
      },
    });
    return inserted!.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const winner = await readCurrent(db, input.companyId, input.childIssueId);
    if (
      winner
      && winner.headSha === input.headSha
      && winner.pullRequestNumber === input.pullRequestNumber
      && winner.owner === input.owner.toLowerCase()
      && winner.repo === input.repo.toLowerCase()
      && winner.branchName === input.branchName
      && normalizeShas(winner.commitShas)?.join() === normalizeShas(input.commitShas)?.join()
    ) {
      return winner.id;
    }
    throw new Error("child_carrier_proof_conflict");
  }
}

async function enumerateWithCredentials(input: {
  db: Db;
  companyId: string;
  owner: string;
  repo: string;
  pullRequestNumber: number;
  headSha: string;
  baseRef: string | null;
  childBranch: string;
}): Promise<{ ok: true; shas: string[] } | { ok: false; reason: string }> {
  const candidates = await resolveGitHubTokenCandidatesForRepo(input.db, input.companyId, input.owner, input.repo);
  if (candidates.length === 0) {
    return { ok: false, reason: "child carrier commit enumeration has no GitHub token" };
  }
  let last = "child carrier commit enumeration failed";
  for (const candidate of candidates) {
    const enumerated = await childCarrierCommits.enumerate({
      token: candidate.token,
      owner: input.owner,
      repo: input.repo,
      pullRequestNumber: input.pullRequestNumber,
      headSha: input.headSha,
      baseRef: input.baseRef,
      childBranch: input.childBranch,
    });
    if (enumerated.ok || !/HTTP 401|HTTP 403/.test(enumerated.reason)) return enumerated;
    last = enumerated.reason;
  }
  return { ok: false, reason: last };
}

export async function resolveChildCarrierDecisionHead(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<ChildCarrierResolution> {
  const card = await readChildWorkspace(db, companyId, issueId);
  if (!card) return { kind: "absent" };
  const claim = readClaim(card.issue.executionState) ?? readBindingPr(card.issue.executionState, card.branch);
  if (!claim) return { kind: "absent" };
  const liveResult = await fetchLivePullRequest(db, companyId, card.repo.owner, card.repo.repo, claim.prNumber);
  if (!liveResult.ok) return { kind: "unresolvable", reason: `delivery_identity_unresolved: ${liveResult.reason}` };
  const live = liveResult.live;
  if (live.headRepoFullName && live.headRepoFullName.toLowerCase() !== `${card.repo.owner}/${card.repo.repo}`.toLowerCase()) {
    return { kind: "absent" };
  }
  if (!live.headRef || live.headRef === card.branch) return { kind: "absent" };
  const ancestors = await findCarrierAncestors(db, companyId, issueId, live.headRef, card.repo);
  if (ancestors.length === 0) return { kind: "absent" };
  if (ancestors.length !== 1) {
    return { kind: "unresolvable", reason: "delivery_identity_unresolved: multiple ancestor carrier candidates; refusing child attribution" };
  }
  if (live.draft === true) return { kind: "unresolvable", reason: "head_draft: recorded child carrier pull request is a draft" };
  if (live.merged === true || live.state !== "open") {
    return { kind: "unresolvable", reason: "head_not_open: recorded child carrier pull request is not an open unmerged pull request" };
  }
  if (!live.headSha || !SHA_RE.test(live.headSha)) {
    return { kind: "unresolvable", reason: "head_unverifiable: recorded child carrier pull request has no readable head" };
  }
  const current = await readCurrent(db, companyId, issueId);
  const claimedHead = "headSha" in claim ? claim.headSha : null;
  if (claimedHead && claimedHead !== live.headSha) {
    if (current) {
      await db
        .update(issueChildCarrierAttributions)
        .set({ state: "invalidated", invalidatedAt: new Date(), updatedAt: new Date() })
        .where(eq(issueChildCarrierAttributions.id, current.id));
    }
    return { kind: "unresolvable", reason: `head_moved: child carrier head moved to ${live.headSha.slice(0, 7)}; review the new head` };
  }
  if (current && current.headSha !== live.headSha) {
    await db
      .update(issueChildCarrierAttributions)
      .set({ state: "invalidated", invalidatedAt: new Date(), updatedAt: new Date() })
      .where(eq(issueChildCarrierAttributions.id, current.id));
    return { kind: "unresolvable", reason: `head_moved: child carrier head moved to ${live.headSha.slice(0, 7)}; review the new head` };
  }
  const enumerated = await enumerateWithCredentials({
    db,
    companyId,
    owner: card.repo.owner,
    repo: card.repo.repo,
    pullRequestNumber: claim.prNumber,
    headSha: live.headSha,
    baseRef: live.baseRef,
    childBranch: card.branch,
  });
  if (!enumerated.ok) return { kind: "unresolvable", reason: `delivery_identity_unresolved: ${enumerated.reason}` };
  const shas = normalizeShas(enumerated.shas);
  if (!shas) return { kind: "unresolvable", reason: "delivery_identity_unresolved: child carrier commit enumeration is empty" };
  if (current) {
    const stored = normalizeShas(current.commitShas) ?? [];
    if (stored.join() !== shas.join() || current.branchName !== live.headRef || current.pullRequestNumber !== claim.prNumber) {
      await db
        .update(issueChildCarrierAttributions)
        .set({ state: "invalidated", invalidatedAt: new Date(), updatedAt: new Date() })
        .where(eq(issueChildCarrierAttributions.id, current.id));
      return { kind: "unresolvable", reason: "delivery_identity_unresolved: child carrier commit enumeration is missing or extra" };
    }
  }
  try {
    await writeCurrent(db, {
      companyId,
      childIssueId: issueId,
      ancestorIssueId: ancestors[0]!,
      owner: card.repo.owner.toLowerCase(),
      repo: card.repo.repo.toLowerCase(),
      pullRequestNumber: claim.prNumber,
      branchName: live.headRef,
      headSha: live.headSha,
      commitShas: shas,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "child_carrier_proof_conflict") {
      return { kind: "unresolvable", reason: "delivery_identity_unresolved: child carrier proof conflict" };
    }
    throw error;
  }
  return {
    kind: "resolved",
    headSha: live.headSha,
    displayName: `${card.repo.owner}/${card.repo.repo}#${claim.prNumber}`,
    pr: { owner: card.repo.owner, repo: card.repo.repo, number: claim.prNumber },
    childCarrierAttribution: true,
  };
}

export async function childCarrierMustNotPublish(
  db: Db,
  companyId: string,
  issueId: string,
  pr: { owner: string; repo: string; number: number },
): Promise<string | null> {
  const current = await readCurrent(db, companyId, issueId);
  if (!current) return null;
  if (
    current.owner === pr.owner.toLowerCase()
    && current.repo === pr.repo.toLowerCase()
    && current.pullRequestNumber === pr.number
  ) {
    return CHILD_CARRIER_STAMP_SKIP;
  }
  return null;
}
export async function classifyAncestorCarrierHead(
  db: Db,
  companyId: string,
  issueId: string,
  headRef: string,
): Promise<"absent" | "one" | "many"> {
  const card = await readChildWorkspace(db, companyId, issueId);
  if (!card || card.branch === headRef) return "absent";
  const ancestors = await findCarrierAncestors(db, companyId, issueId, headRef, card.repo);
  if (ancestors.length === 0) return "absent";
  return ancestors.length === 1 ? "one" : "many";
}

export async function childCarrierAttributionMatches(
  db: Db,
  companyId: string,
  issueId: string,
  pr: { owner: string; repo: string; number: number; headRefName: string | null },
): Promise<boolean> {
  const current = await readCurrent(db, companyId, issueId);
  if (!current || !pr.headRefName) return false;
  return current.owner === pr.owner.toLowerCase()
    && current.repo === pr.repo.toLowerCase()
    && current.pullRequestNumber === pr.number
    && current.branchName === pr.headRefName;
}


export async function recordChildCarrierDecision(db: Db, companyId: string, issueId: string): Promise<void> {
  const [issue] = await db
    .select({ executionState: issues.executionState })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
    .limit(1);
  const state = issue?.executionState as Record<string, unknown> | null | undefined;
  const decisionId = typeof state?.lastDecisionId === "string" ? state.lastDecisionId : null;
  if (!decisionId || state?.lastDecisionOutcome !== "approved") return;
  const current = await readCurrent(db, companyId, issueId);
  if (!current || current.childDecisionId) return;
  const [decision] = await db
    .select({ id: issueExecutionDecisions.id, outcome: issueExecutionDecisions.outcome })
    .from(issueExecutionDecisions)
    .where(and(
      eq(issueExecutionDecisions.id, decisionId),
      eq(issueExecutionDecisions.companyId, companyId),
      eq(issueExecutionDecisions.issueId, issueId),
    ))
    .limit(1);
  if (!decision || decision.outcome !== "approved") return;
  const claim = readClaim(state);
  if (!claim || claim.prNumber !== current.pullRequestNumber || claim.headSha !== current.headSha) return;
  await db
    .update(issueChildCarrierAttributions)
    .set({ childDecisionId: decision.id, updatedAt: new Date() })
    .where(and(
      eq(issueChildCarrierAttributions.id, current.id),
      eq(issueChildCarrierAttributions.state, "current"),
    ));
}

async function descendantIds(db: Db, companyId: string, ownerIssueId: string): Promise<Array<{ id: string; status: string }>> {
  const result = await db.execute(sql`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM issues WHERE parent_id = ${ownerIssueId} AND company_id = ${companyId}
      UNION
      SELECT i.id FROM issues i
      JOIN descendants d ON i.parent_id = d.id
      WHERE i.company_id = ${companyId}
    )
    SELECT id, status FROM issues
    WHERE company_id = ${companyId} AND id IN (SELECT id FROM descendants) AND status <> 'cancelled'
  `);
  const rows: unknown[] = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  return rows.flatMap((row) => {
    const record = row as { id?: unknown; status?: unknown };
    return typeof record.id === "string" && typeof record.status === "string"
      ? [{ id: record.id, status: record.status }]
      : [];
  });
}

export async function carrierOwnerChildAttributionBlock(
  db: Db,
  companyId: string,
  ownerIssueId: string,
  pr: { owner: string; repo: string; number: number; headSha?: string | null; headRef?: string | null },
): Promise<string | null> {
  const owner = await readChildWorkspace(db, companyId, ownerIssueId);
  if (!owner) return null;
  if (pr.headRef && pr.headRef.toLowerCase() !== owner.branch.toLowerCase()) return null;
  if (pr.owner.toLowerCase() !== owner.repo.owner.toLowerCase() || pr.repo.toLowerCase() !== owner.repo.repo.toLowerCase()) {
    return null;
  }
  const descendants = await descendantIds(db, companyId, ownerIssueId);
  const attributions = await db
    .select()
    .from(issueChildCarrierAttributions)
    .where(and(
      eq(issueChildCarrierAttributions.companyId, companyId),
      eq(issueChildCarrierAttributions.ancestorIssueId, ownerIssueId),
      eq(issueChildCarrierAttributions.pullRequestNumber, pr.number),
      eq(issueChildCarrierAttributions.state, "current"),
    ));
  if (descendants.length === 0) return null;
  const live = await fetchLivePullRequest(db, companyId, owner.repo.owner, owner.repo.repo, pr.number);
  if (!live.ok) return CHILD_CARRIER_OWNER_GATE_SKIP;
  if (pr.headSha && live.live.headSha && pr.headSha.toLowerCase() !== live.live.headSha) {
    return CHILD_CARRIER_OWNER_GATE_SKIP;
  }
  const headSha = live.live.headSha;
  if (!headSha) return CHILD_CARRIER_OWNER_GATE_SKIP;
  const required = new Map<string, string[]>();
  for (const descendant of descendants) {
    const card = await readChildWorkspace(db, companyId, descendant.id);
    if (!card) continue;
    if (
      card.repo.owner.toLowerCase() !== owner.repo.owner.toLowerCase()
      || card.repo.repo.toLowerCase() !== owner.repo.repo.toLowerCase()
    ) continue;
    const enumerated = await enumerateWithCredentials({
      db,
      companyId,
      owner: owner.repo.owner,
      repo: owner.repo.repo,
      pullRequestNumber: pr.number,
      headSha,
      baseRef: live.live.baseRef,
      childBranch: card.branch,
    });
    if (!enumerated.ok) return CHILD_CARRIER_OWNER_GATE_SKIP;
    const shas = normalizeShas(enumerated.shas);
    if (!shas) continue;
    required.set(descendant.id, shas);
  }
  if (required.size === 0) return null;
  for (const [childId, shas] of required) {
    const row = attributions.find((item) => item.childIssueId === childId);
    const stored = row ? normalizeShas(row.commitShas) : null;
    if (!row || !stored || stored.join() !== shas.join()) return CHILD_CARRIER_OWNER_GATE_SKIP;
    if (row.owner !== pr.owner.toLowerCase() || row.repo !== pr.repo.toLowerCase()) return CHILD_CARRIER_OWNER_GATE_SKIP;
    if (row.headSha !== headSha) return CHILD_CARRIER_OWNER_GATE_SKIP;
    if (pr.headRef && row.branchName.toLowerCase() !== pr.headRef.toLowerCase()) return CHILD_CARRIER_OWNER_GATE_SKIP;
    if (!row.childDecisionId) return CHILD_CARRIER_OWNER_GATE_SKIP;
    const [childIssue] = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(and(eq(issues.id, childId), eq(issues.companyId, companyId)))
      .limit(1);
    const claim = readClaim(childIssue?.executionState);
    if (!claim || claim.prNumber !== row.pullRequestNumber || (claim.headSha !== null && claim.headSha !== row.headSha)) {
      return CHILD_CARRIER_OWNER_GATE_SKIP;
    }
    const [latest] = await db
      .select({ outcome: issueExecutionDecisions.outcome })
      .from(issueExecutionDecisions)
      .where(and(
        eq(issueExecutionDecisions.issueId, childId),
        eq(issueExecutionDecisions.companyId, companyId),
      ))
      .orderBy(desc(issueExecutionDecisions.createdAt))
      .limit(1);
    if (!latest || latest.outcome !== "approved") return CHILD_CARRIER_OWNER_GATE_SKIP;
    const [decision] = await db
      .select({ outcome: issueExecutionDecisions.outcome })
      .from(issueExecutionDecisions)
      .where(and(
        eq(issueExecutionDecisions.id, row.childDecisionId),
        eq(issueExecutionDecisions.issueId, childId),
        eq(issueExecutionDecisions.companyId, companyId),
      ))
      .limit(1);
    if (!decision || decision.outcome !== "approved") return CHILD_CARRIER_OWNER_GATE_SKIP;
  }
  return null;
}

export async function childCarrierStampBlock(
  db: Db,
  companyId: string,
  pr: { owner: string; repo: string; number: number; headSha?: string | null; headRef?: string | null },
  issueId?: string,
): Promise<string | null> {
  if (issueId) {
    const childSkip = await childCarrierMustNotPublish(db, companyId, issueId, pr);
    if (childSkip) return childSkip;
    const ownerSkip = await carrierOwnerChildAttributionBlock(db, companyId, issueId, pr);
    if (ownerSkip) return ownerSkip;
  }
  const rows = await db
    .select({
      ancestorIssueId: issueChildCarrierAttributions.ancestorIssueId,
      childIssueId: issueChildCarrierAttributions.childIssueId,
    })
    .from(issueChildCarrierAttributions)
    .where(and(
      eq(issueChildCarrierAttributions.companyId, companyId),
      eq(issueChildCarrierAttributions.owner, pr.owner.toLowerCase()),
      eq(issueChildCarrierAttributions.repo, pr.repo.toLowerCase()),
      eq(issueChildCarrierAttributions.pullRequestNumber, pr.number),
      eq(issueChildCarrierAttributions.state, "current"),
    ));
  for (const row of rows) {
    if (row.ancestorIssueId !== issueId) {
      const ownerSkip = await carrierOwnerChildAttributionBlock(db, companyId, row.ancestorIssueId, pr);
      if (ownerSkip) return ownerSkip;
    }
    if (row.childIssueId !== issueId) {
      const childSkip = await childCarrierMustNotPublish(db, companyId, row.childIssueId, pr);
      if (childSkip) return childSkip;
    }
  }
  return null;
}

export async function carrierArmBlock(
  db: Db,
  companyId: string,
  issueId: string,
  pr: { owner: string; repo: string; number: number; headSha?: string | null; headRef?: string | null } | null,
): Promise<string | null> {
  if (pr) return childCarrierStampBlock(db, companyId, pr, issueId);
  if (await readCurrent(db, companyId, issueId)) return CHILD_CARRIER_STAMP_SKIP;
  return null;
}
