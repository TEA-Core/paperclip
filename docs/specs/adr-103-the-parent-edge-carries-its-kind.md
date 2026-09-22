# ADR-103 — the parent edge carries its kind

**Status:** accepted (exec-CTO ruling, SUP-17179, 2026-09-22)
**Root issue:** SUP-17167. **Symptom signature:** `process-child-reclassified-as-decomposed-parent`.
**Chain depth:** 1 — first ruling on this signature.
**Extends:** ADR-102 (SUP-16499, `paperclip-agent-tools/doctrine/adr-102-ladder-mutation-is-a-transition.md`).
ADR-102's invariants **apply here unchanged**; this ruling is their analogue one relation over. See §7.
**Supersedes in part:** the SUP-16586 label carve-out *contract* is retained and closed at four names;
the label *treadmill* it implies is retired by M2.
**Does not reopen:** the `>= 2` threshold, the SUP-15451 `origin_kind` narrowing, the SUP-16025
cancelled-child skip, the `ADR072_CLOSE_LADDER` rung table, or the ratified close ladder
`review:support-QAE → review:coder-LE → approval:exec-CTO`.
**Numbering:** ADR-102 is the highest ordinal attested in `paperclip-agent-tools/doctrine/` and this
repo's `docs/` (96, 98, 100, 101, 102 in use); this takes the next free one.

---

## 0. Verification posture — this ruling is against the deployed control plane

Every line number below is the **running server**, not a worktree guess. Probed 2026-09-22:

| probe | result |
|---|---|
| `GET /api/health` | `commit: 25ff637255e28b8499106825771896fc28850aae`, `version 2026.428.0+2928.git.25ff63725` |
| `git hash-object /app/server/src/services/done-transition-guard.ts` | `96780ba1c5d6ee56d40be28d0895ebeb349aa6aa` |
| `git rev-parse 25ff6372:server/src/services/done-transition-guard.ts` | `96780ba1…` — identical |
| `git rev-parse origin/fold/tea-patches-v2026.722.0:…/done-transition-guard.ts` | `96780ba1…` — identical |

The guard file is **byte-identical across deployed, `main`, and this worktree**, so its line numbers
are unambiguous. `routes/issues.ts` is *not*: deployed blob `30cb08bf…` vs worktree `fbfc51b0…`
(SUP-17125 hoisted the remedy into a `const` and added `postTerminalStatusRefusalComment`). The M3
defect is present in **both** forms and is cited at both offsets — deployed `:4647-4651`, worktree
`:4558-4562`.

---

## 1. Decision

`issues.parent_id` is **overloaded**: it carries at least three distinct relations, and only one of
them is a decomposition signal. The done-transition guard reads the column as though it carried one.
That is the root cause, and no predicate over the present store can repair it, because **the store
does not record which relation an edge represents**.

The ruling is therefore: **make the relation explicit on the edge.** The parent edge must carry its
kind, declared by the writer in the same write that draws the edge, and read lazily at close.

- **Process children are identified by a server-owned discriminator on the edge**, not by a property
  of the child, and never by a title or description heuristic (§9.1).
- **Classification stays lazy** — computed at the close from live rows. ADR-102's rejection of a
  create-time classification cache stands, and is not weakened here (§7.1).
- **The atomic boundary is the edge write, as a validity gate that persists nothing derived** — the
  exact shape of ADR-102's M1 ("make the mutation total"), applied to `parent_id` instead of
  `executionPolicy.stages` (§4, M4).
- **Genuine decomposed-parent behaviour is preserved in full.** Two qualifying laddered *work*
  children still require `review:support-QAE → review:coder-LE → approval:exec-CTO`. The threshold
  does not move; the default classification is `decomposition`, so the guard stays fail-closed.

Four mechanisms, M1–M4, sequenced in §4. M1 and M3 stop the live class this week; M2 and M4 retire it.

---

## 2. Root cause — one column, three relations

In this company's practice, `issues.parent_id` is written to express at least three different things:

| # | relation | meaning | is it a decomposition signal? |
|---|---|---|---|
| 1 | **decomposition** | the child implements a *slice of the parent's scope* | **yes** — this is the one ADR-072 is about |
| 2 | **programme membership** | the parent is a tracking/programme card | no |
| 3 | **procedural attachment** | the child is *about* the parent — courier, unblock, redo, delivery, architecture-review | **no** |

