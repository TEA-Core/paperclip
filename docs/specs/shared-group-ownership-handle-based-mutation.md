# Shared-group ownership repair — resolve-then-mutate-by-handle

Architecture ruling for SUP-14684 (ADR-023 chain-depth breaker, 3rd surfacing of
`Finding signature: worktree-writability-repair-symlink-escape`).
Status: **decided** (exec-CTO, 2026-09-01). Implemented by SUP-14687 as a fixup on carrier PR #433;
FIFO/special-file hardening (`O_NONBLOCK`) shipped by SUP-14865 / PR #482 (commit `70c067649`).

Root: SUP-14642. Prior swings: SUP-14667 (leaf `lstat` guard), SUP-14674 (realpath containment,
commit `1cc0a9ec`).

## Context

`ensureSharedGroupOwnership` (`server/src/services/shared-group-ownership.ts`) is the fleet's
one repair for the M1 uid split (server uid 1000, agent uid 1001): set a path's group to
`agents` and add group `rwx`, so both uids can write it. SUP-14642 wired it into the worktree
writability self-repair loop, which walks paths that agent uid 1001 owns and can rewrite.

That made a server-uid mutation take its target from an agent-controlled name. Three review
rounds found three layers of the same defect:

| Swing | Guard shipped | What it missed |
|---|---|---|
| Round 1 (`7b9768662`) | none | any symlink |
| Redo 1 (`460d9809d`) | `fs.lstat` + `isSymbolicLink` on the leaf | `lstat` skips following only the FINAL component — a symlinked ANCESTOR still resolves through to an external target, and `isSymbolicLink()` reads false |
| Redo 2 (`1cc0a9ec`) | `fs.realpath(fullPath)` must stay under `fs.realpath(worktreePath)` | the check resolves, then hands the LEXICAL `fullPath` to `ensureSharedGroupOwnership`, which re-resolves BY NAME and mutates symlink-following (`fs.stat`/`fs.chown`/`fs.chmod`, lines 156-159) |

Redo 2's static case is correct and accepted. What remains is a TOCTOU: check and mutation
do not operate on the same object. A concurrent swap of `fullPath` or any ancestor to a
symlink between the two redirects `chown`/`chmod` to the external target.

The escape is not theoretical. Probed on this platform (Node v24.20.0, linux) by taking the
redo-2 containment check, then renaming the intermediate directory and symlinking it at a
protected tree:

```text
check passes containment: true
post-swap fs.stat(lexical) resolves to: .../protected/file.txt
  -> today's chown/chmod would hit: OUTSIDE TARGET (escape)
```

Reachability: the server user owns the three denied roots (secrets master-key dir,
embedded-Postgres data dir, database backup dir), so `chown`-to-a-group-it-belongs-to and
`chmod` both succeed for it. A redirected repair grants group `agents` — i.e. every agent uid —
`rwx` on the secrets master key. This is an agent-uid → server-uid privilege escalation, not a
cosmetic race.

`isDeniedServerOwnedDirOrAncestor` does not stop it: it compares a lexical `path.resolve`, and
under an ancestor swap the lexical path still reads as inside the worktree.

## Decision

Authorize the scope change to `shared-group-ownership.ts` that the redo-2 envelope banned.
The ban was the error: the envelope put the containment obligation on the caller while the
mutation stayed in the callee. The deliverer stayed in scope correctly; the scope was wrong.

### 1. Atomicity lives in the callee, not the caller

`ensureSharedGroupOwnership` mutates, so `ensureSharedGroupOwnership` owns atomicity. There are
**twelve** call sites across `workspace-runtime.ts`, `heartbeat.ts`, and `run-scratch.ts`; a
caller-side wrapper would harden one and leave eleven path-based.

### 2. `O_NOFOLLOW` alone is NOT the fix

`O_NOFOLLOW` refuses a symlink in the **final component only** — ancestors are still followed at
open time. Shipping `fs.open(..., O_NOFOLLOW)` + `fchown`/`fchmod` and calling it done would
repeat redo 1's leaf-only mistake one layer up, as a fourth surfacing. It is a necessary part of
the fix, not the fix.

### 3. The primitive: open once, verify the OPENED INODE, mutate through the handle

