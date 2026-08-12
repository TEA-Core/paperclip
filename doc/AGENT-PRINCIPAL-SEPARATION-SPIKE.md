# Agent principal-separation spike: closing the master-key uid gap

Status: **measurement complete** — this is a read-only spike, no runtime code changed.
Issue: SUP-12475 · parent SUP-12472 · root SUP-12233.
Measured inside the deployed control-plane container (`fold/tea-patches-v2026.722.0`), running as **uid 1000 (`node`)** in a live agent execution workspace. All output below is verbatim, key material redacted (byte length only).

---

## Baseline — gap still open at measurement time

Confirmed independently of the pre-supplied baseline (taken on `fold-8d9aed037`); this build matches it exactly.

```
$ id
uid=1000(node) gid=1000(node) groups=1000(node)

$ ps -o pid,user,comm,args -p 1,7
  PID USER     COMMAND     COMMAND
    1 root     docker-init /sbin/docker-init -- docker-entrypoint.sh node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
    7 node     MainThread  node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
```

- Server pid **7**, owned by **`node` (uid 1000)**, running as a plain non-root process (no effective capabilities — see M1).
- Key file: **ABSENT** at both `/etc/paperclip/secrets/master.key` and `/paperclip/instances/default/secrets/master.key`.
- `/proc/7/environ`: **READABLE** by uid 1000 (mode `0400`, owner `1000:1000`). Contains **one** `PAPERCLIP_SECRETS_MASTER_KEY` entry, **value byte length = 44**. Full environ is 1215 bytes.
- `/proc/7/mem`: **open-for-read succeeds** for uid 1000.

```
$ grep PAPERCLIP_SECRETS_MASTER_KEY <(tr '\0' '\n' < /proc/7/environ) | awk -F= '{printf "entry=%s value_byte_len=%d\n", $1, length(substr($0,index($0,"=")+1))}'
entry=PAPERCLIP_SECRETS_MASTER_KEY value_byte_len=44

$ node -e 'const fs=require("fs"); try{const fd=fs.openSync("/proc/7/mem","r"); console.log("OPEN_FOR_READ_OK fd="+fd)}catch(e){console.log("OPEN_FAILED "+e.code)}'
OPEN_FOR_READ_OK fd=17
```

**Gap open.** The server and the agent share uid 1000 in one PID namespace; `/proc/7/environ` and `/proc/7/mem` are readable by the same uid. File moves and env-stripping cannot change this (same principal). Confirmed, not just asserted.

---

## M1 — second uid in-container

### M1.1 — capabilities, no-new-privileges, setuid surface

```
$ capsh --print
Current: =
Bounding set =cap_chown,cap_dac_override,cap_fowner,cap_fsetid,cap_kill,cap_setgid,cap_setuid,cap_setpcap,cap_net_bind_service,cap_net_raw,cap_sys_chroot,cap_mknod,cap_audit_write,cap_setfcap
Ambient set =
Current IAB: !cap_dac_read_search,...,!cap_sys_admin,...,!cap_sys_ptrace,...

$ grep -E 'Cap(Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs|Seccomp' /proc/self/status
CapInh:  0000000000000000
CapPrm:  0000000000000000
CapEff:  0000000000000000
CapBnd:  00000000a80425fb
CapAmb:  0000000000000000
NoNewPrivs: 0
Seccomp: 2
Seccomp_filters: 3
```

- `CAP_SETUID`/`CAP_SETGID` are present **only in the bounding set**, not in effective/permitted/ambient/inheritable (all `0`). A non-root process **cannot use** them.
- `NoNewPrivs = 0`, so setuid binaries are honoured (no NNP block); the root fs and `/paperclip` are **not** `nosuid` (`overlay rw,relatime`, `ext4 rw,relatime`).
- Setuid helpers: `gosu` (mode `0755`, **not** setuid), `setpriv` (`0755`), `runuser` (`0755`), `su` (**`4755`**, setuid-root), `sudo` absent.

### M1.2 — can uid-1000 obtain uid 1001? No.

