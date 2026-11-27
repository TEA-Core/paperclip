# Persistent agent files

Each managed agent has one current directory, scoped by company and agent. The
Instructions Editor reads and writes this directory. `AGENTS.md` (or the
configured entry) is one file in it. Agents may create ordinary files and nested
folders for notes, memory, and other personal working material. Files in the
task working directory remain task files.

Agents can edit their own managed files under the responsible user’s current
target permissions. Access to another agent’s files additionally requires the
caller’s own target-scoped configuration permission; shared company membership
or a responsible user alone does not grant peer access.

## Layout

The canonical host directory keeps its existing physical location:

```
<instance>/companies/<company>/agents/<agent>/
  instructions/                 current agent files (editor)
    AGENTS.md
    notes/
    any-supported-file
  file-sync/                   operational state (live copies may be agents-group readable)
    adopted.json
    canonical-manifest.json   metadata/hash cache, no file contents
    runs/<initial-run>/
      owner.json              current run owning the writable copy
      live/                   writable copy for the provider lifetime
```

The process starts in its existing task workspace. `AGENT_HOME` points to the
registered writable agent copy. Adapter `HOME` and `CODEX_HOME` keep their
existing meanings and are not personal-file storage. Local copies are outside
the task workspace. Remote providers currently confine file sync to their
workspace: their independent agent copy therefore lives under the excluded
`.paperclip-runtime/agent-files/<agent>/<run>/` area. It is not included in task
workspace sync, Git staging, or task deliverables.

The runtime's agents group is resolved by name (`agents`) only. When the name
does not resolve (no such group, no `getent`, or a lookup timeout), no group is
used and the server logs a warning, whatever `PAPERCLIP_AGENTS_GID` says.
`PAPERCLIP_AGENTS_GID` is accepted only when it equals the named group's gid;
an override that differs, is gid `0`, or is the server's own primary group is
refused and no group is used. The group is used only when the server process
may assign it (it is root or a member).

Editor saves, bundle initialization/import, and adoption of revision-backed files
write instruction files as `0640` and directories as `0750`, both owned by the
agents group, explicitly independent of umask. Group read is intentional; group
write and world access are never granted. When no agents group resolves, these
writes stay owner-only (`0600` files, `0700` directories) and grant no group
access. Each write replaces the file with a new inode in the final mode and
group. It also sets every existing directory from the instruction root down to
that file to the same layout, so a loose (for example `0777`) directory is
tightened. Each of those directories must be owned by the server user.

For canonical storage under `<instance>/companies/`, each existing directory
from the instance root down to the instruction root (the agent directory
included) must be owned by the server user and must not be world-writable. A
server-owned directory there that is only group-writable loses group write in
place. Nothing outside the instance root is checked or changed.

A write is refused with `INSTRUCTION_STORAGE_UNSAFE` when a directory is owned
by another user (`reason: "foreign-owner"`), when an ancestor is world-writable
(`"world-writable-ancestor"`), or when a mode cannot be tightened
(`"cannot-tighten"`). Files that are not written are not bulk-migrated. The
adoption marker remains private (`0600`).

Instruction files are readable by every member of the agents group. Do not put
secrets (API keys, tokens, passwords, credentials) in instruction files or
doctrine; give agents secrets through secret references in their environment
variables instead.

