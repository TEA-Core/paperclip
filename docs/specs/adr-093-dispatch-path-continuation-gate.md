# ADR-093 — the continuation-path gate belongs on the dispatch path

**Status:** accepted (exec-CTO ruling, SUP-13998, 2026-09-03)
**Succeeds:** ADR-074 D1 (SUP-14030 — "re-cut the in_progress guard with the §2a
continuation-path predicate"), which is hereby ruled *correct but insufficient*, not wrong.
**Does not reopen:** ADR-074 D3 (historical pre-guard `done` population, dispositioned as a
class at Tier 1).
**Implemented by:** nothing yet — SUP-14879 (D2), SUP-14880 (D1), SUP-14881 (D3), all
assigned to coder-BE.
**Numbering:** ADR-092 is the highest ordinal attested in `paperclip-agent-tools/doctrine/`
and this repo's `docs/`; this takes the next free one. It is filed as a successor rather
than an ADR-074 `Dn` amendment because ADR-074's record is a Paperclip decision thread with
no file form, so its next free `Dn` is not verifiable from a run.

## 0. Bullet 1 first: the §2a guard is live, and the card's premise stands

The router filed this card on the assumption that the merged guard is deployed and still
insufficient, and flagged that assumption as unverified. It is now verified. Probed
2026-09-03 against the running control plane:

| probe | result |
|---|---|
| `GET /api/health` | `commit: d672fb732d18021b3a3b25419652381cd9045293` |
| `git merge-base --is-ancestor 45d68e8d5 d672fb73` | exit 0 — PR #363's **merge commit** is an ancestor of the deployed commit |
| `git hash-object /app/server/src/routes/issues.ts` | `3c1d5e46dc540362fdf7ad03abdc8d12b8761449` |
| `git rev-parse d672fb73:server/src/routes/issues.ts` | `3c1d5e46dc540362fdf7ad03abdc8d12b8761449` — identical |
| pid 1 cmdline | `node --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js` |
| `grep -c evaluateIssueContinuationPath /app/server/dist/routes/issues.js` | `2` (built `2026-09-03 03:48`, alongside `IN_PROGRESS_SETTLE_WINDOW_MS`, `hasLiveContinuation`, `evaluateContinuationPathForIssue`) |

One trap worth recording, because it will produce a false "not deployed" for the next
person who probes this: PR #363's **head** sha `485250c2` is **not** an ancestor of the
deployed commit — the PR landed as squash/rebase merge `45d68e8d5`. An ancestry probe keyed
on the PR head sha reports NO for a guard that is in fact live. Key ancestry probes on the
merge commit, and corroborate with blob identity against the `/api/health` commit.

So: the guard is live, and the recurrence measured on SUP-14761 seven days after the merge
is a post-guard recurrence. Everything below follows from that.

## 1. What the guard actually gates, measured on the deployed tree

`evaluateIssueContinuationPath` appears in exactly two files:
`server/src/routes/issues.ts` and its test. **`grep evaluateIssueContinuationPath
server/src/services/heartbeat.ts` returns zero hits.** The predicate is confined to the
routes layer — it fires when something PATCHes an issue *into* `in_progress`.

The dispatcher is `server/src/services/heartbeat.ts`, and its timer eligibility test
(`heartbeat.ts:21117-21130`) is, in full:

```
companyId = agent.companyId
AND assigneeAgentId = agent.id
AND status IN ('todo','in_progress')
AND createdAt >= cutoff
```

`timerWorkLeaseState` (`heartbeat.ts:13187-13216`) adds one more term — the issue must not
be held by a live execution lease — and that is the entire notion of "this agent has work".
An `in_progress` card with `executionRunId: null` and no live lease satisfies it forever.

ADR-074 D1 was right that a synchronous write-time check is the wrong instrument, and §2a
fixed the predicate's *accuracy*. Neither moved the gate. **Gap 1 in the card is confirmed
exactly as filed.**

## 2. Why the existing per-issue throttle did not save SUP-14761

This matters because it is the obvious cheap answer, and it does not work.

A per-issue dispatch-path rate limiter already exists —
`server/src/services/issue-rewake-throttle.ts` (PAP-13775) — and it implements almost
exactly the predicate the router proposed: a streak of consecutive succeeded-but-no-progress
runs earns an escalating cooldown. It did not fire. Two independent reasons, both structural:

**2.1 The timer wake is not a throttle candidate, and cannot be made one cheaply.**
`THROTTLED_ISSUE_REWAKE_REASONS` is `{issue_assigned, issue_continuation_needed,
issue_assignment_recovery, issue_graph_liveness_backstop}`. The timer scheduler enqueues
with `reason: "heartbeat_timer"` (`heartbeat.ts:21142`), which is neither in that set nor
null, so `isThrottleCandidateIssueRewake` returns `false` and the throttle block at
`heartbeat.ts:20080` never evaluates.

Widening the set does not fix it. The timer wake is enqueued as
`enqueueWakeup(agent.id, {...})` — **agent-scoped, carrying no `issueId` at all**
(`heartbeat.ts:21139-21151`). The issue is resolved *after* dispatch. An issue-keyed
throttle has nothing to key on at the moment the decision is made.

**2.2 Throttling has no terminal state.** `ISSUE_REWAKE_MAX_COOLDOWN_MS` is 30 minutes.
Fully engaged, on a permanently stuck card, the throttle still authorises ~48 full-price
adapter sessions per day, forever. A rate limiter is the wrong shape for a condition that
never resolves on its own.

Corroboration on SUP-14761 (`7fb0b53f-9343-4bc4-ab18-7feff4c26b0e`): 30 runs; 20 of the 30
run-attributed activity sets carry no `ISSUE_PROGRESS_ACTIVITY_ACTIONS` row at all. The
streak input was present and correct. The throttle was simply never consulted.

One wrong hypothesis, killed so it is not re-derived: the runtime stub comment *"Run
completed. Agent did not post a summary comment this run"* is **not** self-defeating. It is
posted via `issuesSvc.addComment` (`heartbeat.ts:17784`), and that service writes no
`issue.comment_added` activity row — only the routes layer does. The stub therefore does not
count as progress, and correctly so.

## 3. The finding that inverts the card's proposed ordering

`server/src/services/issue-recovery-actions.ts:12`:

```ts
const ACTIVE_RECOVERY_ACTION_STATUSES = ["active", "escalated"] as const
```

`getActiveForIssue` filters on that set, and its result is fed straight into the
`activeRecoveryAction` disjunct of `evaluateIssueContinuationPath`
(`routes/issues.ts`, `evaluateContinuationPathForIssue`).

**An escalated, handoff-exhausted, board-owned recovery action therefore evaluates as a live
continuation path.** That is precisely the state SUP-14761 was in: recovery action
`8f56c023-585e-4f3b-bd62-b07d18cdc7bc`, `cause: successful_run_missing_state`, `handoffAttempt
1 / maxHandoffAttempts 1`, escalated to `ownerType: board`, `ownerAgentId: null`. Its
activity log records the whole ladder — `issue.successful_run_handoff_required` ×2 →
`issue.recovery_action_max_attempts_reached` → `issue.recovery_action_exhausted` →
`issue.successful_run_handoff_escalated`.

The consequence is the ruling of this ADR:

> **Porting the §2a predicate to the dispatch path verbatim would not have stopped
> SUP-14761.** The gate would return `ok: true` — "there is a live continuation path" — in
> the exact state it exists to catch, because a dead recovery ladder is indistinguishable
> from a live one at the only place the predicate looks.

The card offers gap 2 as the *cheaper* fix, to be weighed on cost. That framing is rejected.
Gap 2 is a **precondition** of gap 1. Shipping gap 1 first ships a gate guaranteed to be open.

## Decisions

**D1 — the gate belongs on the dispatch path.** Not the write path, not a new parallel
mechanism, not a widened rewake throttle. Concretely: the timer eligibility query and
`timerWorkLeaseState` gain a continuation-path term that reuses
`evaluateIssueContinuationPath`. The write-path guard from ADR-074 D1 **stays** — it is a
cheap correctness check on an explicit state claim and costs nothing. This ADR adds a second
site; it does not relocate the first.

The predicate must move to a service module (`server/src/services/issue-continuation-path.ts`)
before `heartbeat.ts` can use it. `services/` importing from `routes/` is a layering
inversion and is not an acceptable shortcut.

**D2 — `escalated` is not a live continuation path, and this ships first.** The
continuation-path consumer must read recovery liveness through a reader restricted to
`status = 'active'`. **`ACTIVE_RECOVERY_ACTION_STATUSES` itself must not be narrowed**: it
also backs the re-entrancy guard at `issue-recovery-actions.ts:362` and the ceiling lookups
at `:176`/`:236`, where treating an escalated row as absent would let a duplicate recovery
action be minted. Add a second reader; do not repurpose the existing one.

**D3 — a refused dispatch parks; it never silently drops.** Suppression with no artifact
converts a visible 48-runs-per-day burn into an invisible stall, which is strictly worse for
whoever investigates the fourth recurrence. Every suppressed dispatch emits an activity row
naming the failing disjuncts, and a persistently suppressed card is escalated to a
board-visible parked state through the existing `blocked_without_blockers` surface (already
live: SUP-14761's log carries `issue.blocked_without_blockers_written` / `_healed` /
`_suppressed`).

**D4 — no waiver.** Bullet 5 of the card asks what replaces the gate if none is affordable.
The question does not arise: D1 is one predicate call added to a query the scheduler already
runs once per agent per interval, against evidence it already loads. A gate is affordable.
There is nothing to replace.

## Ordering

```
SUP-14879 (D2, recovery liveness) ──blocks──▶ SUP-14880 (D1, dispatch gate) ──blocks──▶ SUP-14881 (D3, park)
```

D2 first is not a preference. D1 landing without D2 is a no-op in the failure mode it targets.
