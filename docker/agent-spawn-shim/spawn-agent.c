/*
 * paperclip-spawn-agent — setuid-root exec shim.
 *
 * Route M1 (SUP-12472 / SUP-12531): the control-plane server runs as uid 1000
 * and agent runs must land on uid 1001, so that an agent cannot read the master
 * key out of /proc/<server-pid>/environ. The same kernel that lets uid 1000 read
 * its own /proc/<pid>/environ denies that read across a uid boundary, and
 * ptrace_may_access is symmetric — so a distinct uid is sufficient.
 *
 * The server cannot do this itself: it runs at CapEff=0 and every in-process
 * route (setpriv, gosu, unshare) returns EPERM. The privilege has to come from
 * the image. This binary is that privilege, scoped as narrowly as it can be:
 * it exists to move 1000 -> 1001 and immediately exec, nothing else.
 *
 * WHY NOT gosu (which the earlier plan named): gosu carries an unconditional
 * self-check that aborts when its own setuid bit is set, and it fires for root
 * too. `chmod 4755 /usr/sbin/gosu` does not produce a spawn path, it produces a
 * container that will not start, because docker-entrypoint.sh ends in
 * `exec gosu node "$@"`. Measured on the deployed image; see SUP-12472.
 *
 * WHY NOT `setcap cap_setuid+ep` on the node binary: that hands CAP_SETUID to
 * the agent's own runtime, so an agent can setuid(0). It voids M1 rather than
 * delivering it. Do not add it as a "simpler" alternative.
 *
 * THREAT MODEL. The grant runs *away* from the privileged principal: the shim
 * only ever lands on AGENT_UID, so an agent that already is AGENT_UID gains
 * nothing by invoking it. The target uid is a compile-time constant and is
 * never read from argv or the environment — if a caller could name its own uid
 * it would name 0, and M1 would be void. That is the single most important
 * property in this file.
 *
 * NOT this binary's job:
 *   - Environment scrubbing. The acpx spawn boundary already strips
 *     PAPERCLIP_SECRETS_MASTER_KEY from child envs, and the child legitimately
 *     needs the rest of its environment.
 *   - umask. The server sets umask 0002 (SUP-12529) and the child inherits it.
 *   - Closing inherited descriptors. The parent is the server, which already
 *     controls what it passes; adding a blanket close here would break the
 *     stdio plumbing the adapters depend on.
 *
 * Exit codes are distinct so a failure is never mistaken for the child's own:
 *   64  usage
 *   70  a precondition or privilege-drop step failed (never exec'd)
 *   127 exec failed
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/statvfs.h>
#include <sys/types.h>
#include <unistd.h>

/* Overridable at build time so the Dockerfile stays the single source of truth
 * for the ids, but every one of them is fixed at compile time. */
#ifndef AGENT_UID
#define AGENT_UID 1001
#endif
#ifndef AGENT_GID
#define AGENT_GID 1001
#endif
#ifndef AGENTS_GID
#define AGENTS_GID 1002
#endif

/* A shim that can land on root is not a privilege boundary, it is a rootkit.
 * Fail the build rather than ship one. */
#if AGENT_UID == 0 || AGENT_GID == 0
#error "AGENT_UID/AGENT_GID must not be 0 — the shim must never land on root"
#endif

/* Mirrors DEFAULT_AGENT_OOM_SCORE_ADJ in
 * packages/adapter-utils/src/oom-priority.ts. A string because the only thing
 * done with it is a write() to /proc.
 *
 * COMPILE-TIME, like every other tunable in this file, and deliberately NOT read
 * from the environment. An earlier revision of this change read
 * PAPERCLIP_AGENT_OOM_SCORE_ADJ out of the environment and was correctly rejected
 * by scripts/__tests__/agent-spawn-shim.test.mjs, which pins "the shim must not
 * read the environment for any decision". That guard is broader than the uid property
 * it is written next to, and that breadth is the point: this is the only
 * setuid-root binary shipped, its caller is not always trusted, and "reads no
 * environment at all" is an invariant that can be audited in one grep, whereas
 * "reads only harmless variables" cannot. The Dockerfile stays the single source
 * of truth, exactly as it is for AGENT_UID/AGENT_GID/AGENTS_GID. */
