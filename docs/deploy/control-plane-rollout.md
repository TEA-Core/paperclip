---
title: Control-Plane Rollout Runbook
summary: How merged fold code becomes the running control plane on the wonton host, which lanes roll it, and the liveness check a closing agent must run
---

# Control-Plane Rollout Runbook

How merged server code becomes the running control plane at
`https://paperclip.dvit.io`, which lane rolls it, and how a closing agent proves
the code is actually serving.

**The one-sentence answer to "what rolls the container?":** a cron-driven
rollout driver on the host, in a daily unattended window. The live plane is a
**Docker Compose stack on the intranet host `wonton`** — not a cloud service —
and the swap is performed by `deploy-image.sh`, which quiesces dispatch, drains
in-flight agent runs, swaps the container behind gates, and rolls back on
failure.

> **This deployment does not use AWS.** There is no ECR repository, no ECS
> service, no Fargate task, and no workflow that calls `aws ecs update-service`.
> [`docs/deploy/aws-ecs.md`](aws-ecs.md) is *product* documentation for users
> deploying their own Paperclip to AWS; it does not describe this fork's plane.
> An earlier revision of this runbook told operators to `docker push` to ECR and
> roll an ECS service `paperclip-server` in cluster `paperclip`. Those commands
> address infrastructure that does not exist here, and cards that cited them
> (SUP-14774) could never be executed. Do not reintroduce them.

## Where the plane actually runs

| | |
|---|---|
| Host | `wonton` — `10.10.10.3`, `paperclip.internal` (since 2026-08-21) |
| Runtime | Docker Compose: `paperclip-server-1`, `paperclip-db-1` (`postgres:17-alpine`) |
| Host port | `3101` |
| Public URL | `https://paperclip.dvit.io` (edge proxy in front of the same container) |
| Intranet URL | `http://10.10.10.3:3101` |
| Deployed line | `fold/tea-patches-v2026.722.0` |
| Image source | `ghcr.io/tea-core/paperclip@<digest>`, published by `docker.yml` on every fold push |

The operational runbook, the compose files and the rollout scripts live in
`~/stack-admin/paperclip-docker/` **on wonton**. That is a separate repository
from this one — it is not checked in here, and nothing in this repo deploys
anything.

## Fold-merge → running-container sequence

| # | Step | Automated? | Owner |
|---|------|-----------|-------|
| 1 | PR merges onto `fold/**` through the merge queue | **Automated** (GitHub) | — |
| 2 | `Fold buildability gate` runs on the merged branch (`install --frozen-lockfile`, typecheck, server build, `docker build`). Build check only. | **Automated** (`.github/workflows/fold-deploy-gate.yml`) | — |
| 3 | `docker.yml` publishes `ghcr.io/tea-core/paperclip:sha-<short>` (and `sha-<short>-cloud`). This is the artifact the rollout consumes. | **Automated** (`.github/workflows/docker.yml`) | — |
| 4 | `auto-rollout.sh` decides whether the fold tip is eligible, pulls the image by digest and retags it `tea-core/paperclip:fold-<short>`. | **Automated** (daily cron on wonton) | — |
| 5 | `deploy-image.sh <tag>` runs the gated swap (below). | **Automated** (invoked by step 4) | — |
| 6 | Liveness verification: `GET /api/health` reports the target commit. | **Manual** — performed by whoever closes the consuming card | Closing agent |

Steps 4–5 are **not** a manual operator surface in the normal case. See the
lanes below for the cases where a human is required.

## The three rollout lanes

### 1. Daily window (the normal path)

A cron entry on wonton runs the driver once a day, unattended:

```text
47 11 * * * auto-rollout.sh --execute --detach --retry-window 7200
```

`auto-rollout.sh` never deploys blindly. Before it calls `deploy-image.sh` it
requires all of the following, and emits a single `decision:` line recording the
outcome (`deploy`, `hold`, or `blocked`):

- the target commit is the tip of the deployed fold branch;
- `fold-deploy-gate` **and** `docker` are both green on that exact SHA;
- ghcr has a manifest for the `sha-<short>` tag, and the image config's
  `org.opencontainers.image.revision` label equals that commit — a tag whose
  label names a different commit is `blocked`, not deployed;
- the image carries **no new migrations** (see below).

Batching is deliberate. Every rollout costs a drain, and the fold branch has
taken merges as often as one per ~80 minutes; a per-merge rollout would leave
dispatch quiesced for most of the day. The cost is per-*deploy*, not per-merge.

For the same reason, do not replace this with a pull-and-restart watcher
(watchtower or equivalent): no quiesce, no drain, no lineage preflight and no
gates is exactly the 2026-07-31 failure that destroyed 17 in-flight agent runs.

**Diagnose a stalled rollout from the absence of the `decision:` line**, never
from the gate `success` lines above it. A driver that dies before deciding
prints a plausible-looking partial log. Alerts go to ntfy topic
`paperclip-rollout`.

