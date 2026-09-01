# ADR-091 D5 — the delivery-identity gate stays closed across repos

**Status:** accepted (exec-CTO ruling, SUP-14733, 2026-09-01)
**Amends:** ADR-091 D1 (SUP-14676), D4 (fail-closed on unresolvable identity)
**Implemented by:** `server/src/services/merge-arming.ts` (`resolveDeliveryIdentity`,
`isDeliveredByCard`, `narrowToDelivered`, `resolveApprovalDecisionHead`)

## Decision

The control plane writes `paperclip/approved` onto a PR head **only** when that head's
repo AND head ref are the card's own delivery identity. A PR in a repo other than the
one the card's project is bound to is `not_delivered`, permanently and by design.
There is no cross-repo stamping path, and none will be added.

A deliverable that belongs in repo *B* must be filed under a project bound to repo *B*.
Filing it under a project bound to repo *A* and pushing to *B* is a filing defect, not a
gate defect.

## Why the gate is right

**1. Cross-repo delivery is not a shape the platform provisions.**

A card's delivery repo is structurally determined by its project and cannot be
overridden per-card:

- `assertValidProjectWorkspace` (`server/src/services/issues.ts`) rejects any
  `projectWorkspaceId` whose `projectId` differs from the card's:
  `"Project workspace must belong to the selected project"`.
- `resolveIssueRepoContext` (`server/src/services/merge-arming.ts`) resolves `repoUrl`
  from exactly one chain — execution workspace → project workspace → project primary
  workspace. Every link is inside one project.
- `parseIssueExecutionWorkspaceSettings`
  (`server/src/services/execution-workspace-policy.ts`) carries `mode`,
  `workspaceStrategy`, `environmentId`, `workspaceRuntime`, `networkEgress`,
  `sharedWorkspaceConcurrency` — and no repo or branch override. No field anywhere on an
  issue names a second repo.

So a PR whose head repo differs from the card's delivery repo was, by construction,
pushed from outside the card's sanctioned execution workspace. D1 is not failing to
model a supported shape; it is the only component that noticed an unsupported one.

**2. Branch-only matching would destroy the anti-laundering property.**

The delivery branch name is derived from the card's own title slug. It is public,
guessable, and creatable by anyone who can push a branch. The *repo* half of the tuple
is the only half the control plane provisions rather than the pusher choosing. If
`headRefName == deliveryBranch` alone authorized a stamp, any actor able to push
`SUP-NNNNN-<slug>` to any repo the control plane's token can reach would harvest that
card's approval as a `paperclip/approved` status. That is precisely the laundering D1
exists to block, re-opened one level up.

**3. Content identity does not rescue it either.**

Certifying the head by diff-vs-base against the approved head (the reconciler's Guard A
shape) proves *what* the diff is. It does not prove *that this card was authorized to
deliver into that repo*. Laundering is an authority question, not a content question, so
a content check cannot stand in for the identity tuple.

## Consequences

- Cross-repo deliverables are filed under a project bound to the deliverable repo.
  Where no such project exists, create one (a project workspace is one row) — do not
  route the delivery through a foreign card.
- A stranded cross-repo PR is **not** recoverable by hand-stamping, by an operator
  status write, or by merging around the `paperclip-approved-enforcer`. The reviewed
  content is re-delivered on a correctly-projected card's own branch as a fresh PR; the
  stranded PR is closed as superseded.
- The reconciler's Guard A fail-closed semantics are unchanged: no certified anchor, no
  write. The `not_delivered` branch continues to persist no `pendingCandidates`.
- **Filing a card into another project requires an explicit `projectWorkspaceId`.** A
  `POST /issues` that names a `projectId` outside the creating run's own project, and
  omits `projectWorkspaceId`, inherits the creating run's workspace and is rejected
  `422 "Project workspace must belong to the selected project"` — even though the target
  project has exactly one primary workspace that would have resolved. Observed while
  filing the SUP-14724 migration card. Pass the target project's primary
  `projectWorkspaceId` explicitly.

## Known cost, and what we fix instead

D1's refusal message reports a repo mismatch in branch language:

> `not_delivered: <owner>/<repo>#N head <owner>/<repo>:<branch> is not this card's
> delivery branch <branch>`

When the branch is character-identical and only the repo differs, that sentence reads as
self-contradictory and sends the reader hunting for a branch bug. That is what turned
SUP-14724 into a two-card escalation chain. The remedy is a better refusal, not a weaker
gate: when the branch matched and the repo did not, name the repo mismatch and the
remedy (file under a project bound to the head repo). Tracked as SUP-14734.

A filing-time guard that rejects a card whose intended deliverable repo differs from its
project repo is explicitly **out of scope**: the deliverable repo is not knowable at
filing time, so such a guard would be a prose heuristic on the issue body. The
delivery-time refusal is the correct enforcement point; it only needs to be legible.

## Precedent

SUP-14724 (`deliver.sh` push-landed guard) was filed in project *Paperclip*
(`TEA-Core/paperclip`) and delivered to `TEA-Core/paperclip-agent-tools` PR #361. The
company already had a *Paperclip Agent Tools* project bound to that repo. The card was
mis-projected; the gate reported it accurately. Recovery was re-delivery under the
correct project (SUP-14735), not a gate change.
