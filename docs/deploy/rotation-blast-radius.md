---
title: Rotation Blast Radius
summary: What rotating the agent JWT secret, or editing a pinned company skill, really invalidates
---

Two routine-looking operator actions have a far wider blast radius than their names
suggest. Both were documented from the fold slice 2c follow-ups and re-verified against
the fork at `8a42563ea2`:

- Rotating the "runtime-tools signing secret" — **there is no such isolated secret.** The
  key is derived from a shared secret that also signs every agent run token, and often the
  board's login sessions.
- Editing or re-pinning a cache-eligible company skill — changes the runtime cache path,
  which changes every agent's session fingerprint, which resets every stored task session
  in the company.

Read the whole page before either action. Neither is a hot-swap.

## The signing secret is shared

There is no `PAPERCLIP_RUNTIME_TOOLS_SECRET`. Runtime-tools tokens are signed with a key
derived from a master secret, and the same master secret signs agent run tokens:

| Consumer | Source | Master secret resolution order |
|---|---|---|
| Runtime-tools tokens (connection intents, GitHub capability) | `server/src/runtime-tools-token.ts` | `PAPERCLIP_AGENT_JWT_SECRET`, then `BETTER_AUTH_SECRET` |
| Agent run JWTs | `server/src/agent-auth-jwt.ts` | `PAPERCLIP_AGENT_JWT_SECRET`, then `BETTER_AUTH_SECRET` |
| Board/user login sessions (Better Auth) | `server/src/auth/better-auth.ts` | `BETTER_AUTH_SECRET`, then `PAPERCLIP_AGENT_JWT_SECRET` |
| Workspace login-handoff tickets | `server/src/auth/workspace-login-handoff.ts` | `BETTER_AUTH_SECRET`, then `PAPERCLIP_AGENT_JWT_SECRET` (one-way derived) |

Two consequences:

1. **The fallback order is reversed between the two families.** Runtime-tools and agent
   JWTs prefer `PAPERCLIP_AGENT_JWT_SECRET`; login sessions prefer `BETTER_AUTH_SECRET`.
   Whether one rotation hits both depends entirely on which of the two variables you set.
2. **Per-company and per-instance isolation does not limit rotation.** The signing key is
   derived per company and per instance ID — the string
   `runtime-tools:{instanceId}:{companyId}` is HMAC'd with the master to produce it — which
   stops a token minted for one company or a dev worktree instance from authenticating
   against another. It does not save you from a master rotation: every derived key changes
   at once, for every company on the instance.

`PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` is a **different** variable, used for signed tool
action approvals. It is not part of the JWT/runtime-tools family and rotating it is not
covered by this runbook.

### What a `PAPERCLIP_AGENT_JWT_SECRET` rotation hits

| Configured state | Agent run JWTs | Runtime-tools tokens | Board/user login sessions |
|---|---|---|---|
| Both `PAPERCLIP_AGENT_JWT_SECRET` **and** `BETTER_AUTH_SECRET` set | dead | dead | **survive** |
| `PAPERCLIP_AGENT_JWT_SECRET` set, `BETTER_AUTH_SECRET` unset | dead | dead | **dead** — sessions sign with the agent JWT secret |
| `PAPERCLIP_AGENT_JWT_SECRET` unset, `BETTER_AUTH_SECRET` set | dead | dead | **dead** — both families sign with `BETTER_AUTH_SECRET` |

Only the first row is a safe configuration to rotate from. If you are in row two or three,
decouple before you rotate: set `BETTER_AUTH_SECRET` to the **current, unchanged** value of
whichever secret is currently signing your sessions, restart, and confirm logins still
work. Existing sessions stay valid (same key bytes), and from that point on a JWT rotation
never touches them.

## Runbook: rotate after `PAPERCLIP_GITHUB_MANAGED_EXECUTION` goes on then off

`PAPERCLIP_GITHUB_MANAGED_EXECUTION` opts local and SSH lanes into upstream's managed
run-identity GitHub projection. It is read at `server/src/services/git-credentials.ts` and
is on **only** when the value, after trim and lowercasing, is exactly `on` — any other
value (`1`, `true`, `off`, empty, or unset) keeps local/SSH runs in host mode per fold
decision D1. Production keeps the variable **unset**.

The flag is a **local/SSH gate only**. `forkForcesHostGitHub` forces host-mode credentials
for the `local` and `ssh` drivers — and for an absent driver, which is local — while every
other driver keeps upstream managed-execution semantics **regardless of this variable**.
Sandbox, plugin and Kubernetes lanes are therefore managed whether or not the flag was ever
set, so "the flag is unset" does not mean "no long-lived capability exists".

Why a rotation is owed when a lane goes managed and then back to host: while a lane is
managed, a run can be minted a `github_credentials` runtime-tools capability whose `exp` is
**30 days** (every other scope is 1 hour — `server/src/runtime-tools-token.ts`). Turning
the lane back to host mode stops minting new capabilities; it does nothing to the ones
already handed out. They stay signature-valid until `exp`. Per-use checks re-read the run
identity and current credential policy, so a revoked or low-trust run stops getting
credentials — but the token itself cannot be un-minted by configuration. **Key rotation is
the only way to invalidate one early.**

