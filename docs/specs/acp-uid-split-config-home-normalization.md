# ACP uid split — agent-side Claude config-home normalization

Decision record for SUP-13870 (design input to the SUP-13489 uid-split rollout).
Status: **decided**; implemented by SUP-13872 on the SUP-13489 branch.

## Context

The local ACP lane seeds a per-agent Claude config home at
`<instanceRoot>/companies/<companyId>/agents/<agentId>/claude-config` and repoints
`CLAUDE_CONFIG_DIR` onto it (`packages/adapters/claude-local/src/server/acp.ts`). Two
server-side (uid 1000) mechanisms keep that tree group-`agents`-reachable:

- the seed, `seedAgentSideClaudeConfig`
  (`packages/adapters/claude-local/src/server/claude-config.ts`), which pre-creates the SDK
  subdirs and chmods them; and
- the run-end teardown `normalizeAgentSideClaudeConfigDirPermissions`, fired via
  `cleanupRemoteBridges` (`packages/adapter-utils/src/acpx-engine/execute.ts`), which
  re-applies `2770` + group `agents` across the tree.

Both work today only because the whole lane runs as uid 1000, so every dir they touch is
uid-1000-owned. A live probe (SUP-13863) showed the claude CLI re-creates `sessions/` at an
explicit `0700` and the active `projects/<slug>` at `2700` at run start, every run, ignoring
umask — the teardown is what erases those bits afterwards.

Once SUP-13489 arms the split and the bridge/CLI run as uid 1001 (`node-agent`), those dirs are
created owned by uid 1001, and a uid-1000 `chmod`/`chgrp` on them is `EPERM`.

## Decision

**Option 1 — normalize from the agent uid**, with a narrowed ownership contract.

### Why not shim-enforced group-writable creation

`umask` and POSIX default ACLs are both *masks*: they can only clear bits from the mode a caller
passes, never add them. The CLI calls `mkdir` with an explicit `0700`, so no umask policy in
`docker/agent-spawn-shim/spawn-agent.c` (whose header already disclaims umask as its job) and no
default ACL on the home can turn that into `2770`. Only syscall interposition
(`LD_PRELOAD`/seccomp over `mkdir`/`chmod`) could, and that is not a boundary this fork should
own.

### Why not accept-and-log degradation

Post-arming the failure is a **throw**, not a log. The seed's per-subdir chmod is unguarded, and
is awaited unguarded from `prepareClaudeLocalManagedHome` and again from the acpx-engine
`execute` seam. Once `sessions/` or `projects/` is uid-1001-owned, that chmod `EPERM`s out of the
managed-home seam and **fails the run at prep, before the bridge launches**. That is a hard
arming blocker regardless of which option is chosen.

### The 2770 invariant is kept

"All agents share uid 1001 anyway" invites dropping the requirement. Don't: the server still
writes *below* the home root — e.g. the poisoned-session unlink at
`<claudeConfigDir>/projects/<encodedCwd>/<sessionId>.jsonl`
(`packages/adapters/claude-local/src/server/execute.ts`), whose directory is resolved from
`CLAUDE_CONFIG_DIR`. Group-write on `projects/<slug>` is what keeps that reachable at uid 1000.

## Post-arming ownership contract

For `<instanceRoot>/companies/<companyId>/agents/<agentId>/claude-config`:

| path | owner | mode | enforced by |
|---|---|---|---|
| home root | uid 1000 (`node`) | `2770`, group `agents` | server seed (unchanged — it owns the dir) |
| `.credentials.json`, `.claude.json` | uid 1000 | `0660`, group `agents` | server seed temp+rename (unchanged) |
| every dir below the root | uid 1001 (`node-agent`) after the first armed run | `2770`, group `agents` | agent-uid normalizer |

## Owning mechanism

