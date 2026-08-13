import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const shimSource = readFileSync(path.join(repoRoot, "docker/agent-spawn-shim/spawn-agent.c"), "utf8");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
// Negative assertions run against instructions only. The Dockerfile *comments*
// warn against exactly the strings those assertions forbid, so matching prose
// would fail the build for documenting the hazard.
const dockerfileInstructions = dockerfile
  .split("\n")
  .filter(line => !line.trimStart().startsWith("#"))
  .join("\n");

// paperclip-spawn-agent is the only setuid-root binary we ship, and it exists to
// hold one property: an agent run cannot read the master key out of
// /proc/<server-pid>/environ, because it is a different uid.
//
// The end-to-end proof of that needs a real uid-1001 process and a real setuid
// bit, so it lives in docker/agent-spawn-shim/test-spawn-shim.sh and runs in a
// container. What is pinned HERE is the set of invariants that would silently
// void the property if someone edited them -- each one is a change that leaves a
// working-looking shim behind, which is exactly how this workstream produced
// three prior half-landings.

test("the target uid is fixed at compile time and never taken from the caller", () => {
  // The single most important property in the file. A caller-selectable uid
  // would be asked for 0, and M1 would be void.
  assert.match(shimSource, /#define\s+AGENT_UID\s+1001/, "AGENT_UID must be a compile-time constant");
  assert.match(shimSource, /setuid\(AGENT_UID\)/, "must drop to the constant, not a variable");

  // No route by which argv or the environment can name the uid.
  assert.doesNotMatch(shimSource, /getenv\s*\(/, "the shim must not read the environment for any decision");
  assert.doesNotMatch(
    shimSource,
    /set(uid|gid|groups)\s*\(\s*(atoi|strtol|argv)/,
    "credential changes must never derive from argv",
  );
});

test("a build that would land on root fails to compile", () => {
  assert.match(
    shimSource,
    /#if\s+AGENT_UID\s*==\s*0\s*\|\|\s*AGENT_GID\s*==\s*0[\s\S]*?#error/,
    "an AGENT_UID of 0 must be a compile error, not a runtime surprise",
  );
});

test("the privilege drop happens in the only safe order", () => {
  const groups = shimSource.indexOf("setgroups(");
  const gid = shimSource.indexOf("setgid(AGENT_GID)");
  const uid = shimSource.indexOf("setuid(AGENT_UID)");
  const exec = shimSource.indexOf("execvp(");

  assert.ok(groups > 0 && gid > 0 && uid > 0 && exec > 0, "all four steps must be present");
  assert.ok(groups < gid, "setgroups must precede setgid");
  assert.ok(gid < uid, "setgid must precede setuid -- after setuid the gid can no longer be changed");
  assert.ok(uid < exec, "the drop must complete before exec");
});

test("supplementary groups are pinned, not inherited from the caller", () => {
  // Inheriting happens to give the right answer today. It is right by accident,
  // and silently becomes wrong the moment the server user gains a group.
  assert.match(shimSource, /const\s+gid_t\s+groups\[\]\s*=\s*\{\s*AGENTS_GID\s*\}/, "the group set must be explicit");
  assert.match(shimSource, /setgroups\(/, "setgroups must actually be called");
});

test("every credential-change return is checked and nothing execs after a failed drop", () => {
  // Anchor on the real calls -- the surrounding comments mention setgroups() too.
  for (const call of ["setgroups(sizeof", "setgid(AGENT_GID)", "setuid(AGENT_UID)"]) {
    const idx = shimSource.indexOf(call);
    const stmt = shimSource.slice(idx - 4, shimSource.indexOf("\n", idx) + 1);
    assert.match(stmt, /if\s*\(/, `${call} return value must be checked`);
  }
  // And the drop is verified rather than assumed.
  assert.match(shimSource, /getuid\(\)\s*!=\s*AGENT_UID/, "must verify the uid actually took");
  assert.match(shimSource, /setuid\(0\)\s*==\s*0/, "must prove root cannot be regained before exec'ing");
});

test("the shim refuses to run unprivileged instead of silently staying uid 1000", () => {
  // A stripped setuid bit or a nosuid mount must be loud. A silent fallback
  // would leave agents on the server's uid while looking like it worked.
  assert.match(shimSource, /ST_NOSUID/, "must detect a nosuid mount explicitly");
  assert.match(shimSource, /geteuid\(\)\s*!=\s*0/, "must refuse to continue without euid 0");
});

test("Dockerfile creates both principals and the shared group", () => {
  assert.match(dockerfile, /groupadd -g \$\{AGENTS_GID\} agents/, "the agents group must exist");
  assert.match(dockerfile, /useradd -u \$\{AGENT_UID\}[^\n]*-G agents[^\n]*node-agent/, "node-agent must be in agents");
  assert.match(dockerfile, /usermod -aG agents node/, "the server user must also be in agents");
});

test("Dockerfile installs the shim setuid-root and proves it works at build time", () => {
  assert.match(dockerfile, /chown root:root \/usr\/local\/sbin\/paperclip-spawn-agent/);
  assert.match(dockerfile, /chmod 4755 \/usr\/local\/sbin\/paperclip-spawn-agent/);
  assert.match(dockerfile, /-Werror/, "the shim must compile clean or fail the build");

  // A broken shim must fail the build, not surface later as an agent fault.
  assert.match(
    dockerfile,
    /paperclip-spawn-agent id -u\)" = "\$\{AGENT_UID\}"/,
    "the build must assert the shim lands on AGENT_UID",
  );
  assert.match(
    dockerfile,
    /paperclip-spawn-agent sh -c[\s\S]{0,80}\/proc\/1\/environ/,
    "the build must assert a cross-uid /proc read is denied",
  );
});

test("the exec probes run on a native build and are loudly skipped under emulation", () => {
  // Under binfmt/qemu the kernel execs the non-setuid emulator, so the setuid
  // bit is never honoured and the shim's euid!=0 refusal fires. The probes can
  // therefore only ever pass natively -- but a skipped probe must be visible in
  // the build log rather than reading like a passed one.
  assert.match(dockerfile, /^ARG BUILDPLATFORM$/m, "BUILDPLATFORM must be declared for buildx to inject it");
  assert.match(dockerfile, /^ARG TARGETPLATFORM$/m, "TARGETPLATFORM must be declared for buildx to inject it");

  const gate = dockerfile.match(
    /if \[ "\$\{BUILDPLATFORM\}" = "\$\{TARGETPLATFORM\}" \]; then([\s\S]*?)else([\s\S]*?)fi/,
  );
  assert.ok(gate, "the exec probes must be gated on BUILDPLATFORM == TARGETPLATFORM");

  const [, nativeBranch, emulatedBranch] = gate;
  assert.match(nativeBranch, /paperclip-spawn-agent id -u/, "the native branch must keep the uid probe");
  assert.match(nativeBranch, /\/proc\/1\/environ/, "the native branch must keep the cross-uid /proc probe");

  assert.doesNotMatch(
    emulatedBranch,
    /gosu node \/usr\/local\/sbin\/paperclip-spawn-agent/,
    "the emulated branch must not attempt a probe that can never pass",
  );
  assert.match(emulatedBranch, /echo "SKIP/, "a skipped probe must be announced in the build log");

  // The gate is worthless if a second, ungated copy of a probe survives: the
  // arm64 build would fail on that one instead.
  const probeLines = dockerfileInstructions
    .split("\n")
    .filter(line => /gosu node \/usr\/local\/sbin\/paperclip-spawn-agent/.test(line));
  assert.ok(probeLines.length > 0, "the probes must still exist");
  const gateIdx = dockerfileInstructions.indexOf('if [ "${BUILDPLATFORM}" = "${TARGETPLATFORM}" ]');
  assert.ok(gateIdx > 0, "the gate must live in an instruction, not only in a comment");
  for (const line of probeLines) {
    assert.ok(
      dockerfileInstructions.indexOf(line) > gateIdx,
      `probe must sit inside the native-build gate: ${line.trim()}`,
    );
  }
});

test("gosu is never made setuid, and node never gets CAP_SETUID", () => {
  // Both are the tempting shortcuts. gosu self-aborts when setuid, which would
  // break `exec gosu node` in the entrypoint and stop the container starting.
  // setcap on node hands CAP_SETUID to the agent runtime, so it can setuid(0)
  // -- that voids M1 rather than delivering it.
  assert.doesNotMatch(
    dockerfileInstructions,
    /chmod\s+[0-7]*4[0-7]{3}\s+\S*gosu/,
    "gosu must never be given a setuid bit",
  );
  assert.doesNotMatch(
    dockerfileInstructions,
    /setcap[^\n]*cap_setuid/,
    "node must never carry CAP_SETUID",
  );
});