#ifndef AGENT_OOM_SCORE_ADJ
#define AGENT_OOM_SCORE_ADJ 500
#endif

/* Stringify the build arg so it can be passed as a bare number, exactly like
 * -DAGENT_UID=${AGENT_UID}. Two levels are required: the inner macro must see the
 * expanded value, not the parameter name. */
#define OOM_SCORE_ADJ_STR_(x) #x
#define OOM_SCORE_ADJ_STR(x) OOM_SCORE_ADJ_STR_(x)

/* The kernel accepts -1000..1000 and rejects anything else with EINVAL. Since the
 * write below is best-effort, an out-of-range build arg would otherwise produce an
 * image that builds, passes its probes, and silently carries no OOM mark at all.
 * Fail the build instead, exactly as an AGENT_UID of 0 does. */
#if AGENT_OOM_SCORE_ADJ > 1000 || AGENT_OOM_SCORE_ADJ < -1000
#error "AGENT_OOM_SCORE_ADJ must be within the kernel range -1000..1000"
#endif

/* How many nice steps below its caller (the server) the agent tree runs.
 * Agent runs share the server's container, and so its CPU cgroup: at equal
 * priority the scheduler splits CPU per runnable thread, so an agent that
 * launches a large test fleet or a deliberate CPU-load reproduction outweighs
 * the control plane. On 2026-09-30 one agent's 128 busy-loop workers drove the
 * host to load 184 at the server's own priority. At 10, a nice-0 thread
 * competing with 16 busy agent threads on two cores got 0.68 of a core instead
 * of 0.11 (measured on the production kernel, in a container, with the workers
 * in their own sessions).
 *
 * COMPILE-TIME, for the same reason as AGENT_OOM_SCORE_ADJ: this binary reads no
 * environment. 0 compiles the step out and leaves the inherited priority alone.
 * A negative value would let the agent tree outrank the server, so it fails the
 * build — and the step runs after the privilege drop anyway, where the kernel
 * refuses an unprivileged process any attempt to raise its own priority. */
#ifndef AGENT_NICE
#define AGENT_NICE 10
#endif

#if AGENT_NICE < 0 || AGENT_NICE > 19
#error "AGENT_NICE must be within 0..19 — agents must never outrank the server"
#endif

#define EXIT_USAGE 64
#define EXIT_PRECONDITION 70
#define EXIT_EXEC 127

static void fail(const char *what) {
  fprintf(stderr, "paperclip-spawn-agent: %s: %s\n", what, strerror(errno));
  _exit(EXIT_PRECONDITION);
}

static void fail_msg(const char *what) {
  fprintf(stderr, "paperclip-spawn-agent: %s\n", what);
  _exit(EXIT_PRECONDITION);
}

#if AGENT_OOM_SCORE_ADJ != 0
/* Report and CONTINUE. The OOM mark is best-effort, so a failure must never stop
 * the privilege drop or the exec — but it must not be invisible either. Silence is
 * exactly how the server-side version of this write went unnoticed for a day while
 * failing on every spawn. */
static void oom_warn(const char *what) {
  fprintf(stderr, "paperclip-spawn-agent: %s: %s (continuing; the agent tree keeps "
                  "its inherited OOM priority)\n",
          what, strerror(errno));
}
#endif

#if AGENT_NICE != 0
/* Report and CONTINUE, like oom_warn: a lower priority is best-effort and must
 * never stop the exec, but a failure must not be silent. */
