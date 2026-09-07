import type {
  ExecutionWorkspaceMode,
  ExecutionWorkspaceStrategy,
  IssueExecutionWorkspaceSettings,
  ProjectExecutionWorkspaceDefaultMode,
  ProjectExecutionWorkspacePolicy,
  SharedWorkspaceConcurrency,
} from "@paperclipai/shared";
import { asString, parseObject } from "../adapters/utils.js";

export type ParsedExecutionWorkspaceMode = Exclude<ExecutionWorkspaceMode, "inherit" | "reuse_existing">;

export const WORKSPACE_WORKTREE_REQUIRES_PROJECT_CODE = "workspace_worktree_requires_project";
export const WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION =
  "Attach a project to the task, or bind a reusable execution workspace, then retry.";
export const WORKSPACE_WORKTREE_REQUIRES_PROJECT_MESSAGE =
  `This task is set to run in an isolated git worktree, but it has no project and no reusable execution workspace to create the worktree from. ${WORKSPACE_WORKTREE_REQUIRES_PROJECT_REMEDIATION}`;

export const WORKSPACE_REUSE_REQUIRES_EXECUTION_WORKSPACE_CODE = "workspace_reuse_requires_execution_workspace";
export const WORKSPACE_REUSE_REQUIRES_EXECUTION_WORKSPACE_REMEDIATION =
  "Pass executionWorkspaceId with the workspace to reuse, pass inheritExecutionWorkspaceFromIssueId (or parentId) to inherit one, or drop executionWorkspacePreference: \"reuse_existing\".";
export const WORKSPACE_REUSE_REQUIRES_EXECUTION_WORKSPACE_MESSAGE =
  `executionWorkspacePreference: "reuse_existing" requires executionWorkspaceId, and none was supplied or inherited. ${WORKSPACE_REUSE_REQUIRES_EXECUTION_WORKSPACE_REMEDIATION}`;

export const WORKSPACE_PATH_HELD_CODE = "workspace_path_held_by_live_workspace";
export const WORKSPACE_PATH_HELD_REMEDIATION =
  "Archive the holding execution workspace (or release the source issue's binding to it) and retry the allocation.";

export const WORKSPACE_CROSS_SOURCE_BINDING_CODE = "workspace_cross_source_binding";
export const WORKSPACE_CROSS_SOURCE_BINDING_REMEDIATION =
  "Bind only to a workspace sourced by the issue itself or a shared workspace; drop the binding to allocate a fresh workspace, or archive the sourced workspace first.";

export const WORKSPACE_CROSS_SOURCE_BINDING_MESSAGE =
  `An issue cannot be bound to an execution workspace sourced by a different issue. ${WORKSPACE_CROSS_SOURCE_BINDING_REMEDIATION}`;

export const WORKSPACE_ISSUE_OVERRIDE_DISALLOWED_CODE = "workspace_issue_override_disallowed";
export const WORKSPACE_ISSUE_OVERRIDE_DISALLOWED_REMEDIATION =
  "Remove the issue's executionWorkspacePreference/executionWorkspaceId override, or set the project's executionWorkspacePolicy.allowIssueOverride to true.";
export const WORKSPACE_ISSUE_OVERRIDE_DISALLOWED_MESSAGE =
  `This issue supplies an execution-workspace override, but the project's executionWorkspacePolicy.allowIssueOverride is false. ${WORKSPACE_ISSUE_OVERRIDE_DISALLOWED_REMEDIATION}`;

type WorkspaceStrategyType = ExecutionWorkspaceStrategy["type"];

export type UnrunnableWorktreeIssueRef = {
  projectId?: string | null;
  projectWorkspaceId?: string | null;
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
};

function cloneRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  return { ...value };
}

