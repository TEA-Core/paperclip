Evidence comment — band #90 close-verification bundle (all machine-verified this run; artifacts in workspace d051c75c…/band90/).

closeverify90.py run1 02:08Z and run2 02:11Z both rc=0, 14/14 controls PASS:
- C1: band population re-derived from the company feed — 10 close-writes, 10 distinct cards, offset paging short-page terminated (pages=1).
- C2 (9x): each sweep declaration comment re-confirmed run-correlated, close-timed (−0.02 s to −0.11 s), structurally matching the band rule set; hard list = SUP-25026, 25029, 25030, 25031, 25035, 25036, 25037, 25039, 25040.
- C2a: SUP-25025 (band #89 card) re-confirmed with tier record (`done_transition_tier2_close`) and clean.
- C3: this card (SUP-25044) present, correct project, full body, band #90 in title.
- C4: serving identity unchanged from serve90 verification (commit `96bc536e…`, pid 8).

Routing comments posted this run: SUP-25007 (recurrence + corrupted cited-SHA sub-signature, comments 230c5ec1/d45aa40b), SUP-24136 (ladder spin 72+24/24 h, comment 1a83a9bc), SUP-24950 (override-close 0 tier rows on SUP-25041 at 01:57:58.053Z, comments e3c86df7/21e87d43/08230543).

Verdict: **FAIL** — 9 of 10 close-writes in band #90 are truth-contradicted; 0 shape ghost PASSes; 0 undetermined. Serial not derivable; no census card minted.
