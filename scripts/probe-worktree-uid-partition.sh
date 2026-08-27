#!/usr/bin/env bash
# Two-real-uid regression probe for the uid-scoped worktree state partition
# (SUP-14127, SUP-14126 ruling item 4).
#
# Runs the worktree state-dir resolution path under TWO DISTINCT REAL uids in a
# single run:
#   1. provision canonical + uid-A scoped worktree state as uid A
#   2. provision uid-B scoped worktree state as uid B
#   3. resolve + assert as uid B  (EACCES on A's 0o600 files, B's own scoped dir,
#      no mutation of A's files)
#   4. resolve + assert as uid A  (the reverse direction, so the probe cannot
#      pass by uid ordering)
#
# The child (scripts/probe-worktree-uid-partition-child.mjs) is launched as
# root, imports the tree's REAL consumer code (server/src/dev-runner-worktree.ts)
# through tsx, then drops itself to the target real uid with process.setuid and
# performs every assertion as that real uid. The harness first verifies each
# real uid is obtainable (setpriv --reuid id -u) and the child verifies its own
# post-drop getuid(), so a probe that cannot run as a second real uid FAILS
# LOUDLY naming the missing prerequisite — a silently skipped probe reproduces
# the green-when-skipped failure mode that made the SUP-13977 deploy-workflow
# conclusion inadmissible.
#
# This works against both the canonical-only fold-head resolution (RED) and the
# uid-scoped resolution from SUP-14087/14118 (GREEN).
#
# Local invocation (root or passwordless sudo):
#   sudo bash scripts/probe-worktree-uid-partition.sh
#   PAPERCLIP_PROBE_UID_A=1000 PAPERCLIP_PROBE_UID_B=1001 sudo bash scripts/probe-worktree-uid-partition.sh
#
# CI: .github/workflows/pr.yml job `worktree_uid_partition`.
# shellcheck disable=SC2015
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf 'ok   - %s\n' "$1"; }
no() { FAIL=$((FAIL + 1)); printf 'FAIL - %s\n' "$1"; }

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "MISSING_BIN $1"; exit 1; }
}

# --- root is required to run a second real uid ---------------------------------
if [ "$(id -u)" != "0" ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    exec sudo -n bash "$0" "$@"
  fi
  no "second real uid cannot be obtained: this probe needs root or passwordless sudo to run setuid/setpriv, and current uid $(id -u) has no privilege path to it"
  printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
  exit 1
fi

UID_A="${PAPERCLIP_PROBE_UID_A:-1000}"
UID_B="${PAPERCLIP_PROBE_UID_B:-1001}"

case "$UID_A" in
  ''|*[!0-9]*) no "PAPERCLIP_PROBE_UID_A='$UID_A' is not a numeric uid"; exit 1 ;;
esac
case "$UID_B" in
  ''|*[!0-9]*) no "PAPERCLIP_PROBE_UID_B='$UID_B' is not a numeric uid"; exit 1 ;;
esac
if [ "$UID_A" -eq 0 ] || [ "$UID_B" -eq 0 ] || [ "$UID_A" -eq "$UID_B" ]; then
  no "need two DISTINCT non-root real uids, got A=$UID_A B=$UID_B"
  exit 1
fi

require setpriv
require node

if [ ! -f "$REPO/cli/node_modules/tsx/dist/loader.mjs" ]; then
  no "cannot find tsx loader under $REPO (expected cli/node_modules/tsx/dist/loader.mjs); run 'pnpm install --frozen-lockfile' first"
  exit 1
fi

# --- verify a REAL second-uid process is obtainable before probing anything ---
# --clear-groups (not --init-groups): the two real uids may have no passwd
# entries on the CI runner, and the probe does not need supplementary groups.
for u in "$UID_A" "$UID_B"; do
  got="$(setpriv --reuid="$u" --regid="$u" --clear-groups -- id -u 2>/dev/null || echo OBTAIN_FAILED)"
  if [ "$got" = "$u" ]; then
    ok "real process under uid $u obtainable (setpriv --reuid=$u -> $got)"
  else
    no "cannot run a real process as uid $u (setpriv returned '$got') — the two-real-uid contract cannot be met; prerequisite missing"
    exit 1
  fi