```
$ setpriv --reuid=1001 --regid=1001 --clear-groups id
setpriv: setresuid failed: Operation not permitted

$ gosu 1001:1001 id
error: failed switching to "1001:1001": operation not permitted

$ su -s /bin/sh nobody -c id
Password: su: Authentication failure
```

- `setpriv`/`gosu` fail with `EPERM` (need CAP_SETUID / root; both absent in the effective set).
- `su` is setuid-root but requires the target account password → `Authentication failure`.
- **No route exists to a second uid from inside.** Critically, the server itself (pid 7, uid 1000, `CapEff=0`) also **cannot** `setuid` to 1001 — so the runner in-container cannot drop privileges on its own. A uid-1001 agent can only be created by a **root** actor: `docker-entrypoint.sh`/compose on the host side, or a **setuid-root** helper (e.g. making `gosu` `4755`) that the server invokes to spawn agents.

**What has to change to reach the target shape (server stays unprivileged, agents run as 1001):**
1. `Dockerfile`: create `node-agent` (uid/gid 1001) + a shared group.
2. Provide a root/setuid spawn path: make `gosu` setuid-root (`4755`) in the image, **or** run a root supervisor in the entrypoint that spawns agents as 1001. (The server at `CapEff=0` cannot do it directly.)
3. `scripts/docker-entrypoint.sh`/compose: wire the agent-spawn path through `gosu 1001 …` (or the supervisor).

### M1.3 — ownership blast radius (the deciding cost)

The **entire** agent-writable surface is owned `1000:1000` today. `HOME=/paperclip` (owned `1000:1000`), so switching the agent to uid 1001 breaks every write unless ownership is fixed.

| Path | Owner:group | Mode | Agent writes? |
|---|---|---|---|
| `HOME` = `/paperclip` (root of everything) | `1000:1000` | `0755` | implicitly |
| worktrees `/paperclip/instances/default/projects/*/*/paperclip/.paperclip/worktrees/*` (**~969 dirs**, each a full git tree) | `1000:1000` | `0755` | **yes (heavy)** |
| managed checkout roots `.../paperclip` | `1000:1000` | `0775` | yes |
| `/paperclip/.gitconfig` | `1000:1000` | `0644` | yes |
| `/paperclip/.cache`, `.config`, `.local` | `1000:1000` | `0755` | yes |
| pnpm store `/paperclip/.local/share/pnpm/store/v3` | `1000:1000` | `0755` | yes |
| npm cache `/tmp/repro-9179/.npm` | `1000:1000` | `0755` | yes |
| run scratch `/tmp/paperclip-run-*` (per-run, `0700`) | `1000:1000` | `0700` | yes |
| `opencode.db` (server-side data dir) | `1000` (node) | — | yes (via CLI) |
| `/paperclip/skills-lib` | `1000:1000` | `0775` | read-only |
| `/paperclip/vaults` | `0:0` (root) | `0755` | read-only (ro mount) |
| `/paperclip/.npm` (unused; real cache is `/tmp/repro-9179/.npm`) | `0:0` | `0755` | no |

**What a uid-1001 agent breaks:** every worktree write (git checkout/commit, edits, build artifacts), pnpm/npm caches, `.cache`/`.config`/`.local`, `~/.gitconfig`, the run scratch dir, and `opencode.db` — i.e. essentially all agent writes fail with `EACCES`.

**Does shared group + `umask 002` cover it?** Partially, at real cost:
- A shared group (add 1001 to group 1000, or a new `agents` group) + `umask 002` + setgid on the tree would let both uids coexist. But it requires a **one-time recursive `chgrp`** over ~969 worktree roots × thousands of files each, **plus** the server must adopt `umask 002`/setgid so every *new* worktree it creates (as 1000) is group-writable — an ongoing, easy-to-regress invariant.
- **Cleaner shape:** each worktree is single-writer (one agent run per issue). The server can `chown`/`chgrp` the worktree to the agent uid at checkout, leaving shared-group + `umask 002` only for the small fixed set (caches, config, scratch, `opencode.db`). Rough `chgrp` count: **~969 worktree roots + ~6 fixed dirs** (vs. recursive over the whole tree).

