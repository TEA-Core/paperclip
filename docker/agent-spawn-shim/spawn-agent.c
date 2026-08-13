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
#include <grp.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
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

  /* Unprivileged from here. execvp's PATH search is the caller's PATH, which is
   * safe precisely because we are already at AGENT_UID — it resolves with the
   * child's own privileges, not ours. */
  execvp(argv[1], &argv[1]);

  fprintf(stderr, "paperclip-spawn-agent: exec %s: %s\n", argv[1],
          strerror(errno));
  _exit(EXIT_EXEC);
}
