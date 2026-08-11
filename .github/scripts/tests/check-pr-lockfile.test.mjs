import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLockfile } from '../check-pr-lockfile.mjs';

const makeFiles = (filenames) => filenames.map(f => ({ filename: f, status: 'modified' }));

test('passes when lockfile is not changed', () => {
  assert.equal(checkLockfile(makeFiles(['src/foo.ts']), 'someuser', 'fix/bug').passed, true);
});

test('passes when lockfile changed by refresh bot on correct branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'chore/refresh-lockfile'
  );
  assert.equal(result.passed, true);
});

// pr.yml exempts `chore/refresh-lockfile` by branch alone, so a human pushing a
// refresh there (the only option on fork branches the refresh bot never runs on)
// must not be told that pr.yml is about to hard-fail the PR.
test('passes when lockfile changed by a human on the refresh branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'someuser',
    'chore/refresh-lockfile'
  );
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test('fails when lockfile changed by regular user', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), 'someuser', 'fix/bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('pnpm-lock.yaml'));
});

test('fails when lockfile changed by bot on wrong branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'fix/something-else'
  );
  assert.equal(result.passed, false);
});
