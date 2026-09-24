import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureManagedProjectWorkspace, isSameManagedRepoUrl } from "../services/heartbeat.ts";

const execFile = promisify(execFileCallback);

let tempHome: string;
let originalHome: string | undefined;

beforeAll(async () => {
  originalHome = process.env.PAPERCLIP_HOME;
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-clone-url-"));
  process.env.PAPERCLIP_HOME = tempHome;
});

afterAll(async () => {
  if (originalHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = originalHome;
  await fs.rm(tempHome, { recursive: true, force: true });
});

async function createLocalSourceRepo(label: string) {
  const sourceRepo = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-clone-url-${label}-`));
  await execFile("git", ["init"], { cwd: sourceRepo });
  await execFile("git", ["config", "user.email", "paperclip@example.com"], { cwd: sourceRepo });
  await execFile("git", ["config", "user.name", "Paperclip Test"], { cwd: sourceRepo });
  await fs.writeFile(path.join(sourceRepo, "README.md"), "hello\n", "utf8");
  await execFile("git", ["add", "README.md"], { cwd: sourceRepo });
  await execFile("git", ["commit", "-m", "init"], { cwd: sourceRepo });
  return sourceRepo;
}

// The managed checkout is the base every git_worktree execution workspace is cut from, and
// every persisted worktree is validated against `git worktree list` run in it. Diverting to a
// second clone therefore does not merely duplicate a checkout: it makes every worktree already
// on disk unlistable from the base the validator now consults, and each run fails with
// "path is not registered in `git worktree list`" — true of the new clone, false of the repo.
// The divert must fire only for a genuinely different repository.
describe("ensureManagedProjectWorkspace repository identity", () => {
  it("keeps the existing checkout when the recorded repoUrl and the checkout origin differ only by a `.git` suffix", async () => {
    const sourceRepo = await createLocalSourceRepo("suffix");
    try {
      const first = await ensureManagedProjectWorkspace({
        companyId: "company-url-suffix",
        projectId: "project-url-suffix",
        repoUrl: sourceRepo,
      });
      // The shape that stranded 15 issues for a day: the checkout's own origin
      // carries the `.git` suffix the recorded repoUrl omits.
      await execFile("git", ["-C", first.cwd, "remote", "set-url", "origin", `${sourceRepo}.git`]);

      const second = await ensureManagedProjectWorkspace({
        companyId: "company-url-suffix",
        projectId: "project-url-suffix",
        repoUrl: sourceRepo,
      });

      expect(second.cwd).toBe(first.cwd);
    } finally {
      await fs.rm(sourceRepo, { recursive: true, force: true });
    }
  });

  it("still diverts to a separate checkout when the existing origin names a different repository", async () => {
    const sourceRepo = await createLocalSourceRepo("same");
    const otherRepo = await createLocalSourceRepo("other");
    try {
      const first = await ensureManagedProjectWorkspace({
        companyId: "company-url-divert",
        projectId: "project-url-divert",
        repoUrl: sourceRepo,
      });
      await execFile("git", ["-C", first.cwd, "remote", "set-url", "origin", otherRepo]);

      const second = await ensureManagedProjectWorkspace({
        companyId: "company-url-divert",
        projectId: "project-url-divert",
        repoUrl: sourceRepo,
      });

      expect(second.cwd).not.toBe(first.cwd);
      const divertedOrigin = await execFile("git", ["-C", second.cwd, "remote", "get-url", "origin"]);
      expect(divertedOrigin.stdout.trim()).toBe(sourceRepo);
    } finally {
      await fs.rm(sourceRepo, { recursive: true, force: true });
      await fs.rm(otherRepo, { recursive: true, force: true });
    }
  });
});

// Cases the clone-backed tests above cannot reach: remote URL spellings that name a real host.
describe("isSameManagedRepoUrl", () => {
  const base = "https://github.com/TEA-Core/Trading-Signal-Platform";

  it.each([
    ["a trailing `.git` suffix", `${base}.git`],
    ["a trailing slash", `${base}/`],
    ["a different case", base.toUpperCase().replace("HTTPS", "https")],
    ["an ssh scheme", "ssh://git@github.com/TEA-Core/Trading-Signal-Platform.git"],
    ["an scp-like remote", "git@github.com:TEA-Core/Trading-Signal-Platform.git"],
    // A checkout whose origin was written with credentials in it must still be
    // recognised as the repository it is, or it diverts on every single run.
    ["embedded credentials", "https://user:token@github.com/TEA-Core/Trading-Signal-Platform.git"],
  ])("treats %s as the same repository", (_label, variant) => {
    expect(isSameManagedRepoUrl(variant, base)).toBe(true);
    expect(isSameManagedRepoUrl(base, variant)).toBe(true);
  });

  it.each([
    ["a different repository", "https://github.com/TEA-Core/paperclip"],
    ["a different owner", "https://github.com/other-org/Trading-Signal-Platform"],
    // Same owner/repo on another host is a different repository; the host must
    // stay part of the comparison even though the path alone matches.
    ["a different host", "https://gitlab.com/TEA-Core/Trading-Signal-Platform"],
  ])("treats %s as a different repository", (_label, variant) => {
    expect(isSameManagedRepoUrl(variant, base)).toBe(false);
  });

  it("treats two hostless local paths that name the same checkout as the same repository", () => {
    // The local-path case: neither side carries a host, so the path is all
    // there is to compare, and a `.git` suffix must still not separate them.
    expect(isSameManagedRepoUrl("/srv/repos/thing", "/srv/repos/thing.git")).toBe(true);
    expect(isSameManagedRepoUrl("/srv/repos/thing", "/srv/repos/other")).toBe(false);
  });

  it("does not treat a hostless URL as matching a hosted one", () => {
    // `normalizeRepoUrl` reduces a hosted URL to `owner/repo`, which a hostless
    // value can equal by coincidence. Answering "same" there would hand back a
    // checkout of a different repository, so a missing host on one side only is
    // not agreement.
    expect(isSameManagedRepoUrl("TEA-Core/Trading-Signal-Platform", base)).toBe(false);
    expect(isSameManagedRepoUrl(base, "TEA-Core/Trading-Signal-Platform")).toBe(false);
  });

  it("never claims a match when either side is missing", () => {
    expect(isSameManagedRepoUrl(null, base)).toBe(false);
    expect(isSameManagedRepoUrl(base, null)).toBe(false);
    expect(isSameManagedRepoUrl("", base)).toBe(false);
  });
});