done

# --- fixture: a linked worktree whose .paperclip/ is a shared-write state dir --
FIX="$(mktemp -d /tmp/paperclip-uid-probe-XXXXXX)"
trap 'rm -rf "$FIX"' EXIT
chmod 0755 "$FIX"
printf 'gitdir: /tmp/paperclip-uid-probe-fake-worktrees/feature\n' > "$FIX/.git"
chmod 0644 "$FIX/.git"
mkdir -p "$FIX/.paperclip"
# Shared-write state dir: both uids create their scoped subdirs, canonical
# 0o600 files owned by the canonical owner are what the kernel protects.
chmod 1777 "$FIX/.paperclip"
mkdir -p "$FIX/home"
chmod 0777 "$FIX/home"

CHILD="$HERE/probe-worktree-uid-partition-child.mjs"
TSX_LOADER="$REPO/cli/node_modules/tsx/dist/loader.mjs"

run_child() {
  # $1 = uid, $2 = role. The child drops itself to $1; the other uid is derived
  # so the probe is symmetric. Runs as root so the live tree and tsx are
  # readable even under a non-traversable checkout path.
  local target_uid="$1" other
  if [ "$target_uid" = "$UID_A" ]; then other="$UID_B"; else other="$UID_A"; fi
  local out rc
  out="$(env \
    HOME="$FIX/home" \
    XDG_CACHE_HOME="$FIX/home/.cache" \
    PAPERCLIP_PROBE_ROOT="$FIX" \
    PAPERCLIP_PROBE_TARGET_UID="$target_uid" \
    PAPERCLIP_PROBE_OTHER_UID="$other" \
    PAPERCLIP_PROBE_REPO_ROOT="$REPO" \
    PAPERCLIP_PROBE_CANONICAL_OWNER_UID="$UID_A" \
    PAPERCLIP_PROBE_TSX_LOADER="$TSX_LOADER" \
    node "$CHILD" "$2" 2>&1)"
  rc=$?
  printf '%s\n' "$out"
  return "$rc"
}

printf '== phase 1: provision canonical + uid-A scoped state as uid %s ==\n' "$UID_A"
if run_child "$UID_A" provision; then
  ok "uid $UID_A provisioned canonical and scoped worktree state"
else
  no "uid $UID_A provisioning failed"
  exit 1
fi

printf '== phase 2: provision uid-B scoped state as uid %s ==\n' "$UID_B"
if run_child "$UID_B" provision; then
  ok "uid $UID_B provisioned its scoped worktree state"
else
  no "uid $UID_B provisioning failed"
  exit 1
fi

printf '== phase 3: resolve + assert as uid %s (non-owner of canonical state) ==\n' "$UID_B"
if run_child "$UID_B" resolve; then
  ok "direction A->B: uid $UID_B resolves its own scoped state and cannot touch uid $UID_A's files"
else
  no "direction A->B: uid $UID_B FAILED the partition assertions"
fi

printf '== phase 4: resolve + assert as uid %s (reverse direction) ==\n' "$UID_A"
if run_child "$UID_A" resolve; then
  ok "direction B->A: uid $UID_A resolves its own scoped state and cannot touch uid $UID_B's files"
else
  no "direction B->A: uid $UID_A FAILED the partition assertions"
fi

# --- fixture-teardown proof: canonical state is still the canonical owner's ---
CANON_STAT="$(stat -c '%u %a %Y' "$FIX/.paperclip/config.json" 2>/dev/null || echo MISSING)"
case "$CANON_STAT" in
  "$UID_A 600"*) ok "canonical config.json still uid $UID_A mode 600 after both directions ($CANON_STAT)" ;;
  *) no "canonical config.json ownership/mode drifted: $CANON_STAT" ;;
esac

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
