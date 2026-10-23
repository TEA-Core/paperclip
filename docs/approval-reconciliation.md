# Approval-status reconciliation

The approval-status reconciler repairs terminally approved cards whose `paperclip/approved` status was not published or was lost after the approval decision.

## Candidate admission

A candidate must have a terminal approved ladder and a persisted approval anchor. Linked GitHub pull requests are normally admitted only when their cached snapshot is open and non-draft. A cached `draft: true` snapshot is also admitted when `executionState.approvalStatus.approvedHeadSha` or `executionState.approvalStatus.publishedHeadSha` is a non-empty string. That exception is only a reachability recovery path: cached metadata is not authoritative for the current PR state.

## Live validation

For every candidate, the reconciler reads the pull request from GitHub before checking the commit status or publishing anything. The live response is authoritative for state, merge status, head SHA, and draft state. A live draft PR is refused with no status write, even when the cached snapshot is stale or an approved head anchor exists.

The live head must equal the certified head, or Guard A must positively prove content identity. It accepts unchanged PR-diff blobs (including an approved subset absorbed into the base), identical commit trees, or identical complete per-file patches with only hunk positions changed. Patch identity preserves significant whitespace, filenames, and change metadata; missing/binary/truncated patches are not patch proof. Compare lists at GitHub's 300-file cap are incomplete and cannot prove equivalence. Substantive changes still refuse automatic publication.

The delegated publish pins the exact PR and expected head. For a certified head change, only the head component of a recorded delivery binding is superseded: its repository, branch, source card, and PR number remain enforced. The delivery receipt is waived only when the decision carries a certified `finalDelivery` naming that same PR (the explicit decision pins `expectedPr` to it); a card without a matching certified `finalDelivery` still needs an exact-head delivery receipt, and a missing one refuses with `delivery-receipt-missing`. A further push before the publisher's head read refuses instead of stamping another head.

## Idempotency and failure behavior

The reconciler first checks the live commit status. An existing successful `paperclip/approved` status is treated as already repaired and is not published again. Missing or failed GitHub reads are recorded as failures and retried by a later tick; uncertain validation never publishes.

The recovery path preserves the existing scan cap, cursor, per-head behavior, delivery-identity checks, ladder guards, and merge-arming rules. It does not reopen review, alter approval content, or create a local GitHub status.

## Reviewing a changed head after completion

The completed ladder is not reopened. Use these company-scoped control-plane APIs:

- `GET /api/issues/:issueId/merge-arming/head-review` returns the certified head, live head, Guard A delta, approved/live file records and patches, and a compare link. This is read-only.
- `POST /api/issues/:issueId/merge-arming/approve-head` records a separate head decision and publishes `paperclip/approved` for exactly the submitted head:

  ```json
  {
    "approvedHeadSha": "<40-character certified SHA from the preview>",
    "headSha": "<40-character live SHA from the preview>",
    "reason": "Reviewed the post-ladder delta and its verification"
  }
  ```

Both APIs require board owner/admin authority (including trusted-local/instance-admin board context). All agent actors are refused before issue lookup or GitHub access, including the original reviewer. Being the author, assignee, a reviewer, or a user with ordinary membership grants no head-approval authority.

The card must be `done`, every declared stage completed, the last decision approved, and Guard B stage integrity intact. Missing anchors, unverifiable deltas, non-open/draft PRs, stale preview anchors, moved heads, foreign delivery identities, and unauthorized actors refuse without a status write. The response includes the reviewed delta and publication outcome. The activity event `issue.approval_head_decision` records the actor, previous and requested heads, PR, reason, and Guard A summary before publication; audit failure prevents the write. Successful publication updates only `executionState.approvalStatus`, preserving the card status, ladder, and stage decisions.

### Head-bound merge release (SUP-20772)

A card-bound PR whose card cannot be stamped (no ladder, a receipt that cannot exist, a head the ladder never saw) is released by a board owner/admin, not by a waiver line:

- `POST /api/issues/:issueId/merge-arming/release` with `{ "headSha": "<40-character live SHA>", "reason": "..." }` publishes `paperclip/approved` with the control-plane `tea-core` App installation token and no other credential (so the `tea-core[bot]` creator check in `scripts/ci/check-paperclip-approved.sh` accepts it). Unlike other stamps there is no PAT, project-env or fleet fallback: with no App credential the route answers 409 `failed` and makes no GitHub call with the description `released by <actorType>:<actorId> for <sha>: <reason>`, cut to GitHub's 140 characters.
- The target is the PR in the card's verified delivery identity (`executionState.delivery`: project repo, control-plane delivery branch, PR number and URL). A PR that is only cited on the card is never a target; a card with no verified binding answers 409 before any GitHub access. The PR must be open, not a draft, still on the bound branch, and `headSha` must be its live head. A different or stale head, or a moved branch, answers 409 with no write. Agent actors and board members who are not owner/admin are refused before any GitHub access. The card's ladder is not consulted.
- Idempotent: a head whose newest `paperclip/approved` is a success created by the control plane answers 200 `already_approved` with no second write or activity row. A success from any other creator, or a newer non-success, does not count: the release is published and logged as normal. The intent is recorded as `issue.merge_release_requested` before anything is written to GitHub (if that insert fails, nothing is published). The outcome follows: `issue.merge_release` for a fresh write, `issue.merge_release_outcome` (with `outcome` and `message`) for a refusal, a failure or an already-approved answer. If only the outcome insert fails, the status is still out, the response still reports it, the error is logged, and the intent row names who released which head.
- The status is keyed by SHA, so a push after the release gets no stamp; release the new head.
- A "release-assurance seat" has no server identity today, so the route is board-only. A seat that needs it acts through the board token.

The head decision is durable before the external status write. If GitHub accepts the status but storing publication state subsequently fails, the API reports the failure and the decision audit remains; a database rollback must not erase the authorization for an already-written status. The `issue.approval_head_decision` row records the authorizer, not that publication applied: a refused publication (for example `delivery-receipt-missing` or a moved head) is visible only in the 409 response, and no publish-outcome audit record exists yet.

## Override label and the reconciler

A PR carrying `override:paperclip-approval` (see [branch protection](branch-protection.md#override-label-sup-20897)) clears the CI enforcer without a `paperclip/approved` status. The reconciler is unaffected: it reads and writes only the status, never the label, and an overridden PR gets no status. Do not publish one to "match" the override. If the control plane later approves the head, the stamp passes the enforcer on its own and the label is not consulted.
