# Agent Runtime Guide

Status: User-facing guide
Last updated: 2026-03-26
Audience: Operators setting up and running agents in Paperclip

## 1. What this system does

Agents in Paperclip do not run continuously.  
They run in **heartbeats**: short execution windows triggered by a wakeup.

Each heartbeat:

1. Starts the configured agent adapter (for example, Claude CLI or Codex CLI)
2. Gives it the current prompt/context
3. Lets it work until it exits, times out, or is cancelled
4. Stores results (status, token usage, errors, logs)
5. Updates the UI live

## 2. When an agent wakes up

An agent can be woken up in four ways:

- `timer`: scheduled interval (for example every 5 minutes)
- `assignment`: when work is assigned/checked out to that agent
- `on_demand`: manual wakeup (button/API)
- `automation`: system-triggered wakeup for future automations

If an agent is already running, new wakeups are merged (coalesced) instead of launching duplicate runs.

## 3. What to configure per agent

## 3.1 Adapter choice

Built-in adapters:

- `claude_local`: runs your local `claude` CLI
- `codex_local`: runs your local `codex` CLI
- `opencode_local`: runs your local `opencode` CLI
- `cursor`: runs Cursor in background mode
- `pi_local`: runs an embedded Pi agent locally
- `hermes_local`: starts your local `hermes` CLI through `@paperclipai/hermes-paperclip-adapter`
- `hermes_gateway`: calls an already-running Hermes API server through `@paperclipai/hermes-paperclip-adapter/gateway`
- `openclaw_gateway`: connects to an OpenClaw gateway endpoint
- `process`: generic shell command adapter
- `http`: calls an external HTTP endpoint

External plugin adapters (install via the adapter manager or API):

- `droid_local`: runs your local Factory Droid CLI (`@henkey/droid-paperclip-adapter`)

For local CLI adapters (`claude_local`, `codex_local`, `opencode_local`, `hermes_local`, `droid_local`), Paperclip assumes the CLI is already installed and authenticated on the host machine. For `hermes_gateway`, Paperclip assumes the Hermes API server is already running, reachable from the Paperclip server, and configured with an API key. The older `@paperclipai/adapter-hermes-gateway` npm package is only a deprecated compatibility shim; the adapter type remains `hermes_gateway`.

## 3.2 Runtime behavior

In agent runtime settings, configure heartbeat policy:

- `enabled`: allow scheduled heartbeats
- `intervalSec`: timer interval (0 = disabled)
- `wakeOnAssignment`: wake when assigned work
- `wakeOnOnDemand`: allow ping-style on-demand wakeups
- `wakeOnAutomation`: allow system automation wakeups

## 3.3 Working directory and execution limits

For local adapters, set:

- `cwd` (working directory)
- `timeoutSec` (max runtime per heartbeat; `0` uses the target default — no adapter timeout on local/SSH, a 4-hour backstop on sandbox targets — and a negative value disables the adapter timeout everywhere, including sandboxes)
- `graceSec` (time before force-kill after timeout/cancel)
- optional env vars and extra CLI args
- use **Test environment** in agent configuration to run adapter-specific diagnostics before saving

## 3.4 Prompt templates

You can set:

- `promptTemplate`: used for every run (first run and resumed sessions)

Templates support variables like `{{agent.id}}`, `{{agent.name}}`, and run context values.

> **Note:** `bootstrapPromptTemplate` is deprecated and should not be used for new agents. Existing configs that use it will continue to work but should be migrated to the managed instructions bundle system.

## 3.5 Agents whose work arrives out of band

Some agents are not started by Paperclip at all. A desktop runtime — Claude Code Desktop, Cowork Desktop — runs on its own schedule, pulls its work through the Paperclip MCP tools, and records the outcome there. Paperclip only needs to be able to say "there is something for you".

Two supported shapes, in order of preference:

1. **A gateway adapter.** If the external runtime can expose an HTTP endpoint, use `openclaw_gateway` or `hermes_gateway`. Paperclip calls the running runtime, the runtime does real work in-band, and the run records a normal disposition. Nothing below applies.
2. **A pull agent.** If the runtime is not reachable over HTTP, configure a wake-only adapter *and* declare the delivery mode:

   ```json
   { "workDelivery": "external_pull" }
   ```

   in the agent's **runtime config**.

`workDelivery` is what tells Paperclip that a run is a doorbell rather than the work. Without it, a wake-only command (the `/bin/echo` no-op operators reach for) produces a run that succeeded having done nothing, and Paperclip reads that as "made progress but chose no next step": it queues a corrective missing-disposition wake, that wake is another no-op, and the stranded-issue sweep eventually escalates the issue with a `missing_disposition` recovery action. With `workDelivery: "external_pull"` set, the missing-disposition handoff is skipped for that agent and any handoff already pending against it is resolved on its next successful run.

