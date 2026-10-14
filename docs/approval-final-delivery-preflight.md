# Final approval delivery preflight

SUP-19860 (AS-02) moves repository-delivery eligibility ahead of the terminal execution-stage decision. Earlier review/approval stages remain card-scoped: they advance normally and cannot publish `paperclip/approved` until every declared stage is genuinely completed and the final decision is approved.

## Producer contract

Before committing a terminal approved decision, the issue routes reuse the delivery-owner resolver and decision-head resolver. Repository-backed cards must resolve exactly one owned delivery PR, then positively verify its live OPEN, unmerged, non-draft state, recorded repository/branch identity, and unchanged readable head. A cited foreign PR is not delivery. Existing independent-review, full-ladder, done-transition, tier, and authorization guards remain in force.

A refusal returns HTTP 409 with `approval_final_delivery_preflight`, the underlying named reason, `deliveryOwnerIssueId`, and an actionable `remedy`. Draft delivery requires the owner to mark the PR ready and submit the final review again. Missing delivery requires that owner to provide the delivery receipt/PR. The stage stays pending: no approved decision, completion, approval stamp, or merge arm is committed.

The check runs on the PATCH verdict, board stage-decision, auto-approval comment, recovery decision, and final escalation-accept routes. Repository-free doc/gate cards retain their existing close semantics. Sanctioned no-deliverable-head overrides remain subject to the existing done guard; they do not bypass ladder or tier requirements.

## Certification and publication

The decision transaction persists `executionState.approvalStatus.approvedHeadSha` and `finalDelivery` (`owner`, `repo`, `number`, `headSha`, `displayName`) from the preflight. Credentials are never persisted in that anchor. The post-commit hook uses this certification instead of certifying a later live head. Publication remains delivery-identity-gated and pinned to both the reviewed SHA and repo/PR identity.

If the head moves between preflight and publication, the publisher returns `status:skipped:head_moved`, writes no status on the new head, and suppresses merge arming. The original approved-head anchor survives for the reconciler's existing Guard A content-identity check. Changed content needs fresh review; pending, cancelled, skipped, or incomplete ladders are not approval.

No ruleset, workflow, required context/app pin, override label, allowlist, or merge-authority hard stop changes. AS-03 consumes certified anchors; this change does not manufacture approval for an already-stranded card.

## Verification

The execution-decisions route suite covers final draft and missing-delivery refusals, successful independent final approval, a post-preflight content push, mid-ladder advancement, and repository-free close. Run the scoped suite directly:

```sh
pnpm --filter @paperclipai/server exec vitest run src/__tests__/issue-execution-decisions-routes.test.ts
pnpm typecheck
```

The root stable runner currently rejects the card's positional `pnpm test:run -- <file>` spelling; it is not an alias for Vitest's filename filter. Sandbox verification should inspect actual HTTP responses, persisted execution state/decision rows, and outbound status transport, not mock-returned expected execution state. Production/live exercise remains owner-gated.

## Rollback

Revert preflight commit + redeploy prior Paperclip build. Keep genuine pending decisions/anchors; no DB rewrite, no fabricated approval; owner handles stranded deliveries individually.