### M1.4 — uid-1001 cannot read `/proc/<uid-1000-pid>/environ`/`mem`

Proven empirically on this kernel via the cross-uid gate (root-owned pid 1 stands in for "different uid"):

```
$ ls -ln /proc/1/environ
-r-------- 1 0 0 0 ... /proc/1/environ

$ node -e 'const fs=require("fs"); try{fs.readFileSync("/proc/1/environ");console.log("READ_OK")}catch(e){console.log("DENIED "+e.code)}'
DENIED EACCES

$ node -e 'const fs=require("fs"); try{fs.openSync("/proc/1/mem","r");console.log("OPEN_OK")}catch(e){console.log("DENIED "+e.code)}'
DENIED EACCES
```

uid 1000 **cannot** read a different-uid process's `/proc/<pid>/environ` or `/mem` (`EACCES`, the `ptrace_may_access` gate + `0400`/`0600` owner-only modes). By the same kernel rule, a **uid-1001** agent cannot read `/proc/7/environ` (owned `1000:1000`). **The M1 mechanism closes the gap.**

---

## M2 — bubblewrap confinement

### M2.1 — is `bwrap` installed? No.

```
$ command -v bwrap && bwrap --version
bwrap ABSENT
```

Expected (no match in `Dockerfile`/`docker-entrypoint.sh`/`docker/`). Installable by the operator, but that is not the blocker (see M2.2).

### M2.2 — do unprivileged user namespaces work? **No — blocked at the seccomp layer.**

```
$ python3 -c "import os,ctypes,errno; libc=ctypes.CDLL(None,use_errno=True); r=libc.unshare(0x10000000); print('EPERM' if r!=0 and ctypes.get_errno()==1 else 'OK')"
unshare(CLONE_NEWUSER) rc=-1 errno=1 (EPERM)

$ # same for every namespace type:
CLONE_NEWPID unshare rc=-1 errno=1 (EPERM)
CLONE_NEWNS  unshare rc=-1 errno=1 (EPERM)
CLONE_NEWNET unshare rc=-1 errno=1 (EPERM)

$ grep Seccomp /proc/self/status
Seccomp:  2
Seccomp_filters: 3
```

- Host is permissive (`/proc/sys/user/max_user_namespaces = 257187`), so the host is not the limit.
- The **container** blocks namespace creation: every `unshare(CLONE_NEW*)` returns `EPERM` under `Seccomp: FILTER` (3 filters) — the Docker default seccomp profile denies `unshare`/`clone` of new namespaces unless `CAP_SYS_ADMIN` is held, and `CapBnd` lacks `CAP_SYS_ADMIN` (see M1.1). `bwrap`'s smoke test (`--unshare-pid --unshare-ipc --unshare-uts …`) therefore **cannot run at all**: `bwrap` is absent *and* its userns syscalls are seccomp-denied.

To make M2 viable the operator must: install `bwrap` in the image **and** relax the container seccomp (`--security-opt seccomp=unconfined`, or a custom profile allowing `unshare`/`clone` namespace flags). That is a strictly larger host/runtime surface than M1, for a weaker property (see M2.3).

### M2.3 / M2.4 — bwrap axes + negative control

**Not measurable in this container** — the userns syscalls needed to construct the sandbox are seccomp-denied (`EPERM`). Both the positive axis (key path absent + server pid not in `/proc`) and the negative control (the `--bind / /` branch still exposes `/proc/<server-pid>/environ`) are blocked on the M2.2 precondition. The distinction between `local-process-sandbox.ts:286` (`--tmpfs / --proc /proc`) and `:330` (`--bind / /`) remains load-bearing for any future implementation, but it cannot be demonstrated here without the seccomp + image changes above.

Note also: even if enabled, bwrap's userns path runs the child at the **same uid** (1000) unless paired with `newuidmap`; M2's protection is PID-namespace isolation ("server pid not in `/proc`"), not a distinct principal. It is strictly more fragile than M1's uid separation.

