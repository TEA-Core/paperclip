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

The head decision is durable before the external status write. If GitHub accepts the status but storing publication state subsequently fails, the API reports the failure and the decision audit remains; a database rollback must not erase the authorization for an already-written status. The `issue.approval_head_decision` row records the authorizer, not that publication applied: a refused publication (for example `delivery-receipt-missing` or a moved head) is visible only in the 409 response, and no publish-outcome audit record exists yet.

## Override label and the reconciler

A PR carrying `override:paperclip-approval` (see [branch protection](branch-protection.md#override-label-sup-20897)) clears the CI enforcer without a `paperclip/approved` status. The reconciler is unaffected: it reads and writes only the status, never the label, and an overridden PR gets no status. Do not publish one to "match" the override. If the control plane later approves the head, the stamp passes the enforcer on its own and the label is not consulted.

## Release-assurance control plane (shadow mode)

Release assurance (RA) gets its own approval seat and a distinct `release-assurance/approved` status, separate from the normal ladder and from `paperclip/approved` (SUP-20771). This slice ships the control plane in **shadow mode only**: decisions are recorded and visible, but nothing is admitted and no RA status is ever written to GitHub. The database can only express `publication_mode = 'shadow'`, so turning publication on is a deliberate later migration, not a flag.

- `release_assurance_events` is an append-only ledger. Its company and issue foreign keys have no delete policy, so deleting a card or company that still has ledger rows is refused with 409 and the audit trail is kept. The ledger is append-only in the database: UPDATE, DELETE and TRUNCATE are revoked from the serving role and UPDATE and DELETE are rejected by a trigger for every role, and the issue key is composite with the company so a row cannot pair an issue with another company. This holds against the serving role and ordinary SQL, not against a table owner or superuser: those can still change rows by disabling or dropping the trigger, by `session_replication_role = replica`, or by `TRUNCATE` (including `CASCADE`). Production must run the application as the restricted serving role. The enrolled RA seat is stored as a plain recorded id, not a foreign key, so it survives deletion of the agent. `hold` is the board enrollment of a card and its exact recorded-delivery PR and persists across head changes; `go` and `no_go` are decisions bound to one exact lowercase 40-hex head. A revocation is a `no_go` on that head. `(company_id, event_id)` is the idempotency key: an identical replay returns the recorded event, a different payload under the same event id is 409.
- `POST /api/issues/:issueId/release-assurance/enroll` (board owner/admin) records the HOLD. The PR must be the card's authoritative recorded delivery: repository, branch and PR number come from the recorded delivery identity (`executionState.delivery`), which the delivery-identity resolver cross-checks against the card's project repository and control-plane delivery branch, and its PR url must name the same GitHub repository and number. A repository changed after the delivery was recorded, a branch that is not the card's, or a PR that is only mentioned in a comment, title or document never binds. The PR must also be open, not merged and not a draft, read through the same warm-cache-only reader as decisions (a cold cache refuses). The binding is re-checked under the issue lock that appends the HOLD, so a delivery that changes mid-request records nothing. `raAgentId` must be an agent of the company. An identical replay answers from the ledger even if the delivery record or seat has since changed. It installs no execution policy.
- `POST /api/issues/:issueId/release-decisions` (board owner/admin) records a GO (with `evidenceDigest` and `ciRunIds`) or NO-GO. The card must be enrolled and `headSha` must equal the live PR head, otherwise 409; a head with a recorded NO-GO rejects any GO. A GO is also refused on a draft PR and when the card's recorded delivery no longer matches the enrolled PR (checked under the issue lock); a NO-GO stays recordable on the enrolled PR. Shadow mode makes zero external writes, so the live head is read with an already-warm cached GitHub App token only: it never reads a secret, mints a token or touches the database. With a cold cache the decision is refused with 409 and the HOLD stays recorded. The response carries `publication: { kind: "shadow", planned }`, the status a later slice would write.
- `GET /api/issues/:issueId/release-decisions` returns the events and the durable per-head verdict: `not_enrolled`, `held`, `go` or `no_go`. A NO-GO beats a GO on the same head whatever order they arrived in.
- `executionPolicy.approvalAuthority: "release_assurance"` is accepted by the schema but refused by `normalizeIssueExecutionPolicy` unless a trusted caller passes `allowReleaseAssuranceAuthority`, so no issue create or PATCH can select it. Even then the policy must be exactly one `approval` stage with exactly one `agent` participant; any other shape is 422. `buildReleaseAssurancePolicy` is the one-stage `approval` template (only the RA seat); it is not installed yet.

Not in this slice: issuer-signature verification and key registry, the `tea-core` publisher and required `release-assurance/go` check, rulesets, repository webhooks, installing the policy on a card, the approval-versus-close separation and decomposed-parent shape, and the exclusion of RA cards from the normal publisher. Those are the later rollout steps and need their own approvals.
