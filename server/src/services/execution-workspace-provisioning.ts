import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import type {
  Environment,
  ExecutionWorkspace,
  ExecutionWorkspaceConfig,
} from "@paperclipai/shared";
import { parseObject } from "../adapters/utils.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
import { logger } from "../middleware/logger.js";
import { unprocessable } from "../errors.js";
import {
  assertGitWorktreeBaseWorkspaceReady,
  assertProjectPrimaryBaseWorkspaceReady,
  buildEffectiveRunSessionConfigMetadata,
  buildEffectiveRunWorkspaceConfigMetadata,
  mergeExecutionWorkspaceMetadataForPersistence,
  provisionExecutionWorkspaceForFreshnessDecision,
  readExecutionWorkspaceOccupancyDeferrals,
  reconcileReusedExecutionWorkspaceProjectWorkspaceId,
  recordWorkspaceConfigFreshnessOperation,
  resolveExecutionWorkspaceConfigFreshness,
  resolveExecutionWorkspaceOccupancyDecision,
  resolveExecutionWorkspaceReuseProvisioningPolicy,
  resolveExecutionWorkspaceReuseRequestForIssue,
  resolveTaskSessionConfigFreshness,
  resolveWorkspaceAfterLowTrustPreflight,
  stripHostWorkspaceProvisionForLowTrustSandbox,
  type ResolvedWorkspaceForRun,
  type WorkspaceConfigFreshnessOperationInput,
} from "./heartbeat.js";
import { createGitRemoteAuthProvider } from "./git-credentials.js";
import {
  readManagedWorktreeInstanceOwnership,
  WORKTREE_INSTANCE_ROOT_METADATA_KEY,
} from "./workspace-instance-cleanup.js";
import { environmentRuntimeService, type EnvironmentRuntimeService } from "./environment-runtime.js";
import { environmentRunOrchestrator } from "./environment-run-orchestrator.js";
import {
  detachIssuesFromClosedSharedExecutionWorkspace,
  executionWorkspaceService,
} from "./execution-workspaces.js";
import {
  hasExplicitIssueExecutionWorkspaceOverride,
  issueExecutionWorkspaceModeForPersistedWorkspace,
  resolveEffectiveWorkspaceStrategyType,
  WORKSPACE_ISSUE_OVERRIDE_DISALLOWED_CODE,
  WORKSPACE_ISSUE_OVERRIDE_DISALLOWED_MESSAGE,
  WORKSPACE_ISSUE_OVERRIDE_DISALLOWED_REMEDIATION,
  type ParsedExecutionWorkspaceMode,
} from "./execution-workspace-policy.js";
import { issueService } from "./issues.js";
import { environmentService } from "./environments.js";
import type { TrustPresetResolution } from "./trust-preset-resolver.js";
import {
  cleanupExecutionWorkspaceArtifacts,
  ensurePersistedExecutionWorkspaceAvailable,
  realizeExecutionWorkspace,
  type ExecutionWorkspaceInput,
  type RealizedExecutionWorkspace,
} from "./workspace-runtime.js";
import {
  workspaceOperationService,
  type WorkspaceOperationRecorder,
} from "./workspace-operations.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";
import type { EffectiveRunConfigSecretManifestEntry } from "./effective-run-config-fingerprints.js";
import type { ProjectExecutionWorkspacePolicy } from "@paperclipai/shared";

type AgentRow = typeof agents.$inferSelect;
type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

export interface ExecutionWorkspaceProvisioningIssueRef {
  id: string;
  identifier: string | null;
  title: string | null;
  status: string | null;
  priority: string | null;
  workMode: string | null;
  description: string | null;
  projectId: string | null;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  executionWorkspacePreference: string | null;
}

export interface ExecutionWorkspaceProvisioningProjectContext {
  id: string;
  executionWorkspacePolicy: unknown;
  env: unknown;
  updatedAt: Date | string | null;
}

export interface ExecutionWorkspaceProvisioningResolvedInstanceSettings {
  experimental: {
    enableWorkspaceBranchReconcileForward: boolean;
    enableWorkspaceDirtyQuarantineRepair: boolean;
  };
}

export interface ExecutionWorkspaceProvisioningRunLifecycle {
  onExecutionWorkspaceOccupied: (input: {
    run: HeartbeatRun;
    workspaceOccupancy: WorkspaceOccupancy | null;
    workspaceOccupancyDecision: WorkspaceOccupancyDecision;
    workspaceReuseRequest: WorkspaceReuseRequest;
  }) => Promise<void>;
  onProvisionFresh?: (input: {
    run: HeartbeatRun;
    issueRef: ExecutionWorkspaceProvisioningIssueRef | null;
    issueId: string | null;
    workspaceOccupancy: WorkspaceOccupancy | null;
    deferrals: number;
  }) => Promise<void>;
}