When the agents group resolves as described above, the fork stages live directories with modes derived from owner bits:
at most `02750` (setgid, group read/traverse), owned by that group.
The `file-sync/`, `runs/`, and run directories have at most `0750`, without
setgid inheritance. Files retain their owner permissions and gain
group read only when the canonical file grants both owner read and group read;
group execute then follows owner execute (`0755` becomes `0750`). Files without
canonical group-read intent stay owner-only (`0600` stays `0600`, `0700` stays
`0700`, and `0604` becomes `0600`). No world access or group write is granted.
The run directory stays `0700` throughout copying and all descendant mode/group
assignments; only the completed tree is opened to the group. This also applies
when staging retries in an existing run directory.
Modes are applied explicitly, independent of umask. If any group or mode
assignment is denied, the run falls back to a fresh copy behind a `0700` run
directory and its receipt does not claim group staging. Without an assignable
group the run also stays private. Both private paths keep only owner permission
bits on all staged entries; no canonical group/world permission bits are copied.
Remote SSH and sandbox restores use the same rule: the run directory closes
before the transport writes any bytes, then the permission walk removes remote
group/world write bits before the run directory opens again. Restore-created
directories have the staged directory mode, never a published `02775`.
Legacy private copies staged before formula versioning kept canonical modes;
their restore stays behind the `0700` run directory without a mode-changing walk.
Warm remote checkpoints download into an owner-only `0700` scratch directory
inside the run directory, and the permission walk removes every group and world
bit from the downloaded entries before validation and save.
The permission walk refuses links and special files with the named
`422` refusal, so a link restored from a remote or sandbox run is not retried.
It rejects changed inode identities, opens entries without following symlinks,
and changes modes and groups through file handles. On Linux it also pins parent
directories through `/proc/self/fd`. Other POSIX hosts, such as macOS, compare
each opened handle's device, inode, and link count with its `lstat` result and
rely on the private `0700` run directory for ancestor stability. Windows has no
POSIX modes, so it skips group staging and the run stays owner-only.
Staging never changes canonical files: a file still at its staged mode is saved
with its canonical mode; only a mode the run itself set is saved. Receipts record
the staging formula version, so copies staged by the earlier group build (`0640`
files, `0750` executables) still map those modes back to the canonical mode.
Version 3 also records the owner-only formula for private runs. Earlier private
copies kept canonical modes when staged, so their live modes are saved as they are.
The canonical manifest cache and warm-run `owner.json` fence are created
atomically as `0600`, including after a warm handoff. Their parent directories
deny group write, so peers cannot create, replace, or unlink these files under
umask `002`. Unsafe old manifest caches are discarded and rebuilt.
Replacing an existing canonical file retains that file's own group, even when its
parent or the live copy has a different group. If the server may not assign that
group (`EPERM`/`EINVAL`), the file is still replaced and a warning names the path
and group. Files and folders a run creates take their canonical parent
folder's group (never the live copy's agents group), with the same best-effort
warning. A new file's mode follows the staging rule (owner bits, group read at
most, never group write; `0664` becomes `0640`), and new folders are `0750`. Runtime ancestor permissions are unchanged.

The fork runs every adapter as one shared principal in the agents group, so any
adapter process can read the live copies of other agents and other companies
while their runs are live. This visibility is an accepted policy of the
shared-principal model; there is no per-agent or per-company group.

Regular files (including binary bytes) and directories are supported, up to
100,000 entries (files and folders), 256 MiB per file and 2 GiB total. Symlinks,
hardlinks, and special
files are rejected, rather than followed or silently skipped. The instruction
entry remains valid UTF-8, at most 1 MiB, and cannot be deleted. The editor edits
text up to 1 MiB and offers downloads for binary or larger files. The reserved
`.paperclip-runtime` directory and the compatibility-only virtual file
`promptTemplate.legacy.md` are not user storage. Task cache and Git ignore
exclusions do not apply to this directory.

These storage limits are separate from the 1 MiB instruction/editor limit. Large
files are hashed and downloaded as streams; listings bound concurrent reads,
and only editor-sized text is buffered. Storage counts uncompressed file bytes,
not allocated disk
blocks. These are sync validation limits, not live filesystem quotas: an agent
can write beyond them while running. Storage limits never pause an agent, fail
a provider run, or block future task admission. A folder at or above a limit
produces a warning on each run until enough files have been removed or shrunk.
Existing saved files are restored even when already over quota, so the agent
can continue working and clean them up with ordinary filesystem tools. Unsafe
paths and links still fail validation; bypassing a storage quota does not
bypass those checks.

