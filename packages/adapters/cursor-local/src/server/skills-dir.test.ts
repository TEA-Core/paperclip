import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { resetAgentSharedGidCacheForTests } from "@paperclipai/adapter-utils/agent-shared-dir";
import { buildCursorSkillsDir } from "./execute.js";

// The gid is injected as the *process's own* gid rather than a real `agents` group.
// chown(2) to a group you already belong to is permitted unprivileged, so this
// exercises the real chown/chmod on every host (mirrors adapter-utils'
// agent-shared-dir.test.ts).
const OWN_GID = typeof process.getgid === "function" ? process.getgid() : null;

describe.skipIf(process.platform === "win32" || OWN_GID == null)(
  "buildCursorSkillsDir agent-uid accessibility (SUP-13486)",
  () => {
    let root: string;
    const savedGidEnv = process.env.PAPERCLIP_AGENTS_GID;

    beforeEach(() => {
      resetAgentSharedGidCacheForTests();
    });

    afterEach(async () => {
      if (savedGidEnv === undefined) delete process.env.PAPERCLIP_AGENTS_GID;
      else process.env.PAPERCLIP_AGENTS_GID = savedGidEnv;
      resetAgentSharedGidCacheForTests();
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    const modeOf = async (p: string) => (await fs.stat(p)).mode & 0o7777;

    it("grants the agent child group access to the mkdtemp root and the skills dir", async () => {
      process.env.PAPERCLIP_AGENTS_GID = String(OWN_GID);
      resetAgentSharedGidCacheForTests();

      const skillsDir = await buildCursorSkillsDir({});
      root = path.dirname(skillsDir);

      // The mkdtemp root is fixed at 0700 by POSIX; the helper widens it to
      // setgid + group rwx and must not touch other.
      const rootMode = await modeOf(root);
      expect(rootMode & 0o070).toBe(0o070); // group rwx
      expect(rootMode & 0o2000).toBe(0o2000); // setgid, so child-created entries keep the gid
      expect(rootMode & 0o007).toBe(0);

      // The skills dir is created with fs.mkdir, which respects the umask
      // (0775 under 0002); the helper adds setgid + group rwx and leaves other
      // exactly as mkdir created it — never widened.
      const skillsMode = await modeOf(skillsDir);
      expect(skillsMode & 0o070).toBe(0o070);
      expect(skillsMode & 0o2000).toBe(0o2000);
      expect(skillsMode & 0o007).toBe(0o7 & ~process.umask());
    });

    it("fails soft when the agents group is absent", async () => {
      delete process.env.PAPERCLIP_AGENTS_GID;
      resetAgentSharedGidCacheForTests();

      // Whatever the host group table says, the helper must not throw: on ungated
      // hosts the child shares the server's uid and already has access, and the
      // group may also legitimately exist with the process a member of it. The
      // mode assertions are covered deterministically above via the injected gid.
      await expect(buildCursorSkillsDir({})).resolves.toBeTypeOf("string");
    });
  },
);
