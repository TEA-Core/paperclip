# RCA — manual external pull agents regenerate recovery actions in every agent status

**Issue:** SUP-11246 · **Status:** proposal, no behaviour change in this PR
**Scope note:** SUP-11246 explicitly says "no production control-plane deploy as part of this
issue; land a proposal first." This document is the deliverable. It changes no runtime code.

---

## Summary

There are **two** loops, they have **two different causes**, and the two published hypotheses
are each correct about exactly one of them.

| Loop | Agent status | Cause | Verdict |
|---|---|---|---|
| `missing_disposition` → `blocked` w/ empty `blockedBy` | `idle` | **H1** — the rebuild dropped `runtimeConfig.heartbeat.wakeOnDemand: false`, whose parse default is `true`, because the company-portability export/import round-trip **cannot represent it** | confirmed, config- *and* commit-level |
| `no_live_path_owner_unavailable` | `paused` | **H2** — the detector is 13 days newer than the wipe and replaced a silent skip | confirmed, commit-level |

H1 is not operator error. The rebuild lost the flag because
`server/src/services/company-portability.ts` drops every `false` boolean on export and never
restores it on import — see [§1.2](#12-why-the-key-was-lost-an-upstream-portability-defect).
That is a second, independent bug, and it will silently disarm any pull agent on the next
company export/import.

The pre-wipe agent row was believed unrecoverable. It is not: `~/agent-snapshots/` on sectoid
holds before/after JSON captures of every agent patch, including two from **2026-07-10**, which
is 13 days before the wipe. Those files are the primary evidence for H1 and they refute the
specific mechanism the issue suspected.

A third finding, not in the issue and not in the board addendum, is that **the fix that landed
on master this morning makes the paused loop worse on the next deploy** — see
[§5](#5-a-regression-already-on-master).

---

## 1. What the snapshots show (H1)

### 1.1 The config delta

`~/agent-snapshots/a28a1fc0-250a-4d6c-bb82-e9491bcd6a70/` — same agent UUID either side of the
wipe, so the pre- and post-wipe rows are directly comparable.

| Snapshot (UTC) | `adapterConfig.command` | `args` | `heartbeat.enabled` | `heartbeat.wakeOnDemand` | status |
|---|---|---|---|---|---|
| 2026-07-10T21:49:49 `before` | — | 0 | `false` | **`true`** | `error` |
| 2026-07-10T21:49:49 `after` | — | 0 | `false` | **`false`** | `error` |
| 2026-07-10T22:27:01 `after` | `/bin/echo` | 1 | `false` | **`false`** | `error` |
| 2026-07-24T06:04:18 `before` | — | 0 | `false` | **absent** | `idle` |
| 2026-07-25T15:41:28 | `/bin/echo` | 0 | `false` | **absent** | `idle` |
| 2026-07-31T22:26:29 `after` | `/bin/echo` | 1 | `false` | **absent** | `idle` |
| 2026-07-31T23:06:21 `after` | `/bin/echo` | 1 | `false` | **absent** | `paused` |
| live today (`paperclipGetAgent`) | `/bin/echo` | 1 | `false` | **`false`** | `paused` |

Two things fall out of this table.

**The `/bin/echo` no-op adapter is not the difference.** It was set pre-wipe, at
2026-07-10T22:27:01Z, by patch body:

```json
{ "adapterConfig": { "args": ["external-pull-agent no-op wake — work arrives via pull (pc-agent/MCP), not platform execution"], "command": "/bin/echo", ... } }
```

It ran clean for 13 days. The issue's stated suspicion — "a `process` adapter whose command is a
successful no-op is indistinguishable, at the run record, from an agent that genuinely did work
and forgot to record a disposition" — is a true statement about the run record, but it is **not**
the post-wipe delta. That configuration predates the wipe unchanged.

**`wakeOnDemand` is the difference.** Pre-wipe it was explicitly `false`, set 38 minutes before
`/bin/echo` was introduced, by patch body:

```json
{ "runtimeConfig": { "heartbeat": { "enabled": false, "maxConcurrentRuns": 20, "wakeOnDemand": false } } }
```

The rebuilt row (`createdAt 2026-07-24T05:58:59.627Z`) carries `{enabled: false,
maxConcurrentRuns: 20}` with **no `wakeOnDemand` key**, and the 2026-07-24T06:04:18Z repair patch
restored only `adapterConfig`, never `runtimeConfig`. That matters because the parse default is
not symmetric with `enabled`:

```ts
// server/src/services/heartbeat.ts:10741-10743
enabled:      asBoolean(heartbeat.enabled, false),
wakeOnDemand: asBoolean(heartbeat.wakeOnDemand ?? … , true),
```

`enabled` defaults **false**, `wakeOnDemand` defaults **true**. An absent key is therefore not
neutral — it is the permissive value. So from 2026-07-24 the agent was, for the first time in its
life, actually wakeable on demand; from 2026-07-25 it again had a command that exits 0. The
`missing_disposition` loop begins in that window and is stopped on 2026-08-01 by the pause. That
matches the operator's own timeline exactly.

### 1.2 Why the key was lost — an upstream portability defect

The rebuilt row's `runtimeConfig` is not an arbitrary shape. It is the exact output of the
company-portability import path, and every field matches a specific line.

```ts
// server/src/services/company-portability.ts:941-949 — applied at import, :4698
function disableImportedTimerHeartbeat(runtimeConfig: unknown) {
  const next = clonePortableRecord(runtimeConfig) ?? {};
  const heartbeat = isPlainRecord(next.heartbeat) ? { ...next.heartbeat } : {};
  heartbeat.enabled = false;
  if (parseFiniteNumberLike(heartbeat.maxConcurrentRuns) == null) {
    heartbeat.maxConcurrentRuns = AGENT_DEFAULT_MAX_CONCURRENT_RUNS;   // = 20
  }
  next.heartbeat = heartbeat;
  return next;
}
```

```ts
// server/src/services/company-portability.ts:1871 — inside pruneDefaultLikeValue
if (opts.dropFalseBooleans && value === false) return undefined;
```

`pruneDefaultLikeValue` is applied to `runtimeConfig` at export with `dropFalseBooleans: true`
(`:3674-3679`), and to `adapterConfig` the same way (`:3667-3673`). Four fingerprints, all
present in the 2026-07-24 row:

| Observed in the rebuilt row | Produced by |
|---|---|
| `heartbeat.enabled: false` present | `:944` writes it unconditionally |
| `heartbeat.maxConcurrentRuns: 20` present | `:946`, `AGENT_DEFAULT_MAX_CONCURRENT_RUNS` (`packages/shared/src/constants.ts:78`) is `20`; export had dropped the explicit `20` as default-like via `RUNTIME_DEFAULT_RULES` (`:669-676`) |
| `heartbeat.wakeOnDemand` **absent** | `:1871` — `false` is dropped on export, and nothing on the import side restores it |
| `adapterConfig.command` **absent** | `:3693-3696` — `/bin/echo` is absolute, so export deletes it and emits `"Agent … command … was omitted from export because it is system-dependent."` |

The command stripping is the corroborating fingerprint: `/bin/echo` was present pre-wipe,
absent immediately after the rebuild, and manually re-added on 2026-07-25 — exactly the
sequence an absolute-command export produces.

So the round-trip is lossy in a direction that is **specifically dangerous for a pull agent**:
`wakeOnDemand: false` is the only heartbeat boolean whose parse default is `true`, so dropping
it does not preserve behaviour — it inverts it. `enabled: false` survives only because the
importer happens to re-write it.

Both of these are upstream code — `ce3b31d2c` (2026-03-02, "prune default values from company
portability exports") and `f9927bdaa` (2026-03-23, "Disable imported timer heartbeats"),
contained in 601 upstream refs. This is not a fork regression.

### 1.3 Why an absent `wakeOnDemand` produces the loop

`wakeOnDemand` is enforced in the one function that actually starts runs:

```ts
// server/src/services/heartbeat.ts:16206-16213
if (source === "timer" && !policy.enabled)      { await writeSkippedRequest("heartbeat.disabled");            return null; }
if (source !== "timer" && !policy.wakeOnDemand) { await writeSkippedRequest("heartbeat.wakeOnDemand.disabled"); return null; }
```

and the recovery sweeps dispatch through that exact function —
`const recovery = recoveryService(db, { enqueueWakeup })` at `heartbeat.ts:5801`. With
`wakeOnDemand: false`, `reconcileStrandedAssignedIssues` → `enqueueInitialAssignedTodoDispatch`
(`recovery/service.ts:4353`) writes a skipped wake request and stops. **No run is created, so no
run can lack a disposition.** With the key absent, the same call spawns `/bin/echo`, which
succeeds having made zero Paperclip tool calls, and the issue moves to `in_progress` with nothing
recorded — which is precisely the input `successful_run_handoff` exists to catch.

### 1.4 H2 is refuted for this loop

The `missing_disposition` machinery is upstream and long predates the wipe:

| Predicate | First commit | Date |
|---|---|---|
| `decideSuccessfulRunHandoff`, `isExhaustedSuccessfulRunHandoff`, `SUCCESSFUL_RUN_MISSING_STATE_REASON` | `454edfe81` "Add recovery handoff system notices (#5289)" | 2026-05-06 |
| `missing_disposition` recovery-action kind | `0808b388e` "[codex] Add source-scoped recovery actions (#5599)" | 2026-05-12 |
| assigned-`todo` dispatch during recovery sweeps | `68c37660f` "Dispatch assigned todo work during recovery sweeps (#4614)" | 2026-04-27 |

Ten to twelve weeks before the wipe, all upstream. The only fork-side change in this area is
`adb2561f2` (2026-07-27, "hand off successful runs that made zero Paperclip tool calls"), and it
does **not** apply here: the tool-call counter is implemented only in the opencode-local parser
(`packages/adapters/opencode-local/src/server/parse.ts:158`), so a `process` adapter reports
`null`, and `readPaperclipToolCallCount` returns `null`, and
`successful-run-handoff.ts:348` (`if (input.paperclipToolCallCount === 0) return true`) is never
reached. The nothing-changed-in-code conclusion holds.

---

## 2. What the git history shows (H2)

`no_live_path_owner_unavailable` and its sibling `no_live_path_unowned` were both introduced by a
single fork commit:

```
eb383a91c 2026-08-05 feat(SUP-11085): convert three silent no-live-path strand exits
                     to board-owned recovery actions [PPC BE] (#83)
```

`git branch -r --contains eb383a91c | grep -c upstream/` → **0**. Fork-only.

The diff is decisive about the prior behaviour. Where the reconciler now opens an action, it
previously did nothing at all:

```diff
       if (issue.status !== "in_review" && !agentInvokable) {
-        result.skipped += 1;
-        continue;
+        …
+        kind: "no_live_path_owner_unavailable",
```

So before 2026-08-05 a paused assignee on a `todo` issue was a **silent skip**. Pausing was a
complete cure, which is exactly why the operator adopted it on 2026-08-01 and why it worked for
five days. The control-plane deploy of 2026-08-06 14:29:48Z turned that same pause into a
trigger. H2 confirmed, commit-level.

---

## 3. The predicates that must change (AC2)

The root defect is stated most cleanly as: **two subsystems disagree about what "this agent can
be invoked" means, and only one of them is authoritative.**

`enqueueWakeup` — the only code path that starts a run — answers the question with
`invokability AND heartbeat policy` (`heartbeat.ts:16188-16213`). Every recovery detector answers
it with `invokability` alone. A pull agent lives in the gap.

### 3.1 The firing predicate

```ts
// server/src/services/recovery/service.ts:3921
if (issue.status !== "in_review" && !agentInvokable) {
```

`agentInvokable` comes from `evaluateAgentInvokabilityFromDb`
(`services/agent-invokability.ts:118`), which is a pure function of agent status and org chain.
It is **correct** about invokability and **wrong** as a liveness signal: it cannot distinguish
"the execution path broke" from "the operator configured this agent to have no execution path."

Note that `agent-invokability.ts:35` `DIRECT_NON_INVOKABLE_STATUSES` is *not* the predicate to
change. A paused agent genuinely is not invokable; that set is right. The error is equating
non-invokable with no-live-path at `service.ts:3921`.

### 3.2 The grace window

```ts
// server/src/services/recovery/service.ts:143
const NO_LIVE_PATH_GRACE_THRESHOLD_MS = 15 * 60 * 1000;
```

This is the "roughly every 15 minutes" in the symptom. It is correct and should not change.

### 3.3 The never-re-checked skip

```ts
// server/src/services/recovery/service.ts:3927-3931
const existingAction = await recoveryActionsSvc.getActiveForIssue(issue.companyId, issue.id);
if (existingAction?.kind === "no_live_path_owner_unavailable") { result.skipped += 1; continue; }
```

Confirms the board addendum: the reconciler never re-evaluates invokability once an action
exists, and has no auto-resolve path for this kind. An action opened during a *transient* pause
outlives the pause.

### 3.4 The read-path retirement — retires on the wrong evidence

```ts
// server/src/routes/issues.ts:3076
if ((issue.status === "todo" || issue.status === "in_progress") && issue.assigneeAgentId) {
  return `Recovery action became stale because the source issue is ${issue.status} with an agent owner.`;
}
```

"has an agent owner" is the precondition the detector already evaluated and rejected — the
detector fired *because* there is an agent owner and that owner is not invokable. Retiring on it
without re-checking invokability discards the finding rather than revalidating it.

### 3.5 The handoff skip, for completeness

```ts
// server/src/services/recovery/successful-run-handoff.ts:420
if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
  return { kind: "skip", reason: `agent status ${agent.status} is not invokable` };
}
```

This is the guard that made pausing cure the `missing_disposition` loop. It is status-only, so it
does not hold for an unpaused pull agent. Under the proposal it becomes a no-invocation-path
skip and holds in every status — which is what AC "no recovery action in **any** status"
requires.

---

## 4. Proposal (AC3)

### 4.1 Recommendation

**Make "does the platform have any way to invoke this agent?" a first-class, named predicate
derived from the configuration that already answers it, and have the recovery detectors consult
it — plus make `no_live_path_owner_unavailable` level-triggered instead of edge-triggered.**

Concretely, one new shared helper, roughly:

```ts
// packages/shared/src/agent-eligibility.ts — alongside isAgentStatusInvokable
export function hasPlatformInvocationPath(heartbeat: { enabled: boolean; wakeOnDemand: boolean }) {
  return heartbeat.enabled || heartbeat.wakeOnDemand;
}
```

`enabled === false && wakeOnDemand === false` means no timer path and no on-demand path: the
platform cannot start a run for this agent under any trigger. That is not an inference about
operator intent — it is a statement about `heartbeat.ts:16206-16213`, which is where runs are or
are not created.

Then, at the four sites in §3:

1. `service.ts:3921` — skip the branch (as it did before 2026-08-05) when the assignee has no
   platform invocation path. An assigned issue on a pull agent is not a strand; it is a queue.
2. `service.ts:3927` — re-evaluate on every sweep and **cancel** the action when the assignee is
   invokable again, instead of skipping unconditionally. This retires the transient-pause class
   the board sweep measured (6 of 11 instances), which the pull-agent exemption alone does not
   touch.
3. `issues.ts:3076` — require invokability, not merely an assignee, before retiring on read.
4. `successful-run-handoff.ts:420` — widen the status check to "no invocation path", so the
   `missing_disposition` loop stays cured if the agent is ever unpaused.

5. `company-portability.ts:1871` / `:941-949` — stop the export/import round-trip from
   silently inverting `wakeOnDemand`. Minimum viable fix: exempt the heartbeat booleans from
   `dropFalseBooleans` (they are policy, not presence flags), or have
   `disableImportedTimerHeartbeat` restore `wakeOnDemand` from the manifest rather than leaving
   it to the parse default. Without this, the predicate the other four items depend on is one
   company export away from flipping back, and the July incident repeats.

Items 1 and 4 close the pull-agent case. Items 2 and 3 fix the two revalidation defects that
exist independently of pull agents and would otherwise remain. Item 5 is what makes the whole
thing durable — it is the actual root cause of the July loop, and it is still live.

### 4.2 Why the other two mechanisms are worse

**A first-class agent kind (`external_pull`).** Right semantics, wrong cost. It needs an enum, a
migration, a UI surface, a company-portability entry, and creates a second source of truth that
can contradict `wakeOnDemand`. The snapshot record shows the operator has been expressing this
intent through `wakeOnDemand: false` since 2026-07-10 — before Paperclip had any detector that
cared. Adding an enum is strictly more machinery for the same predicate, and it diverges the
fork from upstream at a type boundary.

The honest objection to reusing `wakeOnDemand` is §1.2: the field is currently *lossy* across a
company export/import. That is an argument for fixing the round-trip, not for adding a second
field beside it — a new `external_pull` enum introduced today would sit in `runtimeConfig` or a
new column and face the same `pruneDefaultLikeValue` treatment unless portability is fixed
anyway. §4.5 makes the fix explicit and it is a prerequisite, not an optional extra.

**An operator-intent field distinguishing a deliberate pause from a fault.** This one is
genuinely inadequate, not merely expensive: it only addresses the paused loop. The agent was
looping while `idle` too, and a pause-intent flag says nothing about an unpaused pull agent — so
it would leave AC "no recovery action in **any** status" unmet, and would re-open the
`missing_disposition` loop the moment the pause is lifted. It also re-encodes information the
runtime config already holds.

**Excluding `adapterType: process` no-op agents from dispatch and recovery.** Worst of the three.
`process` is a legitimate adapter used by working agents, so the exclusion has to key on the
command *looking like* a no-op — a heuristic over a string. It would suppress recovery for
genuinely broken process agents, i.e. it destroys the detector's true positives, which is the
opposite of what SUP-11085 shipped it for.

---

## 5. A regression already on master

`fold/tea-patches-v2026.722.0` contains, from this morning:

```
cfaa321d0 2026-08-07 fix(SUP-11327): no_live_path_owner_unavailable read-path revalidation, …
81ea520cd 2026-08-07 fix(SUP-11327): address CR findings — kind mismatch, invokability evidence, test kinds
```

These add `no_live_path_owner_unavailable` to the read-projection retirement path
(`issues.ts:3047-3049`) so it can retire without a durable write. Combined with the unchanged
predicate at `issues.ts:3076`, the effect on a paused pull agent is:

1. sweep opens the action (agent not invokable, 15 min elapsed);
2. **any** issue read — the UI list poll, `paperclipListIssues`, `paperclipGetIssue` — reaches
   `issues.ts:3076`, sees `todo` + an assignee, and cancels it;
3. the next sweep re-opens it;
4. repeat.

Today the action is stable because the deployed image (`v2026.722.0-tea`) predates SUP-11327 —
which is why SUP-11246's own live action still carries `attemptCount: 1` and a `createdAt` of
2026-08-06T16:39:39Z. On the next deploy the five parked instances stop being permanent and
start churning, with an `issue.recovery_action_resolved` activity-log row per read. §4 item 3 is
the change that prevents this; it should not ship without it.

---

## 6. The pull path is unaffected (AC4)

Issue discoverability does not depend on agent status anywhere on the read path.

- `svc.list(companyId, listFilters)` filters on `assigneeAgentId`, status, project, labels — no
  join to `agents.status`, no visibility predicate involving the agent lifecycle.
- The only two reads of `agents.status` in `services/issues.ts` are `:2613` (blocker-attention
  classification) and `:3383` (issue-graph liveness annotation). Both **annotate** issues; neither
  filters one out of a result set.
- The proposal touches only `recovery/service.ts`, `routes/issues.ts`'s
  `classifySourceRecoveryRevalidation`, `successful-run-handoff.ts`, and one new predicate in
  `packages/shared`. It adds no read-path condition.

So Claude Desktop and pc-agent MCP keep seeing exactly the issues they see today. This is also
the reason the pull model works at all while the agent is paused, and why it must not be
"fixed" by unpausing.

Out of scope and untouched: the `assigneeAgentId` issue-write gate (SUP-9516).

---

## 7. Effect on the live instances (AC5)

Every one of these is assigned to `coder-Claude-code`
(`a28a1fc0-250a-4d6c-bb82-e9491bcd6a70`; `paused`, `heartbeat.enabled: false`,
`heartbeat.wakeOnDemand: false`).

| Issue | Status | Today | Under the proposal |
|---|---|---|---|
| SUP-10914 | `todo` | fires every 15 min | §4.1 skips the branch — never opens |
| SUP-11164 | `todo` | fires every 15 min | §4.1 skips the branch — never opens |
| SUP-11155 | `done` | already outside the candidate set | unchanged |
| SUP-11330 | `todo` | fires every 15 min | §4.1 skips the branch — never opens |
| SUP-11332 | `todo` | fires every 15 min | §4.1 skips the branch — never opens |
| SUP-11246 | `todo` | live action `562e2d79`, opened 2026-08-06T16:39:39Z | §4.1 skips; §4.2 cancels the existing row on the next sweep |

SUP-11155 reached `done` since the issue was filed, so the "three live instances" are now two,
plus three more that the board sweep parked for the same reason. The candidate query
(`service.ts:3799`) is `status ∈ {todo, in_progress, in_review}`, which is why `done` alone
retires it.

The transient-pause class the board sweep resolved by hand (SUP-10257, SUP-11128, SUP-11390,
SUP-11391, SUP-11165, SUP-10817 — six assignees that were `running`/`idle` at triage) is retired
automatically by §4.2, which is the part a pull-agent exemption on its own would not have fixed.

**Do not** resolve the existing actions manually to test this. They are the evidence, and per
§5 a manual resolve today records a false disposition and the detector re-fires regardless.

---

## 8. Fork or upstream (AC6)

Split, by provenance:

| Change | Surface | Where |
|---|---|---|
| §4.1 skip when no invocation path | `no_live_path_owner_unavailable` branch, `recovery/service.ts:3921` | **fork** — the branch is `eb383a91c`, fork-only, contained in zero upstream refs |
| §4.2 level-triggered re-evaluation | same branch, `recovery/service.ts:3927` | **fork** — same commit |
| §4.3 read-path retirement guard | `classifySourceRecoveryRevalidation`, `routes/issues.ts:3076` | **fork** — the `no_live_path_owner_unavailable` arm is `cfaa321d0`/`81ea520cd`, fork-only. The `stranded_assigned_issue` arm and the `:3076` predicate itself are upstream, so the guard should be written to preserve upstream behaviour for upstream kinds |
| §4.4 handoff skip widened | `successful-run-handoff.ts:420` | **upstream.** `decideSuccessfulRunHandoff` is `454edfe81` (2026-05-06, upstream). This is the one change that belongs upstream, and it is worth proposing there: any deployment with a heartbeat-disabled, wake-disabled agent has the same latent `missing_disposition` loop |
| §4.5 portability round-trip | `company-portability.ts:1871`, `:941-949` | **upstream, unambiguously.** `ce3b31d2c` (2026-03-02) and `f9927bdaa` (2026-03-23), both contained in 601 upstream refs. Nothing fork-specific is involved |
| `hasPlatformInvocationPath` helper | `packages/shared/src/agent-eligibility.ts` | **upstream**, as the natural home next to `isAgentStatusInvokable`; carry it in the fold until accepted |

Named upstream surfaces:

- §4.4 — `paperclipai/paperclip`,
  `server/src/services/recovery/successful-run-handoff.ts` → `decideSuccessfulRunHandoff`.
- §4.5 — `paperclipai/paperclip`, `server/src/services/company-portability.ts` →
  `pruneDefaultLikeValue` and `disableImportedTimerHeartbeat`. This one is worth filing upstream
  on its own merits regardless of what Paperclip decides about pull agents: any agent whose
  operator set a heartbeat boolean to `false` loses that setting on export, and `wakeOnDemand` is
  the one where losing it is not fail-safe.
- New predicate — `paperclipai/paperclip`, `packages/shared/src/agent-eligibility.ts`.

---

## 9. Corrections to the issue body

Recorded so the next reader does not re-derive them:

1. **"the pre-wipe database and its backups are gone, so the old agent rows cannot be read
   directly"** — the rows themselves are gone, but `~/agent-snapshots/<agentId>/<ts>/{before,after}.json`
   on sectoid preserves full agent JSON either side of every patch, back to 2026-07-10. This is a
   general-purpose forensic surface and should be the first stop for any future
   config-drift RCA.
2. **"Both agents were recreated on 2026-07-24T05:58–05:59Z"** — true, but the rebuilt row reuses
   the *same* UUID as the pre-wipe one (`a28a1fc0-…`), which is what makes the snapshot
   comparison valid.
3. **The suspected H1 mechanism (adapter/command difference) is refuted.** `/bin/echo` predates
   the wipe. The actual delta is a single dropped `runtimeConfig.heartbeat` key.
4. **`heartbeat.enabled: false` is not a distinguishing signal** — it is the parse default
   (`heartbeat.ts:10741`), and the portability importer writes it unconditionally
   (`company-portability.ts:945`), so nearly every agent carries it. Only `wakeOnDemand: false`
   is non-default, and only the conjunction means "no invocation path at all."
5. **The loss was not operator error.** §1.2 shows the rebuild produced exactly the row a
   company-portability import produces, down to `maxConcurrentRuns: 20` and the stripped absolute
   `command`. Anyone re-running that export/import today would reproduce the July loop, so
   restoring `wakeOnDemand: false` by hand — which has already happened, some time between
   2026-07-31 and 2026-08-04 — is not a durable fix.
