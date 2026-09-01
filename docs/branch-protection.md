# Branch protection on the fold branch

SUP-13629 (disposition of the approval gap; parent SUP-13589). The merge gate
on `TEA-Core/paperclip` `fold/tea-patches-v2026.722.0` — the deployed line of
this repo, which is a vendor fold of upstream paperclip carrying TEA patches.

Prior state (measured live 2026-08-21): the fold had **no approval-bearing
gate at all**. Ruleset `20756420` required only `verify` and `e2e`;
`required_approving_review_count` was `0`; and `bypass_actors` listed the
repository **admin** (`RepositoryRole` `5`, `bypass_mode: pull_request`) — so
an admin could merge any PR, with no approval and no merge queue, by walking
through the ruleset. A gate an admin can walk through is not a gate.

## What is enforced today

One ruleset (`20756420` "fold merge queue", `target: branch`, include
`refs/heads/fold/tea-patches-v2026.722.0`) — there is **no** classic branch
protection on the fold branch (`GET /branches/fold/.../protection` answers
404). The ruleset is the whole gate:

| rule | value |
|---|---|
| `required_status_checks` | `verify`, `e2e`, `paperclip-approved-enforcer` |
| `merge_queue` | required, `SQUASH`, `ALLGREEN` |
| `pull_request` | `required_approving_review_count: 0` — deliberately: see below |
| `bypass_actors` | `[]` — empty (admin bypass removed by SUP-13629) |

Because the merge queue is required, every landing commit is re-checked on
`merge_group` — that is the enforcement point, and it is why the approval
guard is written to be *enforcing on `merge_group`* rather than only on
`pull_request`.

## Which mechanism was chosen, and why

A GitHub-native `required_pull_request_reviews` requirement is unsatisfiable by
this fleet: every agent pushes and merges as the single shared machine identity
`kronik187`, and GitHub forbids approving your own PR, so a native review
requirement would route every autonomous PR through one human — not a gate, a
stoppage. Instead the gate is the **`paperclip-approved-enforcer` required
status check** (`.github/workflows/paperclip-approved.yml` +
`scripts/ci/check-paperclip-approved.sh`), which reads the approval decision
from the control plane, where reviewer ≠ assignee is structurally enforced.
The non-pusher approval is real; it is recorded one layer up from GitHub.

### The consume-contract (pinned)

- `context: "paperclip/approved"`, `state: "success"` on the PR head.
- Produced only by the control plane (`publishApprovalStatus`) when a card's
  `review` stage records `approved` **and** the card has exactly one linked,
  open PR. **Nothing in this repository may create, mock or backfill that
  status** — a local write is a contract violation that manufactures a fake
  approval. The enforcer is read-only (two GETs: `pulls/{n}` and
  `commits/{sha}/status`).
- Behaviour by event: `pull_request` → advisory (exit 0, green — the status
  only exists after the review stage approves); `merge_group` → **fail-closed**
  (missing/pending/failed/unresolvable/API-error all block the merge); `push`
  → no-op success (never `skipped`, so the context can be required without
  deadlocking the queue — SUP-13500).
- The job lives in its **own workflow** so a `push` to the fold runs only the
  lightweight enforcer, not the full `pr.yml` suite.
- Fold adaptation: the merge-queue ref embeds the base branch, which itself
  contains slashes — `gh-readonly-queue/fold/tea-patches-v2026.722.0/pr-<N>-<sha>`.
  The queue-ref regex is `^gh-readonly-queue/.+/pr-([0-9]+)-[0-9a-f]+$`; the
  single-component agent-tools pattern would never resolve a fold queue entry
   and would deadlock the fold merge queue.

### First-publish recovery surface (SUP-14748)

The first `publishApprovalStatus` call can skip for reasons only a human
understands — a PR that was hand-merged or closed, a coordinating card that
merely cited a PR rather than delivering it, a head that moved between the
approval decision and the publish. The stamp cannot be manufactured by hand:
the enforcer rejects it, and a locally-written `paperclip/approved` would be a
contract violation (fake approval). The only sanctioned recovery is the
**operator-invocable re-arm** route:

- `POST /api/issues/:issueId/merge-arming/republish` — board owner/admin only.
  An agent caller is refused (403) before any GitHub read or write. It is the
  single surface a human may use to re-stamp; hand-writing the status on the PR
  head is still forbidden.
- It re-runs `publishApprovalStatus` **verbatim** — pinned to the decision-time
  head and with delivery identity enforced — rather than re-deriving anything.
  It is idempotent: if `executionState.approvalStatus.publishedHeadSha` is
  already set it returns `200 already_published` with no GitHub I/O; otherwise
  it resolves the decision head, re-publishes to the pinned head, and persists
  the certified head back to `executionState.approvalStatus` (so the reconciler
  and enforcer can verify it).
- It fails closed: `409` with a verbatim refusal when the card has no recorded
  `approved` decision, when ADR-073 stage-integrity (Guard B) does not hold,
  when the decision head cannot be positively resolved, or when the head moved
  between resolve and publish. Nothing is stamped in the failure case.

### Waiving a cardless PR

The fold's own changes are TEA-authored deliveries with Paperclip cards, so
they carry `paperclip/approved` once their card is approved. Any PR with **no**
Paperclip card (doctrine sync, rescue, upstream-patch experiment, the lockfile
refresh bot) must declare either the PR-body line
`Paperclip-Approved-Waiver: <reason>` (non-empty) or the exact label
`no-paperclip-card`. A waived run exits 0 and logs `waived:` with the declared
reason or label. The lockfile refresh bot's PR body already carries the waiver
(`.github/workflows/refresh-lockfile.yml`, SUP-13629) so its auto-merge is not
stranded by the required context.

## Admin bypass — decision (SUP-13629)

The pre-existing `bypass_actors` entry (admin, `bypass_mode: pull_request`) was
**removed** — `bypass_actors: []`. Rationale: the fold is a deployment target
of production TEA infrastructure and the gate exists to stop an unapproved
merge; retaining a bypass an admin can walk through recreates the incident
SUP-13589 was filed against. The risk that originally motivated keeping it (an
in-flight fold process stranding on the gate) is handled instead by the
**waiver mechanism** above — a fold-sync/cardless import declares a waiver,
which is reviewable in the PR body/labels, rather than by a blanket role
bypass. The gate is probed live rather than read from the settings object:
a PR with no control-plane approval and no waiver is observed failing at the
merge boundary and not landing (the probe evidence and failing log line are
recorded on SUP-13629). **No admin bypass is retained.**

## Residual risk

The `paperclip/approved` commit status is the approval signal, and any token
with `statuses: write` on this repository — which every admin has — could in
principle post that context by hand. Nothing in this repository may create,
mock or write it; a local write is a policy boundary, not a mechanical one,
and cannot be closed with repository settings alone. Recorded here rather than
papered over.

## Changing the gate

Adding or removing a required context is a `PUT` on the ruleset — **not** a
`PATCH`, which 404s on this repository:

```bash
gh api repos/TEA-Core/paperclip/rulesets/20756420 > pre.json   # keep the pre-image
# edit rules[].parameters.required_status_checks, then:
gh api -X PUT repos/TEA-Core/paperclip/rulesets/20756420 --input new.json
gh api repos/TEA-Core/paperclip/rulesets/20756420 \
  --jq '.rules[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context'
```

A context is only safe to require if its job reports `success` (never
`skipped`) on `merge_group` **and** `push` — otherwise the merge queue
deadlocks.

## Fold durability note

This repo is a vendor fold: upstream paperclip releases are folded in under
`fold/tea-patches-v2026.722.0` by the fold process. The approval gate lives in
repo files (`.github/workflows/paperclip-approved.yml`,
`scripts/ci/check-paperclip-approved.sh`, this doc) so a future fold carries
it forward; the ruleset itself is a settings object that the fold process does
not touch. Any fold that rewrites `pr.yml` must keep this workflow and its
required context intact, or the fold merge queue deadlocks.
