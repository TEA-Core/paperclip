import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ensureAgentAccessibleDir,
  ensureAgentAccessibleTree,
  resetAgentSharedGidCacheForTests,
} from "./agent-shared-dir.js";

// The gid is injected as the *process's own* gid rather than a real `agents` group.
// chown(2) to a group you already belong to is permitted unprivileged, so this
// exercises the real chown/chmod on every host — a test pinned to gid 1002 would
// only pass inside the deployed image.
const OWN_GID = typeof process.getgid === "function" ? process.getgid() : null;

describe.skipIf(process.platform === "win32" || OWN_GID == null)(
  "ensureAgentAccessibleDir (SUP-13484)",
  () => {
    let dir: string;
    const savedGidEnv = process.env.PAPERCLIP_AGENTS_GID;

    beforeEach(async () => {
      resetAgentSharedGidCacheForTests();
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-shared-dir-test-"));
    });

    afterEach(async () => {
      if (savedGidEnv === undefined) delete process.env.PAPERCLIP_AGENTS_GID;
      else process.env.PAPERCLIP_AGENTS_GID = savedGidEnv;
      resetAgentSharedGidCacheForTests();
      await fs.rm(dir, { recursive: true, force: true });
    });

    const modeOf = async (p: string) => (await fs.stat(p)).mode & 0o7777;

    it("mkdtemp really is 0700 — the premise the fix rests on", async () => {
      // If this ever stops holding the fix is unnecessary, and the test that
      // follows would pass vacuously. Assert the hazard, not just the repair.
      // Only the rwx bits are asserted: an inherited setgid bit from a setgid
      // parent tmpdir is legal and irrelevant — group *access* is what was denied.
      expect(await modeOf(dir) & 0o777).toBe(0o700);
    });

    it("adds setgid and group rwx so a child at another uid can write inside", async () => {
      process.env.PAPERCLIP_AGENTS_GID = String(OWN_GID);
      resetAgentSharedGidCacheForTests();

      await ensureAgentAccessibleDir(dir);

      const mode = await modeOf(dir);
      expect(mode & 0o070).toBe(0o070); // group rwx
      expect(mode & 0o2000).toBe(0o2000); // setgid, so child-created entries keep the gid
      expect(mode & 0o007).toBe(0); // never widened to other
      expect((await fs.stat(dir)).gid).toBe(OWN_GID);
    });

    it("is a no-op when the shared group does not exist", async () => {
      delete process.env.PAPERCLIP_AGENTS_GID;
      resetAgentSharedGidCacheForTests();

      await expect(
        ensureAgentAccessibleDir(dir, {
          groupName: "paperclip-group-that-does-not-exist",
          warn: () => {},
        }),
      ).resolves.toBeUndefined();

      // Ungated hosts run the child at the server's own uid, so leaving it closed is correct.
      expect(await modeOf(dir) & 0o077).toBe(0);
    });

    it("widens copied files, which fs.cp staged at their restrictive source mode", async () => {
      process.env.PAPERCLIP_AGENTS_GID = String(OWN_GID);
      resetAgentSharedGidCacheForTests();

      const nested = path.join(dir, "opencode");
      await fs.mkdir(nested);
      const secret = path.join(nested, "auth.json");
      await fs.writeFile(secret, "{}", { mode: 0o600 });
      expect(await modeOf(secret)).toBe(0o600);

      await ensureAgentAccessibleTree(dir);

      // Group rw: the child refreshes credentials in place, so read-only is not enough.
      expect((await modeOf(secret)) & 0o060).toBe(0o060);
      expect((await modeOf(secret)) & 0o007).toBe(0);
      expect((await modeOf(nested)) & 0o070).toBe(0o070);
    });

    it("does not follow symlinks out of the staged tree", async () => {
      process.env.PAPERCLIP_AGENTS_GID = String(OWN_GID);
      resetAgentSharedGidCacheForTests();

      const outside = path.join(dir, "..", `agent-shared-dir-outside-${process.pid}`);
      await fs.writeFile(outside, "x", { mode: 0o600 });
      try {
        await fs.symlink(outside, path.join(dir, "link"));
        await ensureAgentAccessibleTree(dir);
        expect(await modeOf(outside)).toBe(0o600);
      } finally {
        await fs.rm(outside, { force: true });
      }
    });
  },
);