function parseExecutionWorkspaceStrategy(raw: unknown): ExecutionWorkspaceStrategy | null {
  const parsed = parseObject(raw);
  const type = asString(parsed.type, "");
  if (type !== "project_primary" && type !== "git_worktree" && type !== "adapter_managed" && type !== "cloud_sandbox") {
    return null;
  }
  return {
    type,
    ...(typeof parsed.baseRef === "string" ? { baseRef: parsed.baseRef } : {}),
    ...(typeof parsed.branchTemplate === "string" ? { branchTemplate: parsed.branchTemplate } : {}),
    ...(typeof parsed.existingBranch === "string" && parsed.existingBranch.trim().length > 0
      ? { existingBranch: parsed.existingBranch.trim() }
      : {}),
    ...(typeof parsed.worktreeParentDir === "string" ? { worktreeParentDir: parsed.worktreeParentDir } : {}),
    ...(typeof parsed.provisionCommand === "string" ? { provisionCommand: parsed.provisionCommand } : {}),
    ...(typeof parsed.runtimeProvisionCommand === "string"
      ? { runtimeProvisionCommand: parsed.runtimeProvisionCommand }
      : {}),
    ...(typeof parsed.teardownCommand === "string" ? { teardownCommand: parsed.teardownCommand } : {}),
  };
}

export function resolveEffectiveWorkspaceStrategyType(
  mode: ParsedExecutionWorkspaceMode,
  config: Record<string, unknown> | null | undefined,
): WorkspaceStrategyType {
  const workspaceStrategy = parseObject(config?.workspaceStrategy);
  const type = asString(workspaceStrategy.type, "");
  if (type === "project_primary" || type === "git_worktree" || type === "adapter_managed" || type === "cloud_sandbox") {
    return type;
  }
  // Default mirrors workspace-runtime.ts realizeExecutionWorkspace: missing type -> "project_primary".
  // agent_default is a metadata-only mode that never creates a worktree, so it keeps "adapter_managed".
  return mode === "agent_default" ? "adapter_managed" : "project_primary";
}

export function resolvePinnedIssueWorkspaceStrategyType(input: {
  mode: ParsedExecutionWorkspaceMode;
  issueSettings: IssueExecutionWorkspaceSettings | null;
}): WorkspaceStrategyType {
  const strategyType = input.issueSettings?.workspaceStrategy?.type;
  if (
    strategyType === "project_primary" ||
    strategyType === "git_worktree" ||
    strategyType === "adapter_managed" ||
    strategyType === "cloud_sandbox"
  ) {
    return strategyType;
  }
  // When no explicit strategy type is set, mirror the runtime default (project_primary for most
  // modes; adapter_managed for agent_default). Mode alone never implies git_worktree.
  return input.mode === "agent_default" ? "adapter_managed" : "project_primary";
}

export function hasReusableExecutionWorkspaceBinding(issue: UnrunnableWorktreeIssueRef): boolean {
  return Boolean(issue.executionWorkspaceId && issue.executionWorkspacePreference === "reuse_existing");
}

/**
 * Does a recorded execution-workspace branch name a `sup-<n>` id that is not
 * the issue's own?
 *
 * This is the server-side mirror of the one-branch-one-issue gate that
 * scripts/deliver.sh applies at delivery time: extract every whole
 * `sup-<n>` token the branch names (case-insensitive; `SUP-15104` does not
 * count as naming `SUP-1510`), and the branch is foreign unless the
 * delivering issue's number is among them. A branch that names no `sup-<n>`
 * token at all (feature/foo, release branches) is outside the gate's scope
 * and passes, exactly as it does in deliver.sh.
 */
export function executionWorkspaceBranchNamesDifferentIssue(input: {
  issueIdentifier?: string | null;
  workspaceBranchName?: string | null;
}): boolean {
  const branchName = input.workspaceBranchName?.trim();
  if (!branchName) return false;
  const issueIdentifier = input.issueIdentifier?.trim();
  if (!issueIdentifier) return false;
  const separator = issueIdentifier.lastIndexOf("-");
  if (separator < 0) return false;
  const issueNumber = issueIdentifier.slice(separator + 1);
  if (!/^[0-9]+$/.test(issueNumber)) return false;
  const branchIssueNumbers: string[] = [];
  for (const match of branchName.matchAll(/sup-[0-9]+/gi)) {
    const digits = match[0].match(/[0-9]+/);
    if (digits) branchIssueNumbers.push(digits[0]);
  }
  if (branchIssueNumbers.length === 0) return false;
  return !branchIssueNumbers.includes(issueNumber);
}

