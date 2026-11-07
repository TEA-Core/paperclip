# Execution Policy: Review & Approval Workflows

Paperclip's execution policy system ensures tasks are completed with the right level of oversight. Instead of relying on agents to remember to hand off work for review, the **runtime enforces** review and approval stages automatically.

## Overview

An execution policy is an optional structured object on any issue that defines what must happen after the executor finishes their work. It supports three layers of enforcement:

| Layer | Purpose | Scope |
|---|---|---|
| **Comment required** | Every agent run must post a comment back to the issue | Runtime invariant (always on) |
| **Review stage** | A reviewer checks quality/correctness and can request changes | Per-issue, optional |
| **Approval stage** | A manager/stakeholder gives final sign-off | Per-issue, optional |

These layers compose. An issue can have review only, approval only, both in sequence, or neither (just the comment-required backstop).

## Data Model

### Execution Policy (issue field: `executionPolicy`)

```ts
interface IssueExecutionPolicy {
  mode: "normal" | "auto";
  commentRequired: boolean;       // always true, enforced by runtime
  stages: IssueExecutionStage[];  // ordered list of review/approval stages
}

interface IssueExecutionStage {
  id: string;                                 // auto-generated UUID
  type: "review" | "approval";                // stage kind
  phase?: "pre_merge" | "post_merge";         // default pre_merge; see doc/execution-semantics.md
  approvalsNeeded: 1;                         // multi-approval is not supported yet
  participants: IssueExecutionStageParticipant[];
}

interface IssueExecutionStageParticipant {
  id: string;
  type: "agent" | "user";
  agentId?: string | null;    // set when type is "agent"
  userId?: string | null;     // set when type is "user"
}
```

Participants can be either agents or board users. Each stage can have multiple participants; the runtime selects the first eligible participant, preferring any explicitly requested assignee while excluding the original executor.

Saving reviewers or approvers retains the existing order of the stage types.
Newly added stage types follow the retained stages.

### Execution State (issue field: `executionState`)

Tracks where the issue currently sits in its policy workflow:

```ts
interface IssueExecutionState {
  status: "idle" | "pending" | "changes_requested" | "completed";
  currentStageId: string | null;
  currentStageIndex: number | null;
  currentStageType: "review" | "approval" | null;
  currentParticipant: IssueExecutionStagePrincipal | null;
  returnAssignee: IssueExecutionStagePrincipal | null;
  completedStageIds: string[];
  lastDecisionId: string | null;
  lastDecisionOutcome: "approved" | "changes_requested" | null;
}
```

### Execution Decisions (table: `issue_execution_decisions`)

An audit trail of every review/approval action:

```ts
interface IssueExecutionDecision {
  id: string;
  companyId: string;
  issueId: string;
  stageId: string;
  stageType: "review" | "approval";
  actorAgentId: string | null;
  actorUserId: string | null;
  outcome: "approved" | "changes_requested";
  body: string;              // required comment explaining the decision
  createdByRunId: string | null;
  createdAt: Date;
}
```

## Workflow

### Happy Path: Review + Approval

```
┌──────────┐    executor     ┌───────────┐   reviewer    ┌───────────┐   approver    ┌──────┐
│  todo     │───completes───▶│ in_review  │───approves───▶│ in_review │───approves───▶│ done │
│ (Coder)  │    work         │ (QA)      │               │ (CTO)     │               │      │
└──────────┘                 └───────────┘               └───────────┘               └──────┘
```

1. **Issue created** with `executionPolicy` specifying a review stage (e.g., QA) and an approval stage (e.g., CTO).
2. **Executor works** on the issue in `in_progress` status.
3. **Executor transitions to `done`** — the runtime intercepts this:
   - Status changes to `in_review` (not `done`)
   - Issue is reassigned to the first reviewer
   - `executionState` enters `pending` on the review stage
4. **Reviewer reviews** and transitions to `done` with a comment:
   - A decision record is created: `{ outcome: "approved" }`
   - Issue stays `in_review`, reassigned to the approver
   - `executionState` advances to the approval stage