### Steps

1. **Establish whether a 30-day capability could still be outstanding.** There is no
   registry to query. The token is a stateless bearer JWT minted once at adapter spawn and
   injected into that run's environment as `PAPERCLIP_GITHUB_BROKER_TOKEN`; it is not
   persisted (the recorded adapter invocation redacts that key), so exposure has to be
   inferred from the **last 30 days of run history, across every driver class** — not from
   the flag alone:
   - **`local` / `ssh` lanes:** exposed only if the deployed environment had the flag
     exactly `on` during that window. Check the deployed env, not your shell.
   - **sandbox, plugin and Kubernetes lanes:** managed regardless of the flag. If any run
     used one of those drivers in the window, assume a capability was minted.

   Rotate unless you can show no run resolved to a managed lane anywhere in the window. A
   flag that never cycled on an instance that only ever ran local/SSH work is the one case
   where no rotation is owed.
2. **Confirm you are in the safe row** of the table above. If not, decouple first.
3. **Quiesce and drain the process you are about to stop.** Rotation means a restart, and a
   restart hard-kills in-flight runs. Use the instance dispatch quiesce and wait for
   `inFlightRuns: 0` — see
   [Dev-Plane Deploy & Restart Hygiene](dev-plane-restart-hygiene.md). Do **not** pause
   agents to quiesce. This quiesce is in-memory, carries a 90-minute TTL, and deliberately
   does **not** survive the restart — a replaced container must come up dispatching — so
   step 7 necessarily runs after dispatch has resumed.
4. **Generate a new master** and deploy it to every replica, then restart:

   ```sh
   openssl rand -hex 32
   ```

5. **Rotate once, fleet-wide.** Never rotate a subset: replicas holding different masters
   mint tokens the other half rejects, which presents as intermittent 401s from agents and
   is much harder to diagnose than an outage.
6. **Expect and confirm the fallout:**
   - Every agent run in flight at the swap loses API auth. Run tokens are minted once at
     adapter spawn, so an already-running session cannot refresh until it is re-spawned.
   - Every outstanding `github_credentials` capability goes dead immediately. Any run still
     relying on managed GitHub credentials fails its git operation rather than falling back
     silently.
   - If your config was in row two or three, every board/user must sign in again.
7. **Verify after the restart**, not before it. The swap already released the quiesce and
   the replacement is dispatching, so do this on the new server: one benign dispatch per
   affected company, then watch for auth-attributed run failures over the following window.
   If verification fails, re-engage the quiesce **on the replacement**
   (`POST /api/instance/dispatch-quiesce`) to stop new dispatch while you fix or roll back
   the master, and release it once the dispatch proves out. If dispatch must not resume at
   all across the swap, the only lever that outlives a restart is a boot-time suppression:
   start the replacement with `PAPERCLIP_RESTORE_IN_PROGRESS=1` (or
   `PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS=1` — `resolveHeartbeatSchedulingSuppression` in
   `server/src/services/heartbeat.ts` then reports `database_restore_in_progress`). That
   suppresses dispatch entirely, so the benign dispatch runs after you clear it; it holds
   normal traffic back, it does not let you dispatch while suppressed.

## Runbook: skill edits and re-pins rotate every agent session

Since the runtime skill cache (upstream #13042), cache-eligible company skills are
materialized into a content-addressed directory. The fingerprint
(`server/src/services/runtime-skill-cache.ts`) covers `companyId`, `skillId`, `sourceType`,
`sourceLocator`, `sourceRef`, the source metadata (owner/repo/hostname/ref/repoSkillDir),
the digest of the stored `SKILL.md` markdown, and the file inventory. The cache entry
directory **is** the fingerprint.

That entry directory is what lands in `runtimeSkills` for the run, and `runtimeSkills` is
one of the session-category config values. A changed skill therefore changes the session
fingerprint, and a stale session fingerprint resets the stored task session.

Eligibility and blast radius, precisely:

- **Cache-eligible** means `sourceType` is `github` or `skills_sh` **and** `sourceRef` is a
  full 40-hex commit SHA. A branch or tag pin is *not* cache-eligible, and `local_path`
  skills are excluded outright.
- **The blast radius is the whole company.** The runtime skill entries are listed per
  company, not per agent, so every agent's session fingerprint moves together. One edited
  skill resets every stored task session in the company.

Treat these as session-resetting edits: editing the stored `SKILL.md` markdown, re-pinning
the commit SHA, changing the source locator/URL, or adding/removing a file from the stored
inventory. Model swaps are **not** in this class — a configured-model change no longer
resets the task session (SUP-13734), because the transcript is model-portable.

### What to do

1. **Batch skill edits into a deploy window.** Session loss is the same class of loss as a
   restart, and the same drain rules apply: quiesce, drain, then edit.
2. **Say so in the change.** The 2c deploy reset every stored task session once for exactly
   this reason; the reset was operator-accepted.
3. **Pin to a commit SHA on purpose** for skills whose content must be stable. A branch pin
   is re-resolved rather than content-addressed, so its content can move under you without
   a cache-path change.
4. **Do not schedule an edit against a company that is mid-run** on tasks whose continuity
   depends on their stored session context. Check for active runs first.