/**
 * Does a branch carry at least one deliverable `sup-<n>` token?
 *
 * Used only at issue-create time, where the new issue's own identifier is not
 * yet assigned but its number is, by construction, strictly greater than every
 * existing issue's number. A source workspace's branch was rendered by an
 * already-existing issue, so every `sup-<n>` token it carries names a card that
 * already exists — and therefore names an id different from the new issue's.
 * For that create path this is exactly equivalent to
 * `executionWorkspaceBranchNamesDifferentIssue`, without needing the new
 * issue's identifier, and it is the branch scripts/deliver.sh's
 * one-branch-one-issue gate would refuse for the new issue. The create site in
 * issues.ts applies the SUP-15231 `shared_workspace` plan-carrier exemption
 * (`inheritedExecutionWorkspaceBranchExempt`) before declining on this
 * predicate, so an ancestor-sourced shared carrier still inherits.
 */
export function executionWorkspaceBranchNamesAnyIssueIdentifier(
  workspaceBranchName?: string | null,
): boolean {
  const branchName = workspaceBranchName?.trim();
  if (!branchName) return false;
  return /sup-[0-9]+/i.test(branchName);
}

/**
 * SUP-15231: is a parent-sourced workspace binding EXEMPT from the SUP-15205
 * branch-identity inheritance decline?
 *
 * The sanctioned `shared_workspace` plan carrier is the one legitimate shape a
 * parent-sourced row can have. TSP's project policy defaults every card to
 * `shared_workspace`, and the plan parent sources the carrier row that its
 * children deliver onto. `merge-arming.ts` keys `branchIsOwn` on
 * `workspaceRow.sourceIssueId === issueId`, so the parent — and only the
 * parent — can lawfully mint `paperclip/approved` on the carrier PR; the
 * children close nested and the parent lands the branch once through its own
 * ladder. Declining that binding pushes every open child onto a fresh
 * `baseRef: origin/main` workspace that lacks the carrier content, deadlocking
 * the parent's ladder. (The 7 commits on #3443 and 3 on #3446 were all pushed
 * by children through deliver.sh — the carrier branch is real, shared content,
 * not a strand.)
 *
 * The exemption fires iff BOTH hold:
 *   1. the source row's mode is `shared_workspace`, and
 *   2. its `sourceIssueId` is a strict ancestor of the issue being bound
 *       (the caller walks the issues parent chain and supplies the verdict).
 *
 * An `isolated_workspace` / `operator_branch` row sourced by a parent — the
 * defect SUP-15205 exists to fix — is NOT exempt. A `shared_workspace` row
 * sourced by a sibling or an unrelated card (not an ancestor) is NOT exempt.
 * Self-sourced and sourceless bindings never reach here: they restore as
 * before and are outside the gate's scope.
 */
export function inheritedExecutionWorkspaceBranchExempt(input: {
  workspaceMode?: string | null;
  workspaceSourceIssueId?: string | null;
  sourceIssueIsAncestorOfBoundIssue?: boolean;
}): boolean {
  if (input.workspaceMode !== "shared_workspace") return false;
  const sourceIssueId = input.workspaceSourceIssueId?.trim();
  if (!sourceIssueId) return false;
  return input.sourceIssueIsAncestorOfBoundIssue === true;
}