5. **Approver approves** and transitions to `done` with a comment:
   - A decision record is created: `{ outcome: "approved" }`
   - `executionState.status` becomes `completed`
   - Issue reaches actual `done` status

### Changes Requested Flow

```
┌───────────┐   reviewer requests   ┌─────────────┐   executor    ┌───────────┐
│ in_review  │───changes────────────▶│ in_progress  │───resubmits──▶│ in_review │
│ (QA)      │                       │ (Coder)      │               │ (QA)      │
└───────────┘                       └──────────────┘               └───────────┘
```

1. **Reviewer requests changes** by transitioning to any status other than `done` (typically `in_progress`), with a comment explaining what needs to change.
2. Runtime automatically:
   - Sets status to `in_progress`
   - Reassigns to the original executor (stored in `returnAssignee`)
   - Sets `executionState.status` to `changes_requested`
3. **Executor makes changes** and transitions to `done` again.
4. Runtime routes back to the **same review stage** (not the beginning), with the same reviewer.
5. This loop continues until the reviewer approves.

### Round Ceiling and Stall Escalation

Consecutive agent `changes_requested` decisions on one stage are counted in `executionState.changesRequestedCount`; a human decision resets the count. When the count reaches the round ceiling, the stage stays pending and is handed to the issue's responsible human instead of the implementer. The ceiling is `maxReviewRounds` when set; otherwise **10** for a policy that carries `stallEscalation` and **3** for a policy that does not, so the raised ceiling never applies without a stall arbiter.

A loop that stops making progress is caught earlier by the optional `stallEscalation`:

```json
{
  "stages": [
    { "type": "review", "participants": [{ "type": "agent", "agentId": "code-reviewer-agent-id" }] }
  ],
  "stallEscalation": { "afterRounds": 2, "toAgentId": "arbiter-agent-id" }
}
```

- On an agent `changes_requested` decision on a **review** stage, once the round count reaches `afterRounds`, the runtime checks for a stall signal:
  - **same head re-bounced**: the head delivered for this round (`executionState.deliveredHeadSha`, recorded from `deliveryIdentity.headSha` on the `in_review` transition) is the head the previous decision already bounced (`executionState.bouncedHeadSha`). `deliveryIdentity.headSha` must be a full git commit sha (40 or 64 hex digits, either case; surrounding whitespace is trimmed); a delivery that records no head, or a stored value that is not a full sha, never counts as the same head. The head is recorded only for a policy that carries `stallEscalation`; a policy without it keeps its execution state unchanged. Every delivery write, on any card with or without `stallEscalation`, now refuses a `deliveryIdentity.headSha` that is not a full git sha (40 or 64 hex digits) with 400; this is a deliberate contract tightening required by the R20 release-assurance grade.
  - **code acceptable**: the reviewer's decision comment has a line that is exactly `Code acceptable: yes` (case-insensitive; it may be a list item or quote and may bold the key or the answer), meaning the remaining finding is not something the implementer can change. Prose that mentions the phrase, a line that adds text after `yes`, or a marker line inside a fenced code block (```` ``` ```` or `~~~`) does not count.
