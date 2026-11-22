# Delivery identity

Approval delivery is bound to one verified pull request, not to a title, branch prefix, or arbitrary mention. The binding is stored in `executionState.delivery` and contains:

- `repo`: the GitHub owner and repository receiving the delivery
- `prNumber`: the exact pull request number
- `prUrl`: the canonical URL for that owner, repository, and number
- `branch`: the pull request head branch
- `headSha`: the reviewed pull request head commit
- `sourceIssueId`: the authorizing issue when present

A record made by `deliver.sh --bind-existing-pr` (AS-05) carries two branches: `branch` is the verified pull request head branch, and `cardBranch` — stamped by the server from the control plane, never client-supplied — is the card's own execution-workspace (or legitimate ADR-083 carrier) branch. Such a record is marked `kind: "as05_bound_pr"`; `kind` and `cardBranch` are server-owned, and the write schema rejects them if a client sends them. The two halves validate differently: ADR-091 D1 branch ownership applies to `cardBranch`; pull-request identity applies to `branch`. On an isolated-workspace card the pull request head is intentionally not the card's worktree branch, which is exactly why the two are recorded separately.

## Verification

Before approval status is published or merge arming proceeds, the server validates the binding against the live GitHub pull request:

1. The source issue, when recorded, must be the current authorizing issue.
2. `prUrl` must be the canonical URL for `repo` and `prNumber`.
3. The exact pull request must exist, be open, and not be a draft. Exception: a merged-only binding (a card with no execution workspace, or an ADR-083 carrier whose owner is already done/cancelled) must instead be merged and proven on the card's own control-plane base branch; an open PR is refused. See [Branch protection](branch-protection.md) for the write path and merged-only rule.
4. Its live head branch must equal `branch`.
5. Its live head SHA must equal `headSha`.
6. The pull request repository must equal the project's delivery repository, and so must its head repository: a fork-head PR is refused, and a merged-only binding also refuses an absent head repository.
7. For an AS-05 record, `cardBranch` must equal the card's control-plane delivery branch and that branch must be one the card may lawfully deliver on (ADR-091 D1); the same ownership gate runs at write time, where the server — not the client — derives it.
8. Cached linked-PR metadata is used only to preserve the GraphQL node ID; it does not replace live verification.

The write-time check (PATCH `/issues/:id` with `deliveryIdentity` carrying both `prNumber` and `prUrl`) runs the same shared verifiers — the static source-issue/canonical-URL validation and the exact live pull-request verification — so what is recorded is exactly what approval time will re-verify. This live write-time proof is the executor's entry-into-review contract; a board refresh on a card already `in_review` keeps its pre-AS-05 write rule for a both-fields record: the recorded `branch` is accepted by exact equality with the control-plane branch (or the merged-only board carve-outs), with no live write-time PR check and no AS-05 stamp — approval time re-verifies the binding as usual. A partial binding (exactly one of `prNumber`/`prUrl`) is refused on every write path, board refresh included. A non-canonical URL, a client `sourceIssueId` naming another issue, an illegitimate `cardBranch`, or any live mismatch (head branch, head SHA, draft, closed-unmerged) is refused with no write.

The exact pull request is selected by number and repository. Title text, issue-reference mentions, branch-only matches, PR URL prefixes, and the first or only same-branch candidate are not authoritative.

## Fail-closed cases

The operation remains unarmed when the binding is incomplete, malformed, cross-repository, source-issue mismatched, ambiguous, stale, moved, closed, merged (except a merged-only binding), replaced, draft, or unverifiable because no usable GitHub token is available. No approval status is written to a different PR, and no fallback resolution may authorize a merge for a bound card.

Cross-repository delivery remains unsupported by design. A deliverable must be filed under a project bound to its destination repository; recovery requires a fresh correctly projected delivery and review.

## Free-text merge constraints are non-binding

Delivery identity answers one question: **which pull request may be armed**. It does not decide whether a card may be armed at all, and it never reads the card's prose.

The approved policy (SUP-20293): a merge constraint written as free text — an issue description, a comment, a document, or any other prose, such as "do not enable auto-merge" or "wait for the board's merge word" — is **non-binding** for merge arming. Prose is not an actuator input: arming is keyed to delivery identity, pull-request ownership (the approving card named in the PR title or head branch), completed approval stages, and the company merge-arming setting. The card description is consulted only as a source of bare PR URLs when linking pull requests, and there is no per-card machine-readable merge opt-out field. A card whose description carries a contrary merge instruction is therefore still armed when its approval lands; that outcome follows the arming contract rather than deviating from it.

## Manual merges use an explicit gate

Work that must not be auto-merged cannot express that requirement in free text. The owner must establish an explicit path before final approval, using one of:

- an **operator/human-gate workflow** — the approval or merge step is held by a human or board-operated process, so a card approval does not arm auto-merge; or
- a **manual-merge card** — the card's deliverable is the merge action itself, performed by an operator after the required checks and review, instead of delivery of a pull request by an implementation card.

Board authority over a landing is exercised through these explicit surfaces, never through prose attached to an implementation card.

## Child-owned carrier attribution

A child card with its own self-sourced execution workspace may have its delivery carried by a strict ancestor's carrier pull request. The server then records a governed attribution row (`issue_child_carrier_attributions`) instead of an `as05_bound_pr` delivery. It is accepted only for the same repository, exactly one strict ancestor, one exact pull request, one carrier branch, one immutable head SHA, and a complete child-specific commit enumeration. A wrong ancestry, repository, pull request or branch, a moved head, a draft or closed pull request, a missing or extra commit, or multiple candidates is refused. A child that borrows the ancestor's workspace (ADR-083 shared carrier) is not diverted: it keeps the ordinary `as05_bound_pr` write.

Child approval records only the child's decision. It does not publish `paperclip/approved` and does not arm the carrier pull request. The self-sourced carrier owner stamps or arms only when every required child attribution is approved, current and complete. The child resolver and the owner publication predicate are separate (`server/src/services/child-carrier-attribution.ts`, `server/src/services/merge-arming.ts`).

The untrusted child claim must retain the canonical PR URL for its current
repository and exact PR number. Preflight, decision attachment and owner
publication each check that anchor. A missing or mismatched URL refuses;
record delivery again through the control plane. Recording a new child-carrier
claim removes an obsolete ordinary delivery binding.

Delivery-only attribution applies the same canonical URL anchor at preflight,
decision attachment and owner publication. It cannot reinterpret an older
receipt as a same-numbered pull request in another repository.

Canonical URL matching remains exact. A casing-only change to the control-plane
repository spelling can refuse an otherwise valid attribution. This is a known
fail-closed canonicalization limitation; this change does not add normalization.

## Authoritative flow

`resolveDeliveryIdentity` reads the recorded identity. `resolveExactBoundPullRequest` verifies the exact live PR and head. `narrowToDelivered` restricts candidates to that verified PR, while `publishApprovalStatus` and `armMergeOnApproval` reject any mismatch before writing approval status or arming merge. The decision-time head resolver uses the same exact binding so the approving card and the actuator target cannot diverge.