/**
 * SUP-15205 (narrowed by SUP-15231): should a `reuse_existing` binding be
 * declined because it would restore this issue onto another issue's delivery
 * branch?
 *
 * Default inheritance copies the parent's workspace binding onto a child, and
 * the restore arm then reads the parent's recorded branch verbatim, so the
 * child's work lands on a branch that names a different SUP id. For an
 * `isolated_workspace` / `operator_branch` row that is a defect: the child
 * would sit on a branch the parent merges and deletes, and no approval can
 * lawfully stamp it for the child. The child must realize its own workspace
 * instead.
 *
 * The one sanctioned exception is the `shared_workspace` plan carrier (see
 * `inheritedExecutionWorkspaceBranchExempt`): a `shared_workspace` row sourced
 * by an ANCESTOR of this issue is the shared branch the plan's children are
 * meant to build on, so it restores as before.
 *
 * This is the provisioning-side backstop; the authoritative decline happens at
 * the inheritance site (issues.ts) which knows the binding is implicit. The
 * branch discriminator is the shared source of truth: a branch that does not
 * name a foreign per-card sup id — `feature/foo`, a release branch — is out of
 * the gate's scope and restores as before, so legitimate shared-branch reuse is
 * unaffected. A binding to a sourceless or self-sourced workspace is an
 * operator opt-in or a resumption of the issue's own workspace and is left
 * alone: restoring it is the counterpart of deliver.sh's explicit out-of-scope
 * override.
 */
export function inheritedExecutionWorkspaceBranchDeclined(input: {
  issueId: string | null;
  issueIdentifier?: string | null;
  workspaceSourceIssueId?: string | null;
  workspaceBranchName?: string | null;
  workspaceMode?: string | null;
  sourceIssueIsAncestorOfBoundIssue?: boolean;
}): boolean {
  if (
    inheritedExecutionWorkspaceBranchExempt({
      workspaceMode: input.workspaceMode,
      workspaceSourceIssueId: input.workspaceSourceIssueId,
      sourceIssueIsAncestorOfBoundIssue: input.sourceIssueIsAncestorOfBoundIssue,
    })
  ) {
    return false;
  }
  const sourceIssueId = input.workspaceSourceIssueId?.trim();
  if (!sourceIssueId || sourceIssueId === input.issueId) return false;
  return executionWorkspaceBranchNamesDifferentIssue({
    issueIdentifier: input.issueIdentifier,
    workspaceBranchName: input.workspaceBranchName,
  });
}

/**
 * Does THIS write supply an issue-level execution-workspace override?
 *
 * The question is about the fields THIS write carries — NOT about the issue's
 * persisted state. `provisionIssueExecutionWorkspace` writes
 * `executionWorkspaceId` back onto every issue it provisions, and
 * `executionWorkspacePreference: "reuse_existing"` for isolated/operator_branch
 * modes, so after one run every issue carries a binding that is
 * indistinguishable from an operator override if you only look at the row. A
 * predicate reading persisted state rejects the SECOND run of every issue in an
 * `allowIssueOverride: false` project, even though the project's own
 * `defaultMode` produced the binding.
 *
 * Only the write boundary can tell the two apart: there, an operator supplying
 * the field is observable, and provisioning's system write-back opts out via
 * `systemWorkspaceBinding`.
 *
 * `null` counts as NOT supplying an override, for two reasons. Clearing an
 * override is not itself an override, so refusing it would trap an issue in the
 * very state the project forbids. And several callers normalize with `?? null`
 * (routines `dispatchRoutineRun`, pipeline stage-entry automations), so the key
 * is present-but-null on every routine-created issue even when nothing was
 * configured — keying on presence alone would reject all of them.
 */
export function suppliesIssueExecutionWorkspaceOverride(input: {
  executionWorkspacePreference?: string | null;
  executionWorkspaceId?: string | null;
}): boolean {
  if (input.executionWorkspaceId) return true;
  const preference = input.executionWorkspacePreference;
  // "inherit" explicitly defers to the project policy — the opposite of an override.
  return Boolean(preference && preference !== "inherit");
}

export function isUnrunnableWorktreeCombo(input: {
  issue: UnrunnableWorktreeIssueRef;
  resolvedMode: ParsedExecutionWorkspaceMode;
  resolvedStrategy: string | null | undefined;
  reusableExecutionWorkspaceAvailable?: boolean | null;
  hasResolvablePriorSessionWorkspace?: boolean | null;
}): boolean {
  if (input.resolvedMode !== "isolated_workspace" && input.resolvedMode !== "operator_branch") return false;
  if (input.resolvedStrategy !== "git_worktree") return false;
  if (input.issue.projectId || input.issue.projectWorkspaceId) return false;
  const hasReusableWorkspace =
    input.reusableExecutionWorkspaceAvailable ?? hasReusableExecutionWorkspaceBinding(input.issue);
  if (hasReusableWorkspace) return false;
  return input.hasResolvablePriorSessionWorkspace !== true;
}

