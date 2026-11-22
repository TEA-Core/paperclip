import { isUniqueViolation } from "../db-errors.js";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
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
  try {
    const url = new URL(repoUrl.replace(/^git@([^:]+):/, "ssh://git@$1/"));
    if (url.hostname.toLowerCase() !== "github.com" || !["https:", "ssh:"].includes(url.protocol)
      || url.search || url.hash || (url.port && !(url.protocol === "ssh:" && url.port === "22"))) return null;
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
    if (!match || [match[1], match[2]].some((part) => !part || part === "." || part === "..")) return null;
    return { owner: match[1]!, repo: match[2]! };
  } catch {
    return null;
  }
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

function readBindingPr(executionState: unknown, cardBranch: string): { prNumber: number; headSha: string | null; branch: string } | null {
  if (!executionState || typeof executionState !== "object" || Array.isArray(executionState)) return null;
  const delivery = (executionState as Record<string, unknown>).delivery;
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) return null;
  const record = delivery as Record<string, unknown>;
  const branch = typeof record.branch === "string" ? record.branch : null;
  const prNumber = record.prNumber;
  if (!branch || branch === cardBranch) return null;
  const headSha = typeof record.headSha === "string" && SHA_RE.test(record.headSha.toLowerCase())
    ? record.headSha.toLowerCase()
    : null;
  return typeof prNumber === "number" && Number.isInteger(prNumber) && prNumber > 0 ? { prNumber, headSha, branch } : null;
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
        signal: AbortSignal.timeout(8_000),
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
  // The PR-commits endpoint stops at 250 in total. Large comparisons instead
  // page between immutable commits, never between refs that can move mid-read.
  let baseSha: string | null = null;
  const completeComparison = async (headRef: string): Promise<{ ok: true; shas: string[] } | { ok: false; reason: string }> => {
    const root = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
    try {
      if (!baseSha) {
        const response = await ghFetch(`${root}/commits/${encodeURIComponent(input.baseRef!)}`, { headers, signal: AbortSignal.timeout(8_000) });
        const body = response.ok ? await response.json().catch(() => null) : null;
        if (typeof body?.sha !== "string" || !SHA_RE.test(body.sha)) return { ok: false, reason: "child carrier comparison has no immutable base" };
        baseSha = body.sha.toLowerCase();
      }
      let headSha = headRef.toLowerCase();
      if (!SHA_RE.test(headSha)) {
        const response = await ghFetch(`${root}/commits/${encodeURIComponent(headRef)}`, { headers, signal: AbortSignal.timeout(8_000) });
        const body = response.ok ? await response.json().catch(() => null) : null;
        if (typeof body?.sha !== "string" || !SHA_RE.test(body.sha)) return { ok: false, reason: "child carrier comparison has no immutable head" };
        headSha = body.sha.toLowerCase();
      }
      const shas: string[] = [];
      const seen = new Set<string>();
      let total: number | undefined;
      for (let page = 1; page <= 20; page += 1) {
        const response = await ghFetch(`${root}/compare/${baseSha}...${headSha}?per_page=100&page=${page}`, { headers, signal: AbortSignal.timeout(8_000) });
        const body = response.ok ? await response.json().catch(() => null) as {
          total_commits?: number; base_commit?: { sha?: string }; commits?: Array<{ sha?: string }>;
        } | null : null;
        if (!body || !Array.isArray(body.commits) || !Number.isInteger(body.total_commits)
          || body.total_commits! < 0 || body.total_commits! > 2_000
          || body.base_commit?.sha?.toLowerCase() !== baseSha
          || (total !== undefined && body.total_commits !== total)) {
          return { ok: false, reason: "child carrier comparison is incomplete" };
        }
        total = body.total_commits!;
        if (body.commits.length !== Math.min(100, total - shas.length)) {
          return { ok: false, reason: "child carrier comparison is incomplete" };
        }
        for (const row of body.commits) {
          if (typeof row.sha !== "string" || !SHA_RE.test(row.sha) || seen.has(row.sha.toLowerCase())) {
            return { ok: false, reason: "child carrier comparison is incomplete" };
          }
          const sha = row.sha.toLowerCase();
          shas.push(sha);
          seen.add(sha);
        }
        if (shas.length === total) {
          const next = /<[^>]+>;\s*rel="next"/i.test(response.headers?.get?.("link") ?? "");
          if (next || (total > 0 && shas.at(-1) !== headSha)) return { ok: false, reason: "child carrier comparison is incomplete" };
          return { ok: true, shas };
        }
      }
    } catch {
      return { ok: false, reason: "child carrier comparison failed: network_error" };
    }
    return { ok: false, reason: "child carrier comparison is incomplete" };
  };
  let prShas: string[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.pullRequestNumber}/commits?per_page=100&page=${page}`;
    let response: Response;
    try {
      response = await ghFetch(url, { headers, signal: AbortSignal.timeout(8_000) });
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
  if (!input.baseRef) return { ok: false, reason: "child carrier commit enumeration has no base branch" };
  if (prShas.at(-1) !== input.headSha && prShas.length === 250) {
    const complete = await completeComparison(input.headSha);
    if (!complete.ok) return complete;
    prShas = complete.shas;
  }
  if (prShas.at(-1) !== input.headSha) {
    return { ok: false, reason: "child carrier head is not the tip of the enumerated pull request commits" };
  }
  const compareUrl = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/compare/${encodeURIComponent(input.baseRef)}...${encodeURIComponent(input.childBranch)}`;
  let compare: Response;
  try {
    compare = await ghFetch(compareUrl, { headers, signal: AbortSignal.timeout(8_000) });
  } catch {
    return { ok: false, reason: "child branch commit enumeration failed: network_error" };
  }
  if (!compare.ok) return { ok: false, reason: `child branch commit enumeration failed: HTTP ${compare.status}` };
  const compareLink = compare.headers?.get?.("link") ?? "";
  const compared = await compare.json().catch(() => null) as {
    total_commits?: unknown;
    commits?: Array<{ sha?: unknown }>;
  } | null;
  if (!compared || !Array.isArray(compared.commits) || typeof compared.total_commits !== "number") {
    return { ok: false, reason: "child branch commit enumeration is incomplete" };
  }
  let childShas: Set<string>;
  if (compared.total_commits > 250) {
    const complete = await completeComparison(input.childBranch);
    if (!complete.ok) return complete;
    childShas = new Set(complete.shas);
  } else {
    if (compared.total_commits !== compared.commits.length || /<[^>]+>;\s*rel="next"/i.test(compareLink)) {
      return { ok: false, reason: "child branch commit enumeration is incomplete" };
    }
    childShas = new Set<string>();
    for (const row of compared.commits) {
      if (typeof row.sha !== "string" || !SHA_RE.test(row.sha.toLowerCase())) {
        return { ok: false, reason: "child branch commit enumeration returned a non-sha" };
      }
      childShas.add(row.sha.toLowerCase());
    }
  }
  const prShaSet = new Set(prShas);
  const intersection = normalizeShas([...childShas].filter((sha) => prShaSet.has(sha)));
  // A complete disjoint branch is not a contributor. A partial contribution is
  // still incomplete proof and must not be confused with that empty result.
  if (!intersection) return { ok: true, shas: [] };
  for (const sha of childShas) {
    if (!prShaSet.has(sha)) {
      return { ok: false, reason: "child carrier commit enumeration is missing a child commit" };
    }
  }
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

