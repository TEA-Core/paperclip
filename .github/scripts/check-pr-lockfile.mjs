#!/usr/bin/env node
/**
 * check-pr-lockfile.mjs
 * Checks that pnpm-lock.yaml was not manually edited.
 * Export: checkLockfile(files, prAuthor, prBranch) → { passed, failures }
 */
import { fileURLToPath } from 'node:url';

// Mirrors the `Block manual lockfile edits` step in pr.yml, which is the gate
// that actually enforces this policy and exempts branches by name alone. Keying
// off the author too made this gate reject a human-pushed lockfile refresh on
// the refresh branch while quoting pr.yml as the reason — advice pr.yml itself
// contradicts. Fork branches deploy from a ref the refresh bot never runs on, so
// those refreshes have to be pushed by hand. The prefixes match pr.yml's
// `startsWith` checks: refresh-lockfile.yml pushes
// `chore/refresh-lockfile-<sanitized base ref>`, not the bare branch name.
const REFRESH_BRANCH_PREFIX = 'chore/refresh-lockfile';
// A fold sync imports upstream's resolved lockfile wholesale rather than
// hand-editing resolutions, and pr.yml exempts it for that reason: the folded
// manifests name packages the pre-fold lockfile has never heard of, so a tree
// without the folded lockfile cannot satisfy the Dockerfile's frozen install.
// Advising a fold author to drop the file is advice pr.yml no longer agrees with.
const FOLD_SYNC_BRANCH_PREFIX = 'fold-sync/';

export function checkLockfile(files, prAuthor, prBranch) {
  const lockfileChanged = files.some(f => f.filename === 'pnpm-lock.yaml');
  if (!lockfileChanged) return { passed: true, failures: [] };

  const exempt =
    prBranch.startsWith(REFRESH_BRANCH_PREFIX) || prBranch.startsWith(FOLD_SYNC_BRANCH_PREFIX);

  return {
    passed: exempt,
    failures: exempt ? [] : [
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
