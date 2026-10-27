# Pending-participant restore: concurrency assurance

This evidence applies to the board-only `POST /api/issues/{id}/restore-participant` operation. All database experiments used disposable embedded PostgreSQL databases created by the server test helpers; no production card or database was modified. The operation does not repair cards with active recovery actions or pending interactions, and no bulk repair is provided.

## Executed scenarios

Run from the repository root with `pnpm --filter @paperclipai/server exec vitest run <test-file>`:

| Test file / scenario | Observation |
| --- | --- |
| `src/__tests__/issue-restore-participant.test.ts`: happy path, refusals and concurrent requests | Atomic expected-value compare-and-set; one winning assignment and one audit row; status, status version, execution state, pending timestamp, stage and decision history unchanged; no wake; agent and other-company callers refused. |
| Same file: restore-first/recovery-first two-connection pool | Both orderings completed within five seconds when one contender initially waited on an issue or run row. Actual restore route returned 409 on the seeded live native run, recovery claimant fulfilled, assignee and audit unchanged. The assertion detects the first blocked contender while the second is in flight; it does not assert simultaneous blocking. |
| `src/services/native-runtime/native-runner-restart-recovery.integration.test.ts`: inverse row locks | PostgreSQL returned SQLSTATE `40P01` for the direct issue-then-run versus run-then-issue transaction overlap; one transaction rolled back with assignment and run status unchanged. This is a database lock-order experiment, not a claim that the route itself deadlocked in that test. |
| Same file: twenty delayed recovery claims | A held run row remained locked across twenty claim attempts; the test waits 900 ms **before each attempt**, not for a 900 ms lock budget. Each attempt hit two separate 1-second run-row lock timeouts, deferred with a warning and no rethrow; a subsequent explicit pass after release claimed it. Before the deferral fix, the same test rejected on the second `55P03`. |
| `src/__tests__/heartbeat-process-recovery.test.ts`: scheduled native recovery after a held issue row | The startup pass encountered two real PostgreSQL lock timeouts and returned a deferred disposition. Release before the fast retry allowed that retry to claim the run without a manual pass. Holding through all three 1/2/4-second retries persisted one error-level `native.recovery.transition` event (`reason: lock_retry_exhausted`, `retryAttempts: 3`) with coordinator generation and history still unchanged; release **after** the cap let the 5-second periodic retry claim automatically, without another exhaustion event. The cap is an operator-visible alert, not termination of recovery. |
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

The restore transaction row-locks existing issue-bound live runs in id order, then the issue, and reads live runs a second time before updating the assignee (the `POST /issues/:id/restore-participant` handler in `server/src/routes/issues.ts`). That second read is not a predicate lock: a writer that does not acquire the same issue-row lock can commit a new run or a newly issue-bound context after it. The following are **source-path dispositions**, not executed writer/restore interleaving tests or a proof of safety for these races:

| Writer | Disposition and evidence |
| --- | --- |
| Bounded retry with nested-only issue binding | **Residual.** `scheduleBoundedRetryForRun` in `heartbeat.ts` reads only top-level `contextSnapshot.issueId`, locks the issue only if that value exists, and inserts `scheduled_retry` with the inherited nested context. For a failed run carrying only `paperclipIssue.id`, the predecessor-row lock does not serialize against restore's issue lock after restore's last live-run read. The max-turn issue gate (`MAX_TURN_CONTINUATION_RETRY_REASON` branch) also requires a top-level issue id; no general after-restore exclusion is established. |
| Same-scope context coalescing | **Residual.** `enqueueWakeup` in `heartbeat.ts` picks a live agent run by task scope (`activeRuns` / `coalescedTargetRun`) and can merge a new nested binding into its context before the separate nested-only queued-run admission branch, without locking the issue row. Restore checks already-bound runs twice; it cannot exclude a post-read binding on an unrelated run. |
| Self-declared run | **Guarded for this restore state, not a continuous lock.** `selfDeclaredRunService` in `self-declared-run.ts` permits `blocked` only for an expired session and atomically changes its status to `in_progress` while requiring the old assignee, then inserts its run in a separate statement. If this status update wins first, restore's `blocked`/`in_review` status compare-and-set fails. If restore wins first, the old agent fails the self-declared assignee predicate. This is a source-level guard assessment, not an executed interleaving. |
| Provider-quota recovery monitor | **Residual after a stale recovery snapshot.** `recovery/service.ts` calls `ensureProviderQuotaWaitRecoveryMonitor` after an action/escalation transaction; that function then inserts a `scheduled_retry` run without locking the issue. An active action already visible to restore is refused (the route's active-recovery-action check), but the separate later insert has no issue-row exclusion if recovery starts from a stale state after restore. No end-to-end writer/restore interleaving was executed. |
| Delayed disposition repair retry | **Residual after a stale recovery snapshot.** `scheduleDispositionRepairAttempt` in `recovery/service.ts` delegates the zero-delay case to `enqueueWakeup`, but inserts the delayed `scheduled_retry` in its own transaction without an issue lock. An already-active action is refused by restore; a later creation/scheduling sequence is not excluded by restore's final read. No end-to-end writer/restore interleaving was executed. |
| Raw serving-role SQL | **Outside the application admission guarantee.** The `heartbeat_runs` insertion used by the disposable test fixtures (`db.insert(heartbeatRuns)` in `issue-restore-participant.test.ts`, among others) uses the same database connection as the route, with no issue-row admission. A privileged writer can issue that insert after restore's final read. This endpoint does not revoke SQL privileges, install a trigger, or take a predicate/table lock. No concurrent raw-SQL/restore interleaving was executed. |

These six paths do not change the tested happy-path preservation contract, but their source-path disposition is **not** release assurance for arbitrary active writers. Receipt-only writes are a different category, and this census is not exhaustive:

- `enqueueWakeup` in `heartbeat.ts` records a skipped request (or calls `recordExecutionWait`), not a run; the wait-conditioned branch locks the issue, while the direct skipped-receipt insert does not. A later replay must recheck admission.
- `enqueueWake` in `native-runtime/status-decision-committer.ts` inserts a queued `agent_wakeup_requests` receipt with an issue id, not a `heartbeat_runs` row; any subsequent promotion is a separate writer requiring its own check.
- `recordExecutionWait` in `execution-wait.ts` coalesces or inserts a skipped wait receipt with `runId: null`, under the caller's issue-row lock (see its doc comment); it is not a new live run.

Do not use this endpoint for a card with a live run, pending interaction or active recovery action; this evidence does not promise exclusivity against new writers after restoration. Green CI is not release assurance or approval to run repairs against production cards.
