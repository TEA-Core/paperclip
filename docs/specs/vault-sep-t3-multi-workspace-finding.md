# VAULT-SEP T3 — Finding: does `workspaces[]` honour multiple entries end-to-end?

- Issue: SUP-13823 · Parent: SUP-13821 · Ruling: ADR-075 (vault `main` @ `0706c557`, binding 3)
- Date: 2026-08-24 · Author: coder-BE
- Target project: `86aa3f31-ce0d-42f8-98e9-02154f9be6a9` (Trading Signal Platform v2)

## Question

Does the Paperclip control plane honour more than one `projectWorkspaces` row per project
end-to-end — i.e. is a second workspace (a) accepted by the projects API and (b) provisioned
per-issue, so that an issue declaring the second workspace gets a worktree of **that** repo?

## Answer

**The multi-workspace plumbing is honoured. The end-to-end lane on TSP v2 is NOT, because the
one command the server actually executes per worktree is the PROJECT-level
`executionWorkspacePolicy.workspaceStrategy.provisionCommand`, which is not repo-aware — and
the per-workspace `setupCommand` the plan hypothesized as the per-workspace hook is inert
metadata the server never executes.**

Part (a) — API acceptance: **PROVEN LIVE** on 2026-08-24 (responses below).
Part (b) — per-issue provisioning honours the declared workspace: **PROVEN LIVE** — canary
SUP-13874 got a worktree of the vault repo on its own managed checkout and committed to a
branch (`a85affa`); its agent dispatch then failed at the shared project-level
provisionCommand, exactly as predicted in code (evidence below). Regression SUP-13875 proves
the primary lane is unaffected by the attach.

## Code path (server, as of this worktree's base)

### 1. The API accepts N workspaces per project

- `server/src/routes/projects.ts:285` — `POST /projects/:id/workspaces`, validated by
  `createProjectWorkspaceSchema` (`packages/shared/src/validators/project.ts:89`):
  `name`/`repoUrl`/`defaultRef`/`setupCommand`/… — no one-per-project constraint.
- `server/src/services/projects.ts:902` — `createWorkspace` inserts a new
  `projectWorkspaces` row; `isPrimary` defaults false and a new row only becomes primary
  when explicitly asked or when it is the first row.
- `server/src/services/projects.ts:882` — `listWorkspaces` returns **all** rows for the
  project; the project JSON's `workspaces[]` is exactly that list.

### 2. Per-issue provisioning honours the issue's declared workspace

- `server/src/services/heartbeat.ts:8902` — `resolveAnchorWorkspaceForRun` reads the
  issue's `projectWorkspaceId` (via `issueProjectRef`) and loads **all** of the project's
  `projectWorkspaces` rows.
- `server/src/services/heartbeat.ts:2787` — `prioritizeProjectWorkspaceCandidatesForRun`
  moves the issue's preferred workspace to the front of the candidate list.
- `server/src/services/heartbeat.ts:1561` — `ensureManagedProjectWorkspace` clones that
  workspace row's `repoUrl` into a managed checkout directory keyed by
  companyId + projectId + **repoName** (`deriveRepoNameFromRepoUrl`, call at
  heartbeat.ts:1564; path via `resolveManagedProjectWorkspaceDir`,
  `server/src/home-paths.ts`), e.g.
  `<instance>/projects/<companyId>/86aa3f31…/tsp-obsidian-vault`. A second workspace with a
  different repo gets its own directory — no collision with the primary's checkout.
- `server/src/services/workspace-runtime.ts:3773` — `realizeExecutionWorkspace`
  (git_worktree branch): cuts the issue worktree from the **anchor's** managed checkout at
  `<repoRoot>/.paperclip/worktrees/<branch>`, with `baseRef` from the project strategy or
  the anchor workspace's `defaultRef`/`repoRef` (workspace-runtime.ts:3847-3850).
- `server/src/services/execution-workspace-provisioning.ts:574` —
  `resolvedProjectWorkspaceId = issueRef?.projectWorkspaceId ?? resolvedWorkspace.workspaceId`.

### 3. The executed per-worktree hook is the PROJECT-level provisionCommand

- `server/src/services/workspace-runtime.ts:3265-3318` — `provisionExecutionWorktree`
  runs `input.strategy.provisionCommand` (the project's
  `executionWorkspacePolicy.workspaceStrategy.provisionCommand`) with **cwd = the
  worktree**. On non-zero exit it throws (the only retry is pnpm lockfile-mismatch,
  workspace-runtime.ts:3249-3263), and the dispatch fails with
  `workspace_validation_failed` — see the worked examples in the comment at
  workspace-runtime.ts:3234-3241 (SUP-12984/12986/12996: "failed EVERY dispatch in ~8s").
- TSP v2's live policy (2026-08-24): `provisionCommand = "corepack enable && pnpm install --frozen-lockfile --prefer-offline"`
  — not repo-aware. A vault worktree has no `package.json` anywhere up its directory chain
  (vault root has none), so `pnpm install --frozen-lockfile` cannot succeed there.

