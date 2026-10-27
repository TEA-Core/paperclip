# Restore participant: delayed-disposition lock mutant

This evidence was captured on the isolated PostgreSQL fixture at recovered worktree head `f33b312d68847a62529001f26be25f24fc5301e7` (before this evidence file was added). Migration `0302_pending_participant_run_admission.sql` and its journal entry were absent. No production card or database was accessed.

The exercised regression is `server/src/__tests__/issue-restore-participant.test.ts:683`, `rechecks a delayed disposition insert under the issue lock after restore's final read`. It pauses the real restore route after its last live-run read while `scheduleDispositionRepairAttempt` acts on a stale resolved-action snapshot. The assertion requires the scheduler to return `null`, no new receipt or run, and restore to return 200.

For each row, the command was:

```sh
pnpm --dir server exec vitest run src/__tests__/issue-restore-participant.test.ts -t 'rechecks a delayed disposition insert under the issue lock'
```

| Code under test | Result | Consumer-visible observation |
| --- | --- | --- |
| Application issue-row `FOR UPDATE` and fresh assignee check present, no DB trigger | 1 passed, 76 skipped | Scheduler returned `null`; restore returned 200. |
| **Temporary mutant:** remove only `.for("update")` in `server/src/services/recovery/service.ts` immediately before the receipt/run insertion, retaining the fresh assignee/status check | **1 failed, 76 skipped** | At line 705: expected `{ retry: null, restoration: 200 }`; received `{ retry: { agentId: former assignee, status: "scheduled_retry", scheduledRetryReason: "issue_disposition_repair" }, restoration: 200 }`. The stale scheduler admitted a former-owner run after successful restoration. |
| Original `FOR UPDATE` restored verbatim | 1 passed, 76 skipped | Safe `null` result restored; production source returned to its pre-mutant snapshot. |

The failing run exited nonzero because of the **intended assertion failure**, not a database error. No SQLSTATE `23514` trigger remains. Full command output from the worker runs: baseline `artifact://1219`, mutant `artifact://1221`, restored `artifact://1223`; the assertion and outcomes above are included here so the PR evidence remains inspectable without those worker-local artifacts. The mutant was not committed.