An API save above a storage limit returns 422 without changing the saved files.
If a stopped run exceeds a storage limit, none of its agent-folder changes are
saved. The run shows a nonblocking storage warning and its save receipt reports
`AGENT_FILES_LIMIT_EXCEEDED` with the specific limit
and, for an oversized file, its path. The previous saved folder is used on the
next run. The temporary run copy is discarded, including on a limit failure;
there is no retained recovery archive or partial-save option. Transient sync
failures get up to three attempts at the stop boundary before cleanup and an
explicit failure receipt. Individual file writes are atomic, but an I/O failure
partway through a sync can leave some files updated; a failed receipt does not
claim whole-folder success.

Sync failures are diagnostics for the affected run, not errors on the current
files in the Instructions Editor. Historical failures remain in the run log;
the run detail also shows warnings from its save receipt. The editor only shows
preserved instruction-only candidates that may need review, alongside errors
from the current browser edit. Later successful saves do not erase run history.

Initial restoration copies the canonical folder once. Warm native Codex turns
reuse that working directory. Checkpoints enumerate file metadata, hash files
whose identity/size/mode/mtime/ctime changed, and temporarily copy and transfer
only changed file contents. Deletions and empty directories travel as manifest
entries. An unchanged image is neither rehashed nor recopied after its first
checkpoint. A modified file is transferred in full; this is a file-level delta,
not block-level deduplication. Canonical hash caches and manifests contain no
file contents. Temporary checkpoint payloads are removed after application.
The operator still provisions storage for the canonical folders, active working
copies and changed-file payloads; these are not aggregate disk quotas.

## Run lifecycle

1. Under the agent lock, restore current files into a private run copy and save
   a baseline of paths, kinds, modes, and hashes. This is sync metadata, not a
   revision history.
2. Stage the copy through the existing workspace transport. Point `AGENT_HOME`
   and instruction guidance at that registered root.
3. For warm native Codex, capture a manifest and changed-file payload at each
   terminal turn boundary before admitting another turn. Check file metadata
   before and after streaming and hash the captured payload independently on
   the host. Retry an unstable checkpoint up to three times; if it cannot be
   validated, close the owned provider and perform the stopped collector. Other
   execution paths retain their stopped-provider collection boundary.
4. Recheck the responsible user's current authorization. Under the same agent
   lock used by editor writes, apply only files changed or deleted relative to
   the last acknowledged baseline. For a competing edit or deletion of the same
   file, the last synchronization to acquire the lock wins. Unchanged files do
   not overwrite another run's changes; newly added unrelated files survive.
5. Record the save receipt and advance the baseline only after application. A
   warm session keeps its directory and hands ownership to the next run using
   a controller-owned marker. Old callbacks cannot collect or remove the next
   owner's files. On session retirement, collect any later writes and remove
   the private directory. No per-run file versions or conflict copies accumulate.

These are validated **per-file checkpoints**, not an atomic snapshot of arbitrary
background writers across an entire directory. Writes after a checkpoint remain
pending until the next checkpoint or verified session retirement. A save receipt
acknowledges only the captured bytes. Lost remote bytes or missing stop proof
cannot become a successful save.

Warm reuse requires the actual live session, the same remote environment and
provider lease, and unchanged canonical files since its last checkpoint. An
editor or another task changing canonical files retires that session before a
fresh copy is restored. A directory-path mismatch also forces retirement. Only
the loaded instruction entry participates in the runtime instruction digest;
ordinary memory/image edits do not change it. Changes to loaded instructions,
policy, credentials or provider configuration may still replace the process.
Relative supporting files are read from `AGENT_HOME`, not the read-only prompt
snapshot. External instruction bundles remain read-only and use their existing
lifecycle.

The editor supplies the hash of the file it read. A stale browser save returns
409 and retains the user's unsaved draft. Run synchronization itself uses
per-file last-sync-wins: a later run can overwrite a saved browser edit to the
same file. There is no text merge or historical copy to recover the overwritten
version. Ordinary task files continue using their existing workspace contract.