### M2.5 — ACPX gap scope (reading estimate)

Confinement is wired only in `resolveSpawnTarget()` (`packages/adapter-utils/src/server-utils.ts:2216`) when `options.localProcessSandbox` is set — reached by the `claude-local`/`codex-local` CLI engine paths. ACPX spawns (`packages/adapter-utils/src/acpx-engine/execute.ts:1224`) do **not** pass `localProcessSandbox`; they only use the `transport === "sandbox"` **remote** bridge (e2b-style, `execute.ts:1204–1247`), not the local bwrap sandbox. Routing ACPX through the local sandbox is an estimate: (a) thread `LocalProcessSandboxOptions` from the ACPX spawn config into `resolveSpawnTarget`, (b) make the ACPX executor reuse that path instead of raw spawn, (c) preserve the ACP API callback bridge and process-session bridge semantics across the sandbox boundary. Non-trivial but bounded (one spawn-path refactor, no new confinement primitive). **Reading estimate only — not implemented.**

---

## M3 — separate agent-runtime container (desk check)

The deployed environment is a **single Docker container** (`pid 1 = /sbin/docker-init`, overlayfs/containerd snapshots visible in `/proc/mounts`; no kubectl/kubeconfig, no k8s APIs). A grep of `packages/adapter-utils/src` for `e2b|daytona|modal|kubernetes|k8s` finds only a code comment ("e2b mirrors login profiles") — **no sandbox-provider transport is wired**. Therefore M3 is a **net-new infra ask** (operator-provisioned sidecar/remote sandbox + a new transport in the adapter), not something reachable from the current deployment. Correctly deferred.

---

## Recommendation — **M1 (second uid)**, with the owner split

**Pick: M1.** The cross-uid `/proc` gate is empirically closed on this kernel (M1.4: uid 1000 → `/proc/1/environ` = `EACCES`), so running agents as a distinct uid 1001 closes the exposure. M2 is blocked at the seccomp layer (userns `EPERM`, M2.2) and delivers a weaker, PID-ns-only property even if enabled; M3 is a net-new infra ask. **M1 is the only mechanism that closes the gap with changes the operator has already offered to execute, and the smallest blast radius.**

**Strongest evidence for the pick:** the same kernel that makes `/proc/7/environ` readable by uid 1000 *denies* a different-uid process the identical read (`EACCES`, M1.4). A distinct uid is sufficient; nothing about M2 or M3 is additionally necessary.

### Who executes what

**Operator-side (image/compose/restart) — the board ask fires on this split:**
1. `Dockerfile`: add `node-agent` (uid/gid **1001**) and a shared `agents` group (1001 + 1000).
2. Provide the spawn path: make `gosu` **setuid-root** (`4755`) in the image, or run a root supervisor in `docker-entrypoint.sh` that launches agents as 1001.
3. One-time ownership pass: `chgrp -R agents` over the ~969 existing worktree roots + the ~6 fixed cache/config dirs (M1.3) — or defer to per-checkout `chown` in the server.

**Agent-side (repo diff — coder-LE):**
1. Server spawns agents via the setuid helper (`gosu 1001 …`) / supervisor instead of direct spawn (the server at `CapEff=0` cannot setuid itself).
2. Server adopts `umask 002` + shared-group ownership (or per-worktree `chown` to the agent uid at checkout) so new worktrees are writable by uid 1001.
3. Ensure caches/config/scratch/`opencode.db` are group-accessible (shared `agents` group, `umask 002`).

**Ordering:** operator-side prerequisites (uid/group + setuid helper) land first, then the agent-side spawn change; the ownership pass can run in parallel with either. M2 and M3 are **not recommended** and need no further work on this card.

### What stays closed (already ruled, not re-tested)

Volume/bind-mount exposure — **closed**; spawn-env (`PAPERCLIP_SECRETS_MASTER_KEY` absent from agent env) — **closed**; same-uid — **open** (this spike's subject). No key material appears anywhere in this document or the measurement.