ADR-072's premise is sound and is not disturbed: *if* a body of engineering work was gated at the
children, the parent must not close ungated. The premise quantifies over relation 1 only.

`countLadderedChildren` (`done-transition-guard.ts:1067`) approximates relation 1 with five clauses:

```
parent_id == parent            (:1090)
AND status != 'cancelled'      (:1135, SUP-16025)
AND origin_kind ∈ {manual, plugin:*}   (:1143-1144, SUP-15451)
AND executionPolicy != null    (:1145)
AND |completedStageIds| + |skippedStageIds| > 0   (:1147-1149)
AND NOT label ∈ {work-type:redo, work-type:delivery, work-type:architecture-review}  (:1109, :1157)
```

Four of those clauses are sound. The load-bearing one — *"the child ran its own ladder, therefore it
was engineered sub-work"* — is a **false proxy**, and the negative label list is the accumulated
evidence that it is false.

### 2.1 The carve-out list is a fossil record of the same defect, discovered four times

| patch | name added | live wedge that forced it |
|---|---|---|
| SUP-15464 | `work-type:redo` | a bounce card re-delivering its own parent |
| SUP-15533 | `work-type:delivery` | a carrier/delivery helper (SUP-15410/15405 over SUP-15140) |
| SUP-16586 | `work-type:architecture-review` | SUP-16569 filed to *fix* SUP-15805's ladder, then arming it |
| **SUP-17167** | *(none — unlabelled)* | SUP-16900 (unblock) + SUP-16884 (courier) over SUP-16872 |

Every one of those four is a member of **relation 3**. Three were patched in after they wedged a
card; the fourth wedged a card and had no label to patch. A fifth class will arrive, because the
list enumerates *discovered instances* of relation 3 while the column keeps admitting *undiscovered*
ones. **A fourth name is a fourth patch on an overloaded column.** The column is what is wrong.

### 2.2 Why the blast radius is "every card in the project"

The `executionPolicy != null` and "ran a stage" clauses were meant to separate engineered sub-work
from bookkeeping. In this project they separate nothing. The Paperclip project carries a
`defaultExecutionPolicy` with a review stage (`{mode: normal, stages: [review: support-CR |
support-QAE], commentRequired: true}`, read live 2026-09-22). **Every manually-filed card under this
project is auto-laddered on creation.** A courier card therefore satisfies `executionPolicy != null`
and, once it does its one job and closes, satisfies the fired-stage clause too — by construction, not
by accident.

Combined with the SUP-15451 narrowing admitting `origin_kind = 'manual'` (both SUP-16900 and
SUP-16884 are `manual`, read live), the qualification for "engineered sub-work" reduces, in this
project, to **"a manually-filed card that is parented here and reached a terminal state."** That is
the definition of a process child as much as of a work child. Hence SUP-17167's correct assessment
of the blast radius: *any card that had a rough review round.*

### 2.3 The refusal lands on the party with no remedy

This is the second half of the root cause, and it is what turned a classification error into a
three-layer deadlock.

The classification input (`parent_id`) is written **by a third party** — the courier's filer, who has
no stake in the parent — and evaluated **lazily, at the parent's close**, arbitrarily later. The
refusal is then delivered to the **parent**, which by that point has an advanced ladder pointer and
cannot lawfully add the missing stages (ADR-102 M1: an insert behind the pointer is itself a
violation). The remediable moment — the edge write, where one field would have fixed it and the
writer was present — passed silently.

A control that fails closed is correct. **A control that fails closed on a party that has no lawful
remedy is a deadlock, not a gate.** Mechanism D's remedy text is not merely wrong prose (§3.2); it is
the observable symptom of this inversion. The guard has no remedy to offer because the only remedy
belonged to a write that already committed.

---

## 3. Two adjacent defects, both confirmed on the deployed tree

Neither is the root cause, both are load-bearing for the operator experience, and both are cheap.

### 3.1 `excludedChildIdentifiers` never reaches the refusing agent, and never reaches anyone on a *successful* close

