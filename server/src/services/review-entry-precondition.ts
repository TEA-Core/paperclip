import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  activityLog, agents, companyMemberships, documentRevisions, documents, executionWorkspaces, heartbeatRuns,
  issueDeliveryReceipts, issueDocuments, issueExecutionDecisions, issueReviewEntryReceipts,
  issues, projectWorkspaces, workspaceOperations, workspaceRuntimeServices, type Db,
} from "@paperclipai/db";
import type { UpdateIssue } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { readNoRepositoryReviewEntryRecord, unpaidLandingDebt, type NoRepositoryLandingRecord } from "./done-transition-guard.js";
import { resolveGitHubToken } from "./github-credential.js";
import { ghFetch, gitHubApiBase } from "./github-fetch.js";
import { captureReviewEntryWorktree, type NoRepositoryWorktreeProbeInput, type ReviewEntryWorktreeSnapshot } from "./hardened-git-probe.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";

export type ReviewEntryPrecondition = NonNullable<UpdateIssue["reviewEntryPrecondition"]>;
type Subject = Omit<typeof issues.$inferSelect, "parentLinkKind"> & { parentLinkKind: string | null };
export type ReviewEntryActor = { agentId: string | null; userId: string | null; runId: string | null };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(code: string, reason: string): never {
  throw conflict(reason, { code: `review_entry_${code}` });
}

type PhysicalWorkspace = { path: string; identity: string };
export interface PreparedReviewEntry {
  binding: { workspace: typeof executionWorkspaces.$inferSelect; project: typeof projectWorkspaces.$inferSelect };
  issueBinding: Record<string, unknown>;
  record: NoRepositoryLandingRecord;
  snapshot: Extract<ReviewEntryWorktreeSnapshot, { ok: true }>;
  input: NoRepositoryWorktreeProbeInput;
  baseSha: string;
  defaultBranch: string;
  covered: ReadonlySet<string>;
  capturedAt: Date;
}

function issueProofBinding(issue: Subject) {
  return {
    id: issue.id, companyId: issue.companyId, status: issue.status, statusVersion: issue.statusVersion,
    deliveryRequirement: issue.deliveryRequirement, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
    checkoutRunId: issue.checkoutRunId, executionRunId: issue.executionRunId, executionPolicy: issue.executionPolicy,
    executionState: issue.executionState, projectId: issue.projectId, projectWorkspaceId: issue.projectWorkspaceId,
    executionWorkspaceId: issue.executionWorkspaceId, executionWorkspaceSettings: issue.executionWorkspaceSettings,
    parentId: issue.parentId, originKind: issue.originKind, originId: issue.originId,
    createdByAgentId: issue.createdByAgentId, createdByUserId: issue.createdByUserId,
    reviewPolicy: issue.reviewPolicy, title: issue.title, description: issue.description,
  };
}

export function assertReviewEntryRequest(body: Record<string, unknown>) {
  if (Object.keys(body).some((key) => !["status", "comment", "reviewEntryPrecondition"].includes(key)) ||
      body.status !== "done" || typeof body.comment !== "string" || !body.comment.trim() ||
      /Closed at Tier\s/im.test(body.comment)) {
    fail("request_refused", "Conditional first review entry requires only status: done, a submission comment without a Tier claim, and reviewEntryPrecondition. Do not combine it with other mutations.");
  }
}