type ChildCarrierAttribution = typeof issueChildCarrierAttributions.$inferSelect;
type VerifiedChildCarrierProof = Pick<ChildCarrierAttribution,
  "companyId" | "childIssueId" | "ancestorIssueId" | "owner" | "repo" | "pullRequestNumber" | "branchName" | "headSha" | "commitShas">;

function sameVerifiedProof(row: ChildCarrierAttribution, proof: VerifiedChildCarrierProof): boolean {
  return row.companyId === proof.companyId && row.childIssueId === proof.childIssueId
    && row.ancestorIssueId === proof.ancestorIssueId && row.provider === "github"
    && row.owner === proof.owner.toLowerCase() && row.repo === proof.repo.toLowerCase()
    && row.pullRequestNumber === proof.pullRequestNumber && row.branchName === proof.branchName
    && row.headSha === proof.headSha && normalizeShas(row.commitShas)?.join() === normalizeShas(proof.commitShas)?.join();
}

function attributionSnapshot(row: ChildCarrierAttribution) {
  return and(
    eq(issueChildCarrierAttributions.id, row.id),
    eq(issueChildCarrierAttributions.companyId, row.companyId),
    eq(issueChildCarrierAttributions.childIssueId, row.childIssueId),
    eq(issueChildCarrierAttributions.state, row.state),
    eq(issueChildCarrierAttributions.ancestorIssueId, row.ancestorIssueId),
    eq(issueChildCarrierAttributions.provider, row.provider),
    eq(issueChildCarrierAttributions.owner, row.owner),
    eq(issueChildCarrierAttributions.repo, row.repo),
    eq(issueChildCarrierAttributions.pullRequestNumber, row.pullRequestNumber),
    eq(issueChildCarrierAttributions.branchName, row.branchName),
    eq(issueChildCarrierAttributions.headSha, row.headSha),
    eq(issueChildCarrierAttributions.commitShas, row.commitShas),
    row.childDecisionId ? eq(issueChildCarrierAttributions.childDecisionId, row.childDecisionId) : isNull(issueChildCarrierAttributions.childDecisionId),
  );
}

