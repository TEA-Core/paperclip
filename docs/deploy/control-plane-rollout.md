---
title: Control-Plane Rollout Runbook
summary: The fold-merge-to-running-container sequence for the live control plane, and the liveness check a closing agent must run
---

# Control-Plane Rollout Runbook

How merged server code becomes the running control plane at
`https://paperclip.dvit.io`, who presses each button, and how a closing agent
proves the code is actually serving.

**The one-sentence answer to "what rolls the container?":**
**Nothing automated. The container is operator-pressed.** `docker.yml` builds and
publishes a `ghcr.io/tea-core/paperclip:sha-<short>` image on every fold push,
but no workflow pushes to ECR and no workflow calls `aws ecs update-service`.
The live plane is an AWS ECS/Fargate service (`paperclip-server`, cluster
`paperclip`) whose image comes from ECR (`<ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/paperclip-server:latest`),
and the ECR push plus the service update are manual, performed by a human
operator. A green "buildability" run is a build check, not a deploy.

## Trigger condition and owner

- **Trigger:** after a PR that touches server code merges onto the fold branch
  (`fold/**`), an operator decides when to roll the merged code out. There is no
  schedule, no webhook, and no bot that does this.
- **Owner of every manual step:** the **human board operator** — the user who
  holds the AWS account/credentials for the `paperclip-server` ECS service (the
  responsible user on the open redeploy card, SUP-14694). No agent workspace has
  AWS credentials, so no agent can perform the rollout without them being wired.

## Fold-merge → running-container sequence

| # | Step | Automated? | Owner |
|---|------|-----------|-------|
| 1 | PR merges onto `fold/**` (GitHub) | **Automated** (GitHub merge) | — |
| 2 | `Fold buildability gate` runs on the merged branch (`install --frozen-lockfile`, typecheck, server build, `docker build`). This is a build check only. | **Automated** (`.github/workflows/fold-deploy-gate.yml`) | — |
| 3 | `docker.yml` `build-and-push` / `build-and-push-cloud` trigger on the fold push and publish `ghcr.io/tea-core/paperclip:sha-<short>` (and `sha-<short>-cloud`). This produces an image artifact; **it is not deployed anywhere**. | **Automated** (`.github/workflows/docker.yml`) | — |
| 4 | Build the ECR image at the target commit and push `paperclip-server:latest` to ECR. | **Manual** — see the commands below | Human board operator |
| 5 | Roll the ECS service: `aws ecs update-service --cluster paperclip --service paperclip-server --force-new-deployment`. | **Manual** (initiated by operator) | Human board operator |
| 6 | ECS rolling update: new task starts, passes the `/api/health` container health check, old task drains. | **Automated** (ECS orchestrator, but only because step 5 was pressed) | — |
| 7 | Liveness verification: `GET /api/health` returns the target commit. | **Manual** — performed by whoever closes the consuming card | Closing agent |

Steps 4 and 5 are the entire manual surface. The commands (from
[`docs/deploy/aws-ecs.md`](aws-ecs.md)):

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Step 4 — build and push the ECR image at the target commit (e.g. d1eecef04)
git checkout d1eecef04
docker build --target production \
  --build-arg PAPERCLIP_BUILD_COMMIT=d1eecef04ba22b11f3a466c9080fbbb81c1cc953 \
  -t paperclip-server .
docker tag paperclip-server:latest \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/paperclip-server:latest
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin \
    $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com
docker push \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/paperclip-server:latest

# Step 5 — roll the service
aws ecs update-service \
  --cluster paperclip \
  --service paperclip-server \
  --force-new-deployment
```

The image is built from the `production` stage (never the `cloud` stage for the
self-hosted plane). `PAPERCLIP_BUILD_COMMIT` bakes the commit SHA into the
image so `/api/health` can report it; if the operator uses the plain commands
above the image derives the version from `git describe` and the commit must be
passed explicitly.

## Liveness check a closing agent must run

`done` = Live. A server-side card is only live when the **running** plane serves
the merged commit — CI green and "deploy gate" green do not prove that.

Probe the deployed plane, not the repo:

```bash
curl -sf https://paperclip.dvit.io/api/health
# {"status":"ok",...,"commit":"<sha>",...}
```

Pass criteria:

- `.status` is `ok`.
- `.commit` is the merge commit (or an ancestor-of-the-merge that contains it)
  that the card's code merged as. Compare against the fold tip:
  `gh api repos/tea-core/paperclip/compare/<served-commit>...fold/tea-patches-v2026.722.0 --jq '.ahead_by'` → `0` means the plane serves the fold tip.
- For byte-level proof, diff the deployed tree against the commit (see SUP-14694
  for the blob-identity method).

**The "Fold buildability gate" workflow conclusion is NOT a liveness check.** It
only proves the merged branch *can* be built (`install`/typecheck/server-build/
`docker build`). It does not build an image for the plane, publish to ECR, or
roll the ECS service — a green run while the plane is stale is the exact
"green when skipped" failure mode `done-definition.md` forbids. Never quote a
workflow conclusion as evidence that code is serving.

## Outstanding rollout debt at filing time (2026-09-01T08:15Z)

As of filing, the live plane served `922b9dc7f` (PR #426, merged
2026-08-31T14:34:07Z) while the fold branch was 5 commits ahead. These merges
are merged-but-not-serving and constitute the rollout debt:

| merge | at | card |
|---|---|---|
| `ee75f2b57` (#432) | 2026-08-31T20:12:06Z | SUP-14640 |
| `e368a9e9c` (#435) | 2026-09-01T02:01:17Z | SUP-14644 |
| `eff52af40` (#437) | 2026-09-01T03:16:48Z | ADR-091 D1 |
| `171333836` (#440) | 2026-09-01T07:01:04Z | SUP-14685 |
| `d1eecef04` (#433) | 2026-09-01T07:58:29Z | SUP-14642 |

The redeploy itself is **SUP-14694** (currently blocked on SUP-14645) — do not
race it. The backfill work that consumes a fresh plane is SUP-14693.

## Related

- [`docs/deploy/aws-ecs.md`](aws-ecs.md) — full ECS setup, `docker/ecs-task-definition.json` template, and the deployment/rollback commands.
- `.github/workflows/fold-deploy-gate.yml` — the buildability gate (renamed from "Fold deploy gate" by SUP-14706 so a green run cannot be read as a deploy).
- `.github/workflows/docker.yml` — image build + publish to ghcr.io (artifact production, not deployment).
- `docs/deploy/dev-plane-restart-hygiene.md` — restart hygiene for dev/shared planes (dispatch quiesce before a swap).
