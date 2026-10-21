# Approval-status reconciliation

The approval-status reconciler repairs terminally approved cards whose `paperclip/approved` status was not published or was lost after the approval decision.

## Candidate admission

A candidate must have a terminal approved ladder and a persisted approval anchor. Linked GitHub pull requests are normally admitted only when their cached snapshot is open and non-draft. A cached `draft: true` snapshot is also admitted when `executionState.approvalStatus.approvedHeadSha` or `executionState.approvalStatus.publishedHeadSha` is a non-empty string. That exception is only a reachability recovery path: cached metadata is not authoritative for the current PR state.

## Live validation

For every candidate, the reconciler reads the pull request from GitHub before checking the commit status or publishing anything. The live response is authoritative for state, merge status, head SHA, and draft state. A live draft PR is refused with no status write, even when the cached snapshot is stale or an approved head anchor exists.

The live head must equal the certified head, or Guard A must positively prove content identity. It accepts unchanged PR-diff blobs (including an approved subset absorbed into the base), identical commit trees, or identical complete per-file patches with only hunk positions changed. Patch identity preserves significant whitespace, filenames, and change metadata; missing/binary/truncated patches are not patch proof. Compare lists at GitHub's 300-file cap are incomplete and cannot prove equivalence. Substantive changes still refuse automatic publication.

The delegated publish pins the exact PR and expected head. For a certified head change, only the head component of a recorded delivery binding is superseded: its repository, branch, source card, and PR number remain enforced. This new head authorization supersedes a recovery receipt for an older head; ordinary publications still enforce existing receipt authorization. A further push before the publisher's head read refuses instead of stamping another head.

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

Both APIs require board owner/admin authority (including trusted-local/instance-admin board context) or the original user/agent holding the latest approving decision on a completed review/approval stage. Being the author, assignee, a same-company agent, or a user with ordinary membership is not enough. A release-assurance reviewer uses this surface when it holds that recorded review authority; arbitrary role names grant nothing.

The card must be `done`, every declared stage completed, the last decision approved, and Guard B stage integrity intact. Missing anchors, unverifiable deltas, non-open/draft PRs, stale preview anchors, moved heads, foreign delivery identities, and unauthorized actors refuse without a status write. The response includes the reviewed delta and publication outcome. The activity event `issue.approval_head_decision` records the actor, previous and requested heads, PR, reason, and Guard A summary before publication; audit failure prevents the write. Successful publication updates only `executionState.approvalStatus`, preserving the card status, ladder, and stage decisions.

