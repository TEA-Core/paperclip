import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readWorkspaceSeedOperationEvidence,
  resolveRuntimeProvisionCommand,
  type RealizedExecutionWorkspace,
} from "../services/workspace-runtime.ts";
import {
  readWorktreeInitializationKey,
  readWorktreeStateManifest,
} from "../worktree-seed-manifest.ts";
import { serverSchemaHead, writeVerifiedInitialization } from "./helpers/worktree-initialization.js";

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
    writeVerifiedInitialization(stateDir, { targetInstanceId: "wt-fresh", revision: serverSchemaHead() });

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

  it("keeps refusing a forged manifest, another instance, an unknown schema or an unreadable target", async () => {
    const revision = serverSchemaHead();
    const cases: Array<{ env: string | null; write: (stateDir: string) => void }> = [
      {
        env: "PAPERCLIP_INSTANCE_ID=wt-fresh\n",
        write: (stateDir) => writeVerifiedInitialization(stateDir, { targetInstanceId: "wt-fresh", revision, forge: true }),
      },
      {
        env: "PAPERCLIP_INSTANCE_ID=wt-other\n",
        write: (stateDir) => writeVerifiedInitialization(stateDir, { targetInstanceId: "wt-fresh", revision }),
      },
      {
        env: "PAPERCLIP_INSTANCE_ID=wt-fresh\n",
        write: (stateDir) => writeVerifiedInitialization(stateDir, {
          targetInstanceId: "wt-fresh",
          revision: { ...revision, schemaFingerprint: `sha256:${"0".repeat(64)}` },
        }),
      },
      { env: null, write: (stateDir) => writeVerifiedInitialization(stateDir, { targetInstanceId: "wt-fresh", revision }) },
    ];
    for (const testCase of cases) {
      const { cwd, stateDir, workspace } = await createSeedWorktree();
      if (testCase.env !== null) await fs.writeFile(path.join(stateDir, ".env"), testCase.env);
      testCase.write(stateDir);
      // A stale skip marker never hides the refusal.
      await fs.writeFile(path.join(stateDir, "seed-skip-no-source"), "{}\n");

      expect(resolveRuntimeProvisionCommand({ config: {}, workspace })).toBe(BUILTIN_SEED_COMMAND);
      const evidence = readWorkspaceSeedOperationEvidence(cwd);
      expect(evidence.verified).toBe(false);
      expect(evidence.metadata.seedState).toBe("unreadable");
    }
  });

  it("refuses a manifest whose initialization key was removed", async () => {
    const { cwd, stateDir, workspace } = await createSeedWorktree();
    await fs.writeFile(path.join(stateDir, ".env"), "PAPERCLIP_INSTANCE_ID=wt-fresh\n");
    writeVerifiedInitialization(stateDir, { targetInstanceId: "wt-fresh", revision: serverSchemaHead() });
    await fs.rm(path.join(stateDir, "initialization.key"));
    expect(resolveRuntimeProvisionCommand({ config: {}, workspace })).toBe(BUILTIN_SEED_COMMAND);
    expect(readWorkspaceSeedOperationEvidence(cwd).verified).toBe(false);
  });
});

describe("readWorktreeStateManifest", () => {
  it("accepts the writer's bound manifest and refuses a forged, tampered or copied one", async () => {
    const revision = serverSchemaHead();
    const read = (stateDir: string) => readWorktreeStateManifest(path.join(stateDir, "seed-manifest.json"), {
      targetInstanceId: "wt-fresh",
      schema: [revision],
      bindingKey: readWorktreeInitializationKey(stateDir),
    });

    const real = await createSeedWorktree();
    writeVerifiedInitialization(real.stateDir, { targetInstanceId: "wt-fresh", revision });
    expect(read(real.stateDir).kind).toBe("initialization");

    const forged = await createSeedWorktree();
    writeVerifiedInitialization(forged.stateDir, { targetInstanceId: "wt-fresh", revision, forge: true });
    expect(read(forged.stateDir)).toMatchObject({ kind: "refused", message: expect.stringMatching(/not bound/) });

    const tampered = await createSeedWorktree();
    writeVerifiedInitialization(tampered.stateDir, { targetInstanceId: "wt-fresh", revision });
    const manifestPath = path.join(tampered.stateDir, "seed-manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, finishedAt: "2026-11-16T10:00:06.000Z" }));
    expect(read(tampered.stateDir)).toMatchObject({ kind: "refused", message: expect.stringMatching(/not bound/) });

    // Another worktree's manifest, copied in without that worktree's key.
    const copied = await createSeedWorktree();
    writeVerifiedInitialization(copied.stateDir, { targetInstanceId: "wt-fresh", revision });
    await fs.copyFile(path.join(real.stateDir, "seed-manifest.json"), path.join(copied.stateDir, "seed-manifest.json"));
    expect(read(copied.stateDir)).toMatchObject({ kind: "refused", message: expect.stringMatching(/not bound/) });
  });
});