export interface ExecutionWorkspaceProvisioningInput {
  db: Db;
  run: HeartbeatRun;
  agent: AgentRow;
  issueId: string | null;
  issueRef: ExecutionWorkspaceProvisioningIssueRef | null;
  runId: string;
  effectiveExecutionWorkspaceMode: ParsedExecutionWorkspaceMode;
  trustPreset: TrustPresetResolution;
  isolatedWorkspacesEnabled: boolean;
  selectedEnvironmentId: string | null;
  selectedEnvironmentForConfig: Environment | null;
  localEnvironment: Environment;
  environmentSelectionSource: string;
  configSnapshot: Partial<ExecutionWorkspaceConfig> | null;
  secretManifest: readonly EffectiveRunConfigSecretManifestEntry[];
  projectExecutionWorkspacePolicy: ProjectExecutionWorkspacePolicy | null;
  issueExecutionWorkspaceSettings: Record<string, unknown> | null;
  executionProjectId: string | null;
  resolvedInstanceSettings: ExecutionWorkspaceProvisioningResolvedInstanceSettings;
  mergedConfig: Record<string, unknown>;
  executionPolicy: { executionMode: string };
  context: Record<string, unknown>;
  resolveWorkspace: (
    previousSessionParams: Record<string, unknown> | null,
  ) => Promise<ResolvedWorkspaceForRun>;
  resolveSessionConfig: (input: {
    requestedShouldReuseExisting: boolean;
    reusableExistingExecutionWorkspace: ExecutionWorkspace | null;
    requestedReusableExecutionWorkspaceConfig: ExecutionWorkspaceConfig | null;
  }) => Promise<{
    previousSessionParams: Record<string, unknown> | null;
    resetTaskSession: boolean;
    sessionResetReason: string | null;
    sessionConfigFreshness: ReturnType<typeof resolveTaskSessionConfigFreshness>;
    sessionConfigMetadata: Awaited<ReturnType<typeof buildEffectiveRunSessionConfigMetadata>>;
  }>;
  runLifecycle: ExecutionWorkspaceProvisioningRunLifecycle;
}

// Re-exported rather than redeclared. This module was extracted out of
// heartbeat.ts, and a structural copy of the resolved-workspace shape silently
// drifts every time upstream extends the original -- the 2026-08-14 fold added
// `additionalWorkspaces` and `referencedProjectFailures` there, and a duplicate
// would have dropped both without a type error at the seam.
export type { ResolvedWorkspaceForRun };

type WorkspaceReuseRequest = ReturnType<typeof resolveExecutionWorkspaceReuseRequestForIssue>;

type WorkspaceOccupancy = NonNullable<
  Awaited<ReturnType<ReturnType<typeof executionWorkspaceService>["findActiveRunOccupyingWorkspace"]>>
>;

type WorkspaceOccupancyDecision = ReturnType<typeof resolveExecutionWorkspaceOccupancyDecision>;

type WorkspaceConfigFreshness = ReturnType<typeof resolveExecutionWorkspaceConfigFreshness>;

type WorkspaceReuseProvisioningPolicy = ReturnType<
  typeof resolveExecutionWorkspaceReuseProvisioningPolicy
>;

export interface ProvisionedIssueExecutionWorkspace {
  kind: "provisioned";
  executionWorkspace: RealizedExecutionWorkspace;
  resolvedWorkspace: ResolvedWorkspaceForRun;
  persistedExecutionWorkspace: ExecutionWorkspace | null;
  resolvedProjectId: string | null;
  resolvedProjectWorkspaceId: string | null;
   requestedShouldReuseExisting: boolean;
   requestedReusableExecutionWorkspaceConfig: ExecutionWorkspaceConfig | null;
   reusableExistingExecutionWorkspace: ExecutionWorkspace | null;
   hostExecutionWorkspaceConfig: Record<string, unknown>;
   sessionConfigMetadata: Awaited<ReturnType<typeof buildEffectiveRunSessionConfigMetadata>>;
   latestWorkspaceConfigMetadata: Awaited<ReturnType<typeof buildEffectiveRunWorkspaceConfigMetadata>>;
   reusedExecutionWorkspace: RealizedExecutionWorkspace | null;
   workspaceReuseRequest: WorkspaceReuseRequest;
   workspaceConfigFreshness: WorkspaceConfigFreshness;
  resolvedWorkspaceReusePolicy: WorkspaceReuseProvisioningPolicy;
  workspaceOperationRecorder: WorkspaceOperationRecorder;
  resetTaskSession: boolean;
  sessionResetReason: string | null;
  sessionConfigFreshness: ReturnType<typeof resolveTaskSessionConfigFreshness>;
  previousSessionParams: Record<string, unknown> | null;
}

export interface DeferredIssueExecutionWorkspace {
  kind: "deferred";
}