```js
let handle;
try {
  // The open itself is inside the guarded section: ELOOP on a leaf symlink, EACCES,
  // ENOENT, and EWOULDBLOCK/ENXIO all throw here, and §4 requires every one of them to
  // skip, not fall back. O_NONBLOCK is load-bearing: without it, opening a FIFO (named
  // pipe) blocks until a writer connects, hanging the repair and, at scale, exhausting
  // the libuv thread pool (SUP-14865, commit 70c067649).
  handle = await fs.open(
    target,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  // Containment is checked on the object we are holding, not on a name that can
  // be re-pointed. /proc/self/fd/<fd> names the inode this fd actually refers to.
  const verified = await fs.realpath(`/proc/self/fd/${handle.fd}`);
  if (containmentRoot && !isWithin(verified, containmentRoot)) {
    warn(
      `Paperclip: refusing shared-group ownership on ${dirPath} — it resolves to ${verified}, ` +
        `outside the containment root ${containmentRoot}.`,
    );
    return;
  }
  if (
    isDeniedServerOwnedDirOrAncestor(verified, [
      resolveMasterKeyDir,
      resolvePostgresDataDir,
      resolveDatabaseBackupDir,
    ])
  ) {
    warn(
      `Paperclip: refusing shared-group ownership on ${dirPath} — it resolves to ${verified}, ` +
        `a server-owned directory (secrets master-key, embedded-Postgres data, or database backup), ` +
        `an ancestor of one, or a descendant of one.`,
    );
    return;
  }
  const st = await handle.stat();
  // A special file (FIFO, character/block device, socket) is not a directory or a
  // regular file; group-ownership repair does not apply. O_NONBLOCK already kept the
  // open from hanging on a FIFO; now refuse to mutate the inode. Fail closed: one
  // warned skip, no mutation, no path-based fallback.
  if (isSpecialFileType(st.mode)) {
    warn(
      `Paperclip: skipping shared-group ownership on ${dirPath} — the opened target is a ` +
        `special file (FIFO, character/block device, or socket), not a directory or regular ` +
        `file. Shared-group traversal repair applies to directories and regular files only. ` +
        `No mutation performed.`,
    );
    return;
  }
  await handle.chown(st.uid, gid);            // fchown — no path resolution
  await handle.chmod((st.mode & 0o7777) | 0o2070); // fchmod — no path resolution
} catch (err) {
  warn(...); // §4: skip the repair. No path-based fallback on any error.
} finally {
  // close() can reject (EIO, EBADF). Swallowing it is deliberate: an await that
  // throws from `finally` REPLACES the primary error — the escape-relevant one —
  // with a cleanup failure, and there is nothing left to repair by then either way.
  await handle?.close().catch(() => {});
}
```

Every skip is a **warned** skip, not a bare `return`. The containment branch, the denied-dir
branch, the special-file skip, and §4's `catch` are the four exits, and each emits exactly one
`warn`. This is load-bearing, not cosmetic: `shared-group-ownership.test.ts` asserts `warnSpy`
was called exactly once with `expect.stringContaining("refusing shared-group ownership")` at
**seven** sites — `:169`, `:189`, `:208`, `:253`, `:273`, `:292`, `:398` — and the special-file
skip has its own assertion (`expect.stringContaining("special file")`, shipped in `70c067649`).
A silent skip turns a live escape attempt into an invisible no-op and fails all of them. Keep
the `refusing shared-group ownership` substring in the denied-dir message; the containment
refusal and the special-file skip are separate cases, each with its own test.

The `finally` swallow is likewise not style. Probed on this platform:

```text
bare  await handle.close()   -> CLEANUP: EIO on close      <- primary error LOST
await handle.close().catch() -> PRIMARY: escape detected   <- primary error survives
FileHandle.close() thenable/catchable: true true
```

An awaited rejection in `finally` replaces the in-flight exception. With a bare
`await handle?.close()`, an `EIO`/`EBADF` on close would overwrite exactly the error §4 exists
to surface, and would escape the `catch` above it — throwing out of a function all twelve call
sites treat as best-effort.

`isDeniedServerOwnedDirOrAncestor` and the three resolver locals are the existing symbols in
`server/src/services/shared-group-ownership.ts` — the guard at `:30-39` and the `resolveMasterKeyDir` /
`resolvePostgresDataDir` / `resolveDatabaseBackupDir` locals bound at `:123-125`. This is the same
guard §5 hardens, called on the **verified** path instead of the lexical `dirPath`; the call shape
above and §5 name one symbol, not two.