static void nice_warn(const char *what) {
  fprintf(stderr, "paperclip-spawn-agent: %s: %s (continuing; the agent tree keeps "
                  "its inherited CPU priority)\n",
          what, strerror(errno));
}
#endif

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr,
            "usage: paperclip-spawn-agent <command> [args...]\n"
            "  Drops to uid %d/gid %d (both fixed at compile time) and execs.\n"
            "  The target uid is NOT selectable by the caller, by design.\n",
            AGENT_UID, AGENT_GID);
    _exit(EXIT_USAGE);
  }

  /* Precondition 1: the filesystem holding this binary must honour setuid.
   * A nosuid mount would leave us unprivileged, and the drop below would then
   * "succeed" as a no-op while the child kept the server's uid — a silent
   * failure that presents as an agent fault. Checked explicitly so the error
   * names the real cause. */
  struct statvfs vfs;
  if (statvfs("/proc/self/exe", &vfs) != 0) {
    fail("cannot statvfs /proc/self/exe");
  }
  if (vfs.f_flag & ST_NOSUID) {
    fail_msg("the filesystem holding this binary is mounted nosuid, so the "
             "setuid bit is ignored — fix the mount options, do not work around this");
  }

  /* Precondition 2: we must actually be setuid-root. Catches a missing or
   * stripped setuid bit, and any nosuid case the check above did not. */
  if (geteuid() != 0) {
    fprintf(stderr,
            "paperclip-spawn-agent: not running with euid 0 (euid=%d) — the "
            "setuid bit is missing or not honoured; refusing to exec\n",
            (int)geteuid());
    _exit(EXIT_PRECONDITION);
  }

  /* Make this process — and therefore the whole agent tree that inherits from
   * it — the kernel's preferred OOM victim, so a runaway agent workload cannot
   * take the control plane down with it. See
   * packages/adapter-utils/src/oom-priority.ts for the incident this defends.
   *
   * WHY IT HAS TO HAPPEN HERE, and not in the server (SUP-17664). The server
   * calls deprioritizeForOom(child.pid) right after spawn(), which works only
   * while no setuid binary is in the spawn path. Once this shim is the spawn
   * target the server can never write that file, at any instant:
   *
   *   - A setuid-root execve is a secure-exec, so the kernel re-owns
   *     the child's /proc entries to root:root (mode 644) BEFORE this shim
   *     runs a single instruction. Measured: at the moment spawn() returns,
   *     the child reads `Uid: 1000 0 0 0` — real uid still the server's,
   *     euid 0, this shim not yet dropped — and the server's write already
   *     fails EACCES, 20/20.
   *   - After the drop below, the same file belongs to AGENT_UID. Still not the
   *     server's uid.
   *
   * So there is no window to hurry into or defer to; the write simply cannot be
   * done from outside. It can be done from HERE, because we still hold euid 0
   * and the file is ours, and oom_score_adj survives both the credential change
   * and the execve at the end of this function — which is precisely what makes
   * one write here cover the provider CLI, the agent's shell and anything they
   * launch. Both spawn lanes (the CLI lane via resolveSpawnTarget and the ACPX
   * lane via resolveAcpAgentSpawnTarget) exec THIS binary, so this single site
   * covers both.
   *
   * Strictly best-effort, exactly like the helper it replaces: a failure here
   * must never fail the exec, because the worst case is the status quo ante.
   *
   * The value is a build arg, not an env var — see AGENT_OOM_SCORE_ADJ above for
   * why. Under the uid split there is therefore no runtime kill switch: changing
   * it means rebuilding with --build-arg AGENT_OOM_SCORE_ADJ=<n>.
   *
   * A build arg of 0 compiles this block out ENTIRELY rather than writing "0".
   * Writing 0 is not the same as not writing: the shim holds euid 0 here, so it
   * could LOWER a nonzero inherited adjustment and quietly make the agent tree a
   * less likely victim than the deployment asked for. "Disabled" has to mean
   * "leave whatever was inherited alone", which is also what
   * resolveAgentOomScoreAdj()'s `clamped === 0` early return already does on the
   * server side.
   *
   * PAPERCLIP_AGENT_OOM_SCORE_ADJ still governs the server-side call in
   * deployments that do NOT arm the split, where that call is the one that does
   * the work.
   */
