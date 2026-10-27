# Restore follow-up: nested-wake lock mutants

This evidence was captured on the isolated PostgreSQL fixture in this worktree after the admission-lock and placement assertions were added, and before this evidence file was added. No production card or database was accessed. Production `server/src/services/heartbeat.ts` was restored with `git checkout --` after each mutant. The end `git diff` for that file was empty.

The two focused tests are in `server/src/__tests__/heartbeat-wake-lock-pool-starvation.test.ts`:

- `admits twenty nested-only wakes after an actual restore releases the issue row` — the nested-wake admission lock test. It now requires the wake blocked by restore to be waiting on `issues ... for update`, not on the participant agent row restore already holds.
- `serializes twenty nested-only wakes against held issue rows without altering their task context` — the wake-lock placement test. After the held-row serialization loop, `assertNestedIssueLockHeldThroughInsert` pauses the nested-only receipt insert and requires a concurrent `select id from issues ... for update` to hit SQLSTATE `55P03`.

For each row, the command was:

```sh
pnpm --dir server exec vitest run src/__tests__/heartbeat-wake-lock-pool-starvation.test.ts -t 'serializes twenty nested-only|admits twenty nested-only wakes after an actual restore'
```

| Code under test | Result | Consumer-visible observation |
| --- | --- | --- |
| Nested-only issue `FOR UPDATE` inside the queue transaction, before the agent lock and the receipt/run insert | 2 passed, 6 skipped | Both tests green. Admission waits were on `issues ... for update`. The placement probe timed out on the issue row while the receipt insert was in progress. |
| **Temporary mutant:** remove only `.for("update")` from the nested-only issue read in `enqueueWakeup` (`heartbeat.ts`, the read immediately before the owner recheck). Recheck left in place. | **2 failed, 6 skipped** | Admission test: expected `{ waitedForRestore: true, status: 200 }`; received `{ waitedForRestore: false, status: 200 }`. Restore returned 200 and the wake never waited on the issue row. Placement test: expected `{ waitedForIssue: true, queuedBeforeRelease: false }`; received `{ waitedForIssue: false, queuedBeforeRelease: true }`. A live run was queued while the issue row was still held. |
| **Temporary mutant:** move that issue `FOR UPDATE` into a transaction that commits, then recheck without the lock inside the receipt/run insert transaction | **2 failed, 6 skipped** | Both tests passed their held-row loops and failed in `assertNestedIssueLockHeldThroughInsert`: expected `lockHeld` true, received false. While the receipt insert slept, a second session took `issues` `FOR UPDATE` immediately. The earlier lock had already committed. |
| Original `FOR UPDATE` restored verbatim inside the insert transaction | 2 passed, 6 skipped in the wake file | Same focused filter, after `git checkout -- server/src/services/heartbeat.ts`. The combined log also skipped the census file because of that filter. |

The failing runs exited nonzero because of the intended assertion failures, not a database setup error. The mutants were not committed. Command logs from this worker: baseline `baseline-after-restore.txt`, remove-lock `mutant-remove-lock.txt`, move-lock `mutant-move-lock.txt`, under the task data directory. The assertions above are included here so the PR evidence remains inspectable without those worker-local logs.
