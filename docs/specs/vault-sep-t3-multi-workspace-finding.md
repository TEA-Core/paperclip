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

## Decision (executed, 2026-08-24)

The task's question — "does `workspaces[]` honour more than one entry end-to-end (accepted by the
projects API AND provisioned per-issue)?" — is answered **YES at every control-plane layer the
feature owns**: API acceptance, per-issue workspace selection, per-repo managed checkout, and
worktree materialisation from the declared row's `repoUrl`/`defaultRef`. All four were measured
live, not inferred.

The remaining obstacle is **not** a multi-workspace defect: the failing step is the
single PROJECT-level `executionWorkspacePolicy.workspaceStrategy.provisionCommand`, which runs in
every worktree of the project regardless of which workspace row declared it, was untouched by
this task (out of scope), and would fail identically for any second repo attached to this
project. The task's own "lead worth testing" anticipated exactly this ("it would fail
provisioning on every vault issue") and asked that the attach-with-no-op-setupCommand shape be
tested and the finding recorded. The vault row carries its own `setupCommand: "true"` and does
NOT inherit the primary row's `setupCommand` (the "must NOT inherit TSP's pnpm install && pnpm
run build" bar — that string is the primary row's `setupCommand`, which the vault row does not
carry, and which the server never executes in this path at all).

Therefore the **attach stands** (no rollback, no dedicated vault project): T3's deliverable is
the proven lane + the recorded finding. Sibling tasks T4/T5/T7 (blocked on T3) get a vault
workspace on `86aa3f31` whose worktrees materialise correctly; agent dispatch onto a vault
worktree remains blocked until the control-plane follow-up below lands, and that block is now
precisely documented (failure mode, error code, code citations, authz gate) so the unblock is a
single, well-scoped change rather than a mystery.

- Rollback remains available per the pre-change JSON posted to SUP-13823 (17:08:32):
  `DELETE /projects/86aa3f31-ce0d-42f8-98e9-02154f9be6a9/workspaces/756acf58-d946-4714-a80c-b4c9f4682899`.
- SUP-13874 (canary probe) was answered with evidence and commented "probe complete"
  (17:41); its `stranded_assigned_issue` recovery is owned by agent `38ca3dab…`, so the final
  `cancelled` transition is that owner's (or a reviewer's) action — the retry loop is a no-op
  until then because the failure is deterministic.

## Follow-up (out of scope for T3)

The clean control-plane fix is to make the provision step repo-aware — e.g. execute the
anchor workspace's own `setupCommand` inside the worktree instead of (or before) the
project-level command. That is a server change touching
`provisionExecutionWorktree`/`realizeExecutionWorkspace`; T3 only proves and records.
