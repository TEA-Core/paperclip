import type { Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { externalObjectMentions, externalObjects, issues } from "@paperclipai/db";
import { secretService } from "./secrets.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";

export interface MergeArmingDecision {
  stageId: string;
  stageType: string;
  outcome: string;
  body: string;
}

export function shouldPublishApprovalStatus<T extends Pick<MergeArmingDecision, "outcome">>(
  decision: T | null | undefined,
): decision is T {
  return decision != null && decision.outcome === "approved";
}

export interface ArmingOutcome {
  kind: "armed" | "skipped" | "failed";
  message: string;
}

export interface LinkedPullRequest {
  id: string;
  owner: string;
  repo: string;
  number: number;
  nodeId: string | null;
  headRefName: string | null;
  displayName: string;
}

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const GITHUB_TOKEN_SECRET_NAMES = ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"] as const;

async function resolveGitHubToken(db: Db, companyId: string): Promise<string | null> {
  const secrets = secretService(db);
  for (const secretName of GITHUB_TOKEN_SECRET_NAMES) {
    const secret = await secrets.getByName(companyId, secretName);
    if (!secret) continue;
    const token = await secrets.resolveSecretValue(companyId, secret.id, "latest");
    const trimmed = token.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export async function resolveLinkedPullRequests(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<LinkedPullRequest[]> {
  const rows = await db
    .select({
      id: externalObjects.id,
      externalId: externalObjects.externalId,
      sanitizedCanonicalUrl: externalObjects.sanitizedCanonicalUrl,
      data: externalObjects.data,
    })
    .from(externalObjectMentions)
    .innerJoin(externalObjects, eq(externalObjects.id, externalObjectMentions.objectId))
    .where(
      and(
        eq(externalObjectMentions.companyId, companyId),
        eq(externalObjectMentions.sourceIssueId, issueId),
        eq(externalObjectMentions.objectType, "pull_request"),
        eq(externalObjects.providerKey, "github"),
      ),
    );

  const results: LinkedPullRequest[] = [];
  for (const row of rows) {
    const state = row.data?.state as string | undefined;
    const draft = row.data?.draft as boolean | undefined;
    if (draft === true) continue;
    if (state !== undefined && state !== "open") continue;

    const match = /^([^/]+)\/([^/]+)#(pull|issues)\/([1-9][0-9]*)$/.exec(row.externalId);
    if (!match) continue;

    const owner = match[1]!;
    const repo = match[2]!;
    const number = Number(match[4]);
    const nodeId = row.data?.node_id as string | undefined | null;
    const headRefName =
      (row.data?.head as Record<string, unknown> | undefined | null)?.ref as string | undefined ??
      (row.data?.headRefName as string | undefined);

    results.push({
      id: row.id,
      owner,
      repo,
      number,
      nodeId: nodeId ?? null,
      headRefName: headRefName ?? null,
      displayName: `${owner}/${repo}#${number}`,
    });
  }

  return results;
}

async function fetchGitHubNodeId(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<string | null> {
  const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-merge-arming",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };

  let response: Response;
  try {
    response = await ghFetch(url, { headers });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return null;

  return typeof body.node_id === "string" ? body.node_id : null;
}

async function enableAutoMerge(
  token: string,
  nodeId: string,
): Promise<{ success: boolean; alreadyQueued: boolean; error: string | null }> {
  const query = `mutation { enablePullRequestAutoMerge(input: { pullRequestId: "${nodeId}" }) { clientMutationId } }`;

  try {
    const response = await ghFetch(GITHUB_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      const errors = body?.errors as Array<{ message?: string }> | undefined;
      const firstError = errors?.[0]?.message ?? "";
      if (firstError.toLowerCase().includes("already") && firstError.toLowerCase().includes("merge")) {
        return { success: true, alreadyQueued: true, error: null };
      }
      return { success: false, alreadyQueued: false, error: firstError || `HTTP ${response.status}` };
    }

    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const errors = body?.errors as Array<{ message?: string }> | undefined;
    if (errors && errors.length > 0) {
      const firstError = errors[0]?.message ?? "";
      if (firstError.toLowerCase().includes("already") && firstError.toLowerCase().includes("merge")) {
        return { success: true, alreadyQueued: true, error: null };
      }
      return { success: false, alreadyQueued: false, error: firstError };
    }

    return { success: true, alreadyQueued: false, error: null };
  } catch {
    return { success: false, alreadyQueued: false, error: "network_error" };
  }
}

export async function publishApprovalStatus(
  db: Db,
  companyId: string,
  issueId: string,
  issueIdentifier: string,
): Promise<ArmingOutcome> {
  const linkedPRs = await resolveLinkedPullRequests(db, companyId, issueId);

  if (linkedPRs.length === 0) {
    return { kind: "skipped", message: "status:skipped:no-pr: No linked pull request found" };
  }

  if (linkedPRs.length > 1) {
    const prList = linkedPRs.map((pr) => pr.displayName).join(", ");
    return {
      kind: "skipped",
      message: `status:skipped:ambiguous: Multiple linked PRs (${linkedPRs.length}): ${prList}`,
    };
  }

  const pr = linkedPRs[0]!;
  const token = await resolveGitHubToken(db, companyId);
  if (!token) {
    return { kind: "failed", message: "status:failed:auth_required: GitHub authentication failed" };
  }

  const headSha = await fetchPullRequestHeadSha(token, pr.owner, pr.repo, pr.number);
  if (!headSha) {
    return { kind: "failed", message: "status:failed:pr_not_found: Could not resolve PR head SHA" };
  }

  const result = await writeCommitStatus(token, pr.owner, pr.repo, headSha, issueIdentifier);
  if (result.success) {
    return {
      kind: "armed",
      message: `status:published: paperclip/approved status written to ${pr.displayName} head ${headSha.slice(0, 7)}`,
    };
  }

  const safeError = result.error ?? "unknown_error";
  const truncated = safeError.length > 200 ? safeError.slice(0, 200) + "..." : safeError;
  return { kind: "failed", message: `status:failed:${truncated}` };
}

async function fetchPullRequestHeadSha(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<string | null> {
  const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-merge-arming",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };

  let response: Response;
  try {
    response = await ghFetch(url, { headers });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return null;

  const head = body.head as Record<string, unknown> | undefined;
  const sha = head?.sha as string | undefined;
  return typeof sha === "string" && sha.length > 0 ? sha : null;
}

async function writeCommitStatus(
  token: string,
  owner: string,
  repo: string,
  headSha: string,
  issueIdentifier: string,
): Promise<{ success: boolean; error: string | null }> {
  const url = `${gitHubApiBase("github.com")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/statuses/${encodeURIComponent(headSha)}`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "paperclip-merge-arming",
    "x-github-api-version": "2022-11-28",
    authorization: `Bearer ${token}`,
  };

  const body = JSON.stringify({
    state: "success",
    context: "paperclip/approved",
    description: `${issueIdentifier} approved via Paperclip`,
    target_url: `https://paperclip.example.com/issues/${issueIdentifier}`,
  });

  let response: Response;
  try {
    response = await ghFetch(url, {
      method: "POST",
      headers,
      body,
    });
  } catch {
    return { success: false, error: "network_error" };
  }

  if (response.ok) {
    return { success: true, error: null };
  }

  const responseBody = await response.json().catch(() => null) as Record<string, unknown> | null;
  const message = responseBody?.message as string | undefined;

  if (response.status === 403 || response.status === 422) {
    const detail = message ?? "";
    return { success: false, error: `scope_missing: ${detail}` };
  }

  return { success: false, error: message ?? `HTTP ${response.status}` };
}

export async function armMergeOnApproval(
  db: Db,
  companyId: string,
  issueId: string,
  decision: MergeArmingDecision,
): Promise<ArmingOutcome> {
  if (decision.outcome !== "approved") {
    return { kind: "skipped", message: `skipped:not-approved: Decision outcome is "${decision.outcome}", not "approved"` };
  }

  const linkedPRs = await resolveLinkedPullRequests(db, companyId, issueId);

  if (linkedPRs.length === 0) {
    return { kind: "skipped", message: "skipped:no-pr: No linked pull request found" };
  }

  if (linkedPRs.length > 1) {
    const prList = linkedPRs.map((pr) => pr.displayName).join(", ");
    return {
      kind: "skipped",
      message: `skipped:ambiguous: Multiple linked PRs (${linkedPRs.length}): ${prList}`,
    };
  }

  const pr = linkedPRs[0]!;

  const ownerMatch = /^(SUP-\d+)/.exec(pr.headRefName ?? "");
  if (!ownerMatch) {
    return { kind: "skipped", message: "skipped:unowned-branch: PR headRefName does not name a SUP-\\d+ owner" };
  }

  const ownerIdentifier = ownerMatch[1]!;
  const [ownerRow] = await db
    .select({
      id: issues.id,
      executionPolicy: issues.executionPolicy,
      executionState: issues.executionState,
    })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.identifier, ownerIdentifier)))
    .limit(1);

  if (!ownerRow) {
    return { kind: "skipped", message: `skipped:unowned-branch: No issue found for identifier ${ownerIdentifier}` };
  }

  if (ownerRow.id !== issueId) {
    return {
      kind: "skipped",
      message: `skipped:not-branch-owner: PR ${pr.number} is owned by ${ownerIdentifier}, not the transitioning issue`,
    };
  }

  const policy = ownerRow.executionPolicy as { stages?: Array<{ id: string }> } | undefined;
  const state = ownerRow.executionState as
    | { completedStageIds?: string[]; lastDecisionOutcome?: string | null }
    | undefined;

  const policyStages = policy?.stages ?? [];
  const completedIds = state?.completedStageIds ?? [];
  const allCompleted = policyStages.every((s) => completedIds.includes(s.id));
  const isApproved = state?.lastDecisionOutcome === "approved";

  if (!allCompleted || !isApproved) {
    const incompleteIds = policyStages.filter((s) => !completedIds.includes(s.id)).map((s) => s.id);
    return {
      kind: "skipped",
      message: `skipped:owner-not-approved: incomplete review/approval stages: ${incompleteIds.join(", ")}`,
    };
  }

  const token = await resolveGitHubToken(db, companyId);
  if (!token) {
    return { kind: "failed", message: "failed:auth_required: GitHub authentication failed" };
  }

  let nodeId = pr.nodeId;
  if (!nodeId) {
    nodeId = await fetchGitHubNodeId(token, pr.owner, pr.repo, pr.number);
    if (!nodeId) {
      return { kind: "failed", message: "failed:node_id_missing: Could not resolve GitHub node ID for linked PR" };
    }
  }

  const result = await enableAutoMerge(token, nodeId);
  if (result.success) {
    if (result.alreadyQueued) {
      return {
        kind: "skipped",
        message: `skipped:already-queued: ${pr.displayName} already queued to merge`,
      };
    }
    return {
      kind: "armed",
      message: `armed: Auto-merge enabled for ${pr.displayName}`,
    };
  }

  const safeError = result.error ?? "unknown_error";
  const truncated = safeError.length > 200 ? safeError.slice(0, 200) + "..." : safeError;
  return { kind: "failed", message: `failed:${truncated}` };
}