The same declaration keeps the undispatchable-assignee sweep quiet. A `process` agent cannot be woken, so that sweep normally reports its `todo`/`in_progress` cards and opens a board-owned `undispatchable_assignee` recovery action. A declared pull agent is exempt while its status lets it work: `active`, `idle`, `running` or `error`. A pull agent in `error` status is still exempt, because `error` describes its last run, not whether it can pull work. A paused, terminated or pending-approval pull agent pulls nothing, so its cards are still reported. Declaring the mode does not close an `undispatchable_assignee` action that is already open: the board resolves it.

Notes:

- The declaration is read from the agent record only. Paperclip never infers it from the adapter command, because a no-op command and a genuinely misconfigured `process` agent look identical — and the misconfigured one still needs its recovery path.
- An agent can declare itself `external_pull`. It edits its own runtime config through `PATCH /api/agents/:id` on itself, or rolls its own config back to a revision that has the declaration (`POST /api/agents/:id/config-revisions/:revisionId/rollback`). Both writes are allowed because an agent may update its own configuration. The activity log (`agent.updated` or `agent.config_rolled_back`) and the new config revision name the agent as the actor. This is intended: a pull agent may state how its own work arrives, and the record shows who made the change.
- It is not a substitute for `status: paused` or `heartbeat.wakeOnDemand: false`. Both of those also stop the noise, but by removing the agent from scheduling entirely; a pull agent should stay wakeable so assignment still reaches it.
- Every other agent is `invoked` by default, and nothing about its recovery behaviour changes.

## 3.6 Instance-wide live-run cap

The instance general setting `liveRunCap` (`PATCH /api/instance/settings/general`, instance admins only) limits how many runs may be `running` at once across the whole instance. `null` or an absent key (the default) turns it off, and admission is unchanged. A stored value that is present but invalid, or a general settings blob that is not an object, fails closed, never open: to the last valid cap this server process read (so an operator cap of 4 stays 4), or the ceiling of 15 when it has read none. A settings read that fails keeps the last value this process read, off included, or the ceiling of 15 when it has read none. A misspelled key reads as absent, so it leaves the cap off.

