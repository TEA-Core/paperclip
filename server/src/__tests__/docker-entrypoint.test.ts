import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Behavioral tests for scripts/docker-entrypoint.sh privilege handling.
 *
 * The entrypoint must support two deployment shapes with one image:
 *  - Docker Compose: container starts as root, remaps the node user to
 *    USER_UID/USER_GID and drops privileges via gosu.
 *  - Kubernetes restricted PodSecurity / OpenShift arbitrary UIDs: the
 *    container starts non-root, where neither the remap nor gosu can work,
 *    so the command must be exec'd directly (with a warning on mismatch).
 *
 * The system commands (id, usermod, groupmod, chown, mkdir, gosu) are stubbed
 * via PATH so the branching logic runs unmodified on any host. mkdir is stubbed
 * because the root path creates /etc/paperclip/secrets, which an unprivileged
 * test host cannot write.
 */

const ENTRYPOINT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "docker-entrypoint.sh");

let stubDir: string;
let logFile: string;

function writeStub(name: string, body: string) {
  const path = join(stubDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function installStubs(ids: { uid: number; gid: number; nodeUid?: number; nodeGid?: number; homeMismatch?: boolean }) {
  writeStub(
    "id",
    [
      `if [ "$1" = "-u" ] && [ "$2" = "node" ]; then echo ${ids.nodeUid ?? 1000};`,
      `elif [ "$1" = "-g" ] && [ "$2" = "node" ]; then echo ${ids.nodeGid ?? 1000};`,
      `elif [ "$1" = "-u" ]; then echo ${ids.uid};`,
      `elif [ "$1" = "-g" ]; then echo ${ids.gid};`,
      `else echo 0; fi`,
    ].join("\n"),
  );
  for (const cmd of ["usermod", "groupmod", "chown", "mkdir"]) {
    writeStub(cmd, `echo "${cmd} $*" >> "${logFile}"`);
  }
  // The entrypoint's ownership probe is a first-mismatch find over the app
  // home. An empty result models a fully node-owned tree (image-baked dir,
  // healthy volume); a path models any uid OR gid mismatch anywhere in the
  // tree (fresh root-owned mount, root-owned descendant, stale group after
  // a GID-only remap).
  writeStub("find", ids.homeMismatch ? `echo "$1/mismatched-entry"` : `true`);
  writeStub("gosu", `echo "gosu $*" >> "${logFile}"\nshift\nexec "$@"`);
}

async function runEntrypoint(env: Record<string, string> = {}) {
  const result = await execFileAsync("sh", [ENTRYPOINT, "echo", "ENTRYPOINT-CMD-RAN"], {
    env: { PATH: `${stubDir}:${process.env.PATH}`, ...env },
  });
  const calls = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  return { stdout: result.stdout, stderr: result.stderr, calls };
}

beforeEach(() => {
  stubDir = mkdtempSync(join(tmpdir(), "entrypoint-stubs-"));
  logFile = join(stubDir, "calls.log");
});

afterEach(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

describe("docker-entrypoint.sh", () => {
  it("keeps the root-start gosu flow with default UID/GID (Docker Compose)", async () => {
    installStubs({ uid: 0, gid: 0 });

    const { stdout, calls } = await runEntrypoint();

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(calls).toContain("gosu node echo ENTRYPOINT-CMD-RAN");
    expect(calls).not.toContain("usermod");
    expect(calls).not.toContain("chown -R node:node /paperclip");
  });

  it("pre-creates the secrets key directory outside the paperclip volume when root", async () => {
    installStubs({ uid: 0, gid: 0 });

    const { stdout, calls } = await runEntrypoint();

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(calls).toContain("mkdir -p /etc/paperclip/secrets");
    expect(calls).toContain("chown node:node /etc/paperclip/secrets");
  });

  it("remaps the node user and chowns /paperclip before gosu when root requests a different UID/GID", async () => {
    // The stubbed node uid stays 1000 while the stat probe reports the old
    // ownership, modelling the post-remap mismatch that must trigger chown.
    installStubs({ uid: 0, gid: 0, homeMismatch: true });

    const { stdout, calls } = await runEntrypoint({ USER_UID: "1001", USER_GID: "1001", PAPERCLIP_HOME: stubDir });

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(calls).toContain("usermod -o -u 1001 node");
    expect(calls).toContain("groupmod -o -g 1001 node");
    expect(calls).toContain(`chown -R node:node ${stubDir}`);
    expect(calls).toContain("gosu node echo ENTRYPOINT-CMD-RAN");
  });

  it("chowns a root-owned home before gosu even with the default UID/GID (fresh volume mount)", async () => {
    // A freshly mounted volume arrives root-owned and shadows the image's
    // build-time chown; with no remap requested the old entrypoint dropped
    // privileges onto an unwritable home and the server crashed on its
    // first mkdir.
    installStubs({ uid: 0, gid: 0, homeMismatch: true });

    const { stdout, calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(calls).toContain(`chown -R node:node ${stubDir}`);
    expect(calls).not.toContain("usermod");
    expect(calls).toContain("gosu node echo ENTRYPOINT-CMD-RAN");
  });

  it("repairs ownership on a GID-only remap (stale group on persisted descendants)", async () => {
    installStubs({ uid: 0, gid: 0, homeMismatch: true });

    const { calls } = await runEntrypoint({ USER_GID: "1001", PAPERCLIP_HOME: stubDir });

    expect(calls).toContain("groupmod -o -g 1001 node");
    expect(calls).toContain(`chown -R node:node ${stubDir}`);
  });

  it("keeps a fully node-owned tree chown-free (no per-boot recursive chown)", async () => {
    installStubs({ uid: 0, gid: 0, homeMismatch: false });

    const { calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

    // Scoped to the recursive walk this test is named for. The fork's
    // unconditional single-directory `chown node:node /etc/paperclip/secrets`
    // is a different guard (see the secrets-key-directory test above) and
    // costs nothing per boot.
    expect(calls).not.toContain("chown -R");
    expect(calls).toContain("gosu node echo ENTRYPOINT-CMD-RAN");
  });

  it("honours PAPERCLIP_HOME for the ownership probe", async () => {
    installStubs({ uid: 0, gid: 0, homeMismatch: true });

    const { calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

    expect(calls).toContain(`chown -R node:node ${stubDir}`);
  });

  it("execs directly and silently when already running as the requested user (restricted PodSecurity)", async () => {
    installStubs({ uid: 1000, gid: 1000 });

    const { stdout, stderr, calls } = await runEntrypoint();

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(stderr).toBe("");
    expect(calls).toBe("");
  });

  it("execs directly with a warning for an arbitrary non-root UID (OpenShift-style)", async () => {
    installStubs({ uid: 1234, gid: 1234 });

    const { stdout, stderr, calls } = await runEntrypoint();

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(stderr).toContain("running unprivileged as 1234:1234; cannot remap to requested 1000:1000");
    expect(calls).toBe("");
  });

  it("execs directly with a warning on a non-root GID mismatch", async () => {
    installStubs({ uid: 1000, gid: 1001 });

    const { stdout, stderr, calls } = await runEntrypoint();

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(stderr).toContain("running unprivileged as 1000:1001; cannot remap to requested 1000:1000");
    expect(calls).toBe("");
  });

  it("has umask 002 set before the gosu exec on the root path (Docker Compose)", () => {
    const script = readFileSync(ENTRYPOINT, "utf8");
    const lines = script.split("\n");
    const umaskLineIdx = lines.findIndex((l) => l.trim() === "umask 002");
    const gosuExecIdx = lines.findIndex((l) => l.trim() === "exec gosu node \"$@\"");
    expect(umaskLineIdx).toBeGreaterThanOrEqual(0);
    expect(gosuExecIdx).toBeGreaterThanOrEqual(0);
    expect(umaskLineIdx).toBeLessThan(gosuExecIdx);
  });

  it("has umask 002 set before the direct exec on the unprivileged path", () => {
    const script = readFileSync(ENTRYPOINT, "utf8");
    const lines = script.split("\n");
    const umaskLineIdx = lines.findIndex((l) => l.trim() === "umask 002");
    const directExecIdx = lines.findIndex((l) => l.trim().startsWith("exec ") && l.trim() !== "exec gosu node \"$@\"");
    expect(umaskLineIdx).toBeGreaterThanOrEqual(0);
    expect(directExecIdx).toBeGreaterThanOrEqual(0);
    expect(umaskLineIdx).toBeLessThan(directExecIdx);
  });

  it("applies umask 002 so files created by the server command are group-writable", async () => {
    installStubs({ uid: 0, gid: 0 });

    const outFile = join(stubDir, "created-by-server.txt");
    const result = await execFileAsync("sh", [ENTRYPOINT, "sh", "-c", `touch ${outFile}`], {
      env: { PATH: `${stubDir}:${process.env.PATH}` },
    });

    expect(existsSync(outFile)).toBe(true);
    const mode = statSync(outFile).mode;
    expect(mode & 0o020).toBe(0o020);
  });
});
