# SUP-20772 head-bound release: executed evidence

Everything here was produced by running the code in this pull request: real embedded PostgreSQL, the real routes and
services, the real `scripts/ci/check-paperclip-approved.sh` through a stand-in `gh`, and only the GitHub HTTP boundary
faked. Nothing was run against live GitHub or a deployed control plane.

## Reproduce

Run from the repository root. `SUP_20772_EVIDENCE_DIR` makes the tests write their JSON next to this file.

```sh
export SUP_20772_EVIDENCE_DIR=$PWD/docs/evidence/sup-20772
# Late-success cells; SUP_20772_CONTROL_SCRIPT adds the previous head's script as a control column.
cp docs/evidence/sup-20772/corpus/previous-head-93e1b0b8-script.sh.txt /tmp/previous-head-script.sh
SUP_20772_CONTROL_SCRIPT=/tmp/previous-head-script.sh pnpm --filter @paperclipai/server exec vitest run src/__tests__/merge-arming-republish.test.ts -t "late provider success, judged"
# Disarm window at 0/50/100/1000/5000 ms, two provider round trips.
pnpm --filter @paperclipai/server exec vitest run src/services/merge-arming.test.ts -t "window from the provider accepting"
# 16-cell authority matrix: reconciler (real tick, real database) 8, backstop (real sweep, scripted rows) 8, actuator 16.
pnpm --filter @paperclipai/server exec vitest run src/services/approval-status-reconciler.test.ts -t "revocation matrix through the real"
pnpm --filter @paperclipai/server exec vitest run src/services/done-close-landing-backstop.test.ts -t "revocation matrix through the real backstop"
pnpm --filter @paperclipai/server exec vitest run src/services/merge-arming.test.ts -t "16-cell authority matrix"
# Round 15: the fence over the status route, provider statuses 403/422/503/timeout, sweep takes every record, the enable deadline and admission lock through the real arm, 409 for a database timeout (controls: cp controls15.py.txt to .py; REPO_ROOT=$PWD python3 controls15.py <scratch dir> old|mut mutants15.json).
pnpm --filter @paperclipai/server exec vitest run src/services/merge-arming.test.ts -t "second route|tries every record in a default sweep|enable-call deadline and the admission lock"
pnpm --filter @paperclipai/server exec vitest run src/__tests__/merge-arming-republish.test.ts -t "answers 409, not 500"
# Round 14: hard cap, escalation, settle, enable deadline (the controls: cp the .txt to a .py; REPO_ROOT=$PWD python3 controls14.py <scratch dir> old|mut mutants14.json).
pnpm --filter @paperclipai/server exec vitest run src/services/merge-arming.test.ts -t "round 14|holds the cap under concurrent|a take-back GitHub never confirms|whatever the authority"
# Abandoned-operation matrix and the CONNECTION_DESTROYED regression.
pnpm --filter @paperclipai/server exec vitest run src/__tests__/merge-arming-republish.test.ts -t "abandoned-operation matrix|cancel during connection startup"
# OFF and ON differential corpora (the .txt files are copies: strip the suffix).
for f in offcompare12 onident12 oncompare10; do cp docs/evidence/sup-20772/corpus/$f.mjs.txt /tmp/$f.mjs; done
cp docs/evidence/sup-20772/corpus/fold-script.sh.txt /tmp/fold-script.sh
node /tmp/offcompare12.mjs $PWD/scripts/ci/check-paperclip-approved.sh /tmp/fold-script.sh $PWD
node /tmp/onident12.mjs $PWD/scripts/ci/check-paperclip-approved.sh /tmp/previous-head-script.sh $PWD
node /tmp/oncompare10.mjs $PWD/scripts/ci/check-paperclip-approved.sh /tmp/previous-head-script.sh $PWD
```

## Results