`countLadderedChildren` returns `excludedChildIdentifiers` (`:1164`) precisely so a carve-out is
auditable and a mislabelled genuine child is detectable — that is SUP-16586's stated contract
(`:1043-1046`). On the deployed tree the field reaches **only the audit-log payloads**
(`:1550` mechanism A, `:1582` mechanism D). Grepped across the deployed guard, `excludedChildIdentifiers`
appears at `:1044, 1074, 1127, 1158, 1164, 1474, 1493, 1550, 1582` and **in no `reason` string**. The
409 body prints `ladderedChildIdentifiers` only (`:1606-1608`).

Worse: when the exclusions bring the count **below 2**, `ladderShape` stays `null`, no audit row is
written at all, and the close succeeds. So the case where an exclusion actually *silenced a gate*
is the one case that leaves **no record anywhere**. That is the auditability hole, and it is on the
side that matters.

### 3.2 The remedy is computed from the caller's door, not from the mechanism that refused

Deployed `routes/issues.ts:4647-4651` (worktree `:4558-4562`):

```ts
remedy: guardResult.ladderUnsatisfied
  ? "Record the unsatisfied review stage's approval (or skip it) …"
  : decisionCarried
    ? "Merge the issue's pull request before approving this review stage …"
    : "Run deliver.sh to deliver the branch …"
```

`evaluateDoneTransitionGuard` already returns a **mechanism-specific** remedy inside `reason` —
mechanism D's is *"Add the missing review/approval stages to this issue's execution policy."*
(`done-transition-guard.ts:1599-1602`), mechanism A's is *"Attach an execution policy with a review
ladder to this issue."* (`:1558-1560`). The route **discards it** and substitutes a remedy derived
from which door was used.

`ladderUnsatisfied` is set by mechanism C alone. Mechanisms A and D return without it, so a
decision-carrying close — an approval-stage decision, exactly SUP-16872's shape — falls through to
the **merge-first** branch unconditionally. Hence the instruction SUP-17167 correctly calls
"exactly backwards": merge the PR whose merge is blocked on the approval you are being refused.

The response `code` is `done_transition_missing_delivery` for **all** mechanisms (`:4568/:4578`
worktree). It is a catchall, not a delivery verdict. Only mechanism C is represented on the remedy
axis; A and D are silently absorbed into the delivery guard's voice.

---

## 4. The mechanisms

### M1 — interim: close the label contract at a fourth name, `work-type:process`

Ship first; the class is live now and M2 needs a migration.

Add `work-type:process` as a fourth company-scoped carve-out name beside `work-type:redo`,
`work-type:delivery`, `work-type:architecture-review`, resolved in the **same single**
`inArray(labels.name, …)` read (`:1109`) — one read covers four names exactly as it covers three.
An excluded child is pushed to `excludedChildIdentifiers` (`:1158`); a silent `continue` is a defect.
Both consumers inherit with no call-site filter: mechanisms A and D, **and** the SUP-15878 route gap.
This is SUP-16586's shape verbatim; do not invent a new one.

`work-type:process` covers relation 3 as a **class**: courier, unblock, review-routing, escalation
handoff, and any future procedural attachment. The three existing names stay — they are in flight,
and their specificity is worth keeping in the audit trail.

**M1 is explicitly declared insufficient on its own.** It is opt-in by the filer and fail-open by
default: an unlabelled process child still counts, which is precisely SUP-17167. M1 buys time. M2 is
the fix.

### M2 — durable: `parent_link_kind` on the edge

Add a column beside `parent_id`:

```
issues.parent_link_kind  text  NOT NULL  DEFAULT 'decomposition'
  CHECK (parent_link_kind IN ('decomposition', 'process'))
```

- Written by the same writer in the **same statement** as `parent_id`, at create
  (`services/issues.ts:518-526`) and at the re-parent PATCH
  (`routes/issues.ts:16437-16439`, the existing `parentChanged` site).
- **Default `decomposition`**, so the guard stays fail-closed and every existing row keeps today's
  meaning. The migration guesses nothing.
- `countLadderedChildren` reads it **lazily at close**, from live rows, in the same pre-network zone
  as today. Nothing is cached (§7.1).
- **Back-compat:** a child carrying any of the four carve-out labels is treated as
  `parent_link_kind = 'process'` regardless of the column, so no relabelling campaign is required
  and M1's protection is never withdrawn.
- **The label list freezes at four.** Once M2 ships, a fifth name is never added; a new procedural
  class declares `parent_link_kind: 'process'` at the edge.

