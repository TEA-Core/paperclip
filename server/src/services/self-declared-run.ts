import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import { isExternalPullAgent } from "./agent-work-delivery.js";
import { heartbeatService } from "./heartbeat.js";
import { logActivity } from "./activity-log.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { forbidden, notFound, conflict } from "../errors.js";
import { asString, parseObject } from "../adapters/utils.js";

export interface SelfDeclaredRunOpenResult {
  runId: string;
  issueId: string;
  status: "running";
  workspace: {
    strategy: string | null;
    cwd: string | null;
    branchName: string | null;
    worktreePath: string | null;
    executionWorkspaceId: string | null;
  };
}

export interface SelfDeclaredRunKeepaliveResult {
  runId: string;
  expiresAt: string;
}

export interface SelfDeclaredRunCloseResult {
  runId: string;
  status: string;
}

import { DEFAULT_SELF_DECLARED_RUN_TTL_MS } from "./run-stillborn.js";

export function selfDeclaredRunService(db: Db) {
  const heartbeat = heartbeatService(db);

  async function getAgentById(agentId: string) {
    return db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getIssueById(issueId: string) {
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function getRunById(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function getProjectById(projectId: string) {
    return db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
  }

  function resolveProjectWorkspacePolicy(projectRow: { executionWorkspacePolicy: unknown } | null): { mode: string; strategyType: string; baseRef: string | null } {
    const policy = parseObject(projectRow?.executionWorkspacePolicy);
    const strategy = parseObject(policy?.workspaceStrategy);
    return {
      mode: asString(policy.defaultMode, "isolated_workspace"),
      strategyType: asString(strategy.type, "git_worktree"),
      baseRef: asString(strategy.baseRef, "") || null,
    };
  }

  async function provisionIssueExecutionWorkspace(
    issueId: string,
    runId: string,
    agentId: string,
    companyId: string,
  ): Promise<{
    strategy: string | null;
    cwd: string | null;
    branchName: string | null;
    worktreePath: string | null;
    executionWorkspaceId: string | null;
  }> {
    const issueRow = await getIssueById(issueId);
    if (!issueRow) throw notFound("Issue not found");

    const projectRow = issueRow.projectId
      ? await getProjectById(issueRow.projectId)
      : null;
    const { mode, strategyType, baseRef } = resolveProjectWorkspacePolicy(projectRow);

    const ews = executionWorkspaceService(db);
    const existingWorkspaceId = issueRow.executionWorkspaceId;
    let workspace = existingWorkspaceId
      ? await ews.getById(existingWorkspaceId)
      : null;

    if (workspace) {
      const now = new Date();
      await ews.update(workspace.id, {
        lastUsedAt: now,
        baseRef: baseRef ?? workspace.baseRef,
      });
    } else {
      const now = new Date();
      const branchName = `self-declared-${runId.slice(0, 8)}`;
      const created = await ews.create({
        companyId,
        projectId: issueRow.projectId ?? "",
        sourceIssueId: issueId,
        mode,
        strategyType,
        name: branchName,
        status: "active",
        baseRef: baseRef ?? null,
        branchName,
        cwd: null,
        lastUsedAt: now,
        openedAt: now,
      });

      if (created) {
        await db
          .update(issues)
          .set({ executionWorkspaceId: created.id, updatedAt: now })
          .where(eq(issues.id, issueId));
        workspace = created;
      }
    }

    if (!workspace) {
      return {
        strategy: null,
        cwd: null,
        branchName: null,
        worktreePath: null,
        executionWorkspaceId: null,
      };
    }

    return {
      strategy: workspace.strategyType,
      cwd: workspace.cwd,
      branchName: workspace.branchName,
      worktreePath: workspace.providerRef ?? null,
      executionWorkspaceId: workspace.id,
    };
  }

  async function openSelfDeclaredRun(
    issueId: string,
    agentId: string,
    reqId?: string,
  ): Promise<SelfDeclaredRunOpenResult> {
    const agent = await getAgentById(agentId);
    if (!agent) throw notFound("Agent not found");
    if (!isExternalPullAgent(agent)) {
      throw forbidden("Agent is not an external pull agent", {
        code: "not_external_pull_agent",
      });
    }

    const issue = await getIssueById(issueId);
    if (!issue) throw notFound("Issue not found");
    if (issue.assigneeAgentId !== agentId) {
      throw forbidden("Agent is not assigned to this issue", {
        code: "not_issue_assignee",
      });
    }

    const now = new Date();

    const updated = await db
      .update(issues)
      .set({
        assigneeAgentId: agentId,
        assigneeUserId: null,
        status: "in_progress",
        startedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.id, issueId),
          inArray(issues.status, ["todo", "in_progress"]),
          or(
            isNull(issues.assigneeAgentId),
            eq(issues.assigneeAgentId, agentId),
          ),
          isNull(issues.executionRunId),
        ),
      )
      .returning()
      .then((rows) => rows[0] ?? null);

    if (!updated) {
      const current = await getIssueById(issueId);
      if (!current) throw notFound("Issue not found");
      if (current.assigneeAgentId !== agentId) {
        throw forbidden("Agent is not assigned to this issue", {
          code: "not_issue_assignee",
        });
      }
      throw conflict("Issue is already being executed", {
        issueId,
        status: current.status,
        executionRunId: current.executionRunId,
      });
    }

    const contextSnapshot = {
      issueId,
      projectId: issue.projectId,
      wakeReason: "self_declared",
    };

    const run = await db
      .insert(heartbeatRuns)
      .values({
        companyId: agent.companyId,
        agentId: agentId,
        invocationSource: "self_declared",
        triggerDetail: "self_declared",
        status: "running",
        startedAt: now,
        contextSnapshot,
        responsibleUserId: issue.responsibleUserId ?? null,
        issueCommentStatus: "not_applicable",
      })
      .returning()
      .then((rows) => rows[0] ?? null);

    if (!run) throw conflict("Failed to create self-declared run");

    await db
      .update(issues)
      .set({
        checkoutRunId: run.id,
        executionRunId: run.id,
        executionAgentNameKey: normalizeAgentNameKey(agent.name),
        executionLockedAt: now,
        updatedAt: now,
      })
      .where(eq(issues.id, issueId));

    const workspace = await provisionIssueExecutionWorkspace(
      issueId,
      run.id,
      agentId,
      agent.companyId,
    );

    if (workspace.executionWorkspaceId) {
      await db
        .update(heartbeatRuns)
        .set({
          contextSnapshot: {
            ...contextSnapshot,
            executionWorkspaceId: workspace.executionWorkspaceId,
          },
          updatedAt: now,
        })
        .where(eq(heartbeatRuns.id, run.id));
    }

    await logActivity(db, {
      companyId: agent.companyId,
      actorType: "agent",
      actorId: agentId,
      action: "self_declared_run_opened",
      entityType: "issue",
      entityId: issueId,
      agentId,
      runId: run.id,
      issueId,
      details: {
        invocationSource: "self_declared",
        executionWorkspaceId: workspace.executionWorkspaceId,
      },
    });

    return {
      runId: run.id,
      issueId,
      status: "running",
      workspace,
    };
  }

  async function keepalive(
    runId: string,
    agentId: string,
    issueId: string,
  ): Promise<SelfDeclaredRunKeepaliveResult> {
    const run = await getRunById(runId);
    if (!run) throw notFound("Run not found");
    if (run.agentId !== agentId) {
      throw forbidden("Run does not belong to calling agent", {
        code: "run_agent_mismatch",
      });
    }
    if (run.status !== "running") {
      throw conflict("Run is not in running status", {
        runId,
        status: run.status,
      });
    }

    const ctx = parseObject(run.contextSnapshot);
    const runIssueId = asString(ctx.issueId, "");
    if (runIssueId.length > 0 && runIssueId !== issueId) {
      throw forbidden("Run does not belong to this issue", {
        code: "run_issue_mismatch",
        runId,
        issueId,
        runIssueId,
      });
    }

    const now = new Date();
    await db
      .update(heartbeatRuns)
      .set({ updatedAt: now })
      .where(eq(heartbeatRuns.id, runId));

    const expiresAt = new Date(now.getTime() + DEFAULT_SELF_DECLARED_RUN_TTL_MS);

    return {
      runId: run.id,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async function closeSelfDeclaredRun(
    runId: string,
    agentId: string,
    issueId: string,
    outcome: "succeeded" | "failed" | "cancelled",
    summary?: string,
  ): Promise<SelfDeclaredRunCloseResult> {
    const run = await getRunById(runId);
    if (!run) throw notFound("Run not found");
    if (run.agentId !== agentId) {
      throw forbidden("Run does not belong to calling agent", {
        code: "run_agent_mismatch",
      });
    }
    if (run.invocationSource !== "self_declared") {
      throw conflict("Run is not a self-declared run", {
        runId,
        invocationSource: run.invocationSource,
      });
    }

    const ctx = parseObject(run.contextSnapshot);
    const runIssueId = asString(ctx.issueId, "");
    if (runIssueId.length > 0 && runIssueId !== issueId) {
      throw forbidden("Run does not belong to this issue", {
        code: "run_issue_mismatch",
        runId,
        issueId,
        runIssueId,
      });
    }

    const { run: updatedRun, updated } = await heartbeat.setRunStatusIfRunning(
      runId,
      outcome,
      {
        finishedAt: new Date(),
        error: summary ?? null,
      },
    );

    if (!updated) {
      throw conflict(
        "Run was not in running status; no status change applied",
        {
          runId,
          status: updatedRun?.status ?? null,
        },
      );
    }

    await heartbeat.releaseIssueExecutionAndPromote(updatedRun!, {
      suppressImmediateRecovery: outcome === "cancelled",
    });

    const agent = await getAgentById(agentId);
    const resolvedIssueId = runIssueId.length > 0 ? runIssueId : issueId;

    if (resolvedIssueId && agent) {
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: "agent",
        actorId: agentId,
        action: "self_declared_run_closed",
        entityType: "issue",
        entityId: resolvedIssueId,
        agentId,
        runId: run.id,
        issueId: resolvedIssueId,
        details: {
          outcome,
          summary: summary ?? null,
        },
      });
    }

    return {
      runId: run.id,
      status: outcome,
    };
  }

  return {
    openSelfDeclaredRun,
    keepalive,
    closeSelfDeclaredRun,
    getRunById,
  };
}

function normalizeAgentNameKey(name: string): string | null {
  if (!name || typeof name !== "string") return null;
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}
