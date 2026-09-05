# Run-summary re-injection is BOUNDED (not a ratchet) — SUP-15050

Verdict on the claim spun out of [SUP-14904](/SUP/issues/SUP-14904):

> "Each aborted run's summary is re-injected into the next run, so the prompt
> ratchets upward and the card can never recover on its own."

**Falsified.** The carried-forward context across consecutive same-issue runs is
**bounded**, and a real looping card does not see its prompt grow — and it recovers
on its own. Details below, read and measured 2026-09-05.

## The re-injection code path (control plane)

The only mechanism that carries a prior run's state into the next run's prompt is
the **issue continuation summary** — one versioned document, regenerated after each
finished run and read back once for the next run. There is no concatenation of
multiple prior-run summaries.

1. **Built per finished run.**
   `server/src/services/heartbeat.ts:10614` `refreshContinuationSummaryForRun` →
   `server/src/services/issue-continuation-summary.ts:242` `refreshIssueContinuationSummary`
   → `issue-continuation-summary.ts:136` `buildContinuationSummaryMarkdown`.
2. **Hard-capped at build time.**
   `issue-continuation-summary.ts:9` `ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS = 8_000`;
   `:10` `SUMMARY_SECTION_MAX_CHARS = 1_200`. The assembled body is truncated to the
   8 000 cap at `issue-continuation-summary.ts:208` (`truncateText(body, …)`).
   Individual pieces are capped earlier: result summary → 1 200 chars (`:146`),
   run error → 500 chars (`:149`), path candidates → max 12 (`:88`), objective →
   1 200 (`:170`).
3. **Replaced, not appended.** `issue-continuation-summary.ts:272` upserts a fresh
   revision whose `latestBody` is the newly-built bounded body. The previous body is
   used only to seed two bounded things: a single "Next Action" line
   (`extractPreviousNextAction`, `:117`) and up to 12 deduped path candidates.
4. **Injected once into the next run.**
   `server/src/services/heartbeat.ts:16054` `getIssueContinuationSummaryDocument`
   (reads the single latest body) → `:16070` `context.paperclipContinuationSummary`.
   The wake-payload copy is additionally inline-capped to 4 000 chars at
   `heartbeat.ts:6533` (`body.slice(0, 4_000)`).
5. **Task markdown has no run-history accumulation.** `heartbeat.ts:6845`
   `buildPaperclipTaskMarkdown` carries only the issue (description, etc.),
   ancestors (capped at 6, `:6883`), and the single latest wake comment. No list of
   prior runs is ever appended.

## Measured on a real looping card (SUP-14873)

SUP-14873 aborted 10 consecutive runs `opencode_exit_1` on 2026-09-03
(13:42Z–17:16Z). For each I pulled the persisted `contextSnapshot` and measured the
size of the re-injected summary (`paperclipContinuationSummary.body`) and the total
run context.

```
time   status   runid   | contSumBody  wakeContSum  taskMd  ctxSnapBytes
---------------------------------------------------------------------------------
13:42  failed   a6210c35 | 3802        3802        4276    33214
13:44  failed   cb95ae38 | 2773        2773        4276    31018
16:32  failed   5fd923d8 | 2773        2773        4276    31098
16:34  failed   4966dc07 | 2773        2773        4276    31018
16:37  failed   e2a8d963 | 2773        2773        4276    31098
16:39  failed   21857e31 | 2773        2773        4276    31018
17:08  failed   efc84738 | 2773        2773        9417    51887
17:09  failed   3a501c15 | 2773        2773        4276    31018
17:14  failed   7d1dcdf7 | 2773        2773        6823    42537
17:16  failed   15a05b42 | 2773        2773        4276    31018
```

- The re-injected summary is **flat at ~2 773 chars** across all ten consecutive
  failed runs — not monotonically increasing.
- Total run context is **flat at ~31 KB**; the two spikes (51 887 / 42 537 bytes) are
  transient wake-comment content on a single run and drop back to ~31 KB on the very
  next run — not accumulation.
- Every failed run had `nativeSessionId: null` / `forceFreshSession: null`: each
  aborted opencode process was a **fresh** invocation that exited (code 1) before
  establishing a session, so there was no adapter-session conversation carried across
  runs either. The "generic adapter exit" in the record is just `opencode_exit_1`.

## Why the card still "never recovered" (it's not this mechanism)

The card recovered on its own once the underlying transient cleared:
succeeded runs at 18:57Z, 19:01Z, 19:56Z, 20:03Z on the same issue. The ten
consecutive aborts were the pre-fix admission-estimator defect (`no_eligible_rung`
on long-context prompts) — `coder-le-default`'s usable context was ~699 k before the
recalibration (SUP-14936 / SUP-14945 / SUP-15039) that raised it to ~1.049 M. That
fault is fixed and out of scope here; the re-injection amplifier it was blamed on is
not present.

## Bottom line

- Carried context across consecutive same-issue runs is **bounded**: single
  continuation-summary document, 8 000-char body cap (4 000-char wake-payload cap),
  plus a task markdown with no run-history accumulation.
- **No cap needed.** Nothing to ship; no follow-up card required.