| Item | File | Result |
|---|---|---|
| Disarm window: provider accepts an arm whose authority was revoked, merges D ms later (D = 0, 50, 100, 1000, 5000), provider round trip 0 and 150 ms | `disarm-window.json` | Accept to take-back request: 6 ms (round trip 0), 157-162 ms (round trip 150) in the committed run on this head (the two runs on the previous head: 5-13 ms and 156-166 ms). Merged first at D = 0 in both cases, and at D = 50 and 100 only with the 150 ms round trip. Never at 1000 and 5000. This is the window GitHub's lack of a compare-and-set leaves; it is measured, not closed. |
| Late provider success judged by the real consumer (D = 0, 100, 1000, 2000, 5000 ms after the 409; unknown beyond both re-checks; unreadable re-check; legitimate confirmed release) | `late-success-cells.json` | Every unconfirmed success refused (exit 1) in switch OFF and ON, at landing and after the void. The previous head's script (control column) accepted it in OFF (exit 0) at every "at landing" cell, and in the two unknown-state cells. The confirmed release is accepted (exit 0) in both modes. |
| New tests against the previous head's source | `old-head-control.json` | 15 of the new tests fail on it (the write-ahead record, backlog cap, boot resume, in-flight settling, startup-cancel regression, backstop record). The authority and late-success cells pass on it: those behaviours were fixed in earlier rounds and these cells are regression coverage (see mutants). |
| Mutants (one safeguard removed each) | `mutants.json` | M1-M8 all killed (failing tests listed per mutant). |
| Round 14 (hard cap, settle always disables, escalation deadline, enable deadline): new tests against the previous head's (5d673893) `merge-arming.ts` and `auto-merge-disarm.ts` | `round14-controls.json` (`previousHead`) | 9 of the 12 selected tests fail on it (3 pass: they cover behaviour that already existed). Two of the nine fail only because the old module has no `disarmEscalation` / `ENABLE_WORST_CASE_MS` export. |
| Round 14 mutants M9-M15 (`mutants14.json`; no admission lock, settle clears an unchanged in-flight record, escalation never reached, no enable deadline, timed-out enable drops the record, sweep takes one record, escalated record answers as an ordinary one) | `round14-controls.json` (`mutants`) | All 7 killed. M12 first survived (the test passed an explicit timeout), so a test on the default deadline was added and it kills it. |
| Round 15 (fence over the status route, provider statuses 403/422/503/timeout through the real sweep, sweep takes every record, enable deadline and admission lock through the real arm, 409 for a database timeout): new tests against the previous head's (84ab1e97) `merge-arming.ts`, `auto-merge-disarm.ts` and `routes/issues.ts` | `round15-controls.json` (`previousHead`) | All 14 selected new tests fail on it (12 in `merge-arming.test.ts`, 2 in `merge-arming-republish.test.ts`: the route answers 500). |
| Round 15 mutants M9-M20 (`mutants15.json`: no admission lock, settle clears an unchanged record, escalation never reached, no enable deadline, timed-out enable drops the record, sweep takes a limited number, escalated record answers as ordinary, sweep never fences, no inline fence, in-flight arm fenced before the deadline, fence writes success, database timeout answers 500) | `round15-controls.json` (`mutants`) | All 12 killed. |
| OFF corpus against the fold script (the script at the merge base 42e79c64 and at the fold tip 0b880e33 are identical) | `corpus/off-vs-fold.out` | 1,920 inputs, 360 differ, all 360 in the class "newest `paperclip/approved` is a control-plane success described `released by ` that no control-plane marker names"; 0 outside it. |
| ON corpus against the previous head's script | `corpus/on-vs-93e1b0b8-*.out` | 384 inputs, 0 differences (both scripts). |

## Not run

Live GitHub or a deployed control plane; `pnpm build`; the full server test shards; release assurance's own corpora
(4,608 exact OFF tuples, 5,484 historical pairs, 60 repair and 1,484 field pairs), which are not on this disk. The
backstop cells run the real sweep and the real authority guard over scripted rows (the database is a scripted fake,
as in the existing backstop suite), not over a real database.
