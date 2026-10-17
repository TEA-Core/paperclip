# Approval-status reconciliation

The approval-status reconciler repairs terminally approved cards whose `paperclip/approved` status was not published or was lost after the approval decision.

## Candidate admission

A candidate must have a terminal approved ladder and a persisted approval anchor. Linked GitHub pull requests are normally admitted only when their cached snapshot is open and non-draft. A cached `draft: true` snapshot is also admitted when `executionState.approvalStatus.approvedHeadSha` or `executionState.approvalStatus.publishedHeadSha` is a non-empty string. That exception is only a reachability recovery path: cached metadata is not authoritative for the current PR state.

## Live validation

For every candidate, the reconciler reads the pull request from GitHub before checking the commit status or publishing anything. The live response is authoritative for state, merge status, head SHA, and draft state. A live draft PR is refused with no status write, even when the cached snapshot is stale or an approved head anchor exists.

The live head must equal the certified head, or Guard A must positively prove that the diff-vs-base is unchanged from the certified head. The delegated publish also uses the expected-head compare-and-swap guard. These checks prevent a recovered status from authorizing an unreviewed head.

## Idempotency and failure behavior

The reconciler first checks the live commit status. An existing successful `paperclip/approved` status is treated as already repaired and is not published again. Missing or failed GitHub reads are recorded as failures and retried by a later tick; uncertain validation never publishes.

The recovery path preserves the existing scan cap, cursor, per-head behavior, delivery-identity checks, ladder guards, and merge-arming rules. It does not reopen review, alter approval content, or create a local GitHub status.
