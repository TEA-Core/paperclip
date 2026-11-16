import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readWorkspaceSeedOperationEvidence,
  resolveRuntimeProvisionCommand,
  type RealizedExecutionWorkspace,
} from "../services/workspace-runtime.ts";
import { serverSchemaHead, verifiedInitializationManifest } from "./helpers/worktree-initialization.js";

const BUILTIN_SEED_COMMAND = "bash ./scripts/provision-worktree-runtime.sh";
const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

/** A managed git worktree whose base checkout has the built-in seed script. */
async function createSeedWorktree() {
  const baseCwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-fresh-init-"));
  tempRoots.push(baseCwd);
  const cwd = path.join(baseCwd, "worktree");
  await fs.mkdir(path.join(baseCwd, "scripts"), { recursive: true });
  await fs.writeFile(path.join(baseCwd, "scripts", "provision-worktree-runtime.sh"), "#!/usr/bin/env bash\n");
  const stateDir = path.join(cwd, ".paperclip");
  await fs.mkdir(stateDir, { recursive: true });
  const workspace: RealizedExecutionWorkspace = {
    baseCwd,
    source: "project_primary",
    projectId: "project-1",
    workspaceId: "workspace-1",
    repoUrl: null,
    repoRef: "HEAD",
    strategy: "git_worktree",
    cwd,
    branchName: null,
    worktreePath: cwd,
    warnings: [],
    created: false,
    branchCreatedByRuntime: false,
  };
  return { cwd, stateDir, workspace };
}

describe("verified fresh worktree initialization in the runtime seed path", () => {
  it("skips the seed command and records verified evidence for this worktree's instance and this build's schema", async () => {
    const { cwd, stateDir, workspace } = await createSeedWorktree();
    await fs.writeFile(path.join(stateDir, ".env"), "PAPERCLIP_INSTANCE_ID=wt-fresh\n");
    await fs.writeFile(
      path.join(stateDir, "seed-manifest.json"),
      verifiedInitializationManifest({ targetInstanceId: "wt-fresh", revision: serverSchemaHead() }),
    );

    expect(resolveRuntimeProvisionCommand({ config: {}, workspace })).toBe("");
    expect(readWorkspaceSeedOperationEvidence(cwd)).toEqual({
      verified: true,
      error: null,
      metadata: {
        provisionKind: "workspace_seed",
        seedState: "verified",
        seedPhase: "complete",
        seedFailurePhase: null,
        initializationProfile: "fresh",
      },
    });
  });

  it("keeps refusing a fresh manifest for another instance, an unknown schema or an unreadable target", async () => {
    const revision = serverSchemaHead();
    const cases: Array<{ env: string | null; manifest: string }> = [
      { env: "PAPERCLIP_INSTANCE_ID=wt-other\n", manifest: verifiedInitializationManifest({ targetInstanceId: "wt-fresh", revision }) },
      {
        env: "PAPERCLIP_INSTANCE_ID=wt-fresh\n",
        manifest: verifiedInitializationManifest({
          targetInstanceId: "wt-fresh",
          revision: { ...revision, schemaFingerprint: `sha256:${"0".repeat(64)}` },
        }),
      },
      { env: null, manifest: verifiedInitializationManifest({ targetInstanceId: "wt-fresh", revision }) },
    ];
    for (const testCase of cases) {
      const { cwd, stateDir, workspace } = await createSeedWorktree();
      if (testCase.env !== null) await fs.writeFile(path.join(stateDir, ".env"), testCase.env);
      await fs.writeFile(path.join(stateDir, "seed-manifest.json"), testCase.manifest);
      // A stale skip marker never hides the refusal.
      await fs.writeFile(path.join(stateDir, "seed-skip-no-source"), "{}\n");

      expect(resolveRuntimeProvisionCommand({ config: {}, workspace })).toBe(BUILTIN_SEED_COMMAND);
      const evidence = readWorkspaceSeedOperationEvidence(cwd);
      expect(evidence.verified).toBe(false);
      expect(evidence.metadata.seedState).toBe("unreadable");
    }
  });
});