export type ProvisionIssueExecutionWorkspaceResult =
  | ProvisionedIssueExecutionWorkspace
  | DeferredIssueExecutionWorkspace;

export interface ProvisionIssueExecutionWorkspaceOptions {
  pluginWorkerManager?: PluginWorkerManager;
  environmentRuntime?: EnvironmentRuntimeService;
}

export async function provisionIssueExecutionWorkspace(
  input: ExecutionWorkspaceProvisioningInput & ProvisionIssueExecutionWorkspaceOptions,
): Promise<ProvisionIssueExecutionWorkspaceResult> {
  const db = input.db;
  const run = input.run;
  const agent = input.agent;
  const issueId = input.issueId;
  const issueRef = input.issueRef;

  if (
    input.projectExecutionWorkspacePolicy?.allowIssueOverride === false &&
    hasExplicitIssueExecutionWorkspaceOverride({
      executionWorkspacePreference: issueRef?.executionWorkspacePreference ?? null,
      executionWorkspaceId: issueRef?.executionWorkspaceId ?? null,
    })
  ) {
    throw unprocessable(WORKSPACE_ISSUE_OVERRIDE_DISALLOWED_MESSAGE, {
      code: WORKSPACE_ISSUE_OVERRIDE_DISALLOWED_CODE,
      remediation: WORKSPACE_ISSUE_OVERRIDE_DISALLOWED_REMEDIATION,
      field: "executionWorkspacePolicy.allowIssueOverride",
    });
  }

  const issuesSvc = issueService(db);
  const executionWorkspacesSvc = executionWorkspaceService(db);
  const environmentsSvc = environmentService(db);
  const workspaceOperationsSvc = workspaceOperationService(db);
  const environmentRuntime =
    input.environmentRuntime ??
    environmentRuntimeService(db, { pluginWorkerManager: input.pluginWorkerManager });
  const envOrchestrator = environmentRunOrchestrator(db, {
    pluginWorkerManager: input.pluginWorkerManager,
    environmentRuntime,
  });

  const requestedExecutionWorkspaceId = readNonEmptyString(issueRef?.executionWorkspaceId);
  const existingExecutionWorkspace = requestedExecutionWorkspaceId
    ? await executionWorkspacesSvc.getById(requestedExecutionWorkspaceId)
    : null;

  const existingExecutionWorkspaceDirectoryExists = await (async () => {
    if (existingExecutionWorkspace?.status !== "archived") return null;
    const workspaceCwd = readNonEmptyString(existingExecutionWorkspace?.cwd);
    if (!workspaceCwd) return null;
    try {
      const stat = await fs.stat(workspaceCwd);
      return stat.isDirectory();
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return false;
      return null;
    }
  })();

  const workspaceReuseRequest = resolveExecutionWorkspaceReuseRequestForIssue({
    issueExecutionWorkspaceId: requestedExecutionWorkspaceId,
    issueExecutionWorkspacePreference: issueRef?.executionWorkspacePreference ?? null,
    existingExecutionWorkspaceStatus: existingExecutionWorkspace?.status ?? null,
    existingExecutionWorkspaceCleanupReason: existingExecutionWorkspace?.cleanupReason ?? null,
    existingExecutionWorkspaceDirectoryExists,
  });

  if (workspaceReuseRequest.bindingUnrestorable && requestedExecutionWorkspaceId) {
    await detachIssuesFromClosedSharedExecutionWorkspace(db, {
      companyId: agent.companyId,
      executionWorkspaceId: requestedExecutionWorkspaceId,
    });
    logger.warn(
      {
        runId: run.id,
        issueId: issueRef?.id ?? null,
        issueIdentifier: issueRef?.identifier ?? null,
        executionWorkspaceId: requestedExecutionWorkspaceId,
        cleanupReason: existingExecutionWorkspace?.cleanupReason ?? null,
      },
      "Cleared a reuse_existing binding to an execution workspace whose directory was removed by platform cleanup; provisioning a fresh workspace for this run",
    );
  }

  const workspaceOccupancy =
    workspaceReuseRequest.requestedShouldReuseExisting && workspaceReuseRequest.requestedExecutionWorkspaceId
      ? await executionWorkspacesSvc.findActiveRunOccupyingWorkspace({
          companyId: agent.companyId,
          executionWorkspaceId: workspaceReuseRequest.requestedExecutionWorkspaceId,
          excludingIssueId: issueId,
          excludingRunId: run.id,
          contenderRunCreatedAt: run.createdAt ?? null,
        })
      : null;

  const workspaceOccupancyDecision = resolveExecutionWorkspaceOccupancyDecision({
    reuseRequested: workspaceReuseRequest.requestedShouldReuseExisting,
    occupied: workspaceOccupancy !== null,
    priorDeferrals: readExecutionWorkspaceOccupancyDeferrals(run),
  });

  if (workspaceOccupancyDecision.action === "defer") {
    await input.runLifecycle.onExecutionWorkspaceOccupied({
      run,
      workspaceOccupancy,
      workspaceOccupancyDecision,
      workspaceReuseRequest,
    });
    return { kind: "deferred" };
  }

  const requestedShouldReuseExisting =
    workspaceOccupancyDecision.action === "provision_fresh"
      ? false
      : workspaceReuseRequest.requestedShouldReuseExisting;

  if (workspaceOccupancyDecision.action === "provision_fresh") {
    logger.warn(
      {
        runId: run.id,
        issueId,
        issueIdentifier: issueRef?.identifier ?? null,
        executionWorkspaceId: workspaceReuseRequest.requestedExecutionWorkspaceId,
        occupiedByRunId: workspaceOccupancy?.runId ?? null,
        occupiedByIssueId: workspaceOccupancy?.issueId ?? null,
        deferrals: workspaceOccupancyDecision.deferrals,
      },
      "execution workspace stayed occupied for the whole wait budget; provisioning a fresh workspace instead of sharing a worktree with another issue's run",
    );
    await input.runLifecycle.onProvisionFresh?.({
      run,
      issueRef,
      issueId,
      workspaceOccupancy,
      deferrals: workspaceOccupancyDecision.deferrals,
    });
  }

  const reusableExistingExecutionWorkspace =
    requestedShouldReuseExisting && workspaceReuseRequest.existingExecutionWorkspaceAvailable
      ? existingExecutionWorkspace
      : null;
  const requestedReusableExecutionWorkspaceConfig = reusableExistingExecutionWorkspace?.config ?? null;

  const {
    previousSessionParams,
    resetTaskSession,
    sessionResetReason,
    sessionConfigFreshness,
    sessionConfigMetadata,
  } = await input.resolveSessionConfig({
    requestedShouldReuseExisting,
    reusableExistingExecutionWorkspace,
    requestedReusableExecutionWorkspaceConfig,
  });

  const effectiveExecutionWorkspaceMode = input.effectiveExecutionWorkspaceMode;

  const { selectedEnvironmentDriver: lowTrustPreflightEnvironmentDriver, workspace: resolvedWorkspace } =
    await resolveWorkspaceAfterLowTrustPreflight({
      db,
      trustPreset: input.trustPreset,
      isolatedWorkspacesEnabled: input.isolatedWorkspacesEnabled,
      effectiveExecutionWorkspaceMode,
      issue: issueRef
        ? {
            companyId: agent.companyId,
            id: issueRef.id,
            projectId: issueRef.projectId,
          }
        : null,
      resolveSelectedEnvironmentDriver: async () => {
        const preflightEnvironment = await envOrchestrator.resolveEnvironment({
          companyId: agent.companyId,
          selectedEnvironmentId: input.selectedEnvironmentId ?? input.localEnvironment.id,
          localEnvironmentId: input.localEnvironment.id,
        });
        return preflightEnvironment.driver;
      },
      resolveWorkspace: () => input.resolveWorkspace(previousSessionParams),
    });

  const hostExecutionWorkspaceConfig = stripHostWorkspaceProvisionForLowTrustSandbox({
    config: {
      workspaceStrategy: input.projectExecutionWorkspacePolicy?.workspaceStrategy,
      ...input.mergedConfig,
    },
    trustPreset: input.trustPreset,
    selectedEnvironmentDriver: lowTrustPreflightEnvironmentDriver,
  });

  const executionWorkspaceBase = {
    baseCwd: resolvedWorkspace.cwd,
    source: resolvedWorkspace.source,
    projectId: resolvedWorkspace.projectId,
    workspaceId: resolvedWorkspace.workspaceId,
    repoUrl: resolvedWorkspace.repoUrl,
    repoRef: resolvedWorkspace.repoRef,
    additionalWorkspaces: resolvedWorkspace.additionalWorkspaces,
  } satisfies ExecutionWorkspaceInput;

  await assertGitWorktreeBaseWorkspaceReady({
    requestedExecutionWorkspaceMode: input.effectiveExecutionWorkspaceMode,
    config: hostExecutionWorkspaceConfig,
    issue: issueRef,
    base: executionWorkspaceBase,
    anchor: {
      baseCwdFallback: resolvedWorkspace.baseCwdFallback,
      materializationFailures: resolvedWorkspace.materializationFailures,
    },
  });
  await assertProjectPrimaryBaseWorkspaceReady({
    requestedExecutionWorkspaceMode: input.effectiveExecutionWorkspaceMode,
    config: hostExecutionWorkspaceConfig,
    agentId: agent.id,
    issue: issueRef,
    base: executionWorkspaceBase,
  });

  const workspaceStrategyForFingerprint = parseObject(hostExecutionWorkspaceConfig.workspaceStrategy);
  const workspaceStrategyFingerprintValue =
    Object.keys(workspaceStrategyForFingerprint).length > 0 ? workspaceStrategyForFingerprint : null;
  const latestWorkspaceStrategyType = resolveEffectiveWorkspaceStrategyType(
    input.effectiveExecutionWorkspaceMode,
    hostExecutionWorkspaceConfig,
  );
  const selectedEnvironmentConfigForFingerprint = parseObject(input.selectedEnvironmentForConfig?.config);
  const workspaceEnvironmentFingerprint = input.selectedEnvironmentForConfig
    ? {
        environmentSelectionSource: input.environmentSelectionSource,
        selectedEnvironmentId: input.selectedEnvironmentId,
        driver: input.selectedEnvironmentForConfig.driver,
        provider: readNonEmptyString(selectedEnvironmentConfigForFingerprint.provider),
        config: input.selectedEnvironmentForConfig.config,
        configRevisionAt:
          input.selectedEnvironmentForConfig.updatedAt instanceof Date
            ? input.selectedEnvironmentForConfig.updatedAt.toISOString()
            : input.selectedEnvironmentForConfig.updatedAt ?? null,
        executionPolicy: input.executionPolicy,
      }
    : null;
  const workspaceRealizationFingerprint = {
    environmentDriver: input.selectedEnvironmentForConfig?.driver ?? null,
    environmentProvider: readNonEmptyString(selectedEnvironmentConfigForFingerprint.provider),
    trustPreset: input.trustPreset.kind,
    lowTrustSandboxDriver: lowTrustPreflightEnvironmentDriver,
  };
  const latestWorkspaceConfigMetadata = buildEffectiveRunWorkspaceConfigMetadata({
    mode: input.effectiveExecutionWorkspaceMode,
    projectId: executionWorkspaceBase.projectId,
    projectWorkspaceId: executionWorkspaceBase.workspaceId,
    strategyType: latestWorkspaceStrategyType,
    workspaceStrategy: workspaceStrategyFingerprintValue,
    repoUrl: executionWorkspaceBase.repoUrl,
    repoRef:
      readNonEmptyString(workspaceStrategyForFingerprint.baseRef) ?? executionWorkspaceBase.repoRef,
    configSnapshot: input.configSnapshot,
    environment: workspaceEnvironmentFingerprint,
    realization: workspaceRealizationFingerprint,
    secretManifest: input.secretManifest,
  });
  const inferredExistingWorkspaceConfigMetadata = reusableExistingExecutionWorkspace
    ? buildEffectiveRunWorkspaceConfigMetadata({
        mode: issueExecutionWorkspaceModeForPersistedWorkspace(reusableExistingExecutionWorkspace.mode),
        projectId: reusableExistingExecutionWorkspace.projectId,
        projectWorkspaceId: reusableExistingExecutionWorkspace.projectWorkspaceId,
        strategyType: reusableExistingExecutionWorkspace.strategyType,
        workspaceStrategy: workspaceStrategyFingerprintValue
          ? {
              ...workspaceStrategyFingerprintValue,
              type: reusableExistingExecutionWorkspace.strategyType,
              ...(reusableExistingExecutionWorkspace.baseRef
                ? { baseRef: reusableExistingExecutionWorkspace.baseRef }
                : {}),
            }
          : { type: reusableExistingExecutionWorkspace.strategyType },
        repoUrl: reusableExistingExecutionWorkspace.repoUrl,
        repoRef: reusableExistingExecutionWorkspace.baseRef,
        configSnapshot: reusableExistingExecutionWorkspace.config as Record<string, unknown> | null,
        environment: workspaceEnvironmentFingerprint,
        realization: workspaceRealizationFingerprint,
        secretManifest: input.secretManifest,
        evaluatedAt: latestWorkspaceConfigMetadata.evaluatedAt,
      })
    : null;
  const workspaceConfigFreshness = resolveExecutionWorkspaceConfigFreshness({
    hasExistingWorkspace: requestedShouldReuseExisting && Boolean(reusableExistingExecutionWorkspace),
    existingWorkspaceMetadata: reusableExistingExecutionWorkspace?.metadata ?? null,
    inferredMetadata: inferredExistingWorkspaceConfigMetadata,
    nextMetadata: latestWorkspaceConfigMetadata,
  });
  const workspaceReuseProvisioningPolicy = resolveExecutionWorkspaceReuseProvisioningPolicy({
    requestedShouldReuseExisting,
    workspaceConfigFreshness,
  });
  const workspaceOperationRecorder = workspaceOperationsSvc.createRecorder({
    companyId: agent.companyId,
    heartbeatRunId: run.id,
    executionWorkspaceId: workspaceReuseProvisioningPolicy.shouldRestoreExistingWorkspace
      ? workspaceReuseRequest.requestedExecutionWorkspaceId
      : null,
    issueId,
  });
  // One credential provider per run: base-ref refreshes during workspace realization and
  // restore authenticate against private GitHub remotes with the same company-secret token
  // the managed clone uses.
  const workspaceGitAuthProvider = createGitRemoteAuthProvider(db, agent.companyId, {
    issueId,
    heartbeatRunId: run.id,
  });
  const { executionWorkspace, reusedExecutionWorkspace, policy: resolvedWorkspaceReusePolicy } =
    await provisionExecutionWorkspaceForFreshnessDecision<RealizedExecutionWorkspace>({
      requestedShouldReuseExisting,
      existingExecutionWorkspaceId: workspaceReuseRequest.requestedExecutionWorkspaceId,
      issueRef,
      runId: run.id,
      workspaceConfigFreshness,
      restoreExistingWorkspace: reusableExistingExecutionWorkspace
        ? () =>
            ensurePersistedExecutionWorkspaceAvailable({
              db,
              base: executionWorkspaceBase,
              workspace: {
                id: reusableExistingExecutionWorkspace.id,
                mode: reusableExistingExecutionWorkspace.mode,
                strategyType: reusableExistingExecutionWorkspace.strategyType,
                cwd: reusableExistingExecutionWorkspace.cwd,
                providerRef: reusableExistingExecutionWorkspace.providerRef,
                projectId: reusableExistingExecutionWorkspace.projectId,
                projectWorkspaceId: reusableExistingExecutionWorkspace.projectWorkspaceId,
                repoUrl: reusableExistingExecutionWorkspace.repoUrl,
                baseRef: reusableExistingExecutionWorkspace.baseRef,
                branchName: reusableExistingExecutionWorkspace.branchName,
                metadata: reusableExistingExecutionWorkspace.metadata as Record<string, unknown> | null,
                config: {
                  provisionCommand:
                    input.configSnapshot?.provisionCommand ??
                    reusableExistingExecutionWorkspace.config?.provisionCommand ??
                    input.projectExecutionWorkspacePolicy?.workspaceStrategy?.provisionCommand ??
                    null,
                  runtimeProvisionCommand:
                    input.configSnapshot?.runtimeProvisionCommand ??
                    reusableExistingExecutionWorkspace.config?.runtimeProvisionCommand ??
                    input.projectExecutionWorkspacePolicy?.workspaceStrategy?.runtimeProvisionCommand ??
                    null,
                },
              },
              issue: issueRef,
              agent: {
                id: agent.id,
                name: agent.name,
                companyId: agent.companyId,
              },
              heartbeatRunId: run.id,
              enableWorkspaceBranchReconcileForward:
                input.resolvedInstanceSettings.experimental.enableWorkspaceBranchReconcileForward,
              enableWorkspaceDirtyQuarantineRepair:
                input.resolvedInstanceSettings.experimental.enableWorkspaceDirtyQuarantineRepair,
              recorder: workspaceOperationRecorder,
              resolveGitAuth: workspaceGitAuthProvider,
            })
        : null,
  realizeWorkspace: () =>
    realizeExecutionWorkspace({
      db,
      base: executionWorkspaceBase,
      config: hostExecutionWorkspaceConfig,
      issue: issueRef,
      agent: {
        id: agent.id,
        name: agent.name,
        companyId: agent.companyId,
      },
      heartbeatRunId: run.id,
      existingExecutionWorkspaceId: workspaceReuseRequest.requestedExecutionWorkspaceId,
      enableWorkspaceBranchReconcileForward:
        input.resolvedInstanceSettings.experimental.enableWorkspaceBranchReconcileForward,
      enableWorkspaceDirtyQuarantineRepair:
        input.resolvedInstanceSettings.experimental.enableWorkspaceDirtyQuarantineRepair,
      recorder: workspaceOperationRecorder,
      resolveGitAuth: workspaceGitAuthProvider,
    }),
    });

  const resolvedProjectId =
    executionWorkspace.projectId ?? issueRef?.projectId ?? input.executionProjectId ?? null;
  const resolvedProjectWorkspaceId = issueRef?.projectWorkspaceId ?? resolvedWorkspace.workspaceId ?? null;
  let persistedExecutionWorkspace: ExecutionWorkspace | null = null;
  const baseExecutionWorkspaceMetadata = mergeExecutionWorkspaceMetadataForPersistence({
    existingMetadata: resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace
      ? reusableExistingExecutionWorkspace?.metadata ?? null
      : null,
    source: executionWorkspace.source,
    createdByRuntime: executionWorkspace.created,
    configSnapshot: input.configSnapshot,
    shouldReuseExisting: resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace,
    shouldRefreshConfigSnapshot: resolvedWorkspaceReusePolicy.shouldRefreshWorkspaceConfigSnapshot,
    workspaceConfigMetadata: resolvedWorkspaceReusePolicy.shouldPersistLatestWorkspaceConfigMetadata
      ? latestWorkspaceConfigMetadata
      : null,
    baseRef: executionWorkspace.repoRef,
    baseRefSha: executionWorkspace.baseRefSha ?? null,
  });
  let persistedWorktreeInstanceRoot =
    resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace
    && typeof reusableExistingExecutionWorkspace?.metadata?.[WORKTREE_INSTANCE_ROOT_METADATA_KEY] === "string"
      ? reusableExistingExecutionWorkspace.metadata[WORKTREE_INSTANCE_ROOT_METADATA_KEY]
      : null;
  if (
    !persistedWorktreeInstanceRoot
    && executionWorkspace.strategy === "git_worktree"
    && executionWorkspace.worktreePath
  ) {
    try {
      persistedWorktreeInstanceRoot = (
        await readManagedWorktreeInstanceOwnership(executionWorkspace.worktreePath)
      )?.instanceRoot ?? null;
    } catch (error) {
      logger.warn(
        {
          runId: run.id,
          issueId,
          executionWorkspaceCwd: executionWorkspace.cwd,
          error: error instanceof Error ? error.message : String(error),
        },
        "Could not record managed worktree instance ownership",
      );
    }
  }
  const nextExecutionWorkspaceMetadata = {
    ...baseExecutionWorkspaceMetadata,
    ...(persistedWorktreeInstanceRoot
      ? { [WORKTREE_INSTANCE_ROOT_METADATA_KEY]: persistedWorktreeInstanceRoot }
      : {}),
  };
  const pendingForwardBranchReconcile = executionWorkspace.pendingForwardBranchReconcile ?? null;
  const branchNameForInitialPersistence =
    pendingForwardBranchReconcile?.recordedBranchName ?? executionWorkspace.branchName;
  try {
    persistedExecutionWorkspace =
      resolvedWorkspaceReusePolicy.shouldRestoreExistingWorkspace && reusableExistingExecutionWorkspace
        ? await executionWorkspacesSvc.update(reusableExistingExecutionWorkspace.id, {
            cwd: executionWorkspace.cwd,
            repoUrl: executionWorkspace.repoUrl,
            baseRef: executionWorkspace.repoRef,
            branchName: branchNameForInitialPersistence,
            providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
            providerRef: executionWorkspace.worktreePath,
            status: "active",
            lastUsedAt: new Date(),
            metadata: nextExecutionWorkspaceMetadata,
            projectWorkspaceId: reconcileReusedExecutionWorkspaceProjectWorkspaceId(
              reusableExistingExecutionWorkspace.projectWorkspaceId,
              resolvedProjectWorkspaceId,
            ),
          })
        : resolvedProjectId
          ? await executionWorkspacesSvc.create({
              companyId: agent.companyId,
              projectId: resolvedProjectId,
              projectWorkspaceId: resolvedProjectWorkspaceId,
              sourceIssueId: issueRef?.id ?? null,
              mode:
                input.effectiveExecutionWorkspaceMode === "isolated_workspace"
                  ? "isolated_workspace"
                  : input.effectiveExecutionWorkspaceMode === "operator_branch"
                    ? "operator_branch"
                    : input.effectiveExecutionWorkspaceMode === "agent_default"
                      ? "adapter_managed"
                      : "shared_workspace",
              strategyType:
                executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "project_primary",
              name: branchNameForInitialPersistence ?? issueRef?.identifier ?? `workspace-${agent.id.slice(0, 8)}`,
              status: "active",
              cwd: executionWorkspace.cwd,
              repoUrl: executionWorkspace.repoUrl,
              baseRef: executionWorkspace.repoRef,
              branchName: branchNameForInitialPersistence,
              providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
              providerRef: executionWorkspace.worktreePath,
              lastUsedAt: new Date(),
              openedAt: new Date(),
              metadata: nextExecutionWorkspaceMetadata,
            })
          : null;
  } catch (error) {
    if (executionWorkspace.created) {
      try {
        await cleanupExecutionWorkspaceArtifacts({
          workspace: {
            id:
              reusableExistingExecutionWorkspace?.id ??
              workspaceReuseRequest.requestedExecutionWorkspaceId ??
              `transient-${run.id}`,
            cwd: executionWorkspace.cwd,
            providerType: executionWorkspace.strategy === "git_worktree" ? "git_worktree" : "local_fs",
            providerRef: executionWorkspace.worktreePath,
            branchName: executionWorkspace.branchName,
            repoUrl: executionWorkspace.repoUrl,
            baseRef: executionWorkspace.repoRef,
            projectId: resolvedProjectId,
            projectWorkspaceId: resolvedProjectWorkspaceId,
            sourceIssueId: issueRef?.id ?? null,
            metadata: nextExecutionWorkspaceMetadata,
          },
          projectWorkspace: {
            cwd: resolvedWorkspace.cwd,
            cleanupCommand: null,
          },
          cleanupCommand: input.configSnapshot?.cleanupCommand ?? null,
          teardownCommand:
            input.configSnapshot?.teardownCommand ??
            input.projectExecutionWorkspacePolicy?.workspaceStrategy?.teardownCommand ??
            null,
          recorder: workspaceOperationRecorder,
        });
      } catch (cleanupError) {
        logger.warn(
          {
            runId: run.id,
            issueId,
            executionWorkspaceCwd: executionWorkspace.cwd,
            cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          },
          "Failed to cleanup realized execution workspace after persistence failure",
        );
      }
    }
    throw error;
  }

  await workspaceOperationRecorder.attachExecutionWorkspaceId(persistedExecutionWorkspace?.id ?? null);
  await recordWorkspaceConfigFreshnessOperation({
    recorder: workspaceOperationRecorder,
    runId: run.id,
    decision: workspaceConfigFreshness,
    hasExistingWorkspace: Boolean(reusableExistingExecutionWorkspace),
    reuseRequested: requestedShouldReuseExisting,
    workspaceReused: Boolean(reusedExecutionWorkspace),
    configSnapshotRefreshed: resolvedWorkspaceReusePolicy.shouldRefreshWorkspaceConfigSnapshot,
    previousWorkspaceId: workspaceReuseRequest.requestedExecutionWorkspaceId,
    activeWorkspaceId: persistedExecutionWorkspace?.id ?? null,
  });
  if (
    reusableExistingExecutionWorkspace &&
    persistedExecutionWorkspace &&
    reusableExistingExecutionWorkspace.id !== persistedExecutionWorkspace.id &&
    reusableExistingExecutionWorkspace.status === "active"
  ) {
    await executionWorkspacesSvc.update(reusableExistingExecutionWorkspace.id, {
      status: "idle",
      cleanupReason: null,
    });
  }
  if (issueId && persistedExecutionWorkspace) {
    const nextIssueWorkspaceMode = issueExecutionWorkspaceModeForPersistedWorkspace(persistedExecutionWorkspace.mode);
    const shouldSwitchIssueToExistingWorkspace =
      issueRef?.executionWorkspacePreference === "reuse_existing" ||
      input.effectiveExecutionWorkspaceMode === "isolated_workspace" ||
      input.effectiveExecutionWorkspaceMode === "operator_branch";
    const nextIssuePatch: Record<string, unknown> = {};
    if (issueRef?.executionWorkspaceId !== persistedExecutionWorkspace.id) {
      nextIssuePatch.executionWorkspaceId = persistedExecutionWorkspace.id;
    }
    if (resolvedProjectWorkspaceId && issueRef?.projectWorkspaceId !== resolvedProjectWorkspaceId) {
      nextIssuePatch.projectWorkspaceId = resolvedProjectWorkspaceId;
    }
    if (shouldSwitchIssueToExistingWorkspace) {
      nextIssuePatch.executionWorkspacePreference = "reuse_existing";
      nextIssuePatch.executionWorkspaceSettings = {
        ...(input.issueExecutionWorkspaceSettings ?? {}),
        mode: nextIssueWorkspaceMode,
      };
    }
    if (Object.keys(nextIssuePatch).length > 0) {
      await issuesSvc.update(issueId, nextIssuePatch);
    }
  }

  if (persistedExecutionWorkspace) {
    input.context.executionWorkspaceId = persistedExecutionWorkspace.id;
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: input.context,
        updatedAt: new Date(),
      })
      .where(eq(heartbeatRuns.id, run.id));
  }

  return {
    kind: "provisioned",
    executionWorkspace,
    // The full resolved anchor+referenced workspace, not just the realized
    // execution workspace. Run preparation needs `workspaceHints` and the
    // referenced-project set off this, and rebuilding it from
    // `executionWorkspace` alone silently drops both.
    resolvedWorkspace,
    persistedExecutionWorkspace,
    resolvedProjectId,
    resolvedProjectWorkspaceId,
    requestedShouldReuseExisting,
    requestedReusableExecutionWorkspaceConfig,
    reusableExistingExecutionWorkspace,
    hostExecutionWorkspaceConfig,
    workspaceConfigFreshness,
    sessionConfigMetadata,
    latestWorkspaceConfigMetadata,
    resolvedWorkspaceReusePolicy,
    reusedExecutionWorkspace,
    workspaceOperationRecorder,
    workspaceReuseRequest,
    resetTaskSession,
    sessionResetReason,
    sessionConfigFreshness,
    previousSessionParams,
  };
}
