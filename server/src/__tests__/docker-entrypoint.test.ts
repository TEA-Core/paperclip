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
 * The system commands (id, usermod, groupmod, chown, mkdir, stat, find, gosu) are stubbed
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

function installStubs(ids: {
  uid: number;
  gid: number;
  nodeUid?: number;
  nodeGid?: number;
  /** Owner uid of the app home ROOT. Defaults to node (already correct). */
  homeRootUid?: number;
}) {
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
  // The ownership probe is a single stat of the app home ROOT -- deliberately
  // not a tree walk. `find` is stubbed to log its invocation AND report a
  // mismatch, so reintroducing upstream's whole-tree probe both trips the
  // "does not walk the home tree" assertion and drives the recursive chown
  // that "never recursively chowns" forbids. A stub that stayed silent would
  // let the recursive path pass vacuously.
  writeStub("find", `echo "find $*" >> "${logFile}"\necho "$1/mismatched-entry"`);
  writeStub("stat", `echo ${ids.homeRootUid ?? 1000}`);
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

  it("remaps the node user and repairs the home root before gosu when root requests a different UID/GID", async () => {
    // The stubbed node uid stays 1000 while the stat probe reports root
    // ownership of the home root, modelling the mismatch that must be repaired.
    installStubs({ uid: 0, gid: 0, homeRootUid: 0 });

    const { stdout, calls } = await runEntrypoint({ USER_UID: "1001", USER_GID: "1001", PAPERCLIP_HOME: stubDir });

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(calls).toContain("usermod -o -u 1001 node");
    expect(calls).toContain("groupmod -o -g 1001 node");
    expect(calls).toContain(`chown node ${stubDir}`);
    expect(calls).toContain("gosu node echo ENTRYPOINT-CMD-RAN");
  });

  it("chowns a root-owned home root before gosu even with the default UID/GID (fresh volume mount)", async () => {
    // A freshly mounted volume arrives root-owned and shadows the image's
    // build-time chown; with no remap requested the old entrypoint dropped
    // privileges onto an unwritable home and the server crashed on its
    // first mkdir. A fresh volume is empty, so repairing the root is enough.
    installStubs({ uid: 0, gid: 0, homeRootUid: 0 });

    const { stdout, calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

    expect(stdout).toContain("ENTRYPOINT-CMD-RAN");
    expect(calls).toContain(`chown node ${stubDir}`);
    expect(calls).not.toContain("usermod");
    expect(calls).toContain("gosu node echo ENTRYPOINT-CMD-RAN");
  });

  it("never recursively chowns the app home, even when the root needs repair", async () => {
    // FORK INVARIANT. PAPERCLIP_HOME contains read-only bind mounts (vaults,
    // skills-lib), directories group-owned by `agents`, and a root-owned shared
    // toolchain. `chown -R` returns non-zero on the read-only mounts and, under
    // `set -e`, kills the entrypoint before the server ever listens -- the
    // 2026-08-15 fold-de08d947e deploy failed gate 2 for exactly this reason.
    // It would also strip the `agents` group fork-wide and make the shared
    // toolchain agent-writable.
    installStubs({ uid: 0, gid: 0, homeRootUid: 0 });

    const { calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

    expect(calls).not.toContain("chown -R");
  });

  it("does not walk the home tree to decide whether to repair ownership", async () => {
    // The probe must stay a single stat of the home root. A tree walk is both
    // costly on a large workspaces bind and the trigger for the recursive
    // chown this fork must never perform.
    installStubs({ uid: 0, gid: 0, homeRootUid: 0 });

    const { calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

    expect(calls).not.toContain("find ");
  });

  it("leaves a node-owned home root untouched (no per-boot chown of the volume)", async () => {
    installStubs({ uid: 0, gid: 0, homeRootUid: 1000 });

    const { calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

    // Scoped to the app home. The fork's unconditional single-directory
    // `chown node:node /etc/paperclip/secrets` is a different guard (see the
    // secrets-key-directory test above) and costs nothing per boot.
    expect(calls).not.toContain(`chown node ${stubDir}`);
    expect(calls).not.toContain("chown -R");
    expect(calls).toContain("gosu node echo ENTRYPOINT-CMD-RAN");
  });

  it("does not repair the home root on a GID-only remap when the owner already matches", async () => {
    // Divergence from upstream, which repaired descendants recursively here.
    // The fork's `agents` group ownership is deliberate, so a group difference
    // is not damage and must not trigger a chown.
    installStubs({ uid: 0, gid: 0, homeRootUid: 1000 });

    const { calls } = await runEntrypoint({ USER_GID: "1001", PAPERCLIP_HOME: stubDir });

    expect(calls).toContain("groupmod -o -g 1001 node");
    expect(calls).not.toContain("chown -R");
    expect(calls).not.toContain(`chown node ${stubDir}`);
  });

  it("honours PAPERCLIP_HOME for the ownership probe", async () => {
    installStubs({ uid: 0, gid: 0, homeRootUid: 0 });

    const { calls } = await runEntrypoint({ PAPERCLIP_HOME: stubDir });

    expect(calls).toContain(`chown node ${stubDir}`);
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