function assertSubject(issue: Subject, expected: ReviewEntryPrecondition, actor: ReviewEntryActor) {
  if (issue.statusVersion !== expected.expectedStatusVersion ||
      issue.executionWorkspaceId !== expected.expectedExecutionWorkspaceId ||
      !isDeepStrictEqual(issue.executionPolicy, expected.expectedExecutionPolicy) ||
      !isDeepStrictEqual(issue.executionState, expected.expectedExecutionState)) {
    fail("stale", "Issue version, policy, state or workspace changed; read the issue before submitting again.");
  }
  if ((actor.agentId ? issue.assigneeAgentId !== actor.agentId || issue.assigneeUserId !== null :
       !actor.userId || issue.assigneeUserId !== actor.userId || issue.assigneeAgentId !== null) ||
      (actor.agentId && (!actor.runId || issue.executionRunId !== actor.runId || issue.checkoutRunId !== actor.runId))) {
    fail("actor_refused", "Only the current assignee and its owning execution run can submit conditional first entry.");
  }
  if (issue.deliveryRequirement !== "record_only" || issue.completedAt || issue.cancelledAt ||
      !["todo", "in_progress"].includes(issue.status)) {
    fail("precondition_failed", "First entry requires an open issue already classified record_only.");
  }
  const state = issue.executionState;
  if (state !== null && (state.status !== "idle" || Object.entries(state).some(([key, value]) =>
    !["status", "completedStageIds", "skippedStageIds", "changesRequestedCount"].includes(key) && value != null) ||
    (Array.isArray(state.completedStageIds) && state.completedStageIds.length > 0) ||
    (Array.isArray(state.skippedStageIds) && state.skippedStageIds.length > 0) ||
    (state.changesRequestedCount != null && state.changesRequestedCount !== 0))) {
    fail("already_entered", "Only a never-entered review ladder can consume this precondition; re-entry and approval are separate operations.");
  }
  const policy = normalizeIssueExecutionPolicy(issue.executionPolicy);
  if (!policy || policy.stages[0]?.type !== "review") fail("precondition_failed", "The first configured stage must be an independent review.");
  return policy;
}

async function readBinding(db: Db, issue: Subject) {
  const [workspace] = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.id, issue.executionWorkspaceId!), eq(executionWorkspaces.companyId, issue.companyId),
  ));
  if (!workspace || workspace.sourceIssueId !== issue.id || workspace.projectId !== issue.projectId ||
      workspace.projectWorkspaceId !== issue.projectWorkspaceId || workspace.status !== "active" || workspace.closedAt ||
      workspace.mode !== "isolated_workspace" || workspace.strategyType !== "git_worktree" || workspace.providerType !== "git_worktree") {
    fail("workspace_not_isolated", "Run this card in its own isolated git worktree workspace. Shared project_primary directories and borrowed workspaces cannot supply strict first-entry proof.");
  }
  if (!workspace.projectWorkspaceId || !workspace.cwd || !workspace.providerRef || workspace.cwd !== workspace.providerRef) {
    fail("workspace_unverified", "The isolated workspace must have one authoritative project binding and worktree path.");
  }
  const [project] = await db.select().from(projectWorkspaces).where(and(
    eq(projectWorkspaces.id, workspace.projectWorkspaceId), eq(projectWorkspaces.companyId, issue.companyId),
    eq(projectWorkspaces.projectId, workspace.projectId),
  ));
  if (!project) fail("workspace_unverified", "The project repository binding is unavailable.");
  return { workspace, project };
}

async function readRecord(db: Db, issue: Subject, actor: ReviewEntryActor) {
  const read = await readNoRepositoryReviewEntryRecord(db, issue, actor);
  if (!read.ok) fail("precondition_failed", read.reason);
  if (read.proof !== "isolated_worktree") fail("workspace_not_isolated", "Run this card in an isolated git worktree.");
  return read.record;
}

/** Network work runs before the write lock. GitHub, not origin/HEAD or a local
 * default ref, pins the published base and positively attests each compared tip.
 * The transaction repeats the full hardened Git proof using only those identities.
 */
