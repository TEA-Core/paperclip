#!/usr/bin/env node
/**
 * check-pr-lockfile.mjs
 * Checks that pnpm-lock.yaml was not manually edited.
 * Export: checkLockfile(files, prAuthor, prBranch) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';

// Mirrors the `Block manual lockfile edits` step in pr.yml, which is the gate
// that actually enforces this policy and exempts `chore/refresh-lockfile` by
// branch alone. Keying off the author too made this gate reject a human-pushed
// lockfile refresh on that branch while quoting pr.yml as the reason — advice
// pr.yml itself contradicts. Fork branches deploy from a ref the refresh bot
// never runs on, so those refreshes have to be pushed by hand.
const REFRESH_BRANCH = 'chore/refresh-lockfile';

export function checkLockfile(files, prAuthor, prBranch) {
  const lockfileChanged = files.some(f => f.filename === 'pnpm-lock.yaml');
  if (!lockfileChanged) return { passed: true, failures: [] };

  const isRefreshBranch = prBranch === REFRESH_BRANCH;

  return {
    passed: isRefreshBranch,
    failures: isRefreshBranch ? [] : [
      'You have changes to `pnpm-lock.yaml` — `pr.yml` will hard-fail this PR with a confusing message about lockfile edits. ' +
      'To fix: run `pnpm install` locally, exclude the lockfile from your commit, push again. ' +
      'The lockfile is regenerated automatically by the refresh bot on a schedule.',
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = JSON.parse(process.env.PR_FILES ?? '[]');
  const result = checkLockfile(files, process.env.PR_AUTHOR ?? '', process.env.PR_BRANCH ?? '');
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
