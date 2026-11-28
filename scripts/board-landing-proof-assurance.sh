#!/usr/bin/env bash
# Board landing proof assurance (POST /api/issues/:id/landing-proof).
#
# One serial run of the checks a release reviewer needs for this route:
#   1. head        the route, OpenAPI and done-guard suites pass at HEAD
#   2. base        the done-guard and OpenAPI suites pass at the merge base
#   3. failing     the route suite from HEAD fails at the merge base
#   4. mutants     six mutants of the HEAD code each fail the route suite:
#                    authz, merged-state, repo-identity, close-time re-read,
#                    close atomicity, other-guard pass-through
#   5. merged      the HEAD suites pass on HEAD merged into the base tip
#
# It never edits the caller's checkout. It works in a throwaway shared clone
# under $TMPDIR, runs one Vitest worker with no file parallelism (one test
# process plus its embedded Postgres at a time), bounds every step with a
# timeout, and removes the clone on exit. GitHub is faked by the suites; no
# step calls a live service.
#
# Usage: scripts/board-landing-proof-assurance.sh [--base <ref>] [--only <step>]
#   --base  the base branch ref (default origin/fold/tea-patches-v2026.722.0)
#   --only  run one step: head | base | failing | mutants | merged
# Exit status is 0 only when every selected step gives its expected result.
set -euo pipefail

BASE_REF="origin/fold/tea-patches-v2026.722.0"
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE_REF="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

REPO="$(git rev-parse --show-toplevel)"
HEAD_SHA="$(git -C "$REPO" rev-parse HEAD)"
BASE_TIP="$(git -C "$REPO" rev-parse "$BASE_REF")"
MERGE_BASE="$(git -C "$REPO" merge-base "$HEAD_SHA" "$BASE_TIP")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/landing-proof-assurance.XXXXXX")"
STEP_TIMEOUT="${STEP_TIMEOUT:-900}"
trap 'rm -rf "$WORK"' EXIT

ROUTE_SUITE="src/__tests__/issue-landing-proof-routes.test.ts"
GUARD_SUITES="src/__tests__/openapi-routes.test.ts src/__tests__/done-transition-guard-decision-routes.test.ts src/__tests__/done-transition-guard-ordering-routes.test.ts"
FAILURES=0

say() { printf '\n== %s\n' "$*"; }
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

checkout() {
  rm -rf "$WORK/tree"
  git clone --quiet --shared --no-checkout "$REPO" "$WORK/tree"
  git -C "$WORK/tree" checkout --quiet --detach "$1"
  ( cd "$WORK/tree" \
    && pnpm install --frozen-lockfile --prefer-offline --reporter=silent \
    && pnpm --filter @paperclipai/plugin-sdk ensure-build-deps >/dev/null \
    && pnpm --filter @paperclipai/paperclip-runner build >/dev/null )
}

# run_suites <expect: pass|fail> <label> <files...>
run_suites() {
  local expect="$1" label="$2"; shift 2
  local log="$WORK/$label.log" status=0
  ( cd "$WORK/tree/server" && timeout "$STEP_TIMEOUT" pnpm exec vitest run "$@" \
      --pool=forks --maxWorkers=1 --no-file-parallelism ) >"$log" 2>&1 || status=$?
  local summary
  summary="$(sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -E '^ +Tests ' | tail -1 || true)"
  if { [ "$expect" = pass ] && [ "$status" -eq 0 ]; } || { [ "$expect" = fail ] && [ "$status" -ne 0 ] && [ "$status" -ne 124 ]; }; then
    echo "ok   $label (expected $expect):${summary:- no summary}"
  else
    echo "FAIL $label (expected $expect, exit $status):${summary:- no summary}"
    sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -E '^ +×|Error:' | head -10 || true
    FAILURES=$((FAILURES + 1))
  fi
}

# mutate <file> <old> <new>: exact, single-occurrence replacement in the clone.
mutate() {
  node -e '
    const fs = require("fs");
    const [file, oldText, newText] = process.argv.slice(1);
    const source = fs.readFileSync(file, "utf8");
    const count = source.split(oldText).length - 1;
    if (count !== 1) { console.error(`mutant anchor found ${count} times in ${file}`); process.exit(3); }
    fs.writeFileSync(file, source.replace(oldText, newText));
  ' "$WORK/tree/$1" "$2" "$3"
}

restore() { git -C "$WORK/tree" checkout --quiet -- server/src; }

echo "head $HEAD_SHA, base tip $BASE_TIP, merge base $MERGE_BASE"

