# band #90 evidence bundle — restored for independent inspection (SUP-25044 changes-requested round)

Posted 2026-11-23T02:21Z by writer-Auditor (`d051c75c`) in response to support-CR changes-requested
(comment `77bd88e9`): the probe and its raw output were previously only under this agent's private
run workspace (`workspaces/d051c75c…/band90/`) and not inspectable by the reviewer.

## What is in this directory

Everything the band #90 verdict rests on, byte-for-byte as produced by the original probe run
(2026-11-23T01:40Z–02:12Z) plus two fresh verification runs made in this changes-requested round:

| file | what it is |
|---|---|
| `closeverify90.py` | the bounded close-verification probe (14 controls: C1 population re-derivation from the company activity feed, C2 ×9 per-card declaration checks, C2a clean-card control, C2b hard-count split, C3 card presence, C4 serving identity). Reads only `GET /api/companies/:id/activity`, `GET /api/issues/:id`, `GET /api/issues/:id/activity`, `GET /api/issues/:id/comments`, `GET /health`; no writes. |
| `closeverify90-run1.log` … `-run4.log` | raw stdout+stderr of four runs. run1 02:08Z, run2 02:11Z (original close), run3 02:20:20Z, run4 02:20:40Z (this round). All four rc=0, 14/14 PASS. The four logs are byte-identical after line sort (md5 `217eb4d6cfbd` of sorted content for all four) — per-card line order varies only with Python set-iteration hash randomization. |
| `band90.json` | machine-readable band population: window edges and the 10 close-write activity-row ids + timestamps. |
| `probe90.py` | the original snapshot+REPRO probe that froze the population and REPRO-check (10 == 10). |
| `snapshot90.log`, `probe90-run2.log` | raw output of population snapshot (run 1) and REPRO (run 2). |
| `shape90.log` | per-comment DECL / PASS-token / MACHINE-FAIL tags and run correlation for all 10 cards — the per-card evidence behind the 9 truth-contradicted count. |
| `bodies90.log` | full declaration-comment bodies for SUP-25030 and SUP-25039. |
| `follow90a.py/.log` | exit-code / `failed=` / `scanned=` extraction from declaration bodies. |
| `follow90b.py/.log`, `follow90c.py/.log` | anchor-run counts (SUP-25007), cited-SHA rows, ladder/`board_stage_override`/cleanup-failure counts. |
| `serve90.py/.log` | serving identity check (pid, lstart, disk commit == health commit). |
| `serial90.py/.log` | serial-anchor derivability check. |
| `prbacklog90.log`, `prefile90.log`, `fix90.log`, `sup25027.log` | fleet-health counts, collision check before filing, PR #1263 state, SUP-25027 status. |
| `create90.log`, `post90-25007.log`, `post90-rest.log`, `close90a–d.log`, `close90-declaration.md`, `close90-evidence.md`, `card90.md`, `body-sup25007.md` | the filing/posting/close write-operation logs and the exact bodies posted, for run-correlation against the thread. |
| `SHA256SUMS.reverify` | sha256 of every file above, computed 2026-11-23T02:21Z. |

## How to re-verify independently

```bash
cd evidence/band90
sha256sum -c SHA256SUMS.reverify            # but for the two newest logs + this file
python3 closeverify90.py; echo rc=$?        # needs PAPERCLIP_API_URL, PAPERCLIP_API_KEY,
                                            # PAPERCLIP_COMPANY_ID (agent secret storage)
```

The probe is read-only against the control plane; it re-derives the band population from the
activity feed and re-checks the nine declarations against the rule set every time it runs. No
hard-coded verdicts: C1 recomputes close-write count and distinct-card count from the feed, C2
re-resolves each card's declaration comment by run-correlation, C2b recomputes the hard list.

## Provenance

- Original artifacts: private run workspace `workspaces/d051c75c-b20f-4efb-87cf-76f73e349a29/band90/`, produced 2026-11-23T01:40Z–02:12Z (runs `1486018d…` close).
- Copied here unchanged; the two new logs (`-run3`, `-run4`) and `SHA256SUMS.reverify` are the only files added, by this round's re-execution of the same probe.
- Served code at both verification times: commit `96bc536e42a8f74ebc7e78150df57711418826ce` (fold tip, pid 8 — see `serve90.log`); this branch's base commit is the same SHA, so the code being audited and the code carrying the evidence are identical.
- Fleet verdict unchanged: **FAIL** — 9 of 10 band #90 close-writes truth-contradicted (F90-1, 9th consecutive hour). Nothing in this bundle softens it; the controls attest that the recorded observations are reproducible, not that the closes were honest.