async function readConcurrentProof(db: Db, proof: VerifiedChildCarrierProof): Promise<string> {
  const winner = await readCurrent(db, proof.companyId, proof.childIssueId);
  if (winner && sameVerifiedProof(winner, proof)) return winner.id;
  throw new Error("child_carrier_proof_conflict");
}

async function writeCurrent(
  db: Db,
  input: VerifiedChildCarrierProof,
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
    const [refreshed] = await db
      .update(issueChildCarrierAttributions)
      .set({
        ancestorIssueId: input.ancestorIssueId,
        owner: input.owner,
        repo: input.repo,
        branchName: input.branchName,
        commitShas: input.commitShas,
        ...(sameVerifiedProof(existing, input)
          ? {}
          : { childDecisionId: null }),
        provenance: { source: "control-plane-verification", headSha: input.headSha },
        updatedAt: now,
      })
      .where(attributionSnapshot(existing))
      .returning({ id: issueChildCarrierAttributions.id });
    return refreshed?.id ?? await readConcurrentProof(db, input);
  }
  const [sameHead] = await db
    .select()
    .from(issueChildCarrierAttributions)
    .where(and(
      eq(issueChildCarrierAttributions.companyId, input.companyId),
      eq(issueChildCarrierAttributions.childIssueId, input.childIssueId),
      eq(issueChildCarrierAttributions.pullRequestNumber, input.pullRequestNumber),
      eq(issueChildCarrierAttributions.headSha, input.headSha),
    ))
    .limit(1);
  if (sameHead) {
    const [refreshed] = await db
      .update(issueChildCarrierAttributions)
      .set({
        state: "current",
        invalidatedAt: null,
        ancestorIssueId: input.ancestorIssueId,
        owner: input.owner,
        repo: input.repo,
        branchName: input.branchName,
        commitShas: input.commitShas,
        ...(sameVerifiedProof(sameHead, input)
          ? {}
          : { childDecisionId: null }),
        writtenByActorType: "system",
        writtenByActorId: CHILD_CARRIER_ATTRIBUTION_ACTOR_ID,
        provenance: { source: "control-plane-verification", headSha: input.headSha },
        updatedAt: now,
      })
      .where(attributionSnapshot(sameHead))
      .returning({ id: issueChildCarrierAttributions.id });
    return refreshed?.id ?? await readConcurrentProof(db, input);
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
    return readConcurrentProof(db, input);
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
  const binding = readBindingPr(card.issue.executionState, card.branch);
  if (binding && binding.branch !== live.headRef) {
    return { kind: "unresolvable", reason: "delivery_identity_unresolved: recorded child carrier branch does not match the live pull request branch" };
  }
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
  const card = await readChildWorkspace(db, companyId, issueId);
  if (!card) return;
  const state = card.issue.executionState as Record<string, unknown> | null | undefined;
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
  const claim = readClaim(state) ?? readBindingPr(state, card.branch);
  if (!claim || claim.prNumber !== current.pullRequestNumber || claim.headSha !== current.headSha) return;
  const approval = state?.approvalStatus as Record<string, unknown> | null | undefined;
  const certificate = approval?.finalDelivery as Record<string, unknown> | null | undefined;
  if (!certificate || certificate.decisionId !== decisionId || certificate.headSha !== current.headSha
    || certificate.number !== current.pullRequestNumber
    || typeof certificate.owner !== "string" || certificate.owner.toLowerCase() !== current.owner
    || typeof certificate.repo !== "string" || certificate.repo.toLowerCase() !== current.repo) return;
  const binding = readBindingPr(state, card.branch);
  if (binding && binding.branch !== current.branchName) return;
  await db
    .update(issueChildCarrierAttributions)
    .set({ childDecisionId: decision.id, updatedAt: new Date() })
    .where(attributionSnapshot(current));
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
  if (descendants.length === 0) return null;
  const sameRepo = [];
  for (const descendant of descendants) {
    const card = await readChildWorkspace(db, companyId, descendant.id);
    if (!card) continue;
    if (
      card.repo.owner.toLowerCase() !== owner.repo.owner.toLowerCase()
      || card.repo.repo.toLowerCase() !== owner.repo.repo.toLowerCase()
    ) continue;
    sameRepo.push({ descendant, card });
  }
  if (sameRepo.length === 0) return null;
  const live = await fetchLivePullRequest(db, companyId, owner.repo.owner, owner.repo.repo, pr.number);
  if (!live.ok) return CHILD_CARRIER_OWNER_GATE_SKIP;
  if (!live.live.headRef || live.live.headRef !== owner.branch
    || (pr.headRef && pr.headRef !== live.live.headRef)) return CHILD_CARRIER_OWNER_GATE_SKIP;
  if (pr.headSha && live.live.headSha && pr.headSha.toLowerCase() !== live.live.headSha) {
    return CHILD_CARRIER_OWNER_GATE_SKIP;
  }
  const headSha = live.live.headSha;
  if (!headSha) return CHILD_CARRIER_OWNER_GATE_SKIP;
  const required = new Map<string, { shas: string[]; branch: string }>();
  for (const { descendant, card } of sameRepo) {
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
    if (enumerated.shas.length === 0) {
      required.set(descendant.id, { shas: [], branch: card.branch });
      continue;
    }
    if (!shas) return CHILD_CARRIER_OWNER_GATE_SKIP;
    required.set(descendant.id, { shas, branch: card.branch });
  }
  if (required.size === 0) return null;
  const attributions = await db
    .select()
    .from(issueChildCarrierAttributions)
    .where(and(
      eq(issueChildCarrierAttributions.companyId, companyId),
      eq(issueChildCarrierAttributions.ancestorIssueId, ownerIssueId),
      eq(issueChildCarrierAttributions.pullRequestNumber, pr.number),
      eq(issueChildCarrierAttributions.state, "current"),
    ));
  for (const [childId, { shas, branch }] of required) {
    const row = attributions.find((item) => item.childIssueId === childId);
    if (shas.length === 0) {
      if (row) return CHILD_CARRIER_OWNER_GATE_SKIP;
      continue;
    }
    const stored = row ? normalizeShas(row.commitShas) : null;
    if (!row || !stored || stored.join() !== shas.join()) return CHILD_CARRIER_OWNER_GATE_SKIP;
    if (row.owner !== pr.owner.toLowerCase() || row.repo !== pr.repo.toLowerCase()) return CHILD_CARRIER_OWNER_GATE_SKIP;
    if (row.headSha !== headSha) return CHILD_CARRIER_OWNER_GATE_SKIP;
    if (row.branchName !== live.live.headRef) return CHILD_CARRIER_OWNER_GATE_SKIP;
    if (!row.childDecisionId) return CHILD_CARRIER_OWNER_GATE_SKIP;
    const [childIssue] = await db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(and(eq(issues.id, childId), eq(issues.companyId, companyId)))
      .limit(1);
    const claim = readClaim(childIssue?.executionState) ?? readBindingPr(childIssue?.executionState, branch);
    const binding = readBindingPr(childIssue?.executionState, branch);
    if (binding && binding.branch !== row.branchName) return CHILD_CARRIER_OWNER_GATE_SKIP;
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
  const checkedOwners = new Set(issueId ? [issueId] : []);
  for (const row of rows) {
    if (!checkedOwners.has(row.ancestorIssueId)) {
      checkedOwners.add(row.ancestorIssueId);
      const ownerSkip = await carrierOwnerChildAttributionBlock(db, companyId, row.ancestorIssueId, pr);
      if (ownerSkip) return ownerSkip;
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