**Why the edge and not the child.** A label is a property of the *child*; the relation is a property
of the *edge*. The same card can be a decomposition child of one parent and procedural to another —
SUP-16872's repair was exactly a re-parent, and under a label scheme the label would have had to move
with the edge as a second write that nothing enforces. Putting the kind on the edge makes
re-parenting carry its own semantics and makes the "two writes disagree" class impossible. It also
matters because `parent_id` is already load-bearing for carrier-workspace inheritance
(`services/issues.ts`: `inheritExecutionWorkspaceFromIssueId ?? issueData.parentId ?? null`), so the
edge is the object that genuinely needs describing.

### M3 — the refusal must speak in the voice of the mechanism that refused

Independent of M1/M2, cheap, and it is what an operator actually reads.

1. `evaluateDoneTransitionGuard` returns a **mechanism discriminator**
   (`"A" | "C" | "D" | "delivery"`) alongside `reason`. `ladderUnsatisfied` is retained or folded in;
   it must stop being the sole axis.
2. The route selects the remedy from that discriminator, not from `decisionCarried`. Mechanisms A and
   D carry their own remedy through; the merge-first string is reachable **only** on a true
   delivery/head refusal.
3. **Merge-first is never emitted on a mechanism A or D refusal.** On a decision-carrying close it is
   provably circular: the approval being refused is the only thing that publishes
   `paperclip/approved`, without which the PR cannot merge.
4. Mechanism D's remedy names the actual remedies in the SUP-17167 shape — *re-parent the procedural
   child to an ancestor, or declare it `process`* — before *add the missing stages*, which is legal
   only while the pointer has not advanced past the first close-ladder rung (ADR-102 M1).
5. `excludedChildIdentifiers` is printed in the refusal `details`, beside `ladderedChildIdentifiers`
   (§3.1).
6. An exclusion that brings the count **below 2** writes an audit row on the **successful** close
   naming every excluded identifier. Exclusion must never be silent in the direction that opens a gate.
7. The response `code` remains `done_transition_missing_delivery` for wire compatibility; the
   mechanism travels in `details`. Renaming the code is out of scope and would break callers.

### M4 — the atomic boundary: make the parent-edge write total

This is the card's second required bullet, and it is ADR-102's M1 one relation over.

In the same transaction as a `parent_id` write (create **or** re-parent), evaluate the live
predicate — persisting nothing derived — and **reject the write** when *all* of:

1. the edge would take the parent's `countLadderedChildren` count from `< 2` to `>= 2`
   (or hold it at `>= 2` while the parent's ladder is non-conforming); **and**
2. the parent's ladder has **already advanced** — `executionState.completedStageIds` is non-empty;
   **and**
3. the parent lacks a conforming ADR-072 close ladder, per `findMissingAdr072CloseLadderStages`
   (`:1481-1488`, the same helper, never a second copy).

The rejection is a `409` naming the parent, the count the edge would reach, and the two lawful
resolutions: declare the edge `parent_link_kind: 'process'` (or label the child, pre-M2), or file the
child under the parent's programme/ancestor.

When the parent's pointer has **not** advanced, the edge is **allowed** and the existing ADR-072
arming path installs the close ladder as designed. Genuine decomposition is untouched — M4 refuses
only the edge that would impose an obligation the parent can no longer discharge.

**This is the whole answer to "the classification cannot silently change after the ladder pointer has
advanced."** It is achieved by refusing the *change*, not by freezing the *classification*. Freezing
is what ADR-102 rejected, and rightly (§7.1).

**M4 does not un-wedge an already-wedged card** — it is a write-time gate and cannot repair a
violation already persisted. §6 is the recovery path, exactly as ADR-102 §"The live instance"
reasoned for its own M1.

### 4.1 Sequencing

```
M1 ──┐
M3 ──┤ independent, ship in parallel, no migration
     │
M2a (schema/migration) ── M2b (route + guard read) ── M4
```

M4 is sequenced after M2b so its rejection message can name `parent_link_kind` as the remedy rather
than a label it is about to retire.

---

## 5. Mixed children, and how exclusions stay auditable

**Counting.** Exclusions subtract **before** the `>= 2` test. The threshold itself does not move.

| parent's children | count | owes the ADR-072 close ladder? |
|---|---|---|
| 2 work + 3 process | 2 | **yes** — full ladder |
| 1 work + 4 process | 1 | no |
| 0 work + 5 process | 0 | no |
| 2 work + 0 process | 2 | **yes** — unchanged from today |

A parent is never let off because it *also* has process children. Process children are invisible to
the count in both directions; they neither arm the gate nor disarm it.

**Auditability.** Every excluded child's identifier is recorded, in all three surfaces:

1. `excludedChildIdentifiers` in the audit-log payload — **already true** (`:1550`, `:1582`).
2. In the **409 refusal body**, beside the counted identifiers — M3.5, new.
3. On a **successful close** whose count fell below 2 *because of* exclusions — M3.6, new, and the
   one that closes the real hole (§3.1).

The exclusion set is a list of identifiers, never a boolean. That is what makes a mislabelled
genuine child detectable by a reader, and it is why §9.1 rejects any heuristic: a heuristic produces
an exclusion nobody declared and nobody can audit.

---

## 6. Recovery for an already-wedged card

Ordered, and it **never** instructs a merge while `paperclip/approved` is missing.

**Symptom.** `409 done_transition_missing_delivery` on an approval-stage decision, whose `error` text
begins *"Mechanism D (ADR-072 close-ladder shape) refused: this issue is a decomposed parent over N
laddered children (…)"*, on a card whose PR reads `mergeStateStatus: CLEAN` with no failing check.

0. **Do not** touch the PR. Do not re-deliver, do not push an empty commit, do not hand-PATCH the
   parent's status, and **do not add stages to the parent** — an insert behind an advanced pointer is
   ADR-102's violation and will strand the ladder a second way.
1. **Disregard the `details.remedy` string** on a mechanism A/D refusal until M3 ships. It is a
   known-false catchall (§3.2). Read `error`, which carries the mechanism's true remedy.
2. From `error`, take the **counted** identifiers — those are the exact cards arming the gate.
3. For each that is procedural, apply **one** of, in preference order:
   - **(a)** re-parent it to the nearest non-work ancestor — the programme card. This is the repair
     David authorized on SUP-16872 (both children moved to SUP-16861; both stayed `done`).
   - **(b)** once M1 ships, label it `work-type:process`.
   - Once M2 ships, **(c)** set `parent_link_kind: 'process'` on the edge — preferred, because it
     keeps the edge and states the truth.
   All three leave the child `done`. **No status write on the child** — no re-open, no cancel. A
   status write would cost the child its own ladder record and can cancel a live recovery action.
4. **Re-issue the parent's approval-stage decision.** This publishes `paperclip/approved` on the head.
5. **Only now** is the PR mergeable. Re-enqueue it.

**Who owns step 3.** Re-parenting or relabelling needs a write grant on the **child**, which
`issue:mutate` scopes to the child's assignee. The parent's approver usually does not hold it. Two
lawful actors: the child's assignee, or an **org-chain ancestor** via
`ANCESTOR_WORKSPACE_CORRECTION_FIELDS` (`routes/issues.ts`), which admits `parentId`. Note that this
hatch re-points carrier-workspace inheritance, so it must not be used against a child holding a live
run. Where the approver cannot act, the parent parks `blocked` with `blockedByIssueIds = [child]` and
names the child's assignee and the action. **The parent's stage is never skipped to escape** — that
converts a classification bug into a review-integrity finding.

---

## 7. Relationship to the two prior rulings

### 7.1 ADR-102 / SUP-16499 — applies, and constrains this ruling

ADR-102 rejected the proposal to evaluate "parent classification … atomically when a laddered child
is created", on the grounds that parent classification is *a derived predicate over a mutable child
set*, so computing it at create time installs *"a cache of a relation that keeps moving"* — the same
defect as `currentStageIndex`, one level up. Its conclusion: **"Keep classification lazy. Make the
mutation total."**

**That reasoning is correct, it binds this ruling, and nothing here weakens it.**

- M2 is **not** a cache. `parent_link_kind` is not derived from anything — it is the **primary fact
  about the edge**, supplied by the writer, in the same statement as the edge, and it moves with the
  edge. A cache is a stored answer to a question that can be recomputed; `parent_link_kind` is the
  one input to that question that **cannot** be recomputed, because it lives only in the filer's
  intent. Today that intent is discarded at the moment it is known and guessed at, badly, months
  later.
- M2 keeps classification **lazy**: `countLadderedChildren` still runs at the close, over live rows,
  in the pre-network zone. M2 changes *what it reads*, not *when*.
- M4 is ADR-102's **M1 in the same shape**: validate the mutation against live state inside the same
  write, reject it if it is not total, persist no projection. ADR-102 put that gate on the
  `executionPolicy.stages` write; M4 puts it on the `parent_id` write.

ADR-102 also observed of SUP-16131 that *"mechanism D fired exactly as designed"* and what failed was
the **repair**. Here the diagnosis differs, and the difference is the point of this card: on
SUP-16872 mechanism D fired **as designed but on a false premise**. The repair path was broken too
(§3.2), but fixing only the repair would leave every courier card still arming a gate it has no
business arming.

### 7.2 ADR/SUP-16586 — its contract is retained, its treadmill is retired

SUP-16586 ruled that this class stays **label-driven** and that matching *"deploy/rollout children by
title or shape"* is forbidden, *"precisely so that a mislabel remains detectable in
`excludedChildIdentifiers`; a heuristic destroys that property."*

**That property is the ratified one and M2 preserves it exactly.** `parent_link_kind` is an explicit
declaration, its effect is recorded in `excludedChildIdentifiers`, and a wrong declaration is as
visible as a mislabel — more so, because §5 now surfaces the set on a successful close as well. M2
changes *where* the declaration lives (edge, not child) and *who owns the vocabulary* (a closed
server-side enum, not an open label namespace). The anti-heuristic rule is re-affirmed verbatim in
§9.1.

What M2 retires is only the implication that each newly-discovered procedural class earns a new
label. Four names is where the list stops.

---

## 8. The `merge_group` visibility hazard — shared invariant, separate owner

The card asks me to address this **only if** there is a shared control-plane invariant. There is, and
it is the one from §2.3:

> **A control must be observable at the surface where it is remediable.**

Both failures instantiate it:

- **Control plane.** Mechanism A/D refuses at the parent's close, where the parent has no lawful
  remedy, while the remediable surface — the edge write — accepted silently. M4 moves the refusal to
  the remediable surface.
- **CI.** Per SUP-17167's evidence, `paperclip-approved-enforcer` is **advisory** on `pull_request` —
  the surface every reader and every agent actually looks at, and the only surface where the PR is
  actionable — and **enforcing** only in `merge_group`, a surface nobody reads. The result was PR
  #3673 reading `mergeStateStatus: CLEAN` with zero failing checks while being unmergeable, dequeued
  by `github-merge-queue[bot]` ~80s after each enqueue, with the real failure buried in a `ci` job on
  a `gh-readonly-queue/…` branch.

**Scope.** I state the invariant; I do **not** specify the CI change. The enforcer lives in
`TEA-Core/Trading-Signal-Platform`, outside this card's assignment scope, and I have **not**
independently verified its workflow triggers — the `pull_request`-advisory / `merge_group`-enforcing
asymmetry above is reported from SUP-17167's evidence and is cited as the filer's, not mine. The TSP
CI child owns the change and owes the verification; this section is its **acceptance frame**, not its
design. Whatever it ships must make the refusal legible on `pull_request`.

---

## 9. Rejected alternatives

### 9.1 Title, description, or any shape heuristic — REJECTED

Matching `^Courier:`, `^Unblock`, "routing", or an empty-diff shape. Rejected, re-affirming
SUP-16586: a heuristic produces an exclusion **nobody declared and nobody can audit**, destroying the
`excludedChildIdentifiers` property that makes a misclassification detectable. It is also silently
bidirectional — a genuine work child titled "Courier integration for the ingest path" is silently
excluded, opening the gate ADR-072 exists to close. Do not add one, in any mechanism, at any layer.

### 9.2 Invert the default — count only children carrying a positive `work` marker — REJECTED

Fail-open in the direction that matters. An unmarked genuine decomposition child would stop counting,
and ADR-072 exists precisely to catch the case nobody thought to mark. The default must remain
`decomposition`.

### 9.3 Derive from the presence of a deliverable (`executionState.delivery`) — REJECTED

Attractive because it is server-owned and unforgeable, but it is another proxy with errors in both
directions. False positive: an unblock child that edits a guard file and runs `deliver.sh` has a
recorded head. False negative: a genuine work child whose slice landed inside a sibling's PR — the
carrier shape this company uses routinely — has none. Substituting a second false proxy for the first
repeats §2's mistake with extra steps.

### 9.4 Infer from `origin_kind` — REJECTED

`issues.origin_kind` is `text NOT NULL DEFAULT 'manual'` (`packages/db/src/schema/issues.ts:53`) — an
open string, supplied at create. Both SUP-16900 and SUP-16884 carry `manual`, as does every genuine
work child. It cannot separate two manually-filed cards, which is the entire question. The SUP-15451
narrowing that *does* use it — excluding platform-generated bookkeeping — is sound and is retained
unchanged; it simply does not reach relation 3.

### 9.5 Drop mechanism D, or raise the `>= 2` threshold — REJECTED

Both solve the symptom by removing the control. ADR-072's close ladder is ratified; SUP-14306 /
SUP-14309 / SUP-14023 / SUP-13777 are the reasons it exists. The threshold, the rung table, and the
ladder are explicitly out of scope of this ruling.

### 9.6 Fix only the remedy text — REJECTED as sufficient, ADOPTED as M3

Correcting §3.2 alone would make the deadlock *diagnosable* while leaving every courier card still
arming a gate. It is necessary and it is M3. It is not the fix.

---

## 10. Regression scenarios the implementation owes

Each must be shown **failing against the pre-change code**, with both outputs pasted. A test that
passes before the change pins nothing. `pnpm --filter server test` exits 0 running nothing — use a
target that actually executes the files.

**M1** (`server/src/services/done-transition-guard.test.ts`): a parent with one `work-type:process`
child and one ordinary laddered child counts **1**; the `done` PATCH is not refused; the process
child's identifier appears in `excludedChildIdentifiers`. All four names resolve in the **same single**
labels read — assert the query count, not just the outcome. The SUP-15878 route gap inherits it,
proven by a test that exercises **the route**, not by assuming the shared helper suffices.

**M2** (`done-transition-guard.test.ts` + a migration test): a child with
`parent_link_kind = 'process'` does not count and is recorded as excluded; a child with the column
defaulted counts, so every pre-migration row keeps today's meaning; a child carrying any of the four
carve-out labels does not count **regardless of the column** (back-compat); the re-parent PATCH
carries the kind, and a kind written at create survives a re-parent that does not restate it —
or is required to restate it, whichever the implementation chooses, but the choice must be pinned
by a test.

**M3** (`server/src/__tests__/done-transition-guard-decision-routes.test.ts`): a
**decision-carrying** close refused by mechanism D returns a remedy that (a) does **not** contain
"Merge the issue's pull request", and (b) names re-parenting/`process`; a true delivery/head refusal
on the same door **still does**. `details` carries the mechanism and `excludedChildIdentifiers`. A
close that **succeeds** with count 1-after-exclusions writes the audit row naming the excluded
identifiers.

**M4** (`server/src/__tests__/issue-execution-policy-routes.test.ts` or the issues-route suite): the
full SUP-16872 sequence — parent with an armed, advanced ladder (`completedStageIds` non-empty,
pointer on the approval stage) and one qualifying child; parent a **second** qualifying child;
**assert 409**, naming the parent and both resolutions, and assert `parent_id` on the child is
**unchanged**. Then the mirror: the same second edge against a parent whose pointer has **not**
advanced is **allowed**, and the ADR-072 ladder arms as designed — without this case M4 is a
wedge-maker. Then: an edge declared `process` is allowed in **both** states.

---

## 11. Implementation ownership

Implementation is out of scope for this ruling and is routed to coding children, filed **parentless**
per the SUP-16586 precedent so that the cards fixing this defect do not themselves become the
laddered children that trigger it.

| mechanism | specialist | blocked on |
|---|---|---|
| M1 — `work-type:process` carve-out | coder-BE | — |
| M3 — mechanism-faithful remedy + exclusion audit | coder-BE | — |
| M2a — `parent_link_kind` schema + migration | coder-DBE | — |
| M2b — route write + guard read | coder-BE | M2a |
| M4 — parent-edge write-time gate | coder-BE | M2b |
| CI — `paperclip/approved` legibility on `pull_request` | TSP CI child (§8) | — |

SUP-16872 is already repaired and is **not** reopened by any of the above.
