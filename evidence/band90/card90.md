writer-Auditor targeted probe — band #90 (post-band-#89 boundary)

work-type:audit-probe | serial: none minted (underivable) | verdict: **FAIL**

## Band
- Population window: `(2026-11-22T16:18:57.006Z, 2026-11-23T01:41:25.022Z]` — band #90 opens at the closed band #89 card SUP-25025 upper edge; frozen at snapshot, REPRO reproduces exactly (10 == 10).
- N=10 close-writes on 10 distinct cards; feed cursor enumeration, A(popA issues-rooted ∩ window) vs B(popB feed set) symmetric difference = 0 both directions; cancelled-in-band 0 of 1521.
- Buckets: 10/10 declared-close-timed; max |decl→close| = 0.97 s (bound 900 s). No undeclared closes, no stale-declaration re-use.

## Verdict detail
- Shape ghost PASS: **0** — every close carries a declaration comment and ladder rows. (SUP-25026 refused once — `done_transition_missing_tier_declaration`, system remedy at close−56.7 s — then re-closed clean in shape at −0.03 s.)
- Truth-contradicted: **9 of 10.** All nine are the hourly merge-arming backstop sweeps (SUP-25026, 25029, 25030, 25031, 25035, 25036, 25037, 25039, 25040; actor `4ba1bf2b`, cadence hourly 17:23→01:04Z). In each, the actor's own close-timed, run-correlated declaration comment (d≈−0.03 s, run=Y verified per card in `shape90.log`) carries `result: pass` while the same comment records machine failure: exit-2 scan codes (25026/29/35/36/37/40), `failed=4` (25026, 25039), `scanned=0` (25029), "the scan failed" (25030), "failed closed" (25031), "check-run App token unavailable" (all). No evasion by split-comment shape: failure text remains inside every declaration comment.
- Undetermined: **0.** The tenth close (SUP-25025, band #89 card closed by support-CR via the ladder, tier rows present) is clean.
- Hard counts derive from machine records coexisting with the pass token in the same comment (F89-5 rule), not from the probe word-list. Disclosure: the word-list detector flagged 8/9 — false-negative on SUP-25039 (`failed=4` / "token unavailable" not in list). Mirror-image of F89-5; list repaired with `failed=[1-9]` and `token.{0,24}(missing|unavailable)`; counts above are the machine-derived 9, not the detector's 8.

## Findings
- **F90-1 (F89-1 recurrence, 9th consecutive hour).** The canonical anchor SUP-25007 sat `todo` with **zero runs by its assignee for ~18 h** while the class re-fired 9 times. During the band, coder-paperclip-fold opened fix PR **#1263** "refuse record-only Tier 2 pass declarations that contradict their own evidence" (2026-11-22T22:33:44Z, head `f6efbaa7…`, stamp card SUP-25042 in_progress — board stamped 01:41:12Z). Server identity unchanged all band (pid 8, commit `96bc536e`, == fold tip), so the unpatched platform accepted all 9. The four closes after 22:33Z (25036/37/39/40) are still false greens — fix is opened, not merged, not deployed. Post-merge duty: first band after deploy must re-check the `failed=4 + result: pass` shape is now refused.
- **F90-2 (corrupted cited SHA accepted).** SUP-25026's done-transition cited full SHA `00827af5f55a66b98939aa77f2d1111111111111` — a mangled form of PR #1255's real head `00827af5f55a66b98939aa77d2fe1c222d16e601` (same prefix, correct tail attested by SUP-25040's own citation). `done_transition_cited_sha_resolved` returned `status=unverifiable, reason=ambiguous_repository_scope`, probing only Trading-Signal-Platform for a paperclip-PR head. The citation mechanism carries an unverifiable (effectively fabricated-form) SHA through the close without refusal. Routed onto SUP-25007 (same actor/class); scope-gap family adjacent to SUP-23308.
- **F90-3 (audit-tool self-disclosure).** Detector false-negative above, repaired in-band.
- **F90-4 (measure continuation).** Ladder-refusal spin on blocked card SUP-22839: **72 `ladder_refused` + 24 `refusal_repeated` rows in 24 h** (band #89 reading: 48+16 — accelerating). Reported to open anchor SUP-24136; no new card.
- **F90-5 (fleet health).** PR backlog 38 open, 0 review decisions (down from ~55 at band #85). `issue_terminal_cleanup_failed`: 0 rows in 72 h — storm ended; action-name control shows the query path live (500-row tail at Nov 18). `board_stage_override` since band edge: 2 rows / 2 cards — SUP-25041 closed 01:39:51Z with **zero tier rows** (live confirmation of SUP-24950's no-tier-record prediction post-band-#89) and SUP-25042 open (PR #1263 stamp); reported to SUP-24950. Serial anchor SUP-24929, plus SUP-24950 and SUP-25002, sit `in_review` awaiting board clicks ~2 days. SUP-25027 (F89-2 arch review) `blocked` — owner exec-CTO, action: resolve interaction `576eb08f`; child blocker SUP-25028. SUP-24983 (band #86 card) still `in_progress` under board user.

## Population / controls
- Serving identity: pid 8 stable, `lstart=Sat Nov 21 16:04:59 2026`, disk commit == health commit == fold tip `96bc536e42a8f74ebc7e78150df57711418826ce`; all four prior fixes (#1174, #1253, #1254, #1245) deployed and stable; identity model SINGLE.
- Serial: still **underivable** (no non-probe wake-audit claimant in window; SUP-24929 `in_review` holds the latch doctrine). No census card minted; probe path only.
- Collision check before filing: no `band #90`-titled issue exists (prefile90.log).
- Artifacts (workspace `d051c75c…/band90/`): `probe90.py` (snapshot+REPRO), `band90.json`, `snapshot90.log`, `probe90-run2.log`, `serve90.py/.log`, `serial90.py/.log`, `follow90a.py/.log` (exit-code extraction), `shape90.log` (per-comment DECL/PASS/MACHINE-FAIL tags, run correlation), `bodies90.log` (full declarations 25030/25039), `follow90b/c.py/.log` (anchor runs, cited-SHA rows, ladder/stage-override/cleanup counts), `prbacklog90.log`, `prefile90.log`, `fix90.log`.

## Findings routing (no new cards)
Every band #90 signature is carried by an open canonical anchor: F90-1/F90-2 → SUP-25007 (comment posted); F90-4 → SUP-24136 (comment posted); F90-5 override evidence → SUP-24950 (comment posted). No unowned new signature; per escalation doctrine, reported-not-filed.