export async function prepareReviewEntry(
  db: Db, issue: Subject, expected: ReviewEntryPrecondition, actor: ReviewEntryActor,
): Promise<PreparedReviewEntry> {
  assertSubject(issue, expected, actor);
  const binding = await readBinding(db, issue);
  const record = await readRecord(db, issue, actor);
  const signal = AbortSignal.timeout(15_000);
  const { hostname, owner, repo } = record.repositoryLocation;
  const headers = { accept: "application/vnd.github+json", "user-agent": "paperclip-review-entry" };
  const baseUrl = `${gitHubApiBase(hostname)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const covered = new Set<string>();
  let baseSha: string;
  let defaultBranch: string;
  const credential = await resolveGitHubToken(db, issue.companyId, signal).catch(() =>
    fail("published_base_unavailable", "The company GitHub credential could not be resolved within the provider deadline."));
  if (!credential.token) fail("published_base_unavailable", "A company-authorized GitHub credential is required for the published base.");
  const authenticatedHeaders = { ...headers, authorization: `Bearer ${credential.token}` };
  async function get(url: string): Promise<Record<string, unknown>> {
    try {
      const response = await ghFetch(url, { headers: authenticatedHeaders, signal });
      if (!response.ok) throw new Error("provider refused");
      const body: unknown = await response.json();
      signal.throwIfAborted();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid response");
      return body as Record<string, unknown>;
    } catch { return fail("published_base_unavailable", "The trusted published base or its ancestry could not be verified within the provider deadline."); }
  }
  const repository = await get(baseUrl);
  if (typeof repository.default_branch !== "string" || !repository.default_branch) fail("published_base_unavailable", "GitHub did not identify its default branch.");
  defaultBranch = repository.default_branch;
  const base = await get(`${baseUrl}/commits/${encodeURIComponent(record.baseBranch)}`);
  if (typeof base.sha !== "string" || !/^[0-9a-f]{40}$/.test(base.sha)) fail("published_base_unavailable", "GitHub did not identify the published base commit.");
  baseSha = base.sha;
  const input: NoRepositoryWorktreeProbeInput = {
    recordedWorktreePath: record.recordedWorktreePath,
    managedProjectRoot: path.dirname(resolveManagedProjectWorkspaceDir({ companyId: issue.companyId, projectId: record.projectId })),
    issueIdentifier: record.identifier,
    projectBranches: new Set([record.baseBranch, defaultBranch, ...(record.repoRef ? [record.repoRef] : [])]),
    attributedBranches: new Set(record.attributedBranches),
    existingOtherCardIdentifiers: async (candidates) => new Set((await db.select({ identifier: issues.identifier }).from(issues)
      .where(and(eq(issues.companyId, issue.companyId), ne(issues.id, issue.id), inArray(issues.identifier, [...candidates]))))
      .flatMap((row) => row.identifier ? [row.identifier] : [])),
    countCommitsAheadOfBase: async (sha) => {
      const comparison = await get(`${baseUrl}/compare/${baseSha}...${sha}`);
      const remoteBase = comparison.base_commit as { sha?: unknown } | undefined;
      const mergeBase = comparison.merge_base_commit as { sha?: unknown } | undefined;
      if (comparison.ahead_by !== 0 || !["identical", "behind"].includes(String(comparison.status)) ||
          remoteBase?.sha !== baseSha || mergeBase?.sha !== sha) {
        fail("repository_work_owed", "A workspace tip is not positively covered by the trusted published base. Tree equality does not prove landed history.");
      }
      covered.add(sha);
      return 0;
    },
  };
  const snapshot = await captureReviewEntryWorktree(input);
  if (!snapshot.ok) fail("git_refused", snapshot.reason);
  return { binding, record, snapshot, input, baseSha, defaultBranch, covered, capturedAt: new Date(), issueBinding: issueProofBinding(issue) };
}

async function physicalPath(candidate: string): Promise<PhysicalWorkspace> {
  const resolved = await realpath(candidate);
  const info = await stat(resolved);
  if (!info.isDirectory()) fail("workspace_unverified", "A recorded workspace path is not a directory.");
  return { path: resolved, identity: `${info.dev}:${info.ino}` };
}

async function assertExclusive(db: Db, issue: Subject, actor: ReviewEntryActor, workspace: typeof executionWorkspaces.$inferSelect) {
  const own = await physicalPath(workspace.providerRef!).catch(() =>
    fail("workspace_unverified", "The isolated workspace path could not be verified."));
  const overlaps = async (candidate: string) => {
    let other: PhysicalWorkspace;
    try { other = await physicalPath(candidate); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return fail("workspace_unverified", "A possible workspace alias could not be resolved.");
    }
    return other.identity === own.identity || other.path === own.path || other.path.startsWith(`${own.path}${path.sep}`);
  };
  // Cross-company aliases are still writers to the same physical bytes. Never
  // return another company's identifiers or paths in the refusal.
  const workspaces = await db.select({
    id: executionWorkspaces.id, cwd: executionWorkspaces.cwd, providerRef: executionWorkspaces.providerRef,
  }).from(executionWorkspaces);
  for (const candidate of workspaces) {
    if (candidate.id === workspace.id) continue;
    for (const candidatePath of new Set([candidate.cwd, candidate.providerRef])) {
      if (candidatePath && path.isAbsolute(candidatePath) && await overlaps(candidatePath)) {
        fail("workspace_shared", "Another execution workspace shares this physical path. Provision a new isolated worktree for this card.");
      }
    }
  }
  for (const project of await db.select({ cwd: projectWorkspaces.cwd }).from(projectWorkspaces)) {
    if (project.cwd && path.isAbsolute(project.cwd) && await overlaps(project.cwd)) {
      fail("workspace_shared", "A project workspace shares this physical path. Provision a separate isolated worktree.");
    }
  }
  for (const service of await db.select({
    stoppedAt: workspaceRuntimeServices.stoppedAt, executionWorkspaceId: workspaceRuntimeServices.executionWorkspaceId, cwd: workspaceRuntimeServices.cwd,
  }).from(workspaceRuntimeServices)) {
    if (service.stoppedAt === null && (service.executionWorkspaceId === workspace.id ||
        service.cwd && path.isAbsolute(service.cwd) && await overlaps(service.cwd))) {
      fail("workspace_busy", "A runtime service can still write this worktree; wait for its confirmed stop.");
    }
  }
  for (const operation of await db.select({
    finishedAt: workspaceOperations.finishedAt, executionWorkspaceId: workspaceOperations.executionWorkspaceId, cwd: workspaceOperations.cwd,
  }).from(workspaceOperations)) {
    if (operation.finishedAt === null && (operation.executionWorkspaceId === workspace.id ||
        operation.cwd && path.isAbsolute(operation.cwd) && await overlaps(operation.cwd))) {
      fail("workspace_busy", "A workspace operation can still write this worktree; wait for it to finish.");
    }
  }
  const bindings = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.executionWorkspaceId, workspace.id), ne(issues.id, issue.id),
  ));
  if (bindings.length) fail("workspace_shared", "Another card uses this execution workspace. Provision a new isolated worktree.");
  const runs = await db.select({
    id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
    status: heartbeatRuns.status, nativeIssueId: heartbeatRuns.nativeIssueId, contextSnapshot: heartbeatRuns.contextSnapshot,
  }).from(heartbeatRuns).where(inArray(heartbeatRuns.status, ["queued", "running"]));
  let ownerFound = !actor.agentId;
  for (const run of runs) {
    const context = run.contextSnapshot ?? {};
    if (run.id === actor.runId) {
      if (run.companyId !== issue.companyId || run.agentId !== actor.agentId || run.status !== "running" ||
          (run.nativeIssueId ?? context.issueId ?? context.taskId) !== issue.id || context.executionWorkspaceId !== workspace.id) {
        fail("actor_refused", "The owning run does not attest this issue and isolated execution workspace.");
      }
      ownerFound = true;
      continue;
    }
    if (context.executionWorkspaceId === workspace.id || run.nativeIssueId === issue.id || context.issueId === issue.id || context.taskId === issue.id) {
      fail("workspace_busy", "Another run holds this card or workspace; wait for it to finish before first entry.");
    }
    const hints = [context.paperclipWorkspace, ...(Array.isArray(context.paperclipWorkspaces) ? context.paperclipWorkspaces : [])];
    const paths: unknown[] = [context.cwd, context.workspaceCwd];
    for (const hint of hints) {
      if (hint && typeof hint === "object" && !Array.isArray(hint)) {
        const workspaceHint = hint as Record<string, unknown>;
        paths.push(workspaceHint.cwd, workspaceHint.worktreePath);
      }
    }
    for (const candidate of paths) {
      if (typeof candidate === "string" && path.isAbsolute(candidate) && await overlaps(candidate)) {
        fail("workspace_busy", "Another run shares this physical path; run this card alone in an isolated worktree.");
      }
    }
  }
  if (!ownerFound) fail("actor_refused", "The owning execution run is no longer running.");
  return own;
}

async function pinnedRevision(db: Db, issue: Subject, key: string, revisionId: string) {
  const [revision] = await db.select({
    id: documentRevisions.id, documentId: documents.id, body: documentRevisions.body,
    revisionNumber: documentRevisions.revisionNumber,
  }).from(issueDocuments).innerJoin(documents, and(eq(documents.id, issueDocuments.documentId), eq(documents.companyId, issue.companyId)))
    .innerJoin(documentRevisions, and(eq(documentRevisions.documentId, documents.id), eq(documentRevisions.companyId, issue.companyId)))
    .where(and(eq(issueDocuments.companyId, issue.companyId), eq(issueDocuments.issueId, issue.id), eq(issueDocuments.key, key),
      eq(documentRevisions.id, revisionId), eq(documentRevisions.revisionNumber, documents.latestRevisionNumber),
      eq(documentRevisions.body, documents.latestBody)));
  if (!revision || !revision.body.trim()) fail("revision_stale", "The ruling or reviewed artifact revision is missing, foreign, empty or no longer current.");
  return { documentId: revision.documentId, revisionId: revision.id, revisionNumber: revision.revisionNumber, bodyDigest: digest(revision.body) };
}

/** Called with the issue FOR UPDATE, before any handoff/comment write. Table
 * writer locks also exclude alias/run and evidence INSERT phantoms, not only
 * updates to existing rows. This deliberately conservative local-worktree mode
 * is not a host filesystem freeze: provisioning gives this card/run sole use
 * of the working directory, and the submitting owner must yield while PATCH
 * runs. No shared primary directory is admitted by an advisory mutex.
 */
export async function verifyReviewEntryAtTransition(
  tx: Db, issue: Subject, expected: ReviewEntryPrecondition, actor: ReviewEntryActor,
  prepared: PreparedReviewEntry, comment: string,
) {
  const policy = assertSubject(issue, expected, actor);
  if (!isDeepStrictEqual(issueProofBinding(issue), prepared.issueBinding)) {
    fail("stale", "The issue's classification, ownership or review authority changed after capture.");
  }
  await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
  await tx.execute(sql`LOCK TABLE execution_workspaces, heartbeat_runs, project_workspaces,
    documents, document_revisions, issue_documents, issue_execution_decisions,
    issue_work_products, issue_delivery_receipts, external_objects, external_object_mentions,
    activity_log, agents, company_memberships, workspace_runtime_services, workspace_operations IN SHARE ROW EXCLUSIVE MODE`);
  const binding = await readBinding(tx, issue);
  const record = await readRecord(tx, issue, actor);
  if (!isDeepStrictEqual(binding, prepared.binding) || !isDeepStrictEqual(record, prepared.record)) {
    fail("stale", "Workspace, repository configuration or entry ruling changed after the published-base proof.");
  }
  const exclusive = await assertExclusive(tx, issue, actor, binding.workspace);
  const [previousEntry] = await tx.select({ id: issueReviewEntryReceipts.id }).from(issueReviewEntryReceipts)
    .where(and(eq(issueReviewEntryReceipts.companyId, issue.companyId), eq(issueReviewEntryReceipts.issueId, issue.id)));
  const [decision] = await tx.select({ id: issueExecutionDecisions.id }).from(issueExecutionDecisions)
    .where(and(eq(issueExecutionDecisions.companyId, issue.companyId), eq(issueExecutionDecisions.issueId, issue.id)));
  if (previousEntry || decision) fail("already_entered", "This issue already has a first-entry receipt or review decision; the proof is not reusable.");
  const [debt] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
    eq(activityLog.companyId, issue.companyId), eq(activityLog.entityId, issue.id), eq(activityLog.entityType, "issue"), unpaidLandingDebt(),
  ));
  const [delivery] = await tx.select({ id: issueDeliveryReceipts.id }).from(issueDeliveryReceipts)
    .where(and(eq(issueDeliveryReceipts.companyId, issue.companyId), eq(issueDeliveryReceipts.sourceIssueId, issue.id)));
  if (debt || delivery) fail("repository_work_owed", "Repository landing debt or a repository delivery receipt contradicts no owed repository work. First entry never discharges debt.");
  const ruling = await pinnedRevision(tx, issue, "entry-ruling", expected.entryRulingRevisionId);
  const artifact = await pinnedRevision(tx, issue, expected.artifact.documentKey, expected.artifact.revisionId);
  if (ruling.documentId === artifact.documentId) fail("revision_refused", "The reviewed artifact must be separate from the independent entry ruling.");
  const rulingAuthors = await tx.select({ agentId: documentRevisions.createdByAgentId, userId: documentRevisions.createdByUserId })
    .from(documentRevisions).where(eq(documentRevisions.documentId, ruling.documentId));
  for (const author of rulingAuthors) {
    if (author.agentId) {
      const [agent] = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, author.agentId), eq(agents.companyId, issue.companyId)));
      if (!agent) fail("ruling_refused", "An entry-ruling author does not belong to this company.");
    } else {
      const [member] = await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, issue.companyId), eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, author.userId!), eq(companyMemberships.status, "active"),
        ne(companyMemberships.membershipRole, "viewer"),
      ));
      if (!member) fail("ruling_refused", "An entry-ruling author is not an active board member of this company.");
    }
  }
  const transition = applyIssueExecutionPolicyTransition({
    issue, policy, previousPolicy: policy, requestedStatus: "done", requestedAssigneePatch: {}, actor,
    allowBoardOverride: false, commentBody: comment,
  });
  const state = transition.patch.executionState as Record<string, unknown> | undefined;
  if (transition.decision || !transition.workflowControlledAssignment || transition.patch.status !== "in_review" ||
      state?.status !== "pending" || state.currentStageId !== policy.stages[0]!.id ||
      state.currentStageIndex !== 0 || (state.completedStageIds as unknown[])?.length || (state.skippedStageIds as unknown[])?.length ||
      state.lastDecisionId || state.lastDecisionOutcome || transition.patch.assigneeAgentId === actor.agentId && actor.agentId !== null ||
      transition.patch.assigneeUserId === actor.userId && actor.userId !== null) {
    fail("reviewer_refused", "The locked transition must select the first independent review participant without a decision, skip or completion.");
  }
  if (typeof transition.patch.assigneeAgentId === "string") {
    const [reviewer] = await tx.select().from(agents).where(and(eq(agents.id, transition.patch.assigneeAgentId), eq(agents.companyId, issue.companyId)));
    if (!reviewer || ["paused", "terminated", "deleted", "pending_approval", "error"].includes(reviewer.status)) fail("reviewer_refused", "The independent reviewer is not eligible to take work.");
  }
  else if (typeof transition.patch.assigneeUserId === "string") {
    const [reviewer] = await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
      eq(companyMemberships.companyId, issue.companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, transition.patch.assigneeUserId), eq(companyMemberships.status, "active"),
      ne(companyMemberships.membershipRole, "viewer"),
    ));
    if (!reviewer) fail("reviewer_refused", "The independent human reviewer is not eligible to take work.");
  } else fail("reviewer_refused", "The first review has no eligible participant.");
  const snapshot = await captureReviewEntryWorktree({ ...prepared.input, existingOtherCardIdentifiers: async (candidates) =>
    new Set((await tx.select({ identifier: issues.identifier }).from(issues).where(and(eq(issues.companyId, issue.companyId), ne(issues.id, issue.id),
      inArray(issues.identifier, [...candidates])))).flatMap((row) => row.identifier ? [row.identifier] : [])),
    countCommitsAheadOfBase: async (sha) => prepared.covered.has(sha) ? 0 : fail("git_changed", "A new Git tip was not covered by the pinned published base."),
  });
  if (!snapshot.ok) fail("git_refused", snapshot.reason);
  if (!isDeepStrictEqual(snapshot, prepared.snapshot)) fail("git_changed", "The worktree, index, HEAD or refs changed after capture.");
  const finalPhysical = await physicalPath(binding.workspace.providerRef!).catch(() =>
    fail("workspace_unverified", "The isolated worktree path disappeared during proof."));
  if (!isDeepStrictEqual(finalPhysical, exclusive)) fail("git_changed", "The physical worktree identity changed during proof.");
  const [classification] = await tx.select({
    activityId: activityLog.id, actorType: activityLog.actorType, actorId: activityLog.actorId, recordedAt: activityLog.createdAt,
  }).from(activityLog).where(and(eq(activityLog.companyId, issue.companyId), eq(activityLog.entityId, issue.id),
    eq(activityLog.entityType, "issue"), eq(activityLog.action, "issue.delivery_requirement_reclassified"),
    sql`${activityLog.details}->>'requestedDeliveryRequirement' = 'record_only'`,
  )).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(1);
  return { transition, evidence: {
    kind: "noRepositoryDelivery", actor, stageId: state.currentStageId, participant: state.currentParticipant,
    policy: issue.executionPolicy, beforeState: issue.executionState, deliveryRequirement: "record_only",
    classificationProvenance: classification ?? {
      source: "issue_creation", createdByAgentId: issue.createdByAgentId, createdByUserId: issue.createdByUserId, recordedAt: issue.createdAt,
    },
    ruling, artifact, noLandingDebt: true, noRepositoryDelivery: true,
    executionWorkspaceId: binding.workspace.id, projectWorkspaceId: binding.project.id, projectId: issue.projectId,
    repository: record.repository, baseBranch: record.baseBranch, baseSha: prepared.baseSha, remoteDefaultBranch: prepared.defaultBranch,
    workspaceOwnership: { kind: "isolated_card_run", sourceIssueId: issue.id, runId: actor.runId, ...exclusive },
    snapshot,
  } };
}