### 2. Urgent lane (agent-initiated, approval-gated)

An agent that needs a fix rolled sooner than the daily window does **not** need
host access. It files a board approval:

```text
paperclipCreateApproval
  type:    "request_board_approval"
  payload: { kind:  "urgent_rollout",
             title: "...",
             body:  "<why this cannot wait>",
             tip:   "<optional 40-char SHA; omit for the branch tip>" }
```

A watcher on wonton polls every 5 minutes and fires once the approval reaches
`approved`. The signal is the board's existing decision path, so the request is
attributable to the requesting agent and the decision is recorded in the product
rather than in a log on the host.

What this grants is narrow: **it changes the timing of a deploy that was already
going to happen.** Every `auto-rollout.sh` gate above still applies, the drain is
not skippable from this lane, and no drain knob is exposed. A 4-hour cooldown
bounds how often the fleet can pay a drain.

### 3. Human operator (migration-carrying images only)

`auto-rollout.sh` **refuses** to ship an image that carries new migrations, and
this is the one case that genuinely requires a human. The compose file sets
`PAPERCLIP_MIGRATION_AUTO_APPLY=true`, so such an image mutates the schema on
startup, while `deploy-image.sh`'s rollback re-tags the *image* — it cannot
revert the schema. An automatic rollback would therefore land the OLD image on
the NEW schema, and whether that is tolerable is per-migration and unverified.

The operator action is an **SSH-to-wonton deploy**, not a cloud API call:

```bash
ssh wonton
cd ~/stack-admin/paperclip-docker

# 1. confirm what the driver would do, changing nothing
./scripts/auto-rollout.sh --plan

# 2. resolve and pull the approved image, then run the gated swap
./scripts/deploy-image.sh tea-core/paperclip:fold-<short>
```

Do **not** hand-run `docker tag` + `docker compose up -d`. A bare restart
SIGKILLs every in-flight `opencode run`, and runs last 20–90 minutes.

Two further traps on this path, both load-bearing:

- **Build from the right tree.** The deployed line is the
  `fold/tea-patches-v2026.722.0` worktree on wonton. A different local checkout
  named `paperclip` can sit ~100 migrations behind while still producing a
  container that serves `/api/health` 200, renders the UI, and logs no startup
  error — with every heartbeat dying on a missing column. Prefer the CI-published
  ghcr image: a local `docker build` produces no `org.opencontainers.image.*`
  labels, which blinds both the preflight and the rollout driver's revision check.
- **Always pass the compose file set.** An explicit `-f` disables compose's
  automatic loading of `docker-compose.override.yml`, silently dropping
  `PAPERCLIP_ALLOWED_HOSTNAMES` (the server then 403s every request whose Host it
  does not know, including `paperclip.internal`) and the db memory limits.
  `deploy-image.sh` already handles this; ad-hoc commands do not.

## What `deploy-image.sh` actually does

The script exists because container replacement destroys in-flight agent work. A
few seconds of HTTP 503 is not the cost worth avoiding — the runs are.

1. **Lineage gate** — `preflight-image.sh --image <tag>` compares the image's
   migration history against what the live DB has applied; refuses on mismatch.
2. **Rollback anchor** — tags the currently-running image `rollback-<id>` before
   touching anything.
3. **Quiesce** — `POST /api/instance/dispatch-quiesce`, which gates new dispatch
   and **cancels nothing**. The response carries the in-flight run count.
   *Never* quiesce by pausing agents: `POST /agents/:id/pause` calls
   `cancelActiveForAgent`, which cancels every queued/running run — on
   2026-08-01 that killed 14 live runs and the drain then reported
   "drained after 0s".
4. **Drain** — polls `GET /api/instance/dispatch-quiesce` until `inFlightRuns`
   reaches 0, deadline-bounded (`--drain-deadline`, default 5400s). On timeout it
   **aborts rather than killing runs**; `--skip-drain` is the explicit opt-in to
   losing them. If the count becomes unreadable mid-drain it aborts too.
5. **Swap** — retags the live tag and recreates the containers, in place.
   Never blue/green: run liveness is keyed on `process_pid` with no instance
   identity, so a second container's reaper would classify the first's live runs
   as orphans.
6. **Verify** — health 200, then the *heartbeat* path: `errorMissingColumn` and
   `heartbeat execution setup failed` must both be 0, measured against a baseline
   sampled **before** the quiesce. Any gate failing triggers an automatic
   rollback to the anchor. **That rollback re-tags the image; it cannot undo a
   schema change.** With `PAPERCLIP_MIGRATION_AUTO_APPLY=true`, an image that
   applied migrations on startup leaves the OLD image running against the NEW
   schema after a rollback — safe only if the migration is backward-compatible.
   This is exactly why `auto-rollout.sh` refuses migration-carrying images
   (lane 3); when you deploy one by hand, treat a gate failure as requiring
   explicit operator recovery, not as a completed rollback.