### 4. The per-workspace `setupCommand` is NOT executed anywhere in the provisioning path

- Grep of the server provisioning path: `setupCommand` appears only in
  `server/src/services/projects.ts` (CRUD), the read model
  `server/src/routes/issues.ts:5440-5480` (`compactIssueProjectWorkspace`), and
  `company-portability.ts`. No executor.
- `ui/src/pages/ProjectWorkspaceDetail.tsx:607` — form field only ("Runs when this
  workspace needs custom bootstrap"); design intent "workspace-root bootstrap" in
  `doc/plans/workspace-product-model-and-work-product.md:248` — but no server-side runner
  exists in this codebase state.
- Authz (`server/src/routes/workspace-command-authz.ts`): agents MAY set `setupCommand` on
  `POST /projects/:id/workspaces` (only `cleanupCommand` is agent-blocked there); agents
  may NOT set `provisionCommand`/`runtimeProvisionCommand`/`teardownCommand`/`cleanupCommand`
  in project policy or issue `executionWorkspaceSettings` — so no agent can bypass the
  shared project-level hook per-issue.

**Consequence:** the task's "lead worth testing" (a second workspace carrying its own no-op
setup command) tests the wrong hook. The no-op `setupCommand` is safe (inert) but also
ineffective: what runs in a vault worktree is the project-level pnpm command.

## Live API evidence (2026-08-24, project `86aa3f31…`)

Pre-change `workspaces[]` (full rollback JSON posted to SUP-13823 first): one entry,
`77ffa827` (Trading-Signal-Platform, `isPrimary: true`,
`updatedAt 2026-07-24T17:02:15.591Z`).

Write:

```
POST /projects/86aa3f31-ce0d-42f8-98e9-02154f9be6a9/workspaces
{
  "name": "tsp-obsidian-vault",
  "sourceType": "git_repo",
  "repoUrl": "https://github.com/TEA-Core/tsp-obsidian-vault",
  "defaultRef": "main",
  "setupCommand": "true",
  "metadata": { "adr": "ADR-075", "purpose": "vault write lane (ADR-075 binding 3)", "vaultSep": "T3" }
}
→ 200 { "id": "756acf58-d946-4714-a80c-b4c9f4682899", "isPrimary": false,
        "setupCommand": "true", "createdAt": "2026-08-24T17:09:11.883Z" }
```

Post-change `GET /projects/86aa3f31…`: `workspaces[]` = [77ffa827 (byte-identical to
pre-change, `isPrimary: true`), 756acf58 (vault, `isPrimary: false`)].
`primaryWorkspace` and `codebase` still point at 77ffa827; `executionWorkspacePolicy`
unchanged.

## Probe runs (dispatched 2026-08-24 17:14-17:21 UTC) — MEASURED RESULTS

| Probe | Declares | Measured |
|---|---|---|
| SUP-13874 (canary) | vault workspace `756acf58` | **Selection + materialisation HONOURED; dispatch BLOCKED by the shared project-level provisionCommand (predicted).** Vault managed checkout cloned 17:14 to `…/86aa3f31…/tsp-obsidian-vault`; worktree cut at `.paperclip/worktrees/SUP-13874-vault-sep-t3-canary-declare-vault-workspace-prove-or-disprove-the-provisioning-lane`, branch `SUP-13874-…`, parent `e07fc1b` (vault `main` tip). 5 consecutive dispatches `setup_failed` (17:14:42→17:20:57), reproduced as `[ERR_PNPM_NO_PKG_MANIFEST] No package.json found in /paperclip`. |
| SUP-13875 (regression) | primary `77ffa827` (issue declares no workspace) | **PASS.** TSP worktree `…/86aa3f31…/Trading-Signal-Platform/.paperclip/worktrees/SUP-13875-…`, branch `SUP-13875-…`, `git log -1` `0b61f2b347`, `node_modules` present — provisioned unchanged after the attach (evidence posted to SUP-13823 17:20:19; probe cancelled 17:20:32). |

Lane-proof commit capability, on the canary's provisioned vault worktree:
marker commit `a85affa "VAULT-SEP T3: canary marker (vault 2nd-workspace provisioning proof)"`
(local only — not pushed, no PR, no merge; worktree left in place as evidence).

## Decision (revised after review, executed 2026-08-24 18:28-18:29 UTC)

The task's question — "does `workspaces[]` honour more than one entry end-to-end (accepted by the
projects API AND provisioned per-issue)?" — is answered **YES at every control-plane layer the
feature owns**: API acceptance, per-issue workspace selection, per-repo managed checkout, and
worktree materialisation from the declared row's `repoUrl`/`defaultRef`. All four were measured
live, not inferred.

The remaining obstacle is **not** a multi-workspace defect: the failing step is the single
PROJECT-level `executionWorkspacePolicy.workspaceStrategy.provisionCommand`, which runs in every
worktree of the project regardless of which workspace row declared it, is not repo-aware, and
would fail identically for any second repo attached to this project. The task's own "lead worth
testing" anticipated exactly this and asked that the attach-with-no-op-setupCommand shape be
tested and the finding recorded. The vault row's `setupCommand: "true"` is inert metadata the
server never executes, so it cannot dodge the project-level pnpm hook.

