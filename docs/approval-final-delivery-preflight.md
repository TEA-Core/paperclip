# Final approval delivery preflight

SUP-19860 (AS-02) moves repository-delivery eligibility ahead of the terminal execution-stage decision. Earlier review/approval stages remain card-scoped: they advance normally and cannot publish `paperclip/approved` until every pre-merge stage is genuinely completed and the last decision is approved (see `doc/execution-semantics.md` for stage `phase`).

## Producer contract

Before committing a terminal approved decision, the issue routes reuse the delivery-owner resolver and decision-head resolver. Repository-backed cards must resolve exactly one owned delivery PR, then positively verify its live OPEN, unmerged, non-draft state, recorded repository/branch identity, and unchanged readable head. A cited foreign PR is not delivery. Issues default to `deliveryRequirement: repository_delivery`; only an authorized board or non-assignee actor may explicitly select `record_only`, which skips only this final open-PR preflight. Existing independent-review, full-ladder, done-transition, tier, and authorization guards remain in force.

A refusal returns HTTP 409 with `approval_final_delivery_preflight`, the underlying named reason, `deliveryOwnerIssueId`, and an actionable `remedy`. Draft delivery requires the owner to mark the PR ready and submit the final review again. Missing delivery requires that owner to provide the delivery receipt/PR. The stage stays pending: no approved decision, completion, approval stamp, or merge arm is committed.

All five terminal approval doors resolve the delivery verdict (bounded by a 20 s timeout) before their write transaction or interaction acceptance; no GitHub request runs under the issue-row lock. Under that lock, each compares the certified issue `status`/`updatedAt` and database delivery binding (repo context, delivery-branch ownership, recorded PR identity, and the certified PR's repo) against the preflight values. PATCH and approval-comment auto-close check before persisting the decision; final escalation acceptance checks and then records its decision in the interaction service's transaction, so a stale verdict leaves the interaction pending. For a PATCH that must release its own run first, the route verifies that no other issue field or delivery binding changed during that release, then takes one certificate from the post-release row before entering the transaction. It never re-anchors an existing certificate. Escalation acceptance defers its activity and post-commit actions until the interaction transaction commits. A changed certified card or binding returns HTTP 409 `approval_final_delivery_preflight_stale`; the stage stays pending with no approved decision, receipt publication, or merge arm, and the caller retries.

Agent mutation authorization can adopt a stale checkout into the request's live run before PATCH's first certificate. The pre-certificate guard permits only that exact run-link transition when the resulting issue timestamp equals its execution-lock timestamp; unrelated card or delivery changes still refuse. The locked guard compares the resulting certificate to the issue and binding at commit, including any later `updatedAt` change.

An approval comment that interrupts an active run reloads the issue after cancellation releases the run links and may update `updatedAt`. It evaluates the review stage and certifies delivery from that post-interrupt row. A later change during the external preflight still fails the locked recheck.

The check runs on the PATCH verdict, board stage-decision, auto-approval comment, recovery decision, and final escalation-accept routes. Repository-free doc/gate cards retain their existing close semantics. Sanctioned no-deliverable-head overrides remain subject to the existing done guard; they do not bypass ladder or tier requirements.

## Done-close draft safety

The done-transition guard includes linked drafts when checking Tier-1 `landing-delegated` declarations and decision-carried closes. An open draft is a named `head_draft` refusal, not an unlinked PR or an eligible merge-arming exemption; the owner must mark the PR ready before submitting the close again. Live discovery and PR-state hydration retain the draft flag, so an owned draft not yet mentioned on the card and a PR converted to draft after caching are both checked.

For older cards already closed `done` over a draft, the hourly done-close landing backstop parks the card `blocked` after its 24-hour grace with a board-owned action to mark the PR ready and republish approval at the ready head. Its draft audit row bounds duplicate comments, not the park: if the status update failed after logging, another sweep retries it before the 7-day discovery window expires. The carrier promotion sweep also keeps done parents (not cancelled ones) eligible for its three-day age-cap trigger while their carrier PR is still an open draft. These paths do not publish approval or arm a draft merge.

## Certification and publication

The decision transaction persists `executionState.approvalStatus.approvedHeadSha` and `finalDelivery` (`owner`, `repo`, `number`, `headSha`, `displayName`) from the preflight. Credentials are never persisted in that anchor. The post-commit hook uses this certification instead of certifying a later live head. `finalDelivery` is tagged with the decision id and every decision patch clears any prior-cycle `finalDelivery` first, so the hook only trusts a certification whose `decisionId` equals the card's `lastDecisionId`; a terminal approval that skips the preflight (sanctioned override accepted, repository-free) re-resolves the live head instead. The escalation-accept door mints its decision id inside the shared decision helper, so it re-tags the preflight certification with that id before running the hook. Publication remains delivery-identity-gated and pinned to both the reviewed SHA and repo/PR identity.

The GitHub PR head is externally owned: it is not re-read under the database row lock. If it moves between preflight and publication, the head-pinned publisher returns `status:skipped:head_moved`, writes no status on the new head, and suppresses merge arming. A separate design card covers recertifying the external head at the approval door. If publication instead resolves a different PR than the certified one (same-SHA sibling), it returns `status:skipped:delivery_moved` with the same no-status, no-arm result. The original approved-head anchor survives for the reconciler's existing Guard A content-identity check. Changed content needs fresh review; pending, cancelled, skipped, or incomplete ladders are not approval.

No ruleset, workflow, required context/app pin, override label, allowlist, or merge-authority hard stop changes. AS-03 consumes certified anchors; this change does not manufacture approval for an already-stranded card.

## Verification

The route suite also checks a successful no-recovery close after the assignee's stale checkout is adopted, and an outside timestamp mutation after that adoption but before approval persists.

The execution-decisions route suite covers final draft and missing-delivery refusals, successful independent final approval including own active-run cancellation, a post-preflight content push, mid-ladder advancement, repository-free close, and deterministic status/`updatedAt`, recorded PR identity, stage-transition and delivery-binding races before each of the three terminal decision transactions. A separate held-preflight case catches a timestamp change before PATCH certification. The race assertions check HTTP 409, pending stage, no decision or accepted interaction, unchanged delivery receipt, no approval publication, and no merge-arm request. Run the scoped suite directly:

```sh
pnpm --filter @paperclipai/server exec vitest run src/__tests__/issue-execution-decisions-routes.test.ts
pnpm typecheck
```

The root stable runner currently rejects the card's positional `pnpm test:run -- <file>` spelling; it is not an alias for Vitest's filename filter. Sandbox verification should inspect actual HTTP responses, persisted execution state/decision rows, and outbound status transport, not mock-returned expected execution state. Production/live exercise remains owner-gated.

The existing refusal suites also assert that a preflight 409 leaves the issue and decision rows unchanged, creates no comment, and sends no approval status. An ambiguity refusal replaces approval-time `pendingCandidates`/`skipReason` with candidate identities and the named owner/remedy in the refusal details. There is no successor certification timestamp: `approvalStatus` stays absent and `lastDecisionId`/`lastDecisionOutcome` stay null. The board-race regression requires one first-stage winner, no losing-request effects before retry, one decision/comment/audit per stage, and final state and wake targets equal to a sequential two-stage control. Existing system diagnostics are counted separately so duplicate comments cannot hide behind the retry.

## Rollback

Revert preflight commit + redeploy prior Paperclip build. Keep genuine pending decisions/anchors; no DB rewrite, no fabricated approval; owner handles stranded deliveries individually.