## Upgrade and recovery

Migration 0287 creates the preview tables idempotently after master’s 0285/0286.
Existing preview receipts, rows, constraints, and pending captures are retained.
On first use, while holding
the agent row lock, import any deployed revision heads into the existing managed
directory once. A controller-owned marker outside agent files prevents any
later replay of those heads. Existing revision rows remain readable for recovery;
new saves never append to them. Old UUID-based clients receive content tokens
and can still submit their previously recorded revision IDs, which are checked
against the corresponding bytes before a write.

Working-copy receipts and native runtime inputs record the new file contract.
A restored native session with no contract field keeps the old instruction-only
copy shape, prompt digest, paths, and collector. Its writes use the compatibility
bridge into current files, with the original baseline fence. Existing pending
legacy candidates remain resolvable. Neither old task workspaces nor arbitrary
external instruction roots are imported as agent directories.

Stock-agent and plugin resets update their declared files while retaining unrelated
personal files and formerly configured entries. Automatic stock upgrades first
record baseline hashes in the existing resource binding, then apply and finalize
under the agent lock. A failed file write or database commit retries against
those hashes and already-applied bytes. Removed, unchanged stock files are
removed; intervening personal edits stop the retry. This pending operation
metadata is cleared on success and does not retain file revisions.

External bundles retain their existing behavior. Their migration to managed
storage is an explicit configuration action. Historical task cwd, provider-home,
checkpoint, and workspace restoration formats are not rewritten.

Backups must include the persistent instance filesystem as well as the database.
New current-file bytes are not database revision rows. Old instruction-only
candidates are retained solely for upgrade compatibility.

Crash recovery can collect a stopped working copy without starting a model.
Cleanup does not wait for a directory lock before process-stop proof exists, or
after the copy is superseded or cleanup is complete. An unavailable copy keeps
its failed-save receipt. Recovery can later clean an unavailable remote copy
after destruction of its exact lease and executes no remote command. An
unavailable local copy can still contain uncollected edits; this cleanup path
preserves those bytes even if local stop proof arrives later.
Deferred cleanup retries after a
delay so one blocked copy does not prevent other copies from being cleaned.
If releasing a run's instruction copy fails, the run records a cleanup warning
and leaves the durable copy for the recovery sweep. Cleanup does not replace the
provider's result, discard usage accounting, or prevent environment lease release.
It does not claim that unsaved agent-file changes were saved; collection failures
keep their separate failed-save receipts. A run attempts failed cleanup only once
before handing it to recovery, rather than repeating the lock wait in teardown.
Re-preparing an existing run uses the same lock as cleanup and rechecks its
receipt under that lock. Preparing a new run keeps its separate admission path.
Missing stop proof or lost remote bytes produce a visible diagnostic, never a
save receipt. An interrupted apply can replay its changed files with the same
last-sync-wins rule. Cleanup resumes for terminal runs; no copy is retained as
an archive after cleanup succeeds.

## Verification

`agent-directory-working-copies.test.ts` exercises nested/binary files, directory
isolation, last-sync-wins edits and deletions, terminal cleanup, link rejection, old-head
adoption, and stable prompt digests. The legacy working-copy and native-tool
suites exercise compatibility. Workspace merge tests exercise preflight and
interrupted replay.

The explicit Product E2E `instruction-persistence` suite creates a file through
the browser editor, runs an agent that changes instructions and supporting files,
checks exact binary bytes via the public download route, restarts the server,
and asks a fresh task to prove restored contents using an independent nonce. A
third task edits its entry while the browser saves that same file; the later
run sync wins while a separate browser-created file survives, with no conflict
candidate or manual resolution. Three more tasks save a sparse file at its
256 MiB boundary, exceed that boundary with a nonfatal save rejection, then
remove it and save a new small file. All tasks must succeed, with warnings
visible in run details while full and cleared after cleanup.
Run results, including unavailable credentials, must be reported separately from
unit or matcher results; a passing matcher does not prove a live run.