if want base || want failing; then
  say "base: merge base $MERGE_BASE"
  checkout "$MERGE_BASE"
  # shellcheck disable=SC2086
  if want base; then run_suites pass base $GUARD_SUITES; fi
  if want failing; then
    git -C "$REPO" show "$HEAD_SHA:server/$ROUTE_SUITE" >"$WORK/tree/server/$ROUTE_SUITE"
    run_suites fail failing-first "$ROUTE_SUITE"
  fi
fi

if want head || want mutants; then
  say "head: $HEAD_SHA"
  checkout "$HEAD_SHA"
  # shellcheck disable=SC2086
  if want head; then run_suites pass head "$ROUTE_SUITE" $GUARD_SUITES; fi
  if want mutants; then
    GUARD=server/src/services/done-transition-guard.ts
    PROOF=server/src/services/board-landing-proof.ts
    ROUTES=server/src/routes/issues.ts

    mutate "$ROUTES" '    assertBoard(req);
    const existing = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Issue not found");
    if (!existing || !(await assertIssueReadAllowed(req, res, existing))) return;
    const decision = await decideIssueAccess(req, existing, "issue:mutate");' \
      '    const existing = await getAccessibleResource(req, res, svc.getById(req.params.id as string), "Issue not found");
    if (!existing || !(await assertIssueReadAllowed(req, res, existing))) return;
    const decision = await decideIssueAccess(req, existing, "issue:mutate");'
    run_suites fail mutant-1-authz "$ROUTE_SUITE"; restore

    mutate "$PROOF" '    if (pr.merged !== true) {' '    if (false) {'
    run_suites fail mutant-2-merged-state "$ROUTE_SUITE"; restore

    mutate "$PROOF" '    if (pr.baseRepoId == null || pr.baseRepoId !== identity.id ||' '    if (false &&'
    run_suites fail mutant-3-repo-identity "$ROUTE_SUITE"; restore

    mutate "$GUARD" '      const verified = await verifyBoardLandingProof(db, { id: issue.id, companyId: issue.companyId, ...fields }, attached.evidence);' \
      '      const live = await verifyBoardLandingProof(db, { id: issue.id, companyId: issue.companyId, ...fields }, attached.evidence);
      // Mutant: a failed live read is treated as verified (the route suite fixture repository and base).
      const verified = live.ok ? live : ({ ok: true, proof: { ...attached.evidence, mergeCommitSha: attached.evidence.mergeCommitSha ?? "", repoUrl: "https://github.com/TEA-Core/paperclip", baseRef: "main" } } as any);'
    mutate "$GUARD" '        if (verifiedHead !== proof.head) throw conflict(' '        if (false) throw conflict('
    run_suites fail mutant-4-close-time-reread "$ROUTE_SUITE"; restore

    mutate "$GUARD" '        } catch { verifiedHead = null; /* Failed and timed-out rechecks cannot discharge debt. */ }
        if (verifiedHead !== proof.head) throw conflict("Board landing proof changed or could not be re-verified; retry the close.", {
          code: "done_transition_missing_delivery", issueId: issue.id,
        });
        await tx.update(activityLog)' \
      '        } catch { verifiedHead = null; /* Failed and timed-out rechecks cannot discharge debt. */ }
        if (verifiedHead !== proof.head) throw conflict("Board landing proof changed or could not be re-verified; retry the close.", {
          code: "done_transition_missing_delivery", issueId: issue.id,
        });
        await db.update(activityLog)'
    run_suites fail mutant-5-atomicity "$ROUTE_SUITE"; restore

    mutate "$GUARD" '  if (landingDebtOwed && result.allowed && !result.landingVerified && options.acceptBoardLandingProof) {' \
      '  if (landingDebtOwed && !result.landingVerified && options.acceptBoardLandingProof) {'
    mutate "$GUARD" '          ...result,
          landingVerified: true,
          landingContext: observer.landingContext,' \
      '          ...result,
          allowed: true,
          landingVerified: true,
          landingContext: observer.landingContext,'
    run_suites fail mutant-6-other-guard-pass-through "$ROUTE_SUITE"; restore
  fi
fi

if want merged; then
  say "merged: $HEAD_SHA into $BASE_TIP"
  checkout "$BASE_TIP"
  git -C "$WORK/tree" -c user.name=assurance -c user.email=assurance@localhost \
    merge --quiet --no-ff --no-edit "$HEAD_SHA" >/dev/null
  ( cd "$WORK/tree" && pnpm install --frozen-lockfile --prefer-offline --reporter=silent )
  # shellcheck disable=SC2086
  run_suites pass merged "$ROUTE_SUITE" $GUARD_SUITES
fi

if [ "$FAILURES" -eq 0 ]; then echo; echo "all selected steps gave their expected result"; else echo; echo "$FAILURES step(s) did not"; fi
[ "$FAILURES" -eq 0 ]