- **Admission only.** The cap is checked before any queued run is claimed, wherever the claim happens. Lowering it below the live count never stops, cancels or pauses a running session. New work stays `queued` until enough runs finish, and raising the cap (or turning it off) starts the waiting queue at once.
- **Numbers.** The setting accepts an integer from 1 to 15. 15 is a hard ceiling; a larger value is rejected, not clamped. 2 slots of the cap are reserved for human/board and review/recovery work. Priority runs fill the reserve first; general work waits once the other slots are full. A priority run beyond the reserve uses a general slot, and a general slot freed later is open to general work again. A cap below 3 shrinks the reserve so general work always keeps one slot.
- **Router input.** When `PAPERCLIP_LIVE_RUN_CAP_ROUTER_URL` points at the router's `/api/runcap`, the server polls it every 15 s (2 s timeout, one request at a time, redirects refused, answers over 4 KiB refused). A fresh router value can only lower the cap, never above the setting and never below a floor of 6 in total (4 general + 2 reserved). A router that is unreachable, answers garbage or has not answered for 60 s is ignored, so the cap falls back to the setting, never to 1 or 0.
- **Order.** Waiting runs start in this order: human/board-initiated runs, then review and recovery work, then everything else; inside each class the oldest run starts first. A general run that has waited 30 minutes is ordered with review and recovery work. It still never uses the reserved slots, and human/board work stays first. Because review and recovery work beyond the reserve holds general slots only until it ends, the aged run takes the next general slot that frees, however long the review stream runs. A run that cannot start for its own reasons (its agent's `maxConcurrentRuns`, a blocker, another run holding the issue) does not hold up the line.
- **How a run's class is decided.** Only facts the server records count. No wake reason is read, and no issue status:
  - Human/board: the run's own wake request was recorded with a `user` actor. The server takes the actor type from the authenticated caller. A human comment, interaction answer or approval decision that a plugin relays is general: the plugin host stamps its plugin id on that wake request.
  - Review/recovery: the run's issue has a recovery origin kind, or the issue's execution state has a review or approval stage pending with this run's agent as the participant. The issue API cannot set a recovery origin kind; examples are stranded-issue recovery and liveness escalation. A pending stage counts only when three things hold:
    - The delivery author (the assignee when the work was delivered) is someone else.
    - The execution-policy engine recorded who seated this participant.
    - An independent board user seated the participant and is not the delivery author. The current seat record identifies agent and user actors only; a missing actor does not prove trusted system or policy authorization.
  - Agent-seated reviews use general slots, including an executor that delivers work and seats a different reviewer. These runs remain capped and run when a general slot is available. A prior board assignment does not authorize an agent's later seating transition.
  - What enforces it: only the engine writes the execution state. No issue or wake API accepts it. The plugin host refuses it on issue create, and a plugin issue update never writes it (only declared patch fields pass).
  - A card the issue monitor mints is general, never review/recovery. An external-service monitor with `recoveryPolicy: "create_recovery_issue"` opens a recovery-origin card on exhaustion, and an agent's own re-arm can cause that. So a card carrying the server-generated `issue_monitor:` origin fingerprint (no issue API accepts a fingerprint) is ordered and slotted as general work, whoever scheduled the monitor. A board-scheduled monitor's card gets no reserve priority either.
  - Everything else is general. That includes an issue created or set `in_review` without a review stage, any agent-seated stage, and a seat without a known independent authority. It also includes any wake reason chosen by an agent, a board user, a plugin or a server path. Recovery wakes on an ordinary issue (for example a recovery action on the source card) are general too, and so are stages seated before the engine recorded seats.
- **Not counted.** External agent sessions neither count toward the cap nor wait on it: agents on the `process`, `http`, `hermes_gateway` or `openclaw_gateway` adapters, and agents declared `workDelivery: "external_pull"` (section 3.5). Every other run counts, in every company. A `running` row whose process died still counts until the orphan reaper finalizes it (up to about 5 minutes).
- **One server process.** Admission state lives in the server process, so the cap holds only while one server process admits runs. During a rolling deploy, the old and new process can each admit up to the free slots until the old one stops.
- **Stuck reads.** Admission takes one lock per decision with a 10 s deadline. If the live count hangs (a stuck database read), each waiting admission is refused after 10 s. The run stays `queued`, is not recorded in line, and the next pass retries it.
- **Status.** `GET /api/instance/live-run-cap` (instance admins only, because the counts span every company) returns counts only: the setting, the router value and its freshness, the effective cap, the live run count, and how many runs are queued and waiting on the cap.

Rollback: `PATCH /api/instance/settings/general` with `{"liveRunCap": null}` takes effect immediately and starts the waiting queue. Reverting the code needs no migration; the setting lives in the existing settings JSON.

## 4. Session resume behavior

Paperclip stores session IDs for resumable adapters.

- Next heartbeat reuses the saved session automatically.
- This gives continuity across heartbeats.
- You can reset a session if context gets stale or confused.

Use session reset when:

- you significantly changed prompt strategy
- the agent is stuck in a bad loop
- you want a clean restart

## 5. Logs, status, and run history

For each heartbeat run you get:

- run status (`queued`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`)
- error text and stderr/stdout excerpts
- token usage/cost when available from the adapter
- full logs (stored outside core run rows, optimized for large output)

In local/dev setups, full logs are stored on disk under the configured run-log path.

## 6. Live updates in the UI

Paperclip pushes runtime/activity updates to the browser in real time.

You should see live changes for:

- agent status
- heartbeat run status
- task/activity updates caused by agent work
- dashboard/cost/activity panels as relevant

If the connection drops, the UI reconnects automatically.

## 7. Common operating patterns

## 7.1 Simple autonomous loop

1. Enable timer wakeups (for example every 300s)
2. Keep assignment wakeups on
3. Use a focused prompt template that tells agents to act in the same heartbeat, leave durable progress, and mark blocked work with an owner/action
4. Watch run logs and adjust prompt/config over time

## 7.2 Event-driven loop (less constant polling)

1. Disable timer or set a long interval
2. Keep wake-on-assignment enabled
3. Use child issues, comments, and on-demand wakeups for handoffs instead of loops that poll agents, sessions, or processes

## 7.3 Safety-first loop

1. Short timeout
2. Conservative prompt
3. Monitor errors + cancel quickly when needed
4. Reset sessions when drift appears

## 8. Troubleshooting

If runs fail repeatedly:

1. Check adapter command availability (e.g. `claude`/`codex`/`opencode`/`hermes` installed and logged in).
2. Verify `cwd` exists and is accessible.
3. Inspect run error + stderr excerpt, then full log.
4. Confirm timeout is not too low.
5. Reset session and retry.
6. Pause agent if it is causing repeated bad updates.

Typical failure causes:

- CLI not installed/authenticated
- bad working directory
- malformed adapter args/env
- prompt too broad or missing constraints
- process timeout

Claude-specific note:

- If `ANTHROPIC_API_KEY` is set in adapter env or host environment, Claude uses API-key auth instead of subscription login. Paperclip surfaces this as a warning in environment tests, not a hard error.

## 9. Security and risk notes

Local CLI adapters run unsandboxed on the host machine.

That means:

- prompt instructions matter
- configured credentials/env vars are sensitive
- working directory permissions matter

Start with least privilege where possible, and avoid exposing secrets in broad reusable prompts unless intentionally required.

## 10. Minimal setup checklist

1. Choose adapter (e.g. `claude_local`, `codex_local`, `opencode_local`, `hermes_local`, `hermes_gateway`, `cursor`, or `openclaw_gateway`). External plugins like `droid_local` are also available via the adapter manager.
2. Set `cwd` to the target workspace (for local adapters).
3. Optionally add a prompt template (`promptTemplate`) or use the managed instructions bundle.
4. Configure heartbeat policy (timer and/or assignment wakeups).
5. Trigger a manual wakeup.
6. Confirm run succeeds and session/token usage is recorded.
7. Watch live updates and iterate prompt/config.