export function canAgentSatisfyIssueWorkspaceSettings(input: {
  issue: UnrunnableWorktreeIssueRef;
  executionWorkspaceSettings: unknown;
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  reusableExecutionWorkspaceAvailable?: boolean | null;
  hasResolvablePriorSessionWorkspace?: boolean | null;
  agentConfig?: Record<string, unknown> | null;
}): boolean {
  const settings = parseIssueExecutionWorkspaceSettings(input.executionWorkspaceSettings);
  const mode = settings?.mode;
  if (mode !== "isolated_workspace" && mode !== "operator_branch") return true;

  const resolvedMode = mode as ParsedExecutionWorkspaceMode;
  // Resolve the candidate's effective strategy exactly the way dispatch does: the agent's
  // adapterConfig is the LOWEST-precedence input, below the issue settings and the project
  // policy. Comparing the candidate's raw adapterConfig against the issue strategy instead
  // would reject every agent whose config does not restate the strategy — including the
  // common `adapterConfig: {}` agent, which dispatch resolves to the issue/project strategy
  // and runs without complaint.
  const candidateWorkspaceConfig = buildExecutionWorkspaceAdapterConfig({
    agentConfig: input.agentConfig ?? {},
    projectPolicy: input.projectPolicy,
    issueSettings: settings,
    mode: resolvedMode,
    legacyUseProjectWorkspace: null,
  });
  // SUP-13100 (reverted, ruling in SUP-13100 round-4): a previous revision preferred the
  // strategyType persisted on the bound `execution_workspaces` row over this derivation.
  // That override was provably dead code. It only engaged when
  // `hasReusableExecutionWorkspaceBinding(issue)` was true, and for exactly those inputs
  // `isUnrunnableWorktreeCombo` already short-circuits to "capable" on its reusable-workspace
  // check — the ladder (recovery/service.ts) passes no `reusableExecutionWorkspaceAvailable`,
  // so that check falls back to the same binding predicate. Measured: 540 ladder-reachable
  // input combinations × 4 bound strategyType values produced zero divergence in the return
  // value. Do not reintroduce it without first making the call site pass an explicit
  // `reusableExecutionWorkspaceAvailable`.
  const resolvedStrategy = resolveEffectiveWorkspaceStrategyType(resolvedMode, candidateWorkspaceConfig);

  return !isUnrunnableWorktreeCombo({
    issue: input.issue,
    resolvedMode,
    resolvedStrategy,
    reusableExecutionWorkspaceAvailable: input.reusableExecutionWorkspaceAvailable,
    hasResolvablePriorSessionWorkspace: input.hasResolvablePriorSessionWorkspace,
  });
}