- With a stall signal, the stage stays pending on the same issue and is handed once to `toAgentId` (recorded in `executionState.stallHandoff` and as an `issue.review_stall_escalated` activity, both in the transaction that records the reviewer's decision). The reviewer's decision is still recorded and the round count keeps running, so the ceiling still escalates to the human afterwards. On a card whose policy carries `stallEscalation`, every stage decision (with or without a stall signal) re-reads the issue under its row lock. When another decision was recorded or a hand-off record appeared since the request read the card, the request gets `409 review_stall_handoff_conflict`, so concurrent decisions are serialised and a plain bounce can never erase a hand-off. When the delivered head (`executionState.deliveredHeadSha`), the round ceiling, the stall policy or the stages changed since the read, the request gets `409 review_stall_policy_changed`, so a decision computed against a refreshed delivery or a lowered ceiling is never recorded. Either refusal writes no decision row, hand-off record or stage state.
- Every execution decision written by `PATCH /api/issues/:id`, by an approval comment (`## Review: APPROVED`) on `POST /api/issues/:id/comments`, or by accepting or rejecting a review round-cap escalation (`POST /api/issues/:id/interactions/:interactionId/accept` and `.../reject`), including one on a plain card that has neither `stallEscalation` nor a hand-off record, re-reads the issue under its row lock before the decision is written. When the round ceiling or any other stall-hold control, `executionState.currentStageId`, `executionState.currentParticipant` (agent ids compared case-insensitively; user ids compared case-sensitively), `executionState.delivery.prNumber`, `delivery.prUrl` or `delivery.headSha`, `executionState.deliveredHeadSha`, `executionState.lastDecisionId`, `executionState.changesRequestedCount` (a decrease is refused the same way as an increase), or the issue status differs from the snapshot the decision was computed from, the request gets `409 review_stall_policy_changed`. The refused request writes no decision row, comment, status change, wake or thread-interaction resolution (on the comment door that includes the comment itself; on the escalation accept and reject doors the decision commits in the interaction's own transaction, so the interaction stays pending and can be retried after re-reading the card). On `PATCH /api/issues/:id`, a decision that would reassign or close the card stops the current assignee's runner goal and cancels that assignee's active run only after this lock-time compare has passed. The stop polls for up to 30 seconds, so it cannot run while the issue row lock is held: the route compares, releases the lock, stops, then compares again inside the write transaction. A refusal whose snapshot is already stale at the first compare does not stop the goal or cancel the run. A snapshot that moves after that compare passes and before the write locks the row is still refused, and the stop authorized by the first compare is not rolled back. The shared final-delivery preflight folds agent-id case on every door that runs it (`PATCH /api/issues/:id`, the board stage decision, recovery resolution, the escalation accept and the approval comment): when it compares the execution policy it read before the external check with the policy under the row lock, agent ids in the stage participant lists and `stallEscalation.toAgentId` compare case-insensitively. The `PATCH` pre-certificate card compare folds the seated participant's agent id the same way. User ids stay case-sensitive, and assignee-column ids are not folded. A case-only rewrite of an agent id is therefore the same agent; a user id that differs only in letter case is a different principal and is refused with `409`. The board `interrupt: true` option on `PATCH /api/issues/:id` and on the comment door is a separate path: it cancels the active run on an explicit board instruction before any execution-decision compare, so a board decision sent with `interrupt` and a stale snapshot cancels the run and then answers `409`. That behavior is unchanged and out of scope here. The done-guard preflight audit rows that run before the lock (`issue.done_transition_guard_skipped` and `issue.done_tier_declaration_skipped`) may remain on every door; they are not part of the decision. A same-head refresh that adds only the pull-request number, or only the pull-request URL, is refused the same way. The hand-off conflict (`409 review_stall_handoff_conflict`) stays limited to stall cards.
- The arbiter **advises only**: it can request changes with a directive (the issue returns to the implementer and the next delivery goes back to the stage reviewer) or park the issue `blocked`. An approval by the agent the stage-run's hand-off record names is refused (`422 stall_arbiter_cannot_approve`), even if a later policy edit lists it on the stage or names another arbiter.
- While it holds the stage, the arbiter may not write the issue's `executionPolicy` or `reviewPolicy` at all (stages, participants, ceiling, `stallEscalation`, or any other policy field): such a PATCH is refused with `403 stall_arbiter_policy_edit_refused` before the body is validated, so a malformed policy body gets the same refusal. A board operator owns policy changes during the hold.
- A stage-run is handed to the arbiter at most once. The arbiter is never the issue's return assignee or delivery author, and never a review-stage participant. Agent ids are compared case-insensitively and `toAgentId` is stored lowercase.
- An arbiter that cannot take work when the stall happens (paused, terminated, pending approval, or no longer in the company) gets no hand-off: the round falls through to the ordinary ceiling behaviour.
- Validation: `afterRounds` is a positive integer no greater than the round ceiling (10 unless `maxReviewRounds` is set); `toAgentId` must be an assignable agent in the issue's company and not paused when the policy write names it; routine dispatch re-applies the routine's stored policy without that availability check, so a routine whose arbiter was paused after it was saved still creates its card (the hand-off then falls back to the ceiling). At `afterRounds` equal to the ceiling, a responsible human receives the stage first; the arbiter acts at that round only when the issue has no responsible human. Without `stallEscalation` the loop keeps the ceiling of 3.
- Known limitation (SUP-23065): `stallEscalation` is an API-only policy field, like `maxReviewRounds`, `returnAssigneeAgentId` and `baseRef`. A board UI policy edit (reviewer change, monitor) and a PATCH that sends only `stages` replace the stored policy and drop the field. The card then returns to the ceiling of 3 with the human escalation; the required reviewer is never skipped. Set and maintain the field through the API until the follow-up keeps it across these edits.
- Rollback: a plain binary revert is unsafe. With the pre-R20 code a card whose stored policy carries `stallEscalation` still reads (`GET` 200), but its title, comment and stages PATCHes return 422 until the new code is back, because the old policy schema is strict and rejects the key; a policy replacement through the old API cannot clear it either. Before reverting the build, remove the field with this migration-free cleanup, in one transaction against the instance database:

  ```sql
  BEGIN;
  UPDATE issues SET execution_policy = execution_policy - 'stallEscalation' WHERE execution_policy ? 'stallEscalation';
  UPDATE projects SET default_execution_policy = default_execution_policy - 'stallEscalation' WHERE default_execution_policy ? 'stallEscalation';
  UPDATE companies SET default_execution_policy = default_execution_policy - 'stallEscalation' WHERE default_execution_policy ? 'stallEscalation';
  UPDATE routines SET execution_policy = execution_policy - 'stallEscalation' WHERE execution_policy ? 'stallEscalation';
  UPDATE routine_revisions SET snapshot = snapshot #- '{routine,executionPolicy,stallEscalation}' WHERE snapshot #> '{routine,executionPolicy}' ? 'stallEscalation';
  COMMIT;
  ```

  Then confirm each `SELECT count(*) FROM <table> WHERE <column> ? 'stallEscalation'` (and `snapshot #> '{routine,executionPolicy}' ? 'stallEscalation'` for `routine_revisions`) returns 0, and only then revert the build. A card held by its arbiter goes back to a configured reviewer on its next transition under either build. The execution-state keys (`deliveredHeadSha`, `bouncedHeadSha`, `stallHandoff`) need no cleanup: the pre-R20 state schema drops unknown keys.

### Policy Variants

**Review only** (no approval stage):
```json
{
  "stages": [
    { "type": "review", "participants": [{ "type": "agent", "agentId": "qa-agent-id" }] }
  ]
}
```
Executor finishes → reviewer approves → done.

**Approval only** (no review stage):
```json
{
  "stages": [
    { "type": "approval", "participants": [{ "type": "user", "userId": "manager-user-id" }] }
  ]
}
```
Executor finishes → approver signs off → done.

**Multiple reviewers/approvers:**
Each stage supports multiple participants. The runtime selects one to act, excluding the original executor to prevent self-review.

## Comment Required Backstop

Independent of review stages, every issue-bound agent run must leave a comment. This is enforced at the runtime level:

1. **Run completes** — runtime checks if the agent posted a comment for this run.
2. **If no comment**: `issueCommentStatus` is set to `retry_queued`, and the agent is woken once more with reason `missing_issue_comment`.
3. **If still no comment after retry**: `issueCommentStatus` is set to `retry_exhausted`. No further retries. The failure is recorded.
4. **If comment posted**: `issueCommentStatus` is set to `satisfied` and linked to the comment ID.

This prevents silent completions where an agent finishes work but leaves no trace of what happened.

### Run-level tracking fields

| Field | Description |
|---|---|
| `issueCommentStatus` | `satisfied`, `retry_queued`, or `retry_exhausted` |
| `issueCommentSatisfiedByCommentId` | Links to the comment that fulfilled the requirement |
| `issueCommentRetryQueuedAt` | Timestamp when the retry wake was scheduled |

## Access Control

- Only the **active reviewer/approver** (the `currentParticipant` in execution state) can advance or reject the current stage.
- Non-participants who attempt to transition the issue receive a `422 Unprocessable Entity` error.
- Both approvals and change requests **require a comment** — empty or whitespace-only comments are rejected.
- The decision comment must be included in the same `PATCH /api/issues/{issueId}` request that changes the status. A prior `POST /api/issues/{issueId}/comments` entry remains normal discussion and does not satisfy the review/approval decision guard.

## API Usage

### Recording review or approval decisions

```bash
PATCH /api/issues/{issueId}
{ "status": "done", "comment": "Reviewer decision: approve - implementation and tests look good." }
```

To request changes, send the target non-`done` status and the explanation together:

```bash
PATCH /api/issues/{issueId}
{ "status": "in_progress", "comment": "Reviewer decision: request changes - cover the retry edge case." }
```

Do not split a decision into `POST /comments` followed by a status-only `PATCH`; the runtime only records the decision from the `comment` field on the same status update.

### Setting an execution policy on issue creation

```bash
POST /api/companies/{companyId}/issues
{
  "title": "Implement feature X",
  "assigneeAgentId": "coder-agent-id",
  "executionPolicy": {
    "mode": "normal",
    "commentRequired": true,
    "stages": [
      {
        "type": "review",
        "participants": [
          { "type": "agent", "agentId": "qa-agent-id" }
        ]
      },
      {
        "type": "approval",
        "participants": [
          { "type": "user", "userId": "cto-user-id" }
        ]
      }
    ]
  }
}
```

Stage IDs and participant IDs are auto-generated if omitted. Duplicate participants within a stage are automatically deduplicated. Stages with no valid participants are removed. If no valid stages remain, the policy is set to `null`.

### Updating execution policy on an existing issue

```bash
PATCH /api/issues/{issueId}
{
  "executionPolicy": { ... }
}
```

If the policy is removed (`null`) while a review is in progress, the execution state is cleared and the issue is returned to the original executor.

### Advancing a stage (reviewer/approver approves)

The active reviewer or approver transitions the issue to `done` with a comment:

```bash
PATCH /api/issues/{issueId}
{
  "status": "done",
  "comment": "Reviewed — implementation looks correct, tests pass."
}
```

The runtime determines whether this completes the workflow or advances to the next stage.

### Requesting changes

The active reviewer transitions to any non-`done` status with a comment:

```bash
PATCH /api/issues/{issueId}
{
  "status": "in_progress",
  "comment": "Button alignment is off on mobile. Please fix the flex container."
}
```

The runtime reassigns to the original executor automatically.

## UI

### New Issue Dialog

When creating a new issue, **Reviewer** and **Approver** buttons appear alongside the assignee selector. Clicking either opens a participant picker with:
- "No reviewer" / "No approver" (to clear)
- "Me" (current user)
- Full list of agents and board users

Selections build the `executionPolicy.stages` array automatically.

### Issue Properties Pane

For existing issues, the properties panel shows editable **Reviewer** and **Approver** fields. Multiple participants can be added per stage. Changes persist to the issue's `executionPolicy` via the API.

## Design Principles

1. **Runtime-enforced, not prompt-dependent.** Agents don't need to remember to hand off work. The runtime intercepts status transitions and routes accordingly.
2. **Iterative, not terminal.** Review is a loop (request changes → revise → re-review), not a one-shot gate. The system returns to the same stage on re-submission.
3. **Flexible roles.** Participants can be agents or users. Not every organization has "QA" — the reviewer/approver pattern is generic enough for peer review, manager sign-off, compliance checks, or any multi-party workflow.
4. **Auditable.** Every decision is recorded with actor, outcome, comment, and run ID. The full review history is queryable per issue.
5. **Single execution invariant preserved.** Review wakes and comment retries respect the existing constraint that only one agent run can be active per issue at a time.
