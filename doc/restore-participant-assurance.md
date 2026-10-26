# Pending-participant restore: concurrency assurance

This evidence applies to the board-only `POST /api/issues/{id}/restore-participant` operation. All database experiments used disposable embedded PostgreSQL databases created by the server test helpers; no production card or database was modified. The operation does not repair cards with active recovery actions or pending interactions, and no bulk repair is provided.

## Executed scenarios

Run from the repository root with `pnpm --filter @paperclipai/server exec vitest run <test-file>`:

| Test file / scenario | Observation |
| --- | --- |
| `src/__tests__/issue-restore-participant.test.ts`: happy path, refusals and concurrent requests | Atomic expected-value compare-and-set; one winning assignment and one audit row; status, status version, execution state, pending timestamp, stage and decision history unchanged; no wake; agent and other-company callers refused. |
| Same file: restore-first/recovery-first two-connection pool | Both orderings completed within five seconds when one contender initially waited on an issue or run row. Actual restore route returned 409 on the seeded live native run, recovery claimant fulfilled, assignee and audit unchanged. The assertion detects the first blocked contender while the second is in flight; it does not assert simultaneous blocking. |
| `src/services/native-runtime/native-runner-restart-recovery.integration.test.ts`: inverse row locks | PostgreSQL returned SQLSTATE `40P01` for the direct issue-then-run versus run-then-issue transaction overlap; one transaction rolled back with assignment and run status unchanged. This is a database lock-order experiment, not a claim that the route itself deadlocked in that test. |
| Same file: twenty delayed recovery claims | A held run row delayed each claim by 900 ms through both lock budgets. All 20 passes deferred the candidate with a warning and no rethrow; a subsequent pass after release claimed it. Before the deferral fix, the same test rejected on the second `55P03`. |
| `src/__tests__/heartbeat-wake-lock-pool-starvation.test.ts`: held actual restore | In 20 isolated issues, the real Express restore route held the issue row while its activity-log insert waited on a disposable audit-table blocker. The real `heartbeatService.wakeup` on a one-connection pool waited on that restore row; no run queued before release, then restore returned 200 and wake admitted. The nested-only context retained its `paperclipIssue.id` without adding top-level `issueId` or `taskKey`. |
| Same file: direct held issue row and other wake | Another 20 distinct nested-only wakes serialized against issue rows. An unscoped wake preserved its explicit task key and serialized `executionContext` unchanged. |

## Mutation checks

Each mutation was applied alone, its focused real-PostgreSQL test was run, and the production line was restored before the next check. These are observed failing assertions, not an assertion that mutation tooling ran over the whole repository.

| Mutated guard | Focused test failure |
| --- | --- |
| Lock-conflict machine code changed | Expected `participant_restore_lock_busy` response code did not match. |
| `details.retryable` changed to false | Expected `true` did not match. |
| `Retry-After` removed | Expected `Retry-After: 1` header missing. |
| Transaction-local 250 ms `lock_timeout` removed | Held issue row did not yield a response within the 1.5-second test budget. |
| Second live-run read removed | A run committed while restore waited on the issue row allowed a 200 instead of 409. |
| Nested-only issue-row lock removed | First wake queued before the held issue row released, and did not wait on that row. |
| Recovery's second lock-conflict `continue` changed to rethrow | All 20 delayed passes rejected with SQLSTATE `55P03` rather than deferring. |
| Unfinished prior-assignee goal refusal disabled | Both active and paused goal fixtures restored with 200 instead of refusing 409. |

## Writer census and residuals

The restore transaction row-locks existing issue-bound live runs in id order, then the issue, and reads live runs a second time before updating the assignee (`server/src/routes/issues.ts`). A new writer can still commit after that second read if it does not acquire the same issue-row lock. These are named residual races, not evidence that all writers have been serialized:

- `server/src/services/heartbeat.ts`: bounded retry derives `issueId` only from top-level `contextSnapshot.issueId` (around line 16536), conditionally locks that issue (around lines 16779–16806), and inserts a scheduled run (around line 17091). A predecessor with only nested `paperclipIssue.id` has no issue lock on this path.
- The same file's `enqueueWakeup` same-scope coalescing branch updates an existing run's context and writes a receipt (around lines 32728–32772) *before* the nested-only queued-run issue lock (around lines 32775–32783). A new nested binding in a coalesced context can evade that lock.
- `server/src/services/recovery/service.ts`: provider-quota retry inserts a `scheduled_retry` run at lines 4076–4128; delayed disposition repair does likewise at lines 4748–4799. Neither transaction locks the issue row before inserting. The zero-delay disposition path delegates to `enqueueWakeup` instead.
- `server/src/services/self-declared-run.ts`: status changes to `in_progress` at lines 113–134, before a separate run insert at lines 157–171. The status/assignee predicate makes an eligible `blocked` or `in_review` restore fail its compare-and-set when this update wins first, but there is no continuous issue lock covering its subsequent insert.
- Raw serving-role SQL can insert a run without the application issue-row admission lock. This operation does not close that database-level path.

These residuals are explicit in `doc/SPEC-implementation.md`. Do not use this endpoint for a card with a live run, pending interaction or active recovery action; a later board decision is required for those cases. Green CI is not release assurance or approval to run repairs against production cards.