export function parseProjectExecutionWorkspacePolicy(raw: unknown): ProjectExecutionWorkspacePolicy | null {
  const parsed = parseObject(raw);
  if (Object.keys(parsed).length === 0) return null;
  const enabled = typeof parsed.enabled === "boolean" ? parsed.enabled : false;
  const workspaceStrategy = parseExecutionWorkspaceStrategy(parsed.workspaceStrategy);
  const defaultMode = asString(parsed.defaultMode, "");
  const defaultProjectWorkspaceId =
    typeof parsed.defaultProjectWorkspaceId === "string" ? parsed.defaultProjectWorkspaceId : undefined;
  const allowIssueOverride =
    typeof parsed.allowIssueOverride === "boolean" ? parsed.allowIssueOverride : undefined;
  const sharedWorkspaceConcurrency = parseSharedWorkspaceConcurrency(parsed.sharedWorkspaceConcurrency);
  const normalizedDefaultMode = (() => {
    if (
      defaultMode === "shared_workspace" ||
      defaultMode === "isolated_workspace" ||
      defaultMode === "operator_branch" ||
      defaultMode === "adapter_default"
    ) {
      return defaultMode as ProjectExecutionWorkspaceDefaultMode;
    }
    if (defaultMode === "project_primary") return "shared_workspace";
    if (defaultMode === "isolated") return "isolated_workspace";
    return undefined;
  })();
  return {
    enabled,
    ...(sharedWorkspaceConcurrency ? { sharedWorkspaceConcurrency } : {}),
    ...(normalizedDefaultMode ? { defaultMode: normalizedDefaultMode } : {}),
    ...(allowIssueOverride !== undefined ? { allowIssueOverride } : {}),
    ...(defaultProjectWorkspaceId ? { defaultProjectWorkspaceId } : {}),
    ...(workspaceStrategy ? { workspaceStrategy } : {}),
    ...(parsed.workspaceRuntime && typeof parsed.workspaceRuntime === "object" && !Array.isArray(parsed.workspaceRuntime)
      ? { workspaceRuntime: { ...(parsed.workspaceRuntime as Record<string, unknown>) } }
      : {}),
    ...(parsed.branchPolicy && typeof parsed.branchPolicy === "object" && !Array.isArray(parsed.branchPolicy)
      ? { branchPolicy: { ...(parsed.branchPolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.pullRequestPolicy && typeof parsed.pullRequestPolicy === "object" && !Array.isArray(parsed.pullRequestPolicy)
      ? { pullRequestPolicy: { ...(parsed.pullRequestPolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.runtimePolicy && typeof parsed.runtimePolicy === "object" && !Array.isArray(parsed.runtimePolicy)
      ? { runtimePolicy: { ...(parsed.runtimePolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.cleanupPolicy && typeof parsed.cleanupPolicy === "object" && !Array.isArray(parsed.cleanupPolicy)
      ? { cleanupPolicy: { ...(parsed.cleanupPolicy as Record<string, unknown>) } }
      : {}),
    ...(parsed.authorizationPolicy && typeof parsed.authorizationPolicy === "object" && !Array.isArray(parsed.authorizationPolicy)
      ? { authorizationPolicy: { ...(parsed.authorizationPolicy as Record<string, unknown>) } }
      : {}),
  };
}

export function gateProjectExecutionWorkspacePolicy(
  projectPolicy: ProjectExecutionWorkspacePolicy | null,
  isolatedWorkspacesEnabled: boolean,
): ProjectExecutionWorkspacePolicy | null {
  if (!isolatedWorkspacesEnabled) return null;
  return projectPolicy;
}

type ParseIssueExecutionWorkspaceSettingsOptions = {
  includeEnvironmentId?: boolean;
};

export function parseIssueExecutionWorkspaceSettings(
  raw: unknown,
  options: ParseIssueExecutionWorkspaceSettingsOptions = {},
): IssueExecutionWorkspaceSettings | null {
  const parsed = parseObject(raw);
  if (Object.keys(parsed).length === 0) return null;
  const workspaceStrategy = parseExecutionWorkspaceStrategy(parsed.workspaceStrategy);
  const sharedWorkspaceConcurrency = parseSharedWorkspaceConcurrency(parsed.sharedWorkspaceConcurrency);
  const mode = asString(parsed.mode, "");
  const normalizedMode = (() => {
    if (
      mode === "inherit" ||
      mode === "shared_workspace" ||
      mode === "isolated_workspace" ||
      mode === "operator_branch" ||
      mode === "reuse_existing" ||
      mode === "agent_default"
    ) {
      return mode;
    }
    if (mode === "project_primary") return "shared_workspace";
    if (mode === "isolated") return "isolated_workspace";
    return "";
  })();
  const networkEgress = parseObject(parsed.networkEgress);
  const allowFqdns = Array.isArray(networkEgress.allowFqdns)
    ? networkEgress.allowFqdns
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim().toLowerCase())
    : [];
  const allowCidrs = Array.isArray(networkEgress.allowCidrs)
    ? networkEgress.allowCidrs
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim())
    : [];
  return {
    ...(normalizedMode
      ? { mode: normalizedMode as IssueExecutionWorkspaceSettings["mode"] }
      : {}),
    ...(sharedWorkspaceConcurrency ? { sharedWorkspaceConcurrency } : {}),
    ...(options.includeEnvironmentId && (typeof parsed.environmentId === "string" || parsed.environmentId === null)
      ? { environmentId: parsed.environmentId }
      : {}),
    ...(workspaceStrategy ? { workspaceStrategy } : {}),
    ...(parsed.workspaceRuntime && typeof parsed.workspaceRuntime === "object" && !Array.isArray(parsed.workspaceRuntime)
      ? { workspaceRuntime: { ...(parsed.workspaceRuntime as Record<string, unknown>) } }
      : {}),
    ...(allowFqdns.length > 0 || allowCidrs.length > 0
      ? { networkEgress: { allowFqdns, allowCidrs } }
      : {}),
  };
}

export function selectEnvironmentExecutionWorkspaceSettings(
  parsedSettings: IssueExecutionWorkspaceSettings | null,
  isolatedWorkspacesEnabled: boolean,
): IssueExecutionWorkspaceSettings | null {
  if (!parsedSettings) return null;
  if (isolatedWorkspacesEnabled) return parsedSettings;
  return parsedSettings.networkEgress
    ? { networkEgress: parsedSettings.networkEgress }
    : null;
}

export type ExecutionWorkspaceEnvironmentSource =
  | "agent"
  | "instance"
  | "default"
  | "managed";

export type ExecutionWorkspaceEnvironmentResolution = {
  environmentId: string;
  source: ExecutionWorkspaceEnvironmentSource;
};

export class ManagedSandboxUnavailableError extends Error {
  constructor() {
    super(
      "This instance runs agents only in its platform-managed sandbox environment " +
        "(managed sandbox only), but no active managed sandbox environment exists — " +
        "its provider plugin may be unavailable. Refusing to fall back to local execution.",
    );
    this.name = "ManagedSandboxUnavailableError";
  }
}

export function resolveExecutionWorkspaceEnvironmentId(input: {
  agentDefaultEnvironmentId: string | null;
  instanceDefaultEnvironmentId: string | null;
  localDefaultEnvironmentId: string;
  /**
   * Managed-sandbox-only policy (`enableManagedSandboxOnly`): any selection
   * that lands on the local environment is redirected to the managed
   * sandbox environment instead, and with no managed environment available
   * the resolution fails closed — never local. Non-local selections (ssh,
   * user-created sandboxes) are untouched: the policy hides local, it does
   * not forbid other environments.
   */
  managedSandboxOnly?: boolean;
  managedSandboxEnvironmentId?: string | null;
}): ExecutionWorkspaceEnvironmentResolution {
  const resolved = ((): ExecutionWorkspaceEnvironmentResolution => {
    if (input.agentDefaultEnvironmentId) {
      return {
        environmentId: input.agentDefaultEnvironmentId,
        source: "agent",
      };
    }
    if (input.instanceDefaultEnvironmentId) {
      return {
        environmentId: input.instanceDefaultEnvironmentId,
        source: "instance",
      };
    }
    return {
      environmentId: input.localDefaultEnvironmentId,
      source: "default",
    };
  })();
  if (input.managedSandboxOnly !== true || resolved.environmentId !== input.localDefaultEnvironmentId) {
    return resolved;
  }
  if (!input.managedSandboxEnvironmentId) {
    throw new ManagedSandboxUnavailableError();
  }
  return { environmentId: input.managedSandboxEnvironmentId, source: "managed" };
}

export function defaultIssueExecutionWorkspaceSettingsForProject(
  projectPolicy: ProjectExecutionWorkspacePolicy | null,
): IssueExecutionWorkspaceSettings | null {
  if (!projectPolicy?.enabled) return null;
  return {
    mode:
      projectPolicy.defaultMode === "isolated_workspace"
        ? "isolated_workspace"
        : projectPolicy.defaultMode === "operator_branch"
          ? "operator_branch"
          : projectPolicy.defaultMode === "adapter_default"
            ? "agent_default"
            : "shared_workspace",
  };
}

export function issueExecutionWorkspaceModeForPersistedWorkspace(
  mode: string | null | undefined,
): IssueExecutionWorkspaceSettings["mode"] {
  if (mode === null || mode === undefined) {
    return "agent_default";
  }
  if (mode === "isolated_workspace" || mode === "operator_branch" || mode === "shared_workspace") {
    return mode;
  }
  if (mode === "adapter_managed" || mode === "cloud_sandbox") {
    return "agent_default";
  }
  return "shared_workspace";
}

export function resolveExecutionWorkspaceMode(input: {
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  issueSettings: IssueExecutionWorkspaceSettings | null;
  legacyUseProjectWorkspace: boolean | null;
}): ParsedExecutionWorkspaceMode {
  const effectiveIssueSettings = input.projectPolicy?.allowIssueOverride === false ? null : input.issueSettings;
  const issueMode = effectiveIssueSettings?.mode;
  if (issueMode && issueMode !== "inherit" && issueMode !== "reuse_existing") {
    return issueMode;
  }
  if (input.projectPolicy?.enabled) {
    if (input.projectPolicy.defaultMode === "isolated_workspace") return "isolated_workspace";
    if (input.projectPolicy.defaultMode === "operator_branch") return "operator_branch";
    if (input.projectPolicy.defaultMode === "adapter_default") return "agent_default";
    return "shared_workspace";
  }
  if (input.legacyUseProjectWorkspace === false) {
    return "agent_default";
  }
  return "shared_workspace";
}

function parseSharedWorkspaceConcurrency(raw: unknown): SharedWorkspaceConcurrency | undefined {
  return raw === "auto" || raw === "serialize" || raw === "allow" ? raw : undefined;
}

export function resolveSharedWorkspaceConcurrency(input: {
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  issueSettings: IssueExecutionWorkspaceSettings | null;
}): SharedWorkspaceConcurrency {
  const effectiveIssueSettings = input.projectPolicy?.allowIssueOverride === false ? null : input.issueSettings;
  return effectiveIssueSettings?.sharedWorkspaceConcurrency
    ?? (input.projectPolicy?.enabled ? input.projectPolicy.sharedWorkspaceConcurrency : undefined)
    ?? "auto";
}

export function buildExecutionWorkspaceAdapterConfig(input: {
  agentConfig: Record<string, unknown>;
  projectPolicy: ProjectExecutionWorkspacePolicy | null;
  issueSettings: IssueExecutionWorkspaceSettings | null;
  mode: ParsedExecutionWorkspaceMode;
  legacyUseProjectWorkspace: boolean | null;
}): Record<string, unknown> {
  const nextConfig = { ...input.agentConfig };
  const effectiveIssueSettings = input.projectPolicy?.allowIssueOverride === false ? null : input.issueSettings;
  const projectHasPolicy = Boolean(input.projectPolicy?.enabled);
  const issueHasWorkspaceOverrides = Boolean(
    effectiveIssueSettings?.mode ||
    effectiveIssueSettings?.workspaceStrategy ||
    effectiveIssueSettings?.workspaceRuntime,
  );
  const hasWorkspaceControl = projectHasPolicy || issueHasWorkspaceOverrides || input.legacyUseProjectWorkspace === false;

  if (hasWorkspaceControl) {
    if (input.mode === "isolated_workspace") {
      const strategy =
        effectiveIssueSettings?.workspaceStrategy ??
        input.projectPolicy?.workspaceStrategy ??
        parseExecutionWorkspaceStrategy(nextConfig.workspaceStrategy) ??
        ({ type: "git_worktree" } satisfies ExecutionWorkspaceStrategy);
      nextConfig.workspaceStrategy = strategy as unknown as Record<string, unknown>;
    } else {
      delete nextConfig.workspaceStrategy;
    }

    if (input.mode === "agent_default") {
      delete nextConfig.workspaceRuntime;
    } else if (effectiveIssueSettings?.workspaceRuntime) {
      nextConfig.workspaceRuntime = cloneRecord(effectiveIssueSettings.workspaceRuntime) ?? undefined;
    } else if (input.projectPolicy?.workspaceRuntime) {
      nextConfig.workspaceRuntime = cloneRecord(input.projectPolicy.workspaceRuntime) ?? undefined;
    }
  }

  return nextConfig;
}