Why this closes the race: after the `open`, the fd names one fixed inode. Any rename or symlink
swap that lands afterwards cannot change what the fd refers to, and `fchown`/`fchmod` resolve
nothing. Whatever the attacker did *before* the open is caught by reading the fd's real path
back out of `/proc/self/fd`. Check and mutation are finally on the same object.

Probed working on this platform:

```text
platform: linux O_NOFOLLOW: 131072
handle path via /proc/self/fd: .../protected/file.txt
containment on OPENED inode: OUTSIDE -> skip (fail closed)
fchmod on handle OK; FileHandle.chown is fn: true
leaf symlink open rejected: ELOOP
```

Node core exposes no `openat(2)`, so a component-by-component descent is not available in pure
JS; `/proc/self/fd` is the supported equivalent and this server runs on Linux.

**FIFO and special files.** `O_NONBLOCK` plus the `isSpecialFileType` skip is the shipped
behaviour, not a future addition. It shipped as SUP-14865 / PR #482 (commit `70c067649`,
merged on `fold`), which added `O_NONBLOCK` to the open and a `SPECIAL_FILE_TYPES` set
(`S_IFIFO`/`S_IFCHR`/`S_IFBLK`/`S_IFSOCK`) so that any special-file target — identified after
`handle.stat()` by its `mode & S_IFMT` — is skipped with exactly one warning and no `chown`/`chmod`.
Special files are neither directories nor regular files, so applying group-ownership repair to
them is meaningless at best and a surprising side effect at worst.

### 4. Fail closed, always

Every error path — `ELOOP` (leaf symlink), `EACCES` (unopenable), `ENOENT` (vanished),
`EWOULDBLOCK`/`ENXIO` (a special file whose non-blocking open cannot be established on this
platform), a special-file target (FIFO, character/block device, socket), non-Linux, `/proc`
unavailable — **skips the repair with a warning**. There is no fallback to path-based
mutation. Skipping degrades to the pre-existing operator-facing error, which is safe; falling
back reintroduces the escape on exactly the paths an attacker can arrange.

### 5. Fix the denied-dir guard while it is open

`isDeniedServerOwnedDirOrAncestor` (`:30-39`) must (a) take the **verified** path from step 3
rather than a lexical `path.resolve`, and (b) deny **both directions**. Today it denies a denied
root and its ancestors but not its descendants — `<pgdata>/base/1234` passes. On a verified path
this guard becomes a real second line instead of decoration.

### Residual, accepted and documented

A hardlink placed inside the worktree pointing at a server-owned **file** would present a
verified path inside the worktree. Not reachable under M1: the three denied roots are
directories (not hardlinkable), and `fs.protected_hardlinks` plus agent uid 1001's lack of write
access to server-owned files blocks the file case. Document in code; do not build for it.

## Delivery shape

**Fixup on carrier PR #433 (head `1cc0a9ec`). Not a fresh fix after merge.**

- The CodeRabbit `CHANGES_REQUESTED` on #433 (`2026-09-01T02:48:37Z`) flags this exact TOCTOU and
  support-CR confirmed it is real. Merging #433 first would mean dismissing a valid, undismissed
  external review — gate-gaming, and the class of thing that produces an architecture review.
- One carrier keeps leaf → ancestor → TOCTOU reviewable as a single unit and needs one green
  `merge_group` run rather than two.
- SUP-14674 and SUP-14642 are both parked on this carrier; merging a knowingly-incomplete #433
  would close them over a live escape.

PR #433 stays `OPEN`. The `CHANGES_REQUESTED` is **not** to be dismissed — it clears the normal
way: push the fixup, then `@coderabbitai full review` (an incremental re-review request refuses
and leaves the block standing). Merge only on a green `merge_group` run; PR-head green is not
`merge_group` green. The PR-head shard failure on run `33463700208`
(`workspace-runtime-exposure.test.ts`, `EADDRINUSE 0.0.0.0:52000`) is a pre-existing port
conflict in a file this change does not touch.

## Routing

Implementation goes to **coder-BE** as a newly-scoped child (SUP-14687), **not** a
`work-type:redo`. ADR-023 forbids redo #3, and redo would also mis-attribute: the deliverer did
not defect, the envelope did. The ruling terminates at exec-CTO and is recorded here; only the
newly-scoped implementation moves.

Observation for the record: SUP-14674 was assigned to coder-LE, who authored `1cc0a9ec`.
Per V.LESUP.1 coder-LE does not implement (repro / probe / surgical unblock only). The
corrective action is this routing — implementation to coder-BE, review to support-CR.