#if AGENT_OOM_SCORE_ADJ != 0
  {
    static const char value[] = OOM_SCORE_ADJ_STR(AGENT_OOM_SCORE_ADJ);
    const size_t len = sizeof(value) - 1;
    int fd = open("/proc/self/oom_score_adj", O_WRONLY);
    if (fd < 0) {
      oom_warn("cannot open /proc/self/oom_score_adj");
    } else {
      ssize_t written = write(fd, value, len);
      if (written < 0) {
        oom_warn("cannot write /proc/self/oom_score_adj");
      } else if ((size_t)written != len) {
        fprintf(stderr,
                "paperclip-spawn-agent: short write to /proc/self/oom_score_adj "
                "(%zd of %zu bytes); the agent tree keeps its inherited OOM "
                "priority\n",
                written, len);
      }
      if (close(fd) != 0) {
        oom_warn("cannot close /proc/self/oom_score_adj");
      }
    }
  }
#endif

  /* Drop, in the only order that is safe: supplementary groups, then gid, then
   * uid. setuid() last, because it is the step that makes the rest impossible.
   *
   * setgroups() is explicit rather than inherited. Inheriting happens to give
   * the right answer today, but it is right by accident: the moment anyone adds
   * a supplementary group to the server user, that group silently rides through
   * into the agent principal and nothing fails visibly. Pin the set. */
  const gid_t groups[] = {AGENTS_GID};
  if (setgroups(sizeof(groups) / sizeof(groups[0]), groups) != 0) {
    fail("setgroups failed");
  }
  if (setgid(AGENT_GID) != 0) {
    fail("setgid failed");
  }
  if (setuid(AGENT_UID) != 0) {
    fail("setuid failed");
  }

  /* Verify the drop rather than trusting the return codes. This is the classic
   * setuid defect: a drop that did not take, followed by an exec that therefore
   * runs as root. Every check below must hold before we are allowed to exec. */
  if (getuid() != AGENT_UID || geteuid() != AGENT_UID) {
    fail_msg("uid did not take after setuid; refusing to exec");
  }
  if (getgid() != AGENT_GID || getegid() != AGENT_GID) {
    fail_msg("gid did not take after setgid; refusing to exec");
  }

  /* The saved-set-uid must have been cleared too, or the child could climb back
   * to root at a time of its choosing. setuid() from euid 0 sets real, effective
   * and saved — so this must now fail. If it succeeds we are root again, and the
   * only safe thing to do is die. */
  if (setuid(0) == 0) {
    fail_msg("privilege drop incomplete — regained uid 0 after dropping; "
             "refusing to exec");
  }

  /* And the group set must be exactly what we asked for. */
  gid_t actual[NGROUPS_MAX];
  int n = getgroups(NGROUPS_MAX, actual);
  if (n < 0) {
    fail("getgroups failed");
  }
  for (int i = 0; i < n; i++) {
    if (actual[i] != AGENTS_GID && actual[i] != AGENT_GID) {
      fprintf(stderr,
              "paperclip-spawn-agent: unexpected supplementary group %d "
              "survived the drop; refusing to exec\n",
              (int)actual[i]);
      _exit(EXIT_PRECONDITION);
    }
  }

  /* Lower the agent tree's CPU priority AGENT_NICE steps below the caller's,
   * capped at the kernel ceiling of 19. Relative rather than absolute, so the
   * agents stay below the server whatever priority the server itself runs at.
   * It inherits across fork and exec, so this one call covers the provider CLI
   * and everything it launches. Done here, after the drop, on purpose: an
   * unprivileged process may only lower its own priority, so no build value and
   * no bug in this block can ever put an agent above the server. */
#if AGENT_NICE != 0
  {
    errno = 0;
    const int current = getpriority(PRIO_PROCESS, 0);
    if (current == -1 && errno != 0) {
      nice_warn("cannot read the current CPU priority");
    } else {
      const int target = current + AGENT_NICE > 19 ? 19 : current + AGENT_NICE;
      if (target > current && setpriority(PRIO_PROCESS, 0, target) != 0) {
        nice_warn("cannot lower the CPU priority");
      }
    }
  }
#endif

  /* Unprivileged from here. execvp's PATH search is the caller's PATH, which is
   * safe precisely because we are already at AGENT_UID — it resolves with the
   * child's own privileges, not ours. */
  execvp(argv[1], &argv[1]);

  fprintf(stderr, "paperclip-spawn-agent: exec %s: %s\n", argv[1],
          strerror(errno));
  _exit(EXIT_EXEC);
}
