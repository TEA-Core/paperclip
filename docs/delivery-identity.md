# Delivery identity

Approval delivery is bound to one verified pull request, not to a title, branch prefix, or arbitrary mention. The binding is stored in `executionState.delivery` and contains:

- `repo`: the GitHub owner and repository receiving the delivery
- `prNumber`: the exact pull request number
- `prUrl`: the canonical URL for that owner, repository, and number
- `branch`: the pull request head branch
- `headSha`: the reviewed pull request head commit
- `sourceIssueId`: the authorizing issue when present

## Verification

Before approval status is published or merge arming proceeds, the server validates the binding against the live GitHub pull request:

1. The source issue, when recorded, must be the current authorizing issue.
2. `prUrl` must be the canonical URL for `repo` and `prNumber`.
3. The exact pull request must exist, be open, and not be a draft.
4. Its live head branch must equal `branch`.
5. Its live head SHA must equal `headSha`.
6. The pull request repository must equal the project's delivery repository.
7. Cached linked-PR metadata is used only to preserve the GraphQL node ID; it does not replace live verification.

The exact pull request is selected by number and repository. Title text, issue-reference mentions, branch-only matches, PR URL prefixes, and the first or only same-branch candidate are not authoritative.

## Fail-closed cases

The operation remains unarmed when the binding is incomplete, malformed, cross-repository, source-issue mismatched, ambiguous, stale, moved, closed, merged, replaced, draft, or unverifiable because no usable GitHub token is available. No approval status is written to a different PR, and no fallback resolution may authorize a merge for a bound card.

Cross-repository delivery remains unsupported by design. A deliverable must be filed under a project bound to its destination repository; recovery requires a fresh correctly projected delivery and review.

## Authoritative flow

`resolveDeliveryIdentity` reads the recorded identity. `resolveExactBoundPullRequest` verifies the exact live PR and head. `narrowToDelivered` restricts candidates to that verified PR, while `publishApprovalStatus` and `armMergeOnApproval` reject any mismatch before writing approval status or arming merge. The decision-time head resolver uses the same exact binding so the approving card and the actuator target cannot diverge.