**Outcome — the negative-lane result was honoured, not the "attach stands" draft.** Review of the
first DELIVERED revision (SUP-13823, changes requested 18:03:14) held that the draft decision
overrode the pre-committed decision rule — the monitor notes recorded that a canary failing at
the pnpm provision step means "DELETE ws `756acf58` + stand up a dedicated vault project" — and
that keeping the attach left the lane unusable (no live issue-run ever dispatched on the vault
lane; T4/T5/T7 stayed blocked). Per the pre-committed rule, executed 18:28-18:29 UTC:

- Rolled back the attach: `DELETE /projects/86aa3f31-ce0d-42f8-98e9-02154f9be6a9/workspaces/756acf58-d946-4714-a80c-b4c9f4682899`
  (18:28:05). Project `86aa3f31` is back to its single pre-change row `77ffa827`, byte-identical
  to the rollback JSON posted to SUP-13823 at 17:08:32.
- Stood up a **dedicated vault project** `07aa11d6-a538-4687-8985-e6be4e060392`
  ("tsp-obsidian-vault", created 18:29:43) whose primary workspace is the vault repo itself
   (`42c7243b-eed4-4e2c-9064-b3e75e71f576`, repoUrl `https://github.com/TEA-Core/tsp-obsidian-vault`,
   `defaultRef: main`). The project carries **no** `executionWorkspacePolicy.workspaceStrategy`
   (live-confirmed: execution-workspace config `provisionCommand: null`) and `defaultMode:
   isolated_workspace`, so vault-lane issues get a `git_worktree` workspace cut from the managed
   vault checkout with **no project-level install command** (provisionExecutionWorktree skips
   empty commands — `if (!provisionCommand) return;`, workspace-runtime.ts:3278): the pnpm
   failure mode is structurally removed, not patched, and the lane is actually usable for T4/T5/T7.
- SUP-13874 (canary probe): **cancelled** — terminal since 18:40:25Z; the assignee re-affirmed
  the cancel at 19:12:33Z (PATCH 200 from the SUP-13895 run; response `changes.cancelledAt.from
  = 18:40:25.384Z`) and left the evidence comment in its thread. The 5× `setup_failed` retry loop
  was deterministic and is moot. Residual: recovery action `3a79dd45` stays `escalated`/
  `exhausted` with `ownerType: board` — per SUP-13698 that shape is terminal until an explicit
  board resolution (no re-sweep dispatch, no heal loop), and the resolution is board-only:
  `issue:mutate` has no manager-chain path and the recovery-resolve endpoint requires a board
  actor. The trap the review flagged is neutralized: the source issue is terminal.
- T4/T5/T7 unblock: they dispatch onto the dedicated vault project (`07aa11d6`) rather than a
  second workspace on the TSP project.

## Lane proof on the dedicated project (executed 2026-08-24 19:12-19:40 UTC)

The round-1 review required this proof to come from **dispatched runs**, not executor-written
commits. Two dispatched runs on project `07aa11d6` / workspace `42c7243b` (both exec-CEO,
top-level issues created by coder-BE) prove it:

| Run | Issue | Result |
|---|---|---|
| `57151501` | SUP-13895 (cleanup task) | Provisioned 19:12:11→19:12:28 (17 s): `git_worktree`, CWD `…/07aa11d6…/tsp-obsidian-vault/.paperclip/worktrees/SUP-13895-…`, branch `SUP-13895-…`, workspace config `provisionCommand: null` — no pnpm step, no `setup_failed`. |
| `b5e1d549` | SUP-13896 (lane proof) | Same lane (19:38:57→19:40:20). Pre-run checks: `origin` = TEA-Core/tsp-obsidian-vault, no `package.json`, no `node_modules`. Committed marker `bfe2e7b "vault-sep T3: lane-proof marker (dispatched run, dedicated project)"` to branch `vault-sep/t3-lane-proof` (one line in `10_Projects/Trading Signal Platform v2/Plans/decisions/2026-08-24 - VAULT-SEP T3 lane proof marker (scratch).md`, labelled "scratch: do not merge") and pushed it: `git ls-remote` → `bfe2e7b… refs/heads/vault-sep/t3-lane-proof`. |

AC bullet 3 is met by a live issue run on that lane: worktree path above;
`git log -1` = `bfe2e7b78167c70cfe5b7141ebc3a28708830196`.

## Follow-up (out of scope for T3)

The clean control-plane fix remains to make the provision step repo-aware — e.g. execute the
anchor workspace's own `setupCommand` inside the worktree instead of (or before) the
project-level command. That is a server change touching
`provisionExecutionWorktree`/`realizeExecutionWorkspace`; T3 proves and records. For now the vault
lane is unblocked by the dedicated project above; the TSP project's pnpm `provisionCommand` is
unchanged and out of scope.