7. **Resume** — via an EXIT trap, so dispatch returns even when the script
   aborts mid-flight. The trap only covers a normal Bash exit: `SIGKILL`, an OOM
   kill or losing the host skips it, and dispatch stays quiesced. The quiesce is
   recorded in `~/.paperclip/deploy-state/quiesced-by-deploy.txt` *before* the
   call that engages it, so a deploy killed at any point leaves a trace; that
   file then blocks the next deploy until cleared. Recover either termination
   path with `./scripts/deploy-image.sh --resume-only`. The server-side quiesce
   TTL (drain deadline + 10 minutes, clamped by the server to 6h) is the backstop
   under all of it.

Zero *work* loss, at the cost of a ~20s API gap during the swap.

## Liveness check a closing agent must run

`done` = Live. A server-side card is only live when the **running** plane serves
the merged commit — CI green and a green buildability gate do not prove that.

Probe the deployed plane, not the repo:

```bash
curl -sf https://paperclip.dvit.io/api/health
# {"status":"ok",...,"commit":"<sha>",...}
```

Pass criteria:

- `.status` is `ok`.
- `.commit` is the merge commit (or a descendant containing it) that the card's
  code merged as. Treat the target merge as the base and the served commit as the
  head — accept `identical` or `ahead` (behind_by `0`), which means the served
  plane contains the target merge:
  `gh api repos/TEA-Core/paperclip/compare/<target-merge-sha>...<served-commit> --jq '.status, .behind_by'`.
  When the requirement is specifically "the plane serves the fold tip", require
  exact SHA equality: `.commit` must equal the fold tip. Refresh the
  remote-tracking ref first — a stale one silently compares against an old SHA
  and passes a check that should fail:

  ```bash
  # `&&`, not two statements: if the fetch fails (offline, auth, renamed branch)
  # the rev-parse below would still succeed against the STALE tracking ref and
  # quietly compare the plane to an old tip.
  git fetch origin fold/tea-patches-v2026.722.0 \
    && git rev-parse origin/fold/tea-patches-v2026.722.0
  ```

**The "Fold buildability gate" workflow conclusion is NOT a liveness check.** It
only proves the merged branch *can* be built. It does not publish the image the
plane consumes and it does not roll the container — a green run while the plane
is stale is the exact "green when skipped" failure mode the company's
done-definition doctrine forbids. Never quote a workflow conclusion as evidence
that code is serving.

## Measuring rollout debt

Rollout debt is the set of merges that are on the fold branch but not in the
served image. Compute it rather than reading a stale table:

```bash
SERVED=$(curl -sf https://paperclip.dvit.io/api/health | jq -r '.commit // empty')

# Guard before use. An unreachable plane, or a payload without `.commit`, leaves
# $SERVED empty or "null" -- and `git log "..origin/<branch>"` with an empty left
# side is a valid range that reports the WHOLE branch as debt. Check, don't assume.
if [ -z "$SERVED" ] || [ "$SERVED" = null ]; then
  echo "could not read the served commit from /api/health" >&2
elif ! git rev-parse --verify --quiet "$SERVED^{commit}" >/dev/null; then
  echo "served commit $SERVED is not in this repo -- fetch, or check the branch" >&2
elif ! git fetch origin fold/tea-patches-v2026.722.0; then
  # Stop here rather than fall through: on a failed fetch the tracking ref below
  # still resolves, to a stale tip, and would under-report the debt.
  echo "could not refresh origin/fold/tea-patches-v2026.722.0 -- debt not computed" >&2
else
  git log --oneline "$SERVED..origin/fold/tea-patches-v2026.722.0"
fi
```

An empty list means the plane is current. A non-empty list is normal *within* a
daily window; it is a fault only if it spans more than one window, which points
at a `blocked`/`hold` decision (or a driver that never reached its `decision:`
line) rather than at the merges themselves.

## Related

- `.github/workflows/fold-deploy-gate.yml` — the buildability gate (renamed from "Fold deploy gate" by SUP-14706 so a green run cannot be read as a deploy).
- `.github/workflows/docker.yml` — image build + publish to ghcr.io; this is the artifact the rollout consumes.
- [`docs/deploy/dev-plane-restart-hygiene.md`](dev-plane-restart-hygiene.md) — restart hygiene for dev/shared planes (dispatch quiesce before a swap).
- [`docs/deploy/docker.md`](docker.md) — the Docker Compose deployment this plane is an instance of.
- [`docs/deploy/aws-ecs.md`](aws-ecs.md) — **product documentation** for users deploying Paperclip to AWS. Not this deployment. Nothing in this runbook depends on it.
- `~/stack-admin/paperclip-docker/README.md` **on wonton** — the operational runbook for this host: image build, merge-queue gates, deploy, and recovery.