1. **The run-end normalizer moves to the agent uid.** The teardown returned by
   `prepareClaudeLocalManagedHome` is shim-exec'd: the server execs the standalone normalizer
   through the setuid spawn shim, which lands at uid 1001 and walks the tree as its owner. Every
   property of the walk is preserved — dirent-type-only recursion (never follows a symlink out of
   the home), per-dir best-effort, files untouched, faults logged and never thrown. The child env
   is scrubbed (no `PAPERCLIP_SECRETS_*`, no `DATABASE_*`).
2. **Selection keys off the same predicate that arms the lane** (`resolveAcpAgentSpawnTarget`).
   Armed → shim-exec'd pass; unarmed → today's in-process walk, byte-identical. No third state,
   no second flag to drift.
3. **Both passes run when the tree is mixed-ownership.** A home populated before arming is
   entirely uid-1000-owned, and uid 1000 cannot hand it over (`chown` to another uid needs
   `CAP_CHOWN`, which the server does not hold). Running the in-process pass *and* the shim pass
   covers the tree by union. Each pass stat-and-skips dirs it does not own **while still
   recursing through them**, so the other side's dirs emit no EPERM noise.
4. **The seed stops pre-creating the SDK subdirs when armed**, and its chmod/chgrp is best-effort
   in all cases. Post-arming the agent uid creates and owns them; the server guarantees only the
   home root plus the two credential files. This is what removes the prep-time throw, and it
   blocks arming on its own.
5. **Normalizer argv is path-constrained** — it refuses any target not matching
   `<instanceRoot>/companies/*/agents/*/claude-config`. The shim already execs arbitrary argv as
   uid 1001 by design (the grant runs *away* from privilege), so this is hygiene on our side of
   the seam, not a boundary claim about the shim.

## Acceptance delta for SUP-13777 / SUP-13489

Replace "zero `0700` dirs" with the shape that is true post-arming:

1. After an armed run: `find <configDir> -type d ! -perm -2070` is empty.
2. After an armed run on a home first created post-arming:
   `find <configDir> -mindepth 1 -type d ! -user node-agent` is empty; `<configDir>` itself is
   uid `node`, mode `2770`, group `agents`.
3. **Second-run assertion — the one that catches this regression.** Two armed runs for the same
   agent: the second must reach the bridge (no prep-time throw) and its seed must log no
   `could not chmod` line for the SDK subdirs.
4. After two armed runs, `.credentials.json` is uid `node`, `0660`, group `agents` (proves the
   temp+rename refresh still lands over a CLI-rewritten `.claude.json`).
5. Reachability probe as uid 1001:
   `test -r <configDir>/.credentials.json && test -w <configDir>/sessions`.
6. Unarmed-lane regression: with the split off, SUP-13503's evidence shape (all dirs `2770`, zero
   exceptions) still holds byte-identical.

## Open question (gated on SUP-13777, not blocking this decision)

SUP-13863 observed `sessions/` at `0700` mid-run but not *how* it got there: the CLI either
(a) chmods the existing dir, or (b) removes and recreates it. Under (a), post-arming the CLI at
uid 1001 would chmod a uid-1000-owned dir → `EPERM` inside the CLI, with unknown CLI-side
handling. Mechanism item 4 makes newly created homes safe under both branches, so the branch only
matters for a home carried over from the unarmed era. Probe before the first armed run against an
existing home: pre-set `sessions/` to `2770` uid-1000, run once armed, re-stat owner+mode (or
`strace -f -e trace=mkdir,mkdirat,chmod,fchmodat`). If (a) holds, the arming step must remove that
agent's SDK subdirs once — session resume is lost for one run, and there is no alternative,
because uid 1000 cannot hand the dirs over.

## References

- SUP-13863 — live probe (mid-run `0700` `sessions/`, `2700` active `projects/<slug>`; post-run
  134 × `2770`, zero exceptions).
- SUP-13503 / PR #342 (`0e061c38d`) — the run-end teardown mechanism.
- SUP-13504 / PR #347 — `agentSpawnTarget` arming on the local ACP lane.
- SUP-13872 — implementation of mechanism items 1–5.
