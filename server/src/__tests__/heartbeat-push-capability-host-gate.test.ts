import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  companySkills,
  connectionGrants,
  createDb,
  issues,
  projects,
  projectWorkspaces,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
} from "@paperclipai/db";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { buildSkillMentionHref } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateWithLockRetry } from "./helpers/truncate-with-lock-retry.js";
import { heartbeatService } from "../services/heartbeat.ts";

// TEA-Core fork (fold 2c, decisions D5/D7): a push-capable run (an issue that mentions the
// github-pr-workflow skill on a git-sensitive local adapter) keeps the push-remote checkout
// validation (I8), and the PAT binding requirement applies only in host GitHub mode.

const execFileAsync = promisify(execFile);

const adapterExecute = vi.hoisted(() =>
  vi.fn(async (_ctx: AdapterExecutionContext) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "Push capability host gate test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "codex_local",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat push capability tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const TRUNCATE_SQL = `
  TRUNCATE TABLE
    "companies",
    "heartbeat_run_events",
    "heartbeat_runs",
    "activity_log",
    "agent_wakeup_requests",
    "agent_runtime_state",
    "environment_leases",
    "environments"
  RESTART IDENTITY CASCADE
`;

async function createRepo(opts: { withRemote: boolean }) {
  const repoRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-push-capability-repo-")));
  const git = (args: string[]) => execFileAsync("git", args, { cwd: repoRoot });
  await git(["init"]);
  await git(["config", "user.email", "paperclip-test@example.com"]);
  await git(["config", "user.name", "Paperclip Test"]);
  await writeFile(path.join(repoRoot, "README.md"), "push capability\n", "utf8");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "initial"]);
  if (opts.withRemote) await git(["remote", "add", "origin", "https://github.com/example/repo.git"]);
  return repoRoot;
}

describeEmbeddedPostgres("heartbeat push capability host gate (D5/D7)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "heartbeat-push-capability-secret");
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-push-capability-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    await truncateWithLockRetry(db, TRUNCATE_SQL);
    adapterExecute.mockClear();
    vi.unstubAllEnvs();
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "heartbeat-push-capability-secret");
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await heartbeat.drainActiveRunExecutions();
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
  });

  async function waitForRunToFinish(runId: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = await heartbeat.getRun(runId);
      if (run && !["queued", "running"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await heartbeat.getRun(runId);
  }

  async function seedPrWorkflowIssue(opts: { withRemote: boolean; bindAgentToken: boolean; managedGitHub: boolean }) {
    const repoRoot = await createRepo({ withRemote: opts.withRemote });
    tempRoots.push(repoRoot);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const skillId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Push capability",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: opts.bindAgentToken
        ? { env: { GH_TOKEN: { type: "plain", value: "agent-bound-pat" } } }
        : {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Push capability", status: "active" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: repoRoot,
      isPrimary: true,
    });
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: "paperclipai/bundled/software-development/github-pr-workflow",
      slug: "github-pr-workflow",
      name: "GitHub PR workflow",
      markdown: "# GitHub PR workflow\n",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Open a pull request",
      description: `Follow [github-pr-workflow](${buildSkillMentionHref(skillId, "github-pr-workflow")}) for this change.`,
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    if (opts.managedGitHub) {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: "responsible-user",
        status: "active",
        membershipRole: "member",
      });
      const [application] = await db.insert(toolApplications).values({
        companyId,
        applicationKey: `github-${randomUUID().slice(0, 8)}`,
        name: "GitHub",
        type: "mcp_http",
        status: "active",
        metadata: { sourceTemplateKey: "github" },
      }).returning();
      const [connection] = await db.insert(toolConnections).values({
        companyId,
        applicationId: application!.id,
        name: "Dedicated GitHub",
        uid: `github/${randomUUID()}`,
        transport: "mcp_remote",
        credentialPolicy: "per_agent",
        status: "active",
        enabled: true,
        healthStatus: "ok",
        config: {},
        transportConfig: { sourceTemplateKey: "github" },
      }).returning();
      await db.insert(toolConnectionInstalls).values({
        companyId,
        connectionId: connection!.id,
        targetType: "company",
        targetId: companyId,
      });
      await db.insert(connectionGrants).values({
        companyId,
        connectionId: connection!.id,
        kind: "agent",
        subjectAgentId: agentId,
        status: "active",
        isDefault: false,
      });
    }
    return { agentId, issueId, projectId };
  }

  async function runIssue(seed: { agentId: string; issueId: string; projectId: string }) {
    const run = await heartbeat.wakeup(seed.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { issueId: seed.issueId, taskId: seed.issueId, projectId: seed.projectId },
    });
    expect(run).not.toBeNull();
    return waitForRunToFinish(run!.id);
  }

  it("a push-capable host-mode run whose checkout has no push remote fails missing_git_push_remote before dispatch (D7 / I8)", async () => {
    const seed = await seedPrWorkflowIssue({ withRemote: false, bindAgentToken: true, managedGitHub: false });

    const finished = await runIssue(seed);

    expect(finished?.status, JSON.stringify({ errorCode: finished?.errorCode, error: finished?.error })).toBe("failed");
    expect(finished?.errorCode).toBe("workspace_validation_failed");
    expect((finished?.resultJson as Record<string, any> | null)?.workspaceValidation).toMatchObject({
      reason: "missing_git_push_remote",
      issueId: seed.issueId,
    });
    expect(adapterExecute).not.toHaveBeenCalled();
  });

  it("a push-capable managed run is not blocked on a PAT binding it could never satisfy (D5)", async () => {
    vi.stubEnv("PAPERCLIP_GITHUB_MANAGED_EXECUTION", "on");
    const seed = await seedPrWorkflowIssue({ withRemote: true, bindAgentToken: false, managedGitHub: true });

    const finished = await runIssue(seed);

    const detail = JSON.stringify({ status: finished?.status, errorCode: finished?.errorCode, error: finished?.error });
    expect(finished?.errorCode, detail).not.toBe("configuration_incomplete");
    expect((finished?.resultJson as Record<string, unknown> | null)?.configurationIncomplete, detail).toBeUndefined();
    expect(adapterExecute, detail).toHaveBeenCalledTimes(1);
    const { context } = adapterExecute.mock.calls[0]![0] as unknown as { context: Record<string, unknown> };
    expect(context.githubAuthenticationMode).toBe("managed");
  });
});
