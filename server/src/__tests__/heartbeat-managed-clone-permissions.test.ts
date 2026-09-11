import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureManagedProjectWorkspace } from "../services/heartbeat.ts";

const execFile = promisify(execFileCallback);

let tempHome: string;
let originalHome: string | undefined;

beforeAll(async () => {
  originalHome = process.env.PAPERCLIP_HOME;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-clone-perms-"));
  process.env.PAPERCLIP_HOME = tempHome;
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = originalHome;
  await fs.rm(tempHome, { recursive: true, force: true });
});

async function createLocalSourceRepo() {
  const sourceRepo = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-clone-perms-source-"));
  await execFile("git", ["init"], { cwd: sourceRepo });
  await execFile("git", ["config", "user.email", "paperclip@example.com"], { cwd: sourceRepo });
  await execFile("git", ["config", "user.name", "Paperclip Test"], { cwd: sourceRepo });
  await fs.writeFile(path.join(sourceRepo, "README.md"), "hello\n", "utf8");
  await execFile("git", ["add", "README.md"], { cwd: sourceRepo });
  await execFile("git", ["commit", "-m", "init"], { cwd: sourceRepo });
  return sourceRepo;
}

describe("ensureManagedProjectWorkspace checkout permissions", () => {
  // Agents run under their own uid and reach the managed checkout only through the shared
  // group. A checkout that lands owner-only (fs.mkdtemp's fixed 0700, carried over by the
  // rename into place) cannot be entered by any agent, so every run in that project fails to
  // spawn in its cwd.
  it("gives the cloned checkout the mode a plain mkdir would, not an owner-only mode", async () => {
    const sourceRepo = await createLocalSourceRepo();
    try {
      const result = await ensureManagedProjectWorkspace({
        companyId: "company-perms",
        projectId: "project-1",
        repoUrl: sourceRepo,
      });
      const probe = path.join(path.dirname(result.cwd), "mode-probe");
      await fs.mkdir(probe);
      const expectedMode = (await fs.stat(probe)).mode & 0o777;
      const checkoutMode = (await fs.stat(result.cwd)).mode & 0o777;
      expect(checkoutMode.toString(8)).toBe(expectedMode.toString(8));
    } finally {
      await fs.rm(sourceRepo, { recursive: true, force: true });
    }
  });
});
